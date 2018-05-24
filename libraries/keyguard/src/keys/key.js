export default class Key {
    /**
     * @param {Uint8Array|string} buf
     * @return {Key}
     */
    static loadPlain(buf) {
        if (typeof buf === 'string') buf = Nimiq.BufferUtils.fromHex(buf);
        if (!buf || buf.byteLength === 0) {
            throw new Error('Invalid Key seed');
        }
        return new Key(Nimiq.KeyPair.unserialize(new Nimiq.SerialBuffer(buf)));
    }

    /**
     * @param {Uint8Array|string} buf
     * @param {Uint8Array|string} passphrase
     * @return {Promise.<Key>}
     */
    static async loadEncrypted(buf, passphrase) {
        if (typeof buf === 'string') buf = Nimiq.BufferUtils.fromHex(buf);
        if (typeof passphrase === 'string') passphrase = Nimiq.BufferUtils.fromAscii(passphrase);
        return new Key(await Nimiq.KeyPair.fromEncrypted(new Nimiq.SerialBuffer(buf), passphrase));
    }


    /** @param {string} friendlyAddress */
    static async getUnfriendlyAddress(friendlyAddress) {
        return Nimiq.Address.fromUserFriendlyAddress(friendlyAddress);
    }

    /**
     * Create a new Key object.
     * @param {KeyPair} keyPair KeyPair owning this Key
     * @returns {Key} A newly generated Key
     */
    constructor(keyPair, type, label) {
        /** @type {KeyPair} */
        this._keyPair = keyPair;
        /** @type {Address} */
        this.address = this._keyPair.publicKey.toAddress();
        this.userFriendlyAddress = this.address.toUserFriendlyAddress();
        this.type = type;
        this.label = label;
    }

    static _isTransaction() {
        // todo implement
    }

    /** Sign a generic message */
    sign(message) {
        if (this._isTransaction(message)) {
            this.createTransaction(message);
        } else {
           return Nimiq.Signature.create(this._keyPair.privateKey, this._keyPair.publicKey, message);
        }
    }

    /**
     * Sign Transaction that is signed by the owner of this Key
     * @param {Address} recipient Address of the transaction receiver
     * @param {number} value Number of Satoshis to send.
     * @param {number} fee Number of Satoshis to donate to the Miner.
     * @param {number} validityStartHeight The validityStartHeight for the transaction.
     * @param {string} format basic or extended
     * @returns {Transaction} A prepared and signed Transaction object. This still has to be sent to the network.
     */
    async createTransaction(recipient, value, fee, validityStartHeight, format) {
        if (typeof recipient === 'string') {
            recipient = await Key.getUnfriendlyAddress(recipient);
        }

        if (format === 'basic') {
            const transaction = new Nimiq.BasicTransaction(this._keyPair.publicKey, recipient, value, fee, validityStartHeight);
            transaction.signature = Nimiq.Signature.create(this._keyPair.privateKey, this._keyPair.publicKey, transaction.serializeContent());
            return transaction;
        }

        // todo extended transactions
    }

    /**
     * Sign a transaction by the owner of this Wallet.
     * @param {Transaction} transaction The transaction to sign.
     * @returns {SignatureProof} A signature proof for this transaction.
     */
    signTransaction(transaction) {
        const signature = Nimiq.Signature.create(this._keyPair.privateKey, this._keyPair.publicKey, transaction.serializeContent());
        return Nimiq.SignatureProof.singleSig(this._keyPair.publicKey, signature);
    }

    /**
     * @param {Uint8Array|string} passphrase
     * @param {Uint8Array|string} [pin]
     * @return {Promise.<Uint8Array>}
     */
    exportEncrypted(passphrase, pin) {
        if (typeof passphrase === 'string') passphrase = Nimiq.BufferUtils.fromAscii(passphrase);
        if (typeof pin === 'string') pin = Nimiq.BufferUtils.fromAscii(pin);
        return this._keyPair.exportEncrypted(passphrase, pin);
    }

    /**
     * @returns {Uint8Array}
     */
    exportPlain() {
        return this._keyPair.serialize();
    }

    /** @type {boolean} */
    get isLocked() {
        return this.keyPair.isLocked;
    }

    /**
     * @param {Uint8Array|string} key
     * @returns {Promise.<void>}
     */
    lock(key) {
        if (typeof key === 'string') key = Nimiq.BufferUtils.fromAscii(key);
        return this.keyPair.lock(key);
    }

    relock() {
        this.keyPair.relock();
    }

    /**
     * @param {Uint8Array|string} key
     * @returns {Promise.<void>}
     */
    unlock(key) {
        if (typeof key === 'string') key = Nimiq.BufferUtils.fromAscii(key);
        return this.keyPair.unlock(key);
    }

    /**
     * @param {Key} o
     * @return {boolean}
     */
    equals(o) {
        return o instanceof Key && this.keyPair.equals(o.keyPair) && this.address.equals(o.address);
    }

    /**
     * @returns {object}
     */
    getPublicInfo() {
        return {
            address: this.userFriendlyAddress,
            type: this.type,
            label: this.label
        }
    }

    /**
     * The public key of the Key owner
     * @type {PublicKey}
     */
    get publicKey() {
        return this._keyPair.publicKey;
    }

    /** @type {KeyPair} */
    get keyPair() {
        return this._keyPair;
    }

}
