(function () {
'use strict';

class Reflection {
    /** @param {Object} proto
     *
     * @returns {Set<string>}
     */
    static userFunctions(proto) {
        return new Set(Reflection._deepFunctions(proto).filter(name => {
            return name !== 'constructor'
                && name !== 'fire'
                && name[0] !== '_';
        }));
    }

    /** @param {Object} proto
     *
     * @returns {string[]}
     */
    static _deepFunctions(proto) {
        if (!proto || proto === Object.prototype) return [];

        const ownProps = Object.getOwnPropertyNames(proto);

        const ownFunctions = ownProps.filter(name => {
            const desc = Object.getOwnPropertyDescriptor(proto, name);
            return !!desc && typeof desc.value === 'function';
        });

        const deepFunctions = Reflection._deepFunctions(Object.getPrototypeOf(proto));

        return [...ownFunctions, ...deepFunctions];
    }
}

class Random {
    static getRandomId() {
        let array = new Uint32Array(1);
        crypto.getRandomValues(array);
        return array[0];
    }

    static pickRandom(array = []) {
        if (array.length < 1) return null;
        return array[Math.floor(Math.random() * array.length)];
    }
}

class RPC {
    /**
     * @param {Window} targetWindow
     * @param {string} interfaceName
     * @param {string} [targetOrigin]
     * @returns {Promise}
     */
    static async Client(targetWindow, interfaceName, targetOrigin = '*') {
        return new Promise((resolve, reject) => {
            let connected = false;

            const interfaceListener = (message) => {
                if (message.source !== targetWindow
                    || message.data.status !== 'OK'
                    || message.data.interfaceName !== interfaceName
                    || (targetOrigin !== '*' && message.origin !== targetOrigin)) return;

                self.removeEventListener('message', interfaceListener);

                connected = true;

                resolve( new (RPC._Client(targetWindow, targetOrigin, interfaceName, message.data.result))() );
            };

            self.addEventListener('message', interfaceListener);


            let connectTimer;
            const timeoutTimer = setTimeout(() => {
                reject(new Error('Connection timeout'));
                clearTimeout(connectTimer);
            }, 30000);

            const tryToConnect = () => {
                if (connected) {
                    clearTimeout(timeoutTimer);
                    return;
                }

                try {
                    targetWindow.postMessage({ command: 'getRpcInterface', interfaceName, id: 0 }, targetOrigin);
                } catch (e){
                    console.log('postMessage failed:' + e);
                }
                connectTimer = setTimeout(tryToConnect, 1000);
            };

            connectTimer = setTimeout(tryToConnect, 100);
        });
    }


    /**
     * @param {Window} targetWindow
     * @param {string} interfaceName
     * @param {array} functionNames
     * @returns {Class}
     * @private
     */
    static _Client(targetWindow, targetOrigin, interfaceName, functionNames) {
        const Client = class {
            constructor() {
                this.availableMethods = functionNames;
                // Svub: Code smell that _targetWindow and _waiting are visible outside. Todo later!
                /** @private
                 *  @type {Window} */
                this._targetWindow = targetWindow;
                this._targetOrigin = targetOrigin;
                /** @private
                 *  @type {Map.<number,{resolve:Function,error:Function}>} */
                this._waiting = new Map();
                self.addEventListener('message', this._receive.bind(this));
            }

            close() {
                self.removeEventListener('message', this._receive.bind(this));
            }

            _receive({ source, origin, data }) {
                // Discard all messages from unwanted sources
                // or which are not replies
                // or which are not from the correct interface
                if (source !== this._targetWindow
                    || !data.status
                    || data.interfaceName !== interfaceName
                    || (this._targetOrigin !== '*' && origin !== this._targetOrigin)) return;

                const callback = this._waiting.get(data.id);

                if (!callback) {
                    console.log('Unknown reply', data);
                } else {
                    this._waiting.delete(data.id);

                    if (data.status === 'OK') {
                        callback.resolve(data.result);
                    } else if (data.status === 'error') {
                        const { message, stack, code } = data.result;
                        const error = new Error(message);
                        error.code = code;
                        error.stack = stack;
                        callback.error(error);
                    }
                }
            }

            /**
             * @param {string} command
             * @param {object[]} [args]
             * @returns {Promise}
             * @private
             */
            _invoke(command, args = []) {
                return new Promise((resolve, error) => {
                    const obj = { command, interfaceName, args, id: Random.getRandomId() };
                    this._waiting.set(obj.id, { resolve, error });
                    this._targetWindow.postMessage(obj, '*');
                    // no timeout for now, as some actions require user interactions
                    // todo maybe set timeout via parameter?
                    //setTimeout(() => error(new Error ('request timeout')), 10000);
                });
            }
        };

        for (const functionName of functionNames) {
            Client.prototype[functionName] = function (...args) {
                return this._invoke(functionName, args);
            };
        }

        return Client;
    }

    /**
     * @param {Class} clazz The class whose methods will be made available via postMessage RPC
     * @param {boolean} [useAccessControl] If set, an object containing callingWindow and callingOrigin will be passed as first arguments to each method
     * @param {string[]} [rpcInterface] A whitelist of function names that are made available by the server
     * @return {T extends clazz}
     */
    static Server(clazz, useAccessControl, rpcInterface) {
        return new (RPC._Server(clazz, useAccessControl, rpcInterface))();
    }

    static _Server(clazz, useAccessControl, rpcInterface) {
        const Server = class extends clazz {
            constructor() {
                super();
                this._name = Server.prototype.__proto__.constructor.name;
                self.addEventListener('message', this._receive.bind(this));
            }

            close() {
                self.removeEventListener('message', this._receive.bind(this));
            }

            _replyTo(message, status, result) {
                message.source.postMessage({ status, result, interfaceName: this._name, id: message.data.id }, message.origin);
            }

            _receive(message) {
                try {
                    if (message.data.interfaceName !== this._name) return;
                    if (!this._rpcInterface.includes(message.data.command)) throw new Error('Unknown command');

                    let args = message.data.args || [];

                    if (useAccessControl && message.data.command !== 'getRpcInterface') {
                        // Inject calling origin to function args
                        args = [{ callingWindow: message.source, callingOrigin: message.origin }, ...args];
                    }

                    /* deactivate this since there is no security issue and by wrapping in acl length info gets lost
                    // Test if request calls an existing method with the right number of arguments
                    const calledMethod = this[message.data.command];
                    if (!calledMethod) {
                        throw `Non-existing method ${message.data.command} called: ${message}`;
                    }

                    if (calledMethod.length < args.length) {
                        throw `Too many arguments passed: ${message}`;
                    }*/

                    const result = this._invoke(message.data.command, args);

                    if (result instanceof Promise) {
                        result
                            .then((finalResult) => this._replyTo(message, 'OK', finalResult))
                            .catch(e => this._replyTo(message, 'error',
                                e.message ? { message: e.message, stack: e.stack, code: e.code } : { message: e } ));
                    } else {
                        this._replyTo(message, 'OK', result);
                    }
                } catch (e) {
                    this._replyTo(message, 'error',
                        e.message ? { message: e.message, stack: e.stack, code: e.code } : { message: e } );
                }
            }

            _invoke(command, args) {
                return this[command].apply(this, args);
            }
        };

        if (rpcInterface !== undefined) {
            Server.prototype._rpcInterface = rpcInterface;
        } else {
            console.warn('No function whitelist as third parameter to Server() found, public functions are automatically determined!');

            // Collect function names of the Server's interface
            Server.prototype._rpcInterface = [];
            for (const functionName of Reflection.userFunctions(clazz.prototype)) {
                Server.prototype._rpcInterface.push(functionName);
            }
        }

        Server.prototype._rpcInterface.push('getRpcInterface');

        // Add function to retrieve the interface
        Server.prototype['getRpcInterface'] = function() {
            if(this.onConnected) this.onConnected.call(this);
            return Server.prototype._rpcInterface;
        };

        return Server;
    }
}

// TODO: Handle unload/load events (how?)

class EventServer {
    constructor() {
        this._listeners = new Map();
        const that = this;
        RPC.Server(class EventRPCServer {
            on({ callingWindow, callingOrigin }, event) {
                if (!that._listeners.get(event)) {
                    that._listeners.set(event, new Map());
                }
                that._listeners.get(event).set(callingWindow, callingOrigin);
            }

            off({ callingWindow, callingOrigin }, event) {
                const eventEntry = that._listeners.get(event);
                if (eventEntry.get(callingWindow) !== callingOrigin) return;

                eventEntry.delete(callingWindow);
                if (that._listeners.get(event).length === 0) {
                    that._listeners.delete(event);
                }
            }

            onConnected() {
                that.onConnected();
            }
        }, true, ['on', 'off']);
    }

    fire(event, value) {
        if (!this._listeners.get(event)) return;

        for (const [callingWindow, callingOrigin] of this._listeners.get(event)) {
            callingWindow.postMessage({event, value}, callingOrigin);
        }
    }

    onConnected() { }
}

/**
 * Functions taken from https://github.com/google/closure-library/blob/master/closure/goog/crypt/crypt.js
 */
class Utf8Tools {

    /**
     * @param {string} str
     * @returns {Uint8Array}
     */
    static stringToUtf8ByteArray(str) {
        // TODO: Use native implementations if/when available
        var out = [], p = 0;
        for (var i = 0; i < str.length; i++) {
            var c = str.charCodeAt(i);
            if (c < 128) {
                out[p++] = c;
            } else if (c < 2048) {
                out[p++] = (c >> 6) | 192;
                out[p++] = (c & 63) | 128;
            } else if (
            ((c & 0xFC00) == 0xD800) && (i + 1) < str.length &&
            ((str.charCodeAt(i + 1) & 0xFC00) == 0xDC00)) {
                // Surrogate Pair
                c = 0x10000 + ((c & 0x03FF) << 10) + (str.charCodeAt(++i) & 0x03FF);
                out[p++] = (c >> 18) | 240;
                out[p++] = ((c >> 12) & 63) | 128;
                out[p++] = ((c >> 6) & 63) | 128;
                out[p++] = (c & 63) | 128;
            } else {
                out[p++] = (c >> 12) | 224;
                out[p++] = ((c >> 6) & 63) | 128;
                out[p++] = (c & 63) | 128;
            }
        }
        return new Uint8Array(out);
    }

    /**
     * @param {Uint8Array} bytes
     * @returns {string}
     */
    static utf8ByteArrayToString(bytes) {
        // TODO: Use native implementations if/when available
        var out = [], pos = 0, c = 0;
        while (pos < bytes.length) {
            var c1 = bytes[pos++];
            if (c1 < 128) {
                out[c++] = String.fromCharCode(c1);
            } else if (c1 > 191 && c1 < 224) {
                var c2 = bytes[pos++];
                out[c++] = String.fromCharCode((c1 & 31) << 6 | c2 & 63);
            } else if (c1 > 239 && c1 < 365) {
                // Surrogate Pair
                var c2 = bytes[pos++];
                var c3 = bytes[pos++];
                var c4 = bytes[pos++];
                var u = ((c1 & 7) << 18 | (c2 & 63) << 12 | (c3 & 63) << 6 | c4 & 63) - 0x10000;
                out[c++] = String.fromCharCode(0xD800 + (u >> 10));
                out[c++] = String.fromCharCode(0xDC00 + (u & 1023));
            } else {
                var c2 = bytes[pos++];
                var c3 = bytes[pos++];
                out[c++] =
                String.fromCharCode((c1 & 15) << 12 | (c2 & 63) << 6 | c3 & 63);
            }
        }
        return out.join('');
    }
}

var NanoNetworkApi = (Config) => class NanoNetworkApi {

    static get API_URL() { return Config.cdn }

    static getApi() {
        this._api = this._api || new NanoNetworkApi();
        return this._api;
    }

    constructor() {
        this._apiInitialized = new Promise(async (resolve) => {
            await NanoNetworkApi._importApi();
            await Nimiq.load();
            // setTimeout(resolve, 500);
            resolve();
        });
        this._createConsensusPromise();

        this._selfRelayedTransactionHashes = new Set();

        this._balances = new Map();
    }

    async connect() {
        await this._apiInitialized;

        Nimiq.GenesisConfig[Config.network]();

        this._consensus = await Nimiq.Consensus.volatileNano();
        this._consensus.on('syncing', e => this._onConsensusSyncing());
        this._consensus.on('established', e => this.__consensusEstablished());
        this._consensus.on('lost', e => this._consensusLost());

        this._consensus.on('transaction-relayed', tx => this._transactionRelayed(tx));

        // this._consensus.on('sync-finished', e => console.log('consensus sync-finished'));
        // this._consensus.on('sync-failed', e => console.log('consensus sync-failed'));
        // this._consensus.on('sync-chain-proof', e => console.log('consensus sync-chain-proof'));
        // this._consensus.on('verify-chain-proof', e => console.log('consensus verify-chain-proof'));

        this._consensus.network.connect();

        this._consensus.blockchain.on('head-changed', block => this._headChanged(block.header));
        this._consensus.mempool.on('transaction-added', tx => this._transactionAdded(tx));
        this._consensus.mempool.on('transaction-expired', tx => this._transactionExpired(tx));
        this._consensus.mempool.on('transaction-mined', (tx, header) => this._transactionMined(tx, header));
        this._consensus.network.on('peers-changed', () => this._onPeersChanged());
    }

    async _headChanged(header) {
        if (!this._consensus.established) return;
        this._recheckBalances();
        this._onHeadChange(header);
    }

    /**
     * @returns {Array<Account>} An array element can be NULL if account does not exist
     */
    async _getAccounts(addresses, stackHeight) {
        if (addresses.length === 0) return [];
        await this._consensusEstablished;
        let accounts;
        const addressesAsAddresses = addresses.map(address => Nimiq.Address.fromUserFriendlyAddress(address));
        try {
            accounts = await this._consensus.getAccounts(addressesAsAddresses);
        } catch (e) {
            stackHeight = stackHeight || 0;
            stackHeight++;
            return await new Promise(resolve => {
                const timeout = 1000 * stackHeight;
                setTimeout(async _ => {
                    resolve(await this._getAccounts(addresses, stackHeight));
                }, timeout);
                console.warn(`Could not retrieve accounts from consensus, retrying in ${timeout / 1000} s`);
            });
        }

        return accounts;
    }

    /**
     * @param {Array<string>} addresses
     */
    async _subscribeAddresses(addresses) {
        const addressesAsAddresses = addresses.map(address => Nimiq.Address.fromUserFriendlyAddress(address));
        await this._consensusEstablished;
        this._consensus.subscribeAccounts(addressesAsAddresses);
    }

    /**
     * @param {Array<string>} addresses
     * @returns {Map}
     */
    async _getBalances(addresses) {
        let accounts = await this._getAccounts(addresses);

        const balances = new Map();

        accounts.forEach((account, i) => {
            const address = addresses[i];
            const balance = account ? Nimiq.Policy.satoshisToCoins(account.balance) : 0;
            balances.set(address, balance);
        });

        return balances;
    }

    /**
     * @param {string} address
     * @param {Map} [knownReceipts] A map with the tx hash as key and the blockhash as value
     * @param {uint} [fromHeight]
     */
    async _requestTransactionHistory(address, knownReceipts = new Map(), fromHeight = 0) {
        await this._consensusEstablished;
        address = Nimiq.Address.fromUserFriendlyAddress(address);

        // Inpired by Nimiq.BaseConsensus._requestTransactionHistory()

        // 1. Get transaction receipts.
        let receipts;
        let retryCounter = 1;
        while (!(receipts instanceof Array)) {
            // Return after the 3rd try
            if (retryCounter >= 4) return {
                transactions: [],
                removedTxHashes: []
            };

            try {
                receipts = await this._consensus._requestTransactionReceipts(address);
                //console.log(`Received ${receipts.length} receipts from the network.`);
            } catch(e) {
                await new Promise(res => setTimeout(res, 1000)); // wait 1 sec until retry
            }

            retryCounter++;
        }

        // 2 Filter out known receipts.
        const knownTxHashes = [...knownReceipts.keys()];
        const receiptTxHashes = receipts.map(r => r.transactionHash.toBase64());

        const removedTxHashes = knownTxHashes.filter(knownTxHash => !receiptTxHashes.includes(knownTxHash));

        receipts = receipts.filter(receipt => {
            if (receipt.blockHeight < fromHeight) return false;

            const hash = receipt.transactionHash.toBase64();

            // Known transaction
            if (knownTxHashes.includes(hash)) {
                // Check if block has changed
                return receipt.blockHash.toBase64() !== knownReceipts.get(hash);
            }

            // Unknown transaction
            return true;
        })
        // Sort in reverse, to resolve recent transactions first
        .sort((a, b) => b.blockHeight - a.blockHeight);

        // console.log(`Reduced to ${receipts.length} unknown receipts.`);

        const unresolvedReceipts = [];

        // 3. Request proofs for missing blocks.
        /** @type {Array.<Promise.<Block>>} */
        const blockRequests = [];
        let lastBlockHash = null;
        for (const receipt of receipts) {
            if (!receipt.blockHash.equals(lastBlockHash)) {
                // eslint-disable-next-line no-await-in-loop
                const block = await this._consensus._blockchain.getBlock(receipt.blockHash);
                if (block) {
                    blockRequests.push(Promise.resolve(block));
                } else {
                    const request = this._consensus._requestBlockProof(receipt.blockHash, receipt.blockHeight)
                        .catch(e => {
                            unresolvedReceipts.push(receipt);
                            console.error(NanoNetworkApi, `Failed to retrieve proof for block ${receipt.blockHash}`
                                + ` (${e}) - transaction history may be incomplete`);
                        });
                    blockRequests.push(request);
                }

                lastBlockHash = receipt.blockHash;
            }
        }
        const blocks = await Promise.all(blockRequests);

        // console.log(`Transactions are in ${blocks.length} blocks`);
        // if (unresolvedReceipts.length) console.log(`Could not get block for ${unresolvedReceipts.length} receipts`);

        // 4. Request transaction proofs.
        const transactionRequests = [];
        for (const block of blocks) {
            if (!block) continue;

            const request = this._consensus._requestTransactionsProof([address], block)
                .then(txs => txs.map(tx => ({ transaction: tx, header: block.header })))
                .catch(e => console.error(NanoNetworkApi, `Failed to retrieve transactions for block ${block.hash()}`
                    + ` (${e}) - transaction history may be incomplete`));
            transactionRequests.push(request);
        }

        const transactions = await Promise.all(transactionRequests);

        // Reverse array, so that oldest transactions are first
        transactions.reverse();
        unresolvedReceipts.reverse();

        return {
            transactions: transactions
                .reduce((flat, it) => it ? flat.concat(it) : flat, [])
                .sort((a, b) => a.header.height - b.header.height),
            removedTxHashes,
            unresolvedReceipts
        };
    }

    __consensusEstablished() {
        this._consensusEstablishedResolver();
        this._headChanged(this._consensus.blockchain.head);
        this._onConsensusEstablished();
    }

    _consensusLost() {
        this._createConsensusPromise();
        this._onConsensusLost();
    }

    _transactionAdded(tx) {
        // Self-relayed transactions are added by the 'transaction-requested' event
        const hash = tx.hash().toBase64();
        if (this._selfRelayedTransactionHashes.has(hash)) return;

        const senderAddr = tx.sender.toUserFriendlyAddress();
        const recipientAddr = tx.recipient.toUserFriendlyAddress();

        // Handle tx amount when the sender is own account
        this._balances.has(senderAddr) && this._recheckBalances(senderAddr);

        this._onTransactionPending(senderAddr, recipientAddr, Nimiq.Policy.satoshisToCoins(tx.value), Nimiq.Policy.satoshisToCoins(tx.fee), Utf8Tools.utf8ByteArrayToString(tx.data), hash, tx.validityStartHeight);
    }

    _transactionExpired(tx) {
        const senderAddr = tx.sender.toUserFriendlyAddress();

        // Handle tx amount when the sender is own account
        this._balances.has(senderAddr) && this._recheckBalances(senderAddr);

        this._onTransactionExpired(tx.hash().toBase64());
    }

    _transactionMined(tx, header) {
        const senderAddr = tx.sender.toUserFriendlyAddress();
        const recipientAddr = tx.recipient.toUserFriendlyAddress();

        // Handle tx amount when the sender is own account
        this._balances.has(senderAddr) && this._recheckBalances(senderAddr);

        this._onTransactionMined(senderAddr, recipientAddr, Nimiq.Policy.satoshisToCoins(tx.value), Nimiq.Policy.satoshisToCoins(tx.fee), Utf8Tools.utf8ByteArrayToString(tx.data), tx.hash().toBase64(), header.height, header.timestamp, tx.validityStartHeight);
    }

    _transactionRelayed(tx) {
        const senderAddr = tx.sender.toUserFriendlyAddress();
        const recipientAddr = tx.recipient.toUserFriendlyAddress();

        // Handle tx amount when the sender is own account
        this._balances.has(senderAddr) && this._recheckBalances(senderAddr);

        this._onTransactionRelayed(senderAddr, recipientAddr, Nimiq.Policy.satoshisToCoins(tx.value), Nimiq.Policy.satoshisToCoins(tx.fee), Utf8Tools.utf8ByteArrayToString(tx.data), tx.hash().toBase64(), tx.validityStartHeight);
    }

    _createConsensusPromise() {
        this._consensusEstablished = new Promise(resolve => {
            this._consensusEstablishedResolver = resolve;
        });
    }

    _globalHashrate(difficulty) {
        return Math.round(difficulty * Math.pow(2, 16) / Nimiq.Policy.BLOCK_TIME);
    }

    async _recheckBalances(addresses) {
        if (!addresses) addresses = [...this._balances.keys()];
        if (!(addresses instanceof Array)) addresses = [addresses];

        const balances = await this._getBalances(addresses);

        for (let [address, balance] of balances) {
            balance -= this._getPendingAmount(address);

            if (this._balances.get(address) === balance) {
                balances.delete(address);
                continue;
            }

            balances.set(address, balance);
            this._balances.set(address, balance);
        }

        if (balances.size) this._onBalancesChanged(balances);
    }

    _getPendingAmount(address) {
        const txs = this._consensus.mempool.getPendingTransactions(Nimiq.Address.fromUserFriendlyAddress(address));
        const pendingAmount = txs.reduce((acc, tx) => acc + Nimiq.Policy.satoshisToCoins(tx.value + tx.fee), 0);
        return pendingAmount;
    }

    /*
        Public API

        @param {Object} obj: {
            sender: <user friendly address>,
            senderPubKey: <serialized public key>,
            recipient: <user friendly address>,
            value: <value in NIM>,
            fee: <fee in NIM>,
            validityStartHeight: <integer>,
            signature: <serialized signature>
        }
    */
    async relayTransaction(txObj) {
        await this._consensusEstablished;
        let tx;
        if (txObj.extraData && txObj.extraData.length > 0) {
            tx = await this._createExtendedTransactionFromObject(txObj);
        } else {
            tx = await this._createBasicTransactionFromObject(txObj);
        }
        // console.log("Debug: transaction size was:", tx.serializedSize);
        this._selfRelayedTransactionHashes.add(tx.hash().toBase64());
        return this._consensus.relayTransaction(tx);
    }

    async getTransactionSize(txObj) {
        await this._apiInitialized;
        let tx;
        if (txObj.extraData && txObj.extraData.length > 0) {
            tx = await this._createExtendedTransactionFromObject(txObj);
        } else {
            tx = await this._createBasicTransactionFromObject(txObj);
        }
        return tx.serializedSize;
    }

    async _createBasicTransactionFromObject(obj) {
        await this._apiInitialized;
        const senderPubKey = Nimiq.PublicKey.unserialize(new Nimiq.SerialBuffer(obj.senderPubKey));
        const recipientAddr = Nimiq.Address.fromUserFriendlyAddress(obj.recipient);
        const value = Nimiq.Policy.coinsToSatoshis(obj.value);
        const fee = Nimiq.Policy.coinsToSatoshis(obj.fee);
        const validityStartHeight = parseInt(obj.validityStartHeight);
        const signature = Nimiq.Signature.unserialize(new Nimiq.SerialBuffer(obj.signature));

        return new Nimiq.BasicTransaction(senderPubKey, recipientAddr, value, fee, validityStartHeight, signature);
    }

    async _createExtendedTransactionFromObject(obj) {
        await this._apiInitialized;
        const senderPubKey = Nimiq.PublicKey.unserialize(new Nimiq.SerialBuffer(obj.senderPubKey));
        const senderAddr = senderPubKey.toAddress();
        const recipientAddr = Nimiq.Address.fromUserFriendlyAddress(obj.recipient);
        const value = Nimiq.Policy.coinsToSatoshis(obj.value);
        const fee = Nimiq.Policy.coinsToSatoshis(obj.fee);
        const validityStartHeight = parseInt(obj.validityStartHeight);
        const signature = Nimiq.Signature.unserialize(new Nimiq.SerialBuffer(obj.signature));
        const data = Utf8Tools.stringToUtf8ByteArray(obj.extraData);

        const proof = Nimiq.SignatureProof.singleSig(senderPubKey, signature);
        const serializedProof = proof.serialize();

        return new Nimiq.ExtendedTransaction(
            senderAddr,    Nimiq.Account.Type.BASIC,
            recipientAddr, Nimiq.Account.Type.BASIC,
            value,
            fee,
            validityStartHeight,
            Nimiq.Transaction.Flag.NONE,
            data,
            serializedProof
        );
    }

    /**
     * @param {string|Array<string>} addresses
     */
    async subscribe(addresses) {
        if (!(addresses instanceof Array)) addresses = [addresses];
        this._subscribeAddresses(addresses);
        this._recheckBalances(addresses);
    }

    /**
     * @param {string|Array<string>} addresses
     * @returns {Map}
     */
    getBalance(addresses) {
        if (!(addresses instanceof Array)) addresses = [addresses];

        const balances = this._getBalances(addresses);
        for (const [address, balance] of balances) { this._balances.set(address, balance); }

        return balances;
    }

    async getAccountTypeString(address) {
        const account = (await this._getAccounts([address]))[0];

        if (!account) return 'basic';

        // See Nimiq.Account.Type
        switch (account.type) {
            case Nimiq.Account.Type.BASIC: return 'basic';
            case Nimiq.Account.Type.VESTING: return 'vesting';
            case Nimiq.Account.Type.HTLC: return 'htlc';
            default: return false;
        }
    }

    async requestTransactionHistory(addresses, knownReceipts, fromHeight) {
        if (!(addresses instanceof Array)) addresses = [addresses];

        let results = await Promise.all(addresses.map(address => this._requestTransactionHistory(address, knownReceipts.get(address), fromHeight)));

        // txs is an array of objects of arrays, which have the format {transaction: Nimiq.Transaction, header: Nimiq.BlockHeader}
        // We need to reduce this to usable simple tx objects

        // Construct arrays with their relavant information
        let txs = results.map(r => r.transactions);
        let removedTxs = results.map(r => r.removedTxHashes);
        let unresolvedTxs = results.map(r => r.unresolvedReceipts);

        // First, reduce
        txs = txs.reduce((flat, it) => it ? flat.concat(it) : flat, []);
        removedTxs = removedTxs.reduce((flat, it) => it ? flat.concat(it) : flat, []);
        unresolvedTxs = unresolvedTxs.reduce((flat, it) => it ? flat.concat(it) : flat, []);

        // Then map to simple objects
        txs = txs.map(tx => ({
            sender: tx.transaction.sender.toUserFriendlyAddress(),
            recipient: tx.transaction.recipient.toUserFriendlyAddress(),
            value: Nimiq.Policy.satoshisToCoins(tx.transaction.value),
            fee: Nimiq.Policy.satoshisToCoins(tx.transaction.fee),
            extraData: Utf8Tools.utf8ByteArrayToString(tx.transaction.data),
            hash: tx.transaction.hash().toBase64(),
            blockHeight: tx.header.height,
            blockHash: tx.header.hash().toBase64(),
            timestamp: tx.header.timestamp,
            validityStartHeight: tx.validityStartHeight
        }));

        return {
            newTransactions: txs,
            removedTransactions: removedTxs,
            unresolvedTransactions: unresolvedTxs
        };
    }

    async getGenesisVestingContracts() {
        await this._apiInitialized;
        const accounts = [];
        const buf = Nimiq.BufferUtils.fromBase64(Nimiq.GenesisConfig.GENESIS_ACCOUNTS);
        const count = buf.readUint16();
        for (let i = 0; i < count; i++) {
            const address = Nimiq.Address.unserialize(buf);
            const account = Nimiq.Account.unserialize(buf);

            if (account.type === 1) {
                accounts.push({
                    address: address.toUserFriendlyAddress(),
                    // balance: Nimiq.Policy.satoshisToCoins(account.balance),
                    owner: account.owner.toUserFriendlyAddress(),
                    start: account.vestingStart,
                    stepAmount: Nimiq.Policy.satoshisToCoins(account.vestingStepAmount),
                    stepBlocks: account.vestingStepBlocks,
                    totalAmount: Nimiq.Policy.satoshisToCoins(account.vestingTotalAmount)
                });
            }
        }
        return accounts;
    }

    async removeTxFromMempool(txObj) {
        const tx = await this._createBasicTransactionFromObject(txObj);
        this._consensus.mempool.removeTransaction(tx);
    }

    _onInitialized() {
        // console.log('Nimiq API ready to use');
        this.fire('nimiq-api-ready');
    }

    _onConsensusSyncing() {
        // console.log('consensus syncing');
        this.fire('nimiq-consensus-syncing');
    }

    _onConsensusEstablished() {
        // console.log('consensus established');
        this.fire('nimiq-consensus-established');
    }

    _onConsensusLost() {
        // console.log('consensus lost');
        this.fire('nimiq-consensus-lost');
    }

    _onBalancesChanged(balances) {
        // console.log('new balances:', balances);
        this.fire('nimiq-balances', balances);
    }

    _onTransactionPending(sender, recipient, value, fee, extraData, hash, validityStartHeight) {
        // console.log('pending:', { sender, recipient, value, fee, extraData, hash, validityStartHeight });
        this.fire('nimiq-transaction-pending', { sender, recipient, value, fee, extraData, hash, validityStartHeight });
    }

    _onTransactionExpired(hash) {
        // console.log('expired:', hash);
        this.fire('nimiq-transaction-expired', hash);
    }

    _onTransactionMined(sender, recipient, value, fee, extraData, hash, blockHeight, timestamp, validityStartHeight) {
        // console.log('mined:', { sender, recipient, value, fee, extraData, hash, blockHeight, timestamp, validityStartHeight });
        this.fire('nimiq-transaction-mined', { sender, recipient, value, fee, extraData, hash, blockHeight, timestamp, validityStartHeight });
    }

    _onTransactionRelayed(sender, recipient, value, fee, extraData, hash, validityStartHeight) {
        // console.log('relayed:', { sender, recipient, value, fee, extraData, hash, validityStartHeight });
        this.fire('nimiq-transaction-relayed', { sender, recipient, value, fee, extraData, hash, validityStartHeight });
    }

    _onDifferentTabError(e) {
        // console.log('Nimiq API is already running in a different tab:', e);
        this.fire('nimiq-different-tab-error', e);
    }

    _onInitializationError(e) {
        // console.log('Nimiq API could not be initialized:', e);
        this.fire('nimiq-api-fail', e);
    }

    _onHeadChange(header) {
        // console.log('height changed:', height);
        this.fire('nimiq-head-change', {
            height: header.height,
            globalHashrate: this._globalHashrate(header.difficulty)
        });
    }

    _onPeersChanged() {
        // console.log('peers changed:', this._consensus.network.peerCount);
        this.fire('nimiq-peer-count', this._consensus.network.peerCount);
    }

    static _importApi() {
        return new Promise((resolve, reject) => {
            let script = document.createElement('script');
            script.type = 'text/javascript';
            script.src = NanoNetworkApi.API_URL;
            script.addEventListener('load', () => resolve(script), false);
            script.addEventListener('error', () => reject(script), false);
            document.body.appendChild(script);
        });
    }

    fire() {
        throw new Error('The fire() method needs to be overloaded!');
    }
};

class Config {

    /* Public methods */

    static get tld() {
        const tld = window.location.origin.split('.');
        return [tld[tld.length - 2], tld[tld.length - 1]].join('.');
    }

    // sure we want to allow this?
    static set network(network) {
        Config._network = network;
    }

    static get network() {
        if (Config._network) return Config._network;

        if (Config.offlinePackaged) return 'main';

        switch (Config.tld) {
            case 'nimiq.com': return 'main';
            case 'nimiq-testnet.com': return 'test';
            default: return 'test'; // Set this to 'test', 'bounty', or 'dev' for localhost development
        }
    }

    static get cdn() {
        if (Config.offlinePackaged) return Config.src('keyguard') + '/nimiq.js';

        switch (Config.tld) {
            case 'nimiq.com': return 'https://cdn.nimiq.com/nimiq.js';
            default: return 'https://cdn.nimiq-testnet.com/nimiq.js'; // TODO make https://cdn.nimiq.com/nimiq.js the default
        }
    }

    static set devMode(devMode) {
        Config._devMode = devMode;
    }

    static get devMode() {
        if (Config._devMode) return Config._devMode;

        switch (Config.tld) {
            case 'nimiq.com': return false;
            case 'nimiq-testnet.com': return false;
            default: return true;
        }
    }

    static origin(subdomain) {
        return Config._origin(subdomain);
    }

    static src(subdomain) {
        return Config._origin(subdomain, true);
    }

    /* Private methods */

    static _origin(subdomain, withPath) {
        if (location.origin.includes('localhost')) {
            return Config._localhost(subdomain, withPath);
        }

        if (Config.devMode) {
            return Config._localhost(subdomain, withPath, true);
        }

        return `https://${subdomain}.${Config.tld}`;
    }

    static _localhost(subdomain, withPath, ipMode) {
        let path = '';

        if (withPath) {
            if (Config.offlinePackaged) path = '/' + subdomain;
            else {
                switch (subdomain) {
                    case 'keyguard': path = '/libraries/keyguard'; break;
                    case 'network': path = '/libraries/network'; break;
                    case 'safe': path = '/apps/safe'; break;
                }
                if (location.pathname.includes('/dist')) {
                    path += `/deployment-${subdomain}/dist`;
                } else {
                    path += '/src';
                }
            }
        }

        subdomain = Config.offlinePackaged ? '' : subdomain + '.';

        const origin = ipMode ? location.hostname : `${subdomain}localhost`;

        return `${location.protocol}//${origin}${location.port ? `:${location.port}` : ''}${path}`;
    }
}

// Signal if the app should be started in offline mode
Config.offline = navigator.onLine !== undefined && !navigator.onLine;

// When packaged as distributed offline app, subdomains are folder names instead
Config.offlinePackaged = true;

class Network {
    constructor() {
        this.connect();
    }

    async connect() {
        const eventServer = new EventServer();
        const network = RPC.Server(NanoNetworkApi(Config));
        network.fire = (event, value) => eventServer.fire(event, value);

        await network.connect();
    }
}

new Network();

}());
