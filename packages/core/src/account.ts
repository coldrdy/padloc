import { stringToBytes, concatBytes, Serializable, AsSerializable, AsBytes, AsDate, AsSet, Exclude } from "./encoding";
import { RSAPublicKey, RSAPrivateKey, RSAKeyParams, HMACKey, HMACParams, HMACKeyParams } from "./crypto";
import { getCryptoProvider as getProvider } from "./platform";
import { Err, ErrorCode } from "./error";
import { PBES2Container } from "./container";
import { Storable } from "./storage";
import { SessionInfo } from "./session";
import { VaultID } from "./vault";
import { Org, OrgID } from "./org";
import { AccountQuota } from "./quota";
import { BillingInfo } from "./billing";
import { VaultItemID } from "./item";

/** Unique identifier for [[Account]] objects */
export type AccountID = string;

class AccountSecrets extends Serializable {
    constructor({ signingKey, privateKey, favorites }: Partial<AccountSecrets> = {}) {
        super();
        Object.assign(this, { signingKey, privateKey, favorites });
    }

    @AsBytes()
    signingKey!: Uint8Array;

    @AsBytes()
    privateKey!: Uint8Array;

    @AsSet()
    favorites = new Set<VaultItemID>();
}

/**
 * The `Account` object represents an individual Padloc user and holds general
 * account information as well as cryptographic keys necessary for accessing
 * [[Vaults]] and signing/verifying [[Org]]anization details.
 *
 * The [[privateKey]] and [[signingKey]] properties are considered secret and
 * therefore need to be encrypted at rest. For this, the [[Account]] object
 * serves as a [[PBESContainer]] which is unlocked by the users **master
 * password**.
 */
export class Account extends PBES2Container implements Storable {
    /** Unique account ID */
    id: AccountID = "";

    /** The users email address */
    email = "";

    /** The users display name */
    name = "";

    /** When the account was created */
    @AsDate()
    created = new Date();

    /** when the account was last updated */
    @AsDate()
    updated = new Date();

    /** The accounts public key */
    @AsBytes()
    publicKey!: RSAPublicKey;

    /**
     * The accounts private key
     *
     * @secret
     * **IMPORTANT**: This property is considered **secret**
     * and should never stored or transmitted in plain text
     */
    @Exclude()
    privateKey!: RSAPrivateKey;

    /**
     * HMAC key used for signing and verifying organization details
     *
     * **IMPORTANT**: This property is considered **secret**
     * and should never stored or transmitted in plain text
     *
     * @secret
     */
    @Exclude()
    signingKey!: HMACKey;

    /** List of currently active sessions */
    @AsSerializable(SessionInfo)
    sessions: SessionInfo[] = [];

    /** ID of the accounts main or "private" [[Vault]]. */
    mainVault: {
        id: VaultID;
        name?: string;
        revision?: string;
    } = { id: "" };

    /** IDs of all organizations this account is a member of */
    orgs: {
        id: OrgID;
        name?: string;
        revision?: string;
    }[] = [];

    /**
     * Revision id used for ensuring continuity when synchronizing the account
     * object between client and server
     */
    revision: string = "";

    @AsSerializable(AccountQuota)
    quota: AccountQuota = new AccountQuota();

    billingDisabled = false;

    @AsSerializable(BillingInfo)
    billing?: BillingInfo;

    usedStorage: number = 0;

    @Exclude()
    favorites = new Set<VaultItemID>();

    /**
     * Whether or not this Account object is current "locked" or, in other words,
     * whether the `privateKey` and `signingKey` properties have been decrypted.
     */
    get locked(): boolean {
        return !this.privateKey;
    }

    get masterKey() {
        return this._key;
    }

    set masterKey(key: Uint8Array | undefined) {
        this._key = key;
    }

    /**
     * Generates the accounts [[privateKey]], [[publicKey]] and [[signingKey]] and
     * encrypts [[privateKey]] and [[singingKey]] using the master password.
     */
    async initialize(password: string) {
        const { publicKey, privateKey } = await getProvider().generateKey(new RSAKeyParams());
        this.publicKey = publicKey;
        this.privateKey = privateKey;
        this.signingKey = await getProvider().generateKey(new HMACKeyParams());
        await this.setPassword(password);
    }

    /** Updates the master password by reencrypting the [[privateKey]] and [[signingKey]] properties */
    async setPassword(password: string) {
        await super.unlock(password);
        await this._commitSecrets();
        this.updated = new Date();
    }

    /**
     * "Unlocks" the account by decrypting and extracting [[privateKey]] and
     * [[signingKey]] from [[encryptedData]]
     */
    async unlock(password: string) {
        await super.unlock(password);
        await this._loadSecrets();
    }

    /**
     * Unlocks the account by providing the encryption key directly rather than
     * deriving it fro the master password
     */
    async unlockWithMasterKey(key: Uint8Array) {
        this._key = key;
        await this._loadSecrets();
    }

    /**
     * "Locks" the account by deleting all sensitive data from the object
     */
    lock() {
        super.lock();
        delete this.privateKey;
        delete this.signingKey;
        delete this.favorites;
    }

    clone() {
        const clone = super.clone();
        clone.copySecrets(this);
        return clone;
    }

    toString() {
        return this.name || this.email;
    }

    /**
     * Creates a signature that can be used later to verify an organizations id and public key
     */
    async signOrg({ id, publicKey }: { id: string; publicKey: Uint8Array }) {
        return getProvider().sign(this.signingKey, concatBytes([stringToBytes(id), publicKey], 0x00), new HMACParams());
    }

    /**
     * Verifies an organizations id an public key, using the signature stored
     * in the [[Member]] object associated with the account.
     */
    async verifyOrg(org: Org): Promise<void> {
        if (!this.signingKey) {
            throw "Account needs to be unlocked first";
        }

        const member = org.getMember(this);

        if (!member) {
            throw new Err(ErrorCode.VERIFICATION_ERROR, "Account is not a member.");
        }

        const verified = await getProvider().verify(
            this.signingKey,
            member.orgSignature,
            concatBytes([stringToBytes(org.id), org.publicKey], 0x00),
            new HMACParams()
        );

        if (!verified) {
            throw new Err(ErrorCode.VERIFICATION_ERROR, `Failed to verify public key of ${org.name}!`);
        }
    }

    async toggleFavorite(id: VaultItemID, favorite: boolean) {
        favorite ? this.favorites.add(id) : this.favorites.delete(id);
        await this._commitSecrets();
    }

    copySecrets(account: Account) {
        this.privateKey = account.privateKey;
        this.signingKey = account.signingKey;
        this.favorites = account.favorites;
        this._key = account._key;
    }

    private async _loadSecrets() {
        const secrets = new AccountSecrets().fromBytes(await this.getData());
        Object.assign(this, secrets);
    }

    private async _commitSecrets() {
        const secrets = new AccountSecrets(this);
        await this.setData(secrets.toBytes());
    }
}
