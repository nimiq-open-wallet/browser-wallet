import Reflection from '/libraries/secure-utils/reflection/reflection.js';
import Random from '/libraries/secure-utils/random/random.js';

export default class RPC {
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
            }, 10000);

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
     * @param {Class} clazz: The class whose methods will be made available via postMessage RPC
     * @param {boolean} useAccessControl: If set, message.source and message.origin will be passed as first two arguments to each method.
     * @return {T extends clazz}
     */
    static Server(clazz, useAccessControl) {
        return new (RPC._Server(clazz, useAccessControl))();
    }

    static _Server(clazz, useAccessControl) {
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

        // Collect function names of the Server's interface
        Server.prototype._rpcInterface = [];
        for (const functionName of Reflection.userFunctions(clazz.prototype)) {
            Server.prototype._rpcInterface.push(functionName);
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
