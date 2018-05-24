import ValidationUtils from '/libraries/secure-utils/validation-utils/validation-utils.js';

export default class NanoApi {

    static get API_URL() { return 'https://cdn.nimiq-network.com/branches/master/nimiq.js' }
    static get satoshis() { return 1e5 }

    static getApi() {
        this._api = this._api || new NanoApi();
        return this._api;
    }

    constructor() {
        this._apiInitialized = new Promise(async (resolve, reject)=> {
            await NanoApi._importApi();
            this.$ = {}
            Nimiq.init(async $ => {
                try {
                    await this._onApiReady();
                    resolve();
                } catch(e) {
                    console.error(e);
                    this.onInitializationError(e);
                }
            }, e => {
                this.onDifferentTabError(e);
            });
        });
    }

    async _onApiReady() {
        await Nimiq.Crypto.prepareSyncCryptoWorker();
        this.onInitialized();
    }

    async loadWallet() {
        if(!this.$.wallet) {
            if(!this.$.walletStore) this.$.walletStore = await new Nimiq.WalletStore();
            this.$.wallet = await this.$.walletStore.getDefault();
            this.onAddressChanged(this.address);
        }
    }

    async connect() {
        await this._apiInitialized;
        // TODO: Make GenesisConfig configurable
        Nimiq.GenesisConfig.dev();
        this.$.consensus = await Nimiq.Consensus.volatileNano();
        this.$.consensus.on('established', e => this._onConsensusEstablished());
        this.$.consensus.network.connect();
        this.$.consensus.blockchain.on('head-changed', e => this._headChanged());
        this.$.consensus.mempool.on('transaction-added', tx => this._transactionAdded(tx));
    }

    async _headChanged() {
        await this._apiInitialized;
        if (!this.$.consensus.established) return;
        const balance = await this._getBalance();
        if (this._balance === balance) return;
        this._balance = balance;
        this.onBalanceChanged(this.balance);
    }

    async _getAccount() {
        await this._apiInitialized;
        await this.loadWallet();
        const account = await this.$.consensus.getAccount(this.$.wallet.address);
        return account || { balance: 0 }
    }

    async _getBalance() {
        await this._apiInitialized;
        const account = await this._getAccount();
        return account.balance;
    }

    _onConsensusEstablished() {
        this._headChanged();
        this.onConsensusEstablished();
    }

    _transactionAdded(tx) {
        if (!tx.recipient.equals(this.$.wallet.address)) return;
        const sender = tx.senderPubKey.toAddress();
        this.onTransactionReceived(sender.toUserFriendlyAddress(), tx.value / NanoApi.satoshis, tx.fee);
    }

    /*
        Public API
    */
    async sendTransaction(recipient, value, fee = 0) {
        await this._apiInitialized;
        const recipientAddr = Nimiq.Address.fromUserFriendlyAddress(recipient);
        value = Math.round(Number(value) * NanoApi.satoshis);
        fee = Math.round(Number(fee) * NanoApi.satoshis);
        const tx = this.$.wallet.createTransaction(recipientAddr, value, fee, this.$.consensus.blockchain.height);
        return this.$.consensus.relayTransaction(tx);
    }

    async getAddress() {
        await this._apiInitialized;
        await this.loadWallet();
        return this.address;
    }

    async getBalance() {
        await this._apiInitialized;
        return this.balance;
    }

    get address() {
        return this.$.wallet.address.toUserFriendlyAddress();
    }

    get balance() {
        return (this._balance / NanoApi.satoshis) || 0;
    }

    /**
     *
     *
     *
     * @return {Object} An object containing `privateKey` in native format and `address` in user-friendly format.
     */
    async generateKeyPair() {
        await this._apiInitialized;
        const keys = Nimiq.KeyPair.generate();
        const privKey = keys.privateKey
        const address = keys.publicKey.toAddress();
        return {
            privateKey: privKey,
            address: address.toUserFriendlyAddress()
        }
    }

    async importKey(privateKey, persist = true) {
        await this._apiInitialized;
        if(typeof privateKey ===  "string") {
            privateKey = Nimiq.PrivateKey.unserialize(Nimiq.BufferUtils.fromHex(privateKey));
        }
        const keyPair = Nimiq.KeyPair.fromPrivateKey(privateKey);
        this.$.wallet = new Nimiq.Wallet(keyPair);
        if (persist) {
            if(!this.$.walletStore) this.$.walletStore = await new Nimiq.WalletStore();
            await this.$.walletStore.put(this.$.wallet);
        }
        return this.address;
    }

    async exportKey() {
        await this._apiInitialized;
        return this.$.wallet.keyPair.privateKey.toHex();
    }

    async lockWallet(pin) {
        await this._apiInitialized;
        return this.$.wallet.lock(pin);
    }

    async unlockWallet(pin) {
        await this._apiInitialized;
        return this.$.wallet.unlock(pin);
    }

    async importEncrypted(encryptedKey, password, persist = true) {
        await this._apiInitialized;
        encryptedKey = Nimiq.BufferUtils.fromBase64(encryptedKey);
        this.$.wallet = await Nimiq.Wallet.loadEncrypted(encryptedKey, password);
        if (persist) {
            if(!this.$.walletStore) this.$.walletStore = await new Nimiq.WalletStore();
            await this.$.walletStore.put(this.$.wallet);
        }
        return this.address;
    }

    async exportEncrypted(password) {
        await this._apiInitialized;
        const exportedWallet = await this.$.wallet.exportEncrypted(password);
        return Nimiq.BufferUtils.toBase64(exportedWallet);
    }

    /** @param {string | Nimiq.Address} address
     * @return {Promise<string>} */
    async nim2ethAddress(address) {
        await this._apiInitialized;
        const addressObj = (typeof address  === 'string') ? await this.getUnfriendlyAddress(address) : address;
        const hash = await Nimiq.Hash.sha256(addressObj.serialize());
        return '0x' + Nimiq.BufferUtils.toHex(hash.subarray(0, 20));
    }

    /** @param {string} friendlyAddress */
    async getUnfriendlyAddress(friendlyAddress) {
        await this._apiInitialized;
        return Nimiq.Address.fromUserFriendlyAddress(friendlyAddress);
    }

    onInitialized() {
        console.log('Nimiq API ready to use');
        this.fire('nimiq-api-ready');
    }

    onAddressChanged(address) {
        console.log('address changed:', address);
        this.fire('nimiq-account', address);
    }

    onConsensusEstablished() {
        console.log('consensus established');
        this.fire('nimiq-consensus-established'/*, this.address*/);
    }

    onBalanceChanged(balance) {
        console.log('new balance:', balance);
        this.fire('nimiq-balance', balance);
    }

    onTransactionReceived(sender, value, fee) {
        console.log('received:', value, 'from:', sender, 'txfee:', fee);
        this.fire('nimiq-transaction', { sender: sender, value: value, fee: fee });
    }

    onDifferentTabError() {
        console.log('Nimiq API is already running in a different tab');
        this.fire('nimiq-different-tab-error');
    }

    onInitializationError() {
        console.log('Nimiq API could not be initialized.');
        this.fire('nimiq-api-fail');
    }

    static formatValue(number, decimals = 3, thousandsSeparator = '\'') {
        number = Number(number)
        decimals = Math.pow(10, decimals);
        return this._formatThousands(Math.round(number * decimals) / decimals, thousandsSeparator);
    }

    // FIXME: formatValueInDollar() is in the wrong place and done wrong
    // static formatValueInDollar(number) {
    //     number = Number(number)
    //     return this.formatValue(number * 0.05, 2);
    // }

    static _formatThousands(number, separator) {
        number = number.toString().split('.');
        var whole = number[0];
        var decimals = number[1];
        var reversed = whole.split('').reverse();
        for(var i = 3; i < reversed.length; i += 4) {
            reversed.splice(i, 0, separator);
        }
        return reversed.reverse().join('') + (decimals ? '.' + decimals : '');
    }

    static validateAddress(address) {
        return ValidationUtils.isValidAddress(address);
    }

    static isValidHash(hash) {
        return ValidationUtils.isValidHash(hash);
    }

    static _importApi() {
        return new Promise((resolve, reject) => {
            let script = document.createElement('script');
            script.type = 'text/javascript';
            script.src = NanoApi.API_URL;
            script.addEventListener('load', () => resolve(script), false);
            script.addEventListener('error', () => reject(script), false);
            document.body.appendChild(script);
        });
    }

    setXElement(xElement) {
       this._xElement = xElement;
       this.fire = this._xElement.fire.bind(xElement);
    }

    // Copied from x-element.
    fire(eventType, detail = null, bubbles = true) { // Fire DOM-Event
        const params = { detail: detail, bubbles: bubbles };
        document.body.dispatchEvent(new CustomEvent(eventType, params));
    }
}