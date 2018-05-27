(function () {
'use strict';

const isMap = m => m instanceof Map;
const isDate = d => d instanceof Date;
const isEmpty = o => Object.keys(o).length === 0;
const isObject = o => o != null && typeof o === 'object';
const properObject = o => isObject(o) && !o.hasOwnProperty ? Object.assign({}, o, {}) : o;

const diff = (lhs, rhs) => {
  if (lhs === rhs) return {}; // equal return no diff

  if (!isObject(lhs) || !isObject(rhs)) return rhs; // return updated rhs

  if (isMap(rhs)) {
    if (!isMap(lhs)) return rhs;

    const diffMap = new Map();

    for (const [key, value] of rhs) {
      if (!lhs.has(key)) { // new key
        diffMap.set(key, value);
        continue;
      }

      const difference = diff(lhs.get(key), value);
      if (!isObject(difference) || !isEmpty(difference) || isDate(difference) || isMap(difference)) {
        diffMap.set(key, difference);
      }
    }

    // Find deleted keys
    for (const key of lhs.keys()) {
      if (!rhs.has(key)) {
        diffMap.set(key, undefined);
      }
    }

    return diffMap.size ? diffMap : {};
  }
  else if (isMap(lhs)) return rhs;

  const l = properObject(lhs);
  const r = properObject(rhs);

  const deletedValues = Object.keys(l).reduce((acc, key) => {
    return r.hasOwnProperty(key) ? acc : Object.assign({}, acc, { [key]: undefined });
  }, {});

  if (isDate(l) || isDate(r)) {
    if (l.valueOf() == r.valueOf()) return {};
    return r;
  }

  return Object.keys(r).reduce((acc, key) => {
    if (!l.hasOwnProperty(key)) return Object.assign({}, acc, { [key]: r[key] }); // return added r key

    const difference = diff(l[key], r[key]);

    if (isObject(difference) && isEmpty(difference) && !isDate(difference) && !isMap(difference)) return acc; // return no diff

    return Object.assign({}, acc, { [key]: difference }); // return updated key
  }, deletedValues);
};

/*import addedDiff from './added/index.js';
import deletedDiff from './deleted/index.js';
import updatedDiff from './updated/index.js';
import detailedDiff from './detailed/index.js';*/

class XElement {

    static get elementMap() {
        this._elementMap = this._elementMap || new Map();
        return this._elementMap;
    }

    /**
     * Creates an instance of XElement.
     * @param {Element | null} element
     * @memberof XElement
     */
    constructor(element) {
        /** @type {string} */
        this.name = null;
        this._boundListeners = new Map();
        this._properties = {};
        this.__bindDOM(element);
        this.__createChildren();
        this.__bindListeners();

        this.onCreate();
    }

    // abstract method
    onCreate() {}

    styles() { return []; }

    /** @returns{(typeof XElement)[]} */
    children() { return []; }

    /**
     * @param {Element | null} element
     */
    __bindDOM(element) {
        if (element instanceof Element) this.$el = element;
        else this.$el = document.querySelector(this.__tagName);
        this.$el.setAttribute('data-x-initialized', true);
        this.$el.xDebug = this; // get easy access to x-element for debugging. Not for production!
        XElement.elementMap.set(this.$el, this);
        this.__fromHtml();
        this.__bindStyles(this.styles());
    }

    __removeListeners() {
        // remove listeners
        for (const [key, { target, event, listener }] of this._boundListeners) {
            target.removeEventListener(event, listener);
        }
    }

    destroy() {
        this.$el.parentNode.removeChild(this.$el);

        // destroy children
        for (const property of Object.getOwnPropertyNames(this)) {
           if (property.destroy) {
               property.destroy();
           }
        }

        this.__removeListeners();

        XElement.elementMap.delete(this);
    }

    /* Get attributes from DOM element - for use with deconstructors */
    get attributes() {
        const map = {};

        for (let i = 0; i < this.$el.attributes.length; i++) {
            const attribute = this.$el.attributes[i];
            map[XElement.camelize(attribute.name)] = attribute.value || true;
        }

        return map;
    }

    // Get single attribute from DOM element
    attribute(name) { return this.$el.getAttribute(name); }

    /* Get properties as object map */
    get properties() {
        return this._properties;
    }

    /* Overwrite this to listen on property changes */
    _onPropertiesChanged() { }

    /** Set single property and call onPropertyChanged after, if present.
     *
     *  @return {boolean} true if there was a change
     */
    setProperty(key, value) {
        const oldProperty = this._properties[key];
        const delta = diff(oldProperty, value);

        if (!isObject(delta) || Object.keys(delta).length > 0) {
            this._properties[key] = value;
            this._onPropertiesChanged({ [key]: delta });
            return true;
        }

        return false;
    }

    /** Set some propertes and call onPropertyChanged after, if present
     *
     *  @return {boolean} true if there was a change
     */
    setProperties(properties, reset) {
        const oldProperties = this._properties;

        this._properties = Object.assign({},
            reset ? {} : this._properties,
            properties
        );

        const changes = diff(oldProperties, this._properties);

        if (Object.keys(changes).length > 0) {
            this._onPropertiesChanged(changes);
            return true;
        }

        return false;
    }

    __createChildren() { // Create all children recursively
        this.children().forEach(child => this.__createChild(child));
    }

    /**
     * @param {(typeof XElement)} childClass
     */
    __createChild(childClass) {
        const name = childClass.__toChildName();
        const tagName = XElement.__toTagName(childClass.name);
        const foundChildren = this.$$(tagName + ':not([data-x-initialized])');

        if (foundChildren.length < 1) {
            throw new Error(`Child could not be created: No tag found with name ${name}`);
        }

        this[name] = [];
        foundChildren.forEach(c => this[name].push(new childClass(c)));

        // if there is only one child of this kind, unwrap it from the array
        if (this[name].length === 1) this[name] = this[name][0];
    }

    __bindListeners() {
        if (!(this.listeners instanceof Function)) return;
        const listeners = this.listeners();
        for (const key in listeners) {
            if (!listeners[key]) continue;
            let event, selector;
            if (key.includes(' ')) [ event, selector ] = key.split(' ');
            else [ event, selector ] = [ key, undefined ];
            const target = selector ? this.$(selector) : this;

            this._boundListeners.set(key, { target, event, listener: e => {
                const method = listeners[key];
                const event = e;
                const detail = e.detail !== undefined ? e.detail : e;
                // passing detail AND event to enable usecase where detail is set, but the event is required while at
                // the same time being backwards compatible, i.e. "old" callback will just ignore the second parameter.
                if (method instanceof Function) method.call(this, detail, event);
                else this[method](event);
            }});

            if (!target) {
                throw new Error(`Non-existing target with selector ${selector} for event ${event}`);
            }

            target.addEventListener(event, this._boundListeners.get(key).listener);
        }
    }

    /*
     * @static
     * @param {string} str
     * @returns {string}
     */
    static camelize(str) {
        return str.replace(/[_.-](\w|$)/g, function (_,x) {
            return x.toUpperCase();
        });
    }

    /**
     * @static
     * @returns {string}
     */
    static __toChildName() {
        let name = this.name;
        if (name.match(/^X[A-Z][a-z]*/)) name = name.substring(1); // replace XAnyConstructorName -> AnyConstructorName
        return '$' + name[0].toLowerCase() + name.substring(1); // AnyConstructorName -> $anyConstructorName
    }

    /**
     * @returns
     */
    __fromHtml() {
        if (!(this.html instanceof Function)) return;
        const html = this.html().trim();
        const currentChildNodes = [ ...this.$el.childNodes ];
        this.$el.innerHTML = html;
        if (currentChildNodes.length === 0) return;
        const $content = this.$('[data-x-content]');
        if (!$content) return;
        currentChildNodes.forEach(node => $content.appendChild(node));
        $content.removeAttribute('data-x-content');
    }

    static get tagName() {
        return XElement.__toTagName(this.name);
    }

    /**
     * @readonly
     */
    get __tagName() { // The tagName of this DOM-Element
        return this.constructor.tagName;
    }

    /**
     * @static
     * @param {string} name
     * @returns
     */
    static __toTagName(name) {
        return name.split(/(?=[A-Z])/).join('-').toLowerCase(); // AnyConstructorName -> any-constructor-name
    }

    /**
     * @static
     * @returns
     */
    static createElement(attributes = []) {
        const name = XElement.__toTagName(this.name);
        const element = document.createElement(name);
        [...attributes].forEach(([key, value]) => element.setAttribute(XElement.__toTagName(key), value));

        return new this(element);
    }

    /**
     * Find the first match of a selector within this element.
     *
     * @param {string} selector
     * @returns {Element}
     */
    $(selector) { return this.$el.querySelector(selector) } // Query inside of this DOM-Element

    /**
     * Finds all matches of a selector within this element.
     *
     * @param {string} selector
     * @returns {NodeList}
     */
    $$(selector) { return this.$el.querySelectorAll(selector) }

    /**
     * Clear all DOM-Element children
     */
    clear() { while (this.$el.firstChild) this.$el.removeChild(this.$el.firstChild); } //

    /**
     * @param {string} type
     * @param {function} callback
     */
    addEventListener(type, callback) { this.$el.addEventListener(type, callback, false); }

    /**
     * @param {string} type
     * @param {function} callback
     */
    removeEventListener(type, callback) { this.$el.removeEventListener(type, callback, false); }

    /**
     * @param {string} eventType
     * @param {any} [detail=null]
     * @param {boolean} [bubbles=true]
     */
    fire(eventType, detail = null, bubbles = true) { // Fire DOM-Event
        const params = { detail: detail, bubbles: bubbles };
        this.$el.dispatchEvent(new CustomEvent(eventType, params));
    }

    /**
     * @param {string} type
     * @param {function} callback
     * @param {Element | window} $el
     */
    listenOnce(type, callback, $el) {
        const listener = e => {
            $el.removeEventListener(type, listener);
            callback(e);
        };
        $el.addEventListener(type, listener, false);
    }

    /**
     * @param {string} styleClass
     */
    addStyle(styleClass) { this.$el.classList.add(styleClass); }

    /**
     * @param {string} styleClass
     */
    removeStyle(styleClass) { this.$el.classList.remove(styleClass); }

    /**
     * @param {() => string[]} styles
     * @returns
     */
    __bindStyles(styles) {
        if (super.styles) super.__bindStyles(super.styles()); // Bind styles of all parent types recursively
        styles.forEach(style => this.addStyle(style));
    }

    /**
     * @param {string} className
     * @param {Element | string} $el
     * @param {() => void} afterStartCallback
     * @param {() => void} beforeEndCallback
     * @returns
     */
    animate(className, $el, afterStartCallback, beforeEndCallback) {
        return new Promise(resolve => {
            $el = $el || this.$el;
            // 'animiationend' is a native DOM event that fires upon CSS animation completion
            const listener = e => {
                if (e.target !== $el) return;
                if (beforeEndCallback instanceof Function) beforeEndCallback();
                this.stopAnimate(className, $el);
                this.$el.removeEventListener('animationend', listener);
                resolve();
            };
            this.$el.addEventListener('animationend', listener);
            $el.classList.add(className);
            if (afterStartCallback instanceof Function) afterStartCallback();
        })
    }

    /**
     * @param {string} className
     * @param {Element | string} $el
     */
    stopAnimate(className, $el) {
        $el = $el || this.$el;
        $el.classList.remove(className);
    }

    static get(node) {
        return XElement.elementMap.get(node);
    }
}

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

class EventClient {
    /**
     * @param {Window} targetWindow
     * @param {string} [targetOrigin]
     * @returns {object}
     */
    static async create(targetWindow, targetOrigin = '*') {
        const client = new EventClient(targetWindow, targetOrigin);
        client._rpcClient = await RPC.Client(targetWindow, 'EventRPCServer', targetOrigin);
        return client;
    }

    constructor(targetWindow, targetOrigin) {
        this._listeners = new Map();
        this._targetWindow = targetWindow;
        this._targetOrigin = targetOrigin;
        self.addEventListener('message', this._receive.bind(this));
    }

    _receive({origin, data: {event, value}}) {
        // Discard all messages from unwanted origins or which are not events
        if ((this._targetOrigin !== '*' && origin !== this._targetOrigin) || !event) return;

        if (!this._listeners.get(event)) return;

        for (const listener of this._listeners.get(event)) {
            listener(value);
        }
    }

    on(event, callback) {
        if (!this._listeners.get(event)) {
            this._listeners.set(event, new Set());
            this._rpcClient.on(event);
        }

        this._listeners.get(event).add(callback);
    }

    off(event, callback) {
        if (!this._listeners.has(event)) return;

        this._listeners.get(event).delete(callback);

        if (this._listeners.get(event).size === 0) {
            this._listeners.delete(event);
            this._rpcClient.off(event);
        }
    }
}

class BasePolicy {
   constructor() {
      this.name = this.constructor.name;
   }

    equals(otherPolicy) {
        return otherPolicy && this.name === otherPolicy.name;
    }

    serialize() {
        const serialized = {};

        for (const prop in this)
            if (!(this[prop] instanceof Function)) serialized[prop] = this[prop];

        return serialized;
    }

    allows(method, args) {
        throw 'Make your own policy by extending Policy and overwrite me'
    }

    needsUi(method, args) {
        throw 'Make your own policy by extending Policy and overwrite me'
    }
}

const KeyType =  {
    HIGH: 'high',
    LOW: 'low'
};

class WalletPolicy extends BasePolicy {
    constructor(limit) {
        super('wallet');
        this.limit = limit;
    }

    equals(otherPolicy) {
        return super.equals(otherPolicy) && this.limit === otherPolicy.limit;
    }

    allows(method, args, state) {
        switch (method) {
            case 'triggerImport':
            case 'persist':
            case 'list':
            case 'createWallet':
                return true;
            case 'sign':
                const { accountNumber, recipient, value, fee } = args;
                const key = state.keys.get(accountNumber);
                if (key && key.type === KeyType.LOW) return true;
                return false;
            default:
                throw new Error(`Unhandled method: ${method}`);
        }
    }

    needsUi(method, args, state) {
        switch (method) {
            case 'triggerImport':
            case 'persist':
            case 'list':
            case 'createVolatile':
                return false;
            case 'sign':
            case 'createWallet':
                return false;
            default:
                throw new Error(`Unhandled method: ${method}`);
        }
    }
}

// todo update

class MinerPolicy extends BasePolicy {
    allows(method, args, state) {
        switch (method) {
            case 'list':
            case 'getMinerAccount':
            case 'createWallet':
                return true;
            default:
                throw new Error(`Unhandled method: ${method}`);
        }
    }

    needsUi(method, args, state) {
        switch (method) {
            case 'list':
            case 'getMinerAccount':
                return false;
            case 'createWallet':
                return true;
            default:
                throw new Error(`Unhandled method: ${method}`);
        }
    }
}

class SafePolicy extends BasePolicy {
    allows(method, args, state) {
        switch (method) {
            case 'importFromFile':
            case 'importFromWords':
            case 'backupFile':
            case 'backupWords':
            case 'list':
            case 'createVolatile':
            case 'createSafe':
            case 'upgrade':
                // todo remove
            case 'createWallet':
                // todo remove
            case 'getMinerAccount':
            case 'rename':
                return true;
            case 'signSafe':
            case 'signWallet':
                // for now, assume there are only keys we are able to use in safe app
                return true;
                /*const [ userFriendlyAddress, recipient, value, fee ] = args;
                const key = (state.keys || state.accounts.entries).get(userFriendlyAddress);
                if (key.type === Keytype.HIGH) return true; */
            default:
                throw new Error(`Unhandled method: ${method}`);
        }
    }

    needsUi(method, args, state) {
        switch (method) {
            case 'list':
            case 'createVolatile':
            // todo remove
            case 'getMinerAccount':
                return false;
            case 'createSafe':
            // todo remove
            case 'createWallet':
            case 'upgrade':
            case 'importFromFile':
            case 'importFromWords':
            case 'backupFile':
            case 'backupWords':
            case 'signSafe':
            case 'signWallet':
            case 'rename':
                return true;
            default:
                throw new Error(`Unhandled method: ${method}`);
        }
    }
}

class Policy {

    static parse(serialized) {
        if (!serialized) return null;
        const policy = Policy.get(serialized.name);
        for (const prop in serialized) policy[prop] = serialized[prop];
        return policy;
    }

    static get(name, ...args) {
        if (!Policy.predefined.hasOwnProperty(name)) throw `Policy "${name} does not exist."`
        return new Policy.predefined[name](...args);
    }
}

Policy.predefined = {};
for (const policy of [WalletPolicy, SafePolicy, MinerPolicy]) {
    Policy.predefined[policy.name] = policy;
}

class NoUIError extends Error {

    static get code() {
        return 'K2';
    }

    constructor(method) {
        super(`Method ${method} needs user interface`);
    }
}

function symbolObservablePonyfill(root) {
	var result;
	var Symbol = root.Symbol;

	if (typeof Symbol === 'function') {
		if (Symbol.observable) {
			result = Symbol.observable;
		} else {
			result = Symbol('observable');
			Symbol.observable = result;
		}
	} else {
		result = '@@observable';
	}

	return result;
}

/* global window */
var root;

if (typeof self !== 'undefined') {
  root = self;
} else if (typeof window !== 'undefined') {
  root = window;
} else if (typeof global !== 'undefined') {
  root = global;
} else if (typeof module !== 'undefined') {
  root = module;
} else {
  root = Function('return this')();
}

var result = symbolObservablePonyfill(root);

/**
 * These are private action types reserved by Redux.
 * For any unknown actions, you must return the current state.
 * If the current state is undefined, you must return the initial state.
 * Do not reference these action types directly in your code.
 */
const ActionTypes = {
  INIT:
    '@@redux/INIT' +
    Math.random()
      .toString(36)
      .substring(7)
      .split('')
      .join('.'),
  REPLACE:
    '@@redux/REPLACE' +
    Math.random()
      .toString(36)
      .substring(7)
      .split('')
      .join('.')
};

/**
 * @param {any} obj The object to inspect.
 * @returns {boolean} True if the argument appears to be a plain object.
 */
function isPlainObject(obj) {
  if (typeof obj !== 'object' || obj === null) return false

  let proto = obj;
  while (Object.getPrototypeOf(proto) !== null) {
    proto = Object.getPrototypeOf(proto);
  }

  return Object.getPrototypeOf(obj) === proto
}

/**
 * Creates a Redux store that holds the state tree.
 * The only way to change the data in the store is to call `dispatch()` on it.
 *
 * There should only be a single store in your app. To specify how different
 * parts of the state tree respond to actions, you may combine several reducers
 * into a single reducer function by using `combineReducers`.
 *
 * @param {Function} reducer A function that returns the next state tree, given
 * the current state tree and the action to handle.
 *
 * @param {any} [preloadedState] The initial state. You may optionally specify it
 * to hydrate the state from the server in universal apps, or to restore a
 * previously serialized user session.
 * If you use `combineReducers` to produce the root reducer function, this must be
 * an object with the same shape as `combineReducers` keys.
 *
 * @param {Function} [enhancer] The store enhancer. You may optionally specify it
 * to enhance the store with third-party capabilities such as middleware,
 * time travel, persistence, etc. The only store enhancer that ships with Redux
 * is `applyMiddleware()`.
 *
 * @returns {Store} A Redux store that lets you read the state, dispatch actions
 * and subscribe to changes.
 */
function createStore(reducer, preloadedState, enhancer) {
  if (typeof preloadedState === 'function' && typeof enhancer === 'undefined') {
    enhancer = preloadedState;
    preloadedState = undefined;
  }

  if (typeof enhancer !== 'undefined') {
    if (typeof enhancer !== 'function') {
      throw new Error('Expected the enhancer to be a function.')
    }

    return enhancer(createStore)(reducer, preloadedState)
  }

  if (typeof reducer !== 'function') {
    throw new Error('Expected the reducer to be a function.')
  }

  let currentReducer = reducer;
  let currentState = preloadedState;
  let currentListeners = [];
  let nextListeners = currentListeners;
  let isDispatching = false;

  function ensureCanMutateNextListeners() {
    if (nextListeners === currentListeners) {
      nextListeners = currentListeners.slice();
    }
  }

  /**
   * Reads the state tree managed by the store.
   *
   * @returns {any} The current state tree of your application.
   */
  function getState() {
    if (isDispatching) {
      throw new Error(
        'You may not call store.getState() while the reducer is executing. ' +
          'The reducer has already received the state as an argument. ' +
          'Pass it down from the top reducer instead of reading it from the store.'
      )
    }

    return currentState
  }

  /**
   * Adds a change listener. It will be called any time an action is dispatched,
   * and some part of the state tree may potentially have changed. You may then
   * call `getState()` to read the current state tree inside the callback.
   *
   * You may call `dispatch()` from a change listener, with the following
   * caveats:
   *
   * 1. The subscriptions are snapshotted just before every `dispatch()` call.
   * If you subscribe or unsubscribe while the listeners are being invoked, this
   * will not have any effect on the `dispatch()` that is currently in progress.
   * However, the next `dispatch()` call, whether nested or not, will use a more
   * recent snapshot of the subscription list.
   *
   * 2. The listener should not expect to see all state changes, as the state
   * might have been updated multiple times during a nested `dispatch()` before
   * the listener is called. It is, however, guaranteed that all subscribers
   * registered before the `dispatch()` started will be called with the latest
   * state by the time it exits.
   *
   * @param {Function} listener A callback to be invoked on every dispatch.
   * @returns {Function} A function to remove this change listener.
   */
  function subscribe(listener) {
    if (typeof listener !== 'function') {
      throw new Error('Expected the listener to be a function.')
    }

    if (isDispatching) {
      throw new Error(
        'You may not call store.subscribe() while the reducer is executing. ' +
          'If you would like to be notified after the store has been updated, subscribe from a ' +
          'component and invoke store.getState() in the callback to access the latest state. ' +
          'See http://redux.js.org/docs/api/Store.html#subscribe for more details.'
      )
    }

    let isSubscribed = true;

    ensureCanMutateNextListeners();
    nextListeners.push(listener);

    return function unsubscribe() {
      if (!isSubscribed) {
        return
      }

      if (isDispatching) {
        throw new Error(
          'You may not unsubscribe from a store listener while the reducer is executing. ' +
            'See http://redux.js.org/docs/api/Store.html#subscribe for more details.'
        )
      }

      isSubscribed = false;

      ensureCanMutateNextListeners();
      const index = nextListeners.indexOf(listener);
      nextListeners.splice(index, 1);
    }
  }

  /**
   * Dispatches an action. It is the only way to trigger a state change.
   *
   * The `reducer` function, used to create the store, will be called with the
   * current state tree and the given `action`. Its return value will
   * be considered the **next** state of the tree, and the change listeners
   * will be notified.
   *
   * The base implementation only supports plain object actions. If you want to
   * dispatch a Promise, an Observable, a thunk, or something else, you need to
   * wrap your store creating function into the corresponding middleware. For
   * example, see the documentation for the `redux-thunk` package. Even the
   * middleware will eventually dispatch plain object actions using this method.
   *
   * @param {Object} action A plain object representing “what changed”. It is
   * a good idea to keep actions serializable so you can record and replay user
   * sessions, or use the time travelling `redux-devtools`. An action must have
   * a `type` property which may not be `undefined`. It is a good idea to use
   * string constants for action types.
   *
   * @returns {Object} For convenience, the same action object you dispatched.
   *
   * Note that, if you use a custom middleware, it may wrap `dispatch()` to
   * return something else (for example, a Promise you can await).
   */
  function dispatch(action) {
    if (!isPlainObject(action)) {
      throw new Error(
        'Actions must be plain objects. ' +
          'Use custom middleware for async actions.'
      )
    }

    if (typeof action.type === 'undefined') {
      throw new Error(
        'Actions may not have an undefined "type" property. ' +
          'Have you misspelled a constant?'
      )
    }

    if (isDispatching) {
      throw new Error('Reducers may not dispatch actions.')
    }

    try {
      isDispatching = true;
      currentState = currentReducer(currentState, action);
    } finally {
      isDispatching = false;
    }

    const listeners = (currentListeners = nextListeners);
    for (let i = 0; i < listeners.length; i++) {
      const listener = listeners[i];
      listener();
    }

    return action
  }

  /**
   * Replaces the reducer currently used by the store to calculate the state.
   *
   * You might need this if your app implements code splitting and you want to
   * load some of the reducers dynamically. You might also need this if you
   * implement a hot reloading mechanism for Redux.
   *
   * @param {Function} nextReducer The reducer for the store to use instead.
   * @returns {void}
   */
  function replaceReducer(nextReducer) {
    if (typeof nextReducer !== 'function') {
      throw new Error('Expected the nextReducer to be a function.')
    }

    currentReducer = nextReducer;
    dispatch({ type: ActionTypes.REPLACE });
  }

  /**
   * Interoperability point for observable/reactive libraries.
   * @returns {observable} A minimal observable of state changes.
   * For more information, see the observable proposal:
   * https://github.com/tc39/proposal-observable
   */
  function observable() {
    const outerSubscribe = subscribe;
    return {
      /**
       * The minimal observable subscription method.
       * @param {Object} observer Any object that can be used as an observer.
       * The observer object should have a `next` method.
       * @returns {subscription} An object with an `unsubscribe` method that can
       * be used to unsubscribe the observable from the store, and prevent further
       * emission of values from the observable.
       */
      subscribe(observer) {
        if (typeof observer !== 'object') {
          throw new TypeError('Expected the observer to be an object.')
        }

        function observeState() {
          if (observer.next) {
            observer.next(getState());
          }
        }

        observeState();
        const unsubscribe = outerSubscribe(observeState);
        return { unsubscribe }
      },

      [result]() {
        return this
      }
    }
  }

  // When a store is created, an "INIT" action is dispatched so that every
  // reducer returns their initial state. This effectively populates
  // the initial state tree.
  dispatch({ type: ActionTypes.INIT });

  return {
    dispatch,
    subscribe,
    getState,
    replaceReducer,
    [result]: observable
  }
}

/**
 * Prints a warning in the console if it exists.
 *
 * @param {String} message The warning message.
 * @returns {void}
 */
function warning(message) {
  /* eslint-disable no-console */
  if (typeof console !== 'undefined' && typeof console.error === 'function') {
    console.error(message);
  }
  /* eslint-enable no-console */
  try {
    // This error was thrown as a convenience so that if you enable
    // "break on all exceptions" in your console,
    // it would pause the execution at this line.
    throw new Error(message)
  } catch (e) {} // eslint-disable-line no-empty
}

const devConfig = {
  mode: 'dev'
};

function getUndefinedStateErrorMessage(key, action) {
  const actionType = action && action.type;
  const actionDescription =
    (actionType && `action "${String(actionType)}"`) || 'an action';

  return (
    `Given ${actionDescription}, reducer "${key}" returned undefined. ` +
    `To ignore an action, you must explicitly return the previous state. ` +
    `If you want this reducer to hold no value, you can return null instead of undefined.`
  )
}

function getUnexpectedStateShapeWarningMessage(
  inputState,
  reducers,
  action,
  unexpectedKeyCache
) {
  const reducerKeys = Object.keys(reducers);
  const argumentName =
    action && action.type === ActionTypes.INIT
      ? 'preloadedState argument passed to createStore'
      : 'previous state received by the reducer';

  if (reducerKeys.length === 0) {
    return (
      'Store does not have a valid reducer. Make sure the argument passed ' +
      'to combineReducers is an object whose values are reducers.'
    )
  }

  if (!isPlainObject(inputState)) {
    return (
      `The ${argumentName} has unexpected type of "` +
      {}.toString.call(inputState).match(/\s([a-z|A-Z]+)/)[1] +
      `". Expected argument to be an object with the following ` +
      `keys: "${reducerKeys.join('", "')}"`
    )
  }

  const unexpectedKeys = Object.keys(inputState).filter(
    key => !reducers.hasOwnProperty(key) && !unexpectedKeyCache[key]
  );

  unexpectedKeys.forEach(key => {
    unexpectedKeyCache[key] = true;
  });

  if (action && action.type === ActionTypes.REPLACE) return

  if (unexpectedKeys.length > 0) {
    return (
      `Unexpected ${unexpectedKeys.length > 1 ? 'keys' : 'key'} ` +
      `"${unexpectedKeys.join('", "')}" found in ${argumentName}. ` +
      `Expected to find one of the known reducer keys instead: ` +
      `"${reducerKeys.join('", "')}". Unexpected keys will be ignored.`
    )
  }
}

function assertReducerShape(reducers) {
  Object.keys(reducers).forEach(key => {
    const reducer = reducers[key];
    const initialState = reducer(undefined, { type: ActionTypes.INIT });

    if (typeof initialState === 'undefined') {
      throw new Error(
        `Reducer "${key}" returned undefined during initialization. ` +
          `If the state passed to the reducer is undefined, you must ` +
          `explicitly return the initial state. The initial state may ` +
          `not be undefined. If you don't want to set a value for this reducer, ` +
          `you can use null instead of undefined.`
      )
    }

    const type =
      '@@redux/PROBE_UNKNOWN_ACTION_' +
      Math.random()
        .toString(36)
        .substring(7)
        .split('')
        .join('.');
    if (typeof reducer(undefined, { type }) === 'undefined') {
      throw new Error(
        `Reducer "${key}" returned undefined when probed with a random type. ` +
          `Don't try to handle ${
            ActionTypes.INIT
          } or other actions in "redux/*" ` +
          `namespace. They are considered private. Instead, you must return the ` +
          `current state for any unknown actions, unless it is undefined, ` +
          `in which case you must return the initial state, regardless of the ` +
          `action type. The initial state may not be undefined, but can be null.`
      )
    }
  });
}

/**
 * Turns an object whose values are different reducer functions, into a single
 * reducer function. It will call every child reducer, and gather their results
 * into a single state object, whose keys correspond to the keys of the passed
 * reducer functions.
 *
 * @param {Object} reducers An object whose values correspond to different
 * reducer functions that need to be combined into one. One handy way to obtain
 * it is to use ES6 `import * as reducers` syntax. The reducers may never return
 * undefined for any action. Instead, they should return their initial state
 * if the state passed to them was undefined, and the current state for any
 * unrecognized action.
 *
 * @returns {Function} A reducer function that invokes every reducer inside the
 * passed object, and builds a state object with the same shape.
 */
function combineReducers(reducers) {
  const reducerKeys = Object.keys(reducers);
  const finalReducers = {};
  for (let i = 0; i < reducerKeys.length; i++) {
    const key = reducerKeys[i];

    if (devConfig.mode !== 'production') {
      if (typeof reducers[key] === 'undefined') {
        warning(`No reducer provided for key "${key}"`);
      }
    }

    if (typeof reducers[key] === 'function') {
      finalReducers[key] = reducers[key];
    }
  }
  const finalReducerKeys = Object.keys(finalReducers);

  let unexpectedKeyCache;
  if (devConfig.mode !== 'production') {
    unexpectedKeyCache = {};
  }

  let shapeAssertionError;
  try {
    assertReducerShape(finalReducers);
  } catch (e) {
    shapeAssertionError = e;
  }

  return function combination(state = {}, action) {
    if (shapeAssertionError) {
      throw shapeAssertionError
    }

    if (devConfig.mode !== 'production') {
      const warningMessage = getUnexpectedStateShapeWarningMessage(
        state,
        finalReducers,
        action,
        unexpectedKeyCache
      );
      if (warningMessage) {
        warning(warningMessage);
      }
    }

    let hasChanged = false;
    const nextState = {};
    for (let i = 0; i < finalReducerKeys.length; i++) {
      const key = finalReducerKeys[i];
      const reducer = finalReducers[key];
      const previousStateForKey = state[key];
      const nextStateForKey = reducer(previousStateForKey, action);
      if (typeof nextStateForKey === 'undefined') {
        const errorMessage = getUndefinedStateErrorMessage(key, action);
        throw new Error(errorMessage)
      }
      nextState[key] = nextStateForKey;
      hasChanged = hasChanged || nextStateForKey !== previousStateForKey;
    }
    return hasChanged ? nextState : state
  }
}

function bindActionCreator(actionCreator, dispatch) {
  return function() {
    return dispatch(actionCreator.apply(this, arguments))
  }
}

/**
 * Turns an object whose values are action creators, into an object with the
 * same keys, but with every function wrapped into a `dispatch` call so they
 * may be invoked directly. This is just a convenience method, as you can call
 * `store.dispatch(MyActionCreators.doSomething())` yourself just fine.
 *
 * For convenience, you can also pass a single function as the first argument,
 * and get a function in return.
 *
 * @param {Function|Object} actionCreators An object whose values are action
 * creator functions. One handy way to obtain it is to use ES6 `import * as`
 * syntax. You may also pass a single function.
 *
 * @param {Function} dispatch The `dispatch` function available on your Redux
 * store.
 *
 * @returns {Function|Object} The object mimicking the original object, but with
 * every action creator wrapped into the `dispatch` call. If you passed a
 * function as `actionCreators`, the return value will also be a single
 * function.
 */
function bindActionCreators(actionCreators, dispatch) {
  if (typeof actionCreators === 'function') {
    return bindActionCreator(actionCreators, dispatch)
  }

  if (typeof actionCreators !== 'object' || actionCreators === null) {
    throw new Error(
      `bindActionCreators expected an object or a function, instead received ${
        actionCreators === null ? 'null' : typeof actionCreators
      }. ` +
        `Did you write "import ActionCreators from" instead of "import * as ActionCreators from"?`
    )
  }

  const keys = Object.keys(actionCreators);
  const boundActionCreators = {};
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const actionCreator = actionCreators[key];
    if (typeof actionCreator === 'function') {
      boundActionCreators[key] = bindActionCreator(actionCreator, dispatch);
    }
  }
  return boundActionCreators
}

/**
 * Composes single-argument functions from right to left. The rightmost
 * function can take multiple arguments as it provides the signature for
 * the resulting composite function.
 *
 * @param {...Function} funcs The functions to compose.
 * @returns {Function} A function obtained by composing the argument functions
 * from right to left. For example, compose(f, g, h) is identical to doing
 * (...args) => f(g(h(...args))).
 */

function compose(...funcs) {
  if (funcs.length === 0) {
    return arg => arg
  }

  if (funcs.length === 1) {
    return funcs[0]
  }

  return funcs.reduce((a, b) => (...args) => a(b(...args)))
}

/**
 * Creates a store enhancer that applies middleware to the dispatch method
 * of the Redux store. This is handy for a variety of tasks, such as expressing
 * asynchronous actions in a concise manner, or logging every action payload.
 *
 * See `redux-thunk` package as an example of the Redux middleware.
 *
 * Because middleware is potentially asynchronous, this should be the first
 * store enhancer in the composition chain.
 *
 * Note that each middleware will be given the `dispatch` and `getState` functions
 * as named arguments.
 *
 * @param {...Function} middlewares The middleware chain to be applied.
 * @returns {Function} A store enhancer applying the middleware.
 */
function applyMiddleware(...middlewares) {
  return createStore => (...args) => {
    const store = createStore(...args);
    let dispatch = () => {
      throw new Error(
        `Dispatching while constructing your middleware is not allowed. ` +
          `Other middleware would not be applied to this dispatch.`
      )
    };
    let chain = [];

    const middlewareAPI = {
      getState: store.getState,
      dispatch: (...args) => dispatch(...args)
    };
    chain = middlewares.map(middleware => middleware(middlewareAPI));
    dispatch = compose(...chain)(store.dispatch);

    return Object.assign({}, store, {
      dispatch
    })
  }
}

const MixinRedux = XElementBase => class extends XElementBase {
    onCreate() {
        super.onCreate();

        const store = MixinRedux.store;

        if (!store) return;

        const { actions, mapStateToProps } = this.constructor;

        if (actions) {
            this.actions = bindActionCreators(actions, store.dispatch);
        }

        if (mapStateToProps) {
            requestAnimationFrame(() => {
                // set initial properties after DOM was created
                const initialProperties = mapStateToProps(store.getState(), this.properties);
                this.setProperties(initialProperties);
            });

            // subscribe to state updates
            this._unsubscribe = store.subscribe(() => {
                const properties = mapStateToProps(store.getState(), this.properties);

                this.setProperties(properties);
            });
        }
    }

    // setProperties(props, reset) {
    //     let newProps = {...this.properties, props};

    //     if (mapStateToProps.length > 1) {
    //         newProps = mapStateToProps(store.getState(), newProps);
    //     }

    //     super.setProperties(newProps, reset);
    // }

    destroy() {
        super.destroy();

        if (this._unsubscribe) {
            this._unsubscribe();
        }
    }
};



// todo [later] Only listen to state updates while element is visible

// to keep track of connection to keyguard (and possibly ledger?)

const TypeKeys = {
    SET_KEYGUARD: 'connection/set-keyguard'
};


function reducer(state, action) {
    if (state === undefined) {
        return {
            keyguard: false
        }
    }

    switch (action.type) {
        case TypeKeys.SET_KEYGUARD:
            return Object.assign({}, state,
                {
                    keyguard: action.connected
                });

        default:
            return state;
    }
}

function setKeyguardConnection(connected) {
   return {
       type: TypeKeys.SET_KEYGUARD,
       connected
   }
}

class KeyguardClient {
	static async create(src, assumedPolicy, getState, needUiCallback, usePopup = true) {
		const client = new KeyguardClient(src, getState, needUiCallback, usePopup);
		this._wrappedApi = await client._wrapApi();
		await client._authorize.bind(client)(assumedPolicy);
		MixinRedux.store.dispatch(setKeyguardConnection(true));
		return this._wrappedApi;
	}

	/**
	 * @private
	 *
	 * @param {string} src URI of secure origin aka key guard aka key dude.
	 * @param {() => StateObject} getState function which returns the state
	 * @param {function} needUiCallback
	 * @param {boolean} usePopup
	 */
	constructor(src, getState, needUiCallback, usePopup = true) {
		this._keyguardSrc = src;
		this._keyguardOrigin = new URL(src).origin;
		this.popup = usePopup;
		this.$iframe = this._createIframe();
		this.needUiCallback = needUiCallback;
		this.publicApi = {};
		this.policy = null;
		this.getState = getState;
	}

	async _wrapApi() {
 		this.embeddedApi = await this._getApi((await this.$iframe).contentWindow);

		for (const methodName of this.embeddedApi.availableMethods) {
			const normalMethod = this._proxyMethod(methodName);
			const secureMethod = this._proxySecureMethod(methodName);
			this.publicApi[methodName] = this._bindMethods(methodName, normalMethod, secureMethod);
		}

		// intercepting "authorize" and "getPolicy" for keeping an instance of the latest authorized policy
		// to predict if user interaction will be needed when calling API methods.
		const apiAuthorize = this.publicApi.authorize.secure;
		this.publicApi.authorize = async requiredPolicy => {
			const success = await apiAuthorize(requiredPolicy);
			this.policy = success ? requiredPolicy : null;
			return success;
		};

		const apiGetPolicy = this.publicApi.getPolicy;
		this.publicApi.getPolicy = async () => {
			return this.policy = Policy.parse(await apiGetPolicy());
		};

		return this.publicApi;
	}

	/** @param {string} methodName
	 *
	 * @returns {function} Trying to call this method in the iframe and open a window if user interaction is required.
	 * */
	_proxyMethod(methodName) {
		const proxy = async (...args) => {
			if (this.policy && !this.policy.allows(methodName, args, this.getState()))
				throw new Error(`Not allowed to call ${methodName}.`)

			try {
				// if we know that user interaction is needed, we'll do a secure request right away, i.e. a redirect/popup
				if (this.policy && this.policy.needsUi(methodName, args, this.getState()))
					return await proxy.secure(...args);

				return await this.embeddedApi[methodName](...args);
			}
			catch (error) {
				if (error.code === NoUIError.code) {
					if (this.needUiCallback instanceof Function) {
						return await new Promise((resolve, reject) => {
							this.needUiCallback(methodName, confirmed => {
								if (!confirmed) reject(new Error('Denied by user.'));
								resolve(proxy.secure.call(args));
							});
						});
					} else throw new Error(`User interaction is required to call "${ methodName }". You need to call this method from an event handler, e.g. a click event.`);
				}
				else throw error;
			}
		};

		return proxy;
	}

	/** @param {string} methodName
	 *
	 * @returns {function} Call this method in a new window
	 * */
	_proxySecureMethod(methodName) {
		return async (...args) => {
			if (this.popup) {
                const apiWindow = window.open(this._keyguardSrc + '/iframe.html', 'NimiqKeyguard', `left=${window.innerWidth / 2 - 250},top=100,width=500,height=820,location=yes,dependent=yes`);
            
				if (!apiWindow) {
					throw new Error('Keyguard window could not be opened.');
                }
                
				const secureApi = await this._getApi(apiWindow);
				const result = await secureApi[methodName](...args);

				apiWindow.close();

				return result;
			} else {
				// top level navigation
				throw new Error('Top level navigation not implemented. Use a popup.');
			}
		}
	}

	_bindMethods(methodName, normalMethod, secureMethod) {
		const method = normalMethod;
		method.secure = secureMethod;
		method.isAllowed = () => (this.policy && this.policy.allows(methodName, arguments, this.getState()));
		return method;
	}

	async _authorize(assumedPolicy) {
		let grantedPolicy = await this.publicApi.getPolicy();
		grantedPolicy = grantedPolicy && Policy.parse(grantedPolicy);
		console.log('Got policy:', grantedPolicy);

		if (!assumedPolicy.equals(grantedPolicy)) {
			const authorized = await this.publicApi.authorize(assumedPolicy);
			if (!authorized) {
				throw new Error('Authorization failed.');
			}
		}


	}

	// _defaultUi(methodName) {
	// 	return new Promise((resolve, reject) => { resolve(window.confirm("You will be forwarded to securely confirm this action.")); });
	// }

	async _getApi(targetWindow) {
		return await RPC.Client(targetWindow, 'KeyguardApi', this._keyguardOrigin);
	}

	/**
	 * @return {Promise}
	 */
	_createIframe() {
		const $iframe = document.createElement('iframe');

		const readyListener = (resolve) => function readyResolver({source, data}) {
			if (source === $iframe.contentWindow && data === 'ready') {
				self.removeEventListener('message', readyResolver);
				resolve($iframe);
			}
		};

		const promise = new Promise(resolve => self.addEventListener('message', readyListener(resolve)));

		$iframe.src = this._keyguardSrc + '/iframe.html';
		$iframe.name = 'keyguard';
		document.body.appendChild($iframe);
		return promise;
	}
}

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

class NetworkClient {
    static getInstance() {
        this._instance = this._instance || new NetworkClient();
        return this._instance;
    }

    constructor() {
        this.rpcClient = new Promise(res => {
            this.rpcClientResolve = res;
        });

        this.eventClient = new Promise(res => {
            this.eventClientResolve = res;
        });
    }

    async launch() {
        this.$iframe = await this._createIframe(Config.src('network'));
        this.rpcClientResolve(RPC.Client(this.$iframe.contentWindow, 'NanoNetworkApi', Config.origin('network')));
        this.eventClientResolve(EventClient.create(this.$iframe.contentWindow));
    }

    /**
     * @return {Promise}
     */
    _createIframe(src) {
        const $iframe = document.createElement('iframe');
        const promise = new Promise(resolve => $iframe.addEventListener('load', () => resolve($iframe)));
        $iframe.src = src;
        $iframe.name = 'network';
        document.body.appendChild($iframe);
        return promise;
    }
}

var networkClient = NetworkClient.getInstance();

class VestingClient {
    static async create() {
        const network = Config.offline ? {} : await networkClient.rpcClient;
        return new VestingClient(network);
    }

    constructor(network) {
        this._network = network;
        this._contracts = new Map();
    }

    async find(addresses) {
        if (Config.offline) return [];

        if (!this._contracts.size) await this._getContracts();

        const foundContracts = [];

        for (const contract of this._contracts) {
            if (!addresses.includes(contract.owner)) continue;
            foundContracts.push(contract);
        }

        return foundContracts;
    }

    async _getContracts() {
        this._contracts = await this._network.getGenesisVestingContracts();
    }

}

const MixinSingleton = XElementBase => class extends XElementBase {
    onCreate() {
        if (this.constructor._instance) {
            throw Error('Singleton already has an instance.');
        }
        this.constructor._instance = this;
        super.onCreate();
    }

    static get instance() {
        if (this._instance) return this._instance;
        const element = document.querySelector(this.tagName);
        if (element) {
            this._instance = new this(element);
        } else {
            this._instance = this.createElement();
            if (!this._instance.$el.parentNode) {
                (MixinSingleton.appContainer || document.body).appendChild(this._instance.$el);
            }
        }
        return this._instance;
    }

    static destroyInstance() {
        if (!this._instance) return;
        this._instance.destroy();
        this._instance = null;
    }
};

const log = message => {
  console.log(
    `%c[Router]%c ${message}`,
    'color: rgb(255, 105, 100);',
    'color: inherit'
  );
};

/**
 * Client side router with hash history
 */
class Router {
  /**
   * Create a new instance of a client side router
   * @param {Object} options Router options
   * @param {boolean} [options.debug=false] - Enable debugging console messages
   * @param {Object} [options.context=window] - Context to listen for changes on
   * @param {boolean} [options.startListening=true] - Initiate listen on construct
   */
  constructor(options) {
    this.options = Object.assign({}, {
      debug: false,
      context: window,
      startListening: true,
    }, options);

    this.isListening = false;
    this.routes = [];
    this.onHashChange = this.check.bind(this);

    if (this.options.startListening) {
      this.listen();
    }
  }

  /**
   * Add a new route
   * @param {string|RegExp|function} route - Name of route to match
   * @param {function} handler - Method to execute when route matches
   * @returns {Router} - This router instance
   */
  add(route, handler) {
    // let newRoute = Router.cleanPath(route);
    let newRoute = route;
    let params = null;

    if (typeof route === 'function') {
        [ newRoute, handler ] = [ '', route ];
    }

    if (!(route instanceof RegExp)) {
        let params = newRoute.match(/({\w+})/gi);

        if (params) {
            for (const param of params) {
                newRoute = newRoute.replace(param, '(\[\\w-+*=()$|,;%{}:"\\[\\]\]+)');
            }

            params = params.map(param => param.substr(1, param.length - 2));
        }

        newRoute = new RegExp(newRoute);
    }

    this.routes.push({
      route: newRoute,
      handler,
      params
    });

    return this;
  }

  /**
   * Recheck the path and reload the page
   * @returns {Router} - This router instance
   */
  check() {
    const hash = this.currentRoute;

    for (const route of this.routes) {
      const match = hash.match(route.route);

      if (match !== null) {
        match.shift();

        let args = new Map();

        for (let i = 0; i < match.length; i++) {
          args.set(route.params[i], match[i]);
        }

        route.handler(args);

        if (this.options.debug) {
          log(`Fetching: /${hash}`);
        }

        return this;
      }
    }

    return this.navigateError(hash);
  }

  /**
   * Start listening for hash changes on the context
   * @param {any} [instance=Window] - Context to start listening on
   * @returns {Router} - This router instance
   */
  listen(instance) {
    this.check();

    if (!this.isListening || instance) {
      (instance || this.options.context).addEventListener(
        'hashchange',
        this.onHashChange
      );

      this.isListening = true;
    }

    return this;
  }

  /**
   * Stop listening for hash changes on the context
   * @param {any} [instance=Window] - Context to stop listening on
   * @returns {Router} - This router instance
   */
  stopListen(instance) {
    if (this.isListening || instance) {
      (instance || this.options.context).removeEventListener(
        'hashchange',
        this.onHashChange
      );

      this.isListening = false;
    }

    return this;
  }

  /**
   * Navigate router to path
   * @param {string} path - Path to navigate the router to
   * @returns {Router} - This router instance
   */
  navigate(path) {
    if (this.options.debug) {
      log(`Redirecting to: /${ Router.cleanPath(path || '') }`);
    }

    const cleanPath = Router.cleanPath(path || '');
    this.options.context.history.pushState({ path: cleanPath }, null, `#/${ cleanPath }`);

    if (path !== 'error') {
      window.dispatchEvent(new Event('hashchange'));
    }

    return this;
  }

  /**
   * Navigate to the error page
   * @param {string} hash
   * @returns {Router} - This router instance
   */
  navigateError(hash) {
    if (this.options.debug) {
      log(`Fetching: /${hash}, not a valid route.`);
    }

    this.navigate('error');

    return this;
  }

  /**
   * Name of the current route
   * @returns {string} - Current route
   */
  get currentRoute() {
    return Router.cleanPath(this.options.context.location.hash);
  }

  /**
   * Strip the path of slashes and hashes
   * @param {string} path - Path to clean of hashes
   * @returns {string} - Cleaned path
   */
  static cleanPath(path) {
    if (!path) {
      return '';
    }

    // return String(path).replace(/^#+\/+|^\/+#+|^\/+|^#+|\/+$|\?(.*)$/g, '');
    // keep trailing slashes! it's important to differ between folder and folder/ for recursive routing
    return String(path).replace(/^#+\/+|^\/+#+|^\/+|^#+|\?(.*)$/g, '');
  }

  static parseRoute(route) {
    return Router.cleanPath(route).split('/');
  }
}

const _waitingForInit = [];
const DEFAULT_CLASSES = ['from-right-in', 'in', 'from-left-out', 'visible', 'from-left-in', 'from-right-out'];

class XRouter extends XElement {

    static get instance() {
        return new Promise((resolve, reject) => {
            if (XRouter._instance) resolve(XRouter._instance);
            else _waitingForInit.push(resolve);
        });
    }

    static create(initialPath = location.hash, classes = DEFAULT_CLASSES) {
        location.hash = initialPath;
        XRouter._classes = classes;

        new XRouter();
    }

    static _sanitizePath(path) { return path.replace(/(^\s*\/|\s*\/$|_[^_]*_)/g, ''); }
    static _isRoot(path = '') { return XRouter._sanitizePath(path) == ''; }

    constructor() {
        super(document.body);
    }

    onCreate() {
        window.XRouter = XRouter;
        this.reverse = false;
        this.routing = false;
        this.running = false;
        this.history = [];

        // read XRouter.classes, then <x-router animations="...", or fall back to DEFAULT_CLASSES
        if (XRouter.classes instanceof Array) this.classes = XRouter.classes;
        else if (this.$el.hasAttribute('animations')) this.classes = this.$el.getAttribute('animations').split(' ');
        if (!(this.classes instanceof Array) || this.classes.length != 6) this.classes = DEFAULT_CLASSES;
        [ this.CSS_IN, this.CSS_SHOW, this.CSS_OUT, this.CSS_VISIBLE, this.CSS_IN_REVERSE, this.CSS_OUT_REVERSE ] = this.classes;

        this._router = new Router({ debug: false, startListening: false });

        let state = 1; // first time, there is no 'previous' element
        this.addEventListener('animationend', e => {
            if (!this.routing) return;
            const xElement = XElement.get(e.target);
            if (e.target == this.current.element) {
                this._toggleInOut(this.animateIn, false, false);
                this._setClass(this.animateIn, this.CSS_SHOW, true);
                this._doRouteCallback(this.current, 'onAfterEntry');
                state++;
            }
            if (this.previous && e.target == this.previous.element) {
                this._toggleInOut(this.animateOut, false, false);
                this._setClass(this.animateOut, this.CSS_VISIBLE, false);
                this._doRouteCallback(this.previous, 'onExit');
                state++;
            }
            if (state == 2) {
                state = 0;
                this.routing = false;
            }
        });

        // X-router is just an element of page, so the initialization of x-router may happen before all the siblings
        // are initialized by x-element. Thus, leaving the current process to make sure all initialization is done.
        setTimeout(() => this._initialize());
    }

    _initialize() {
        this.parseRoutes(this.$$('[x-route]'));
        this.parseAside(this.$$('[x-route-aside]'));
        this.hookUpLinks(this.$$('a[x-href]'));

        XRouter._instance = this;
        for (const callback of _waitingForInit) callback(this);

        // make sure that anyone that was listening can act first, e.g. update the route
        setTimeout(() => this._router.listen());
    }

    parseRoutes(routeElements) {
        this.routes = new Map();
        this.routeByElement = new Map();
        for (const element of routeElements) {
            const { path, nodes } = this._absolutePathOf(element);
            const regex = XRouter._isRoot(path) ? /^\/?$|^\/?_.*/ : new RegExp(`^\/?${ path }$|^\/?${ path }_.*$`);
            const route = { path, element, regex, nodes };

            // relative route '/' might overwrite parent route
            this.routes.set(XRouter._sanitizePath(path), route);
            this.routeByElement.set(element, route);
            element.parentNode.classList.add('x-route-parent');
        }

        for (const [path, route] of this.routes){
            this._router.add(route.regex, (params) => this._show(path, params));
        }

    }

    parseAside(routeElements) {
        this.asides = new Map();
        for (const element of routeElements) {
            const tag = element.attributes['x-route-aside'].value.trim();
            const regex = new RegExp(`.*_${ tag }\/?([^_]*)_.*`);
            const replace = new RegExp(`_${ tag }\/?[^_]*_`, 'g');
            this.asides.set(tag, { tag, element, regex, replace, visible: false });
        }
    }

    hookUpLinks(links) {
        this.links = [];
        for (const link of links) {
            const linkPath = link.attributes['x-href'].value.trim();
            if (linkPath[0] == '/') {
                const path = XRouter._sanitizePath(linkPath);
                link.href = `#/${ path }`;
                this.links.push({ path, link });
            } else {
                let { path, nodes } = this._absolutePathOf(link);
                let absolutePath = path ? `${ path }/${ linkPath }` : linkPath;
                if (linkPath.slice(0, 2) == '..') {
                    if (nodes.length < 2) {
                        path = '';
                        nodes = [nodes[0]];
                    }
                    else {
                        path = this._absolutePathOf(nodes.reverse()[1]).path;
                    }
                    absolutePath = XRouter._sanitizePath(path);
                }
                link.href = `#/${ absolutePath }`;
                this.links.push({ path: absolutePath, link });
            }
        }
    }

    goTo(pathOrNode, relativePath) {
        this.reverse = false;
        const findRoute = (nodeOrPath, relative) => {
            if (typeof nodeOrPath == 'string') {
                const path = nodeOrPath;
                return { route: this._getRoute(path), path };
            }
            let node = nodeOrPath.$el ? nodeOrPath.$el : nodeOrPath;
            node = relative ? node.querySelector(`[x-route="${ relative }"]`) : node;
            const route = this.routeByElement.get(node);
            return { route, path: route.path };
        };
        const { route, path } = findRoute(pathOrNode, relativePath);
        if (!route) throw `XRouter: route for absolute path "${ path }" of ${ pathOrNode.tagName } not found.`;
        this.history.unshift(route);
        this._router.navigate(path);
    }

    _absolutePathOf(node, relativePath){
        if (typeof node == 'string') return node; // `node` is abs path already
        const nodes = [];
        const readPath = (node, path = []) => {
            const segment = node.getAttribute('x-route');
            if (segment != null) {
                path.unshift(XRouter._sanitizePath(segment));
                nodes.unshift(node);
            }
            return (node.parentNode != this.$el) ? readPath(node.parentNode, path) : path;
        };
        const leaf = relativePath ? node.querySelector(`[x-route="${ relativePath }"]`) : node;
        if (!leaf) throw new Error(`XRouter: can not find relative x-route ${ relativePath } in this tag ${ node.tagName }`);
        const path = readPath(leaf).filter(segment => segment.trim().length > 0).join('/');
        return { path, nodes };
    }

    goBackTo(path) {
        this.reverse = true;
        const search = new RegExp(`.*${ path }.*`);
        const found = this.history.find((item, index) => {
            if (path == item || item.match(search)) {
                this.goBack(index);
                return true;
            }
        });
        if (!found) {
            throw new Error(`XRouter: goBackTo(${ path }): path not found in history ${ JSON.stringify(this.history) }`);
        }
    }

    goBack(steps = 1) {
        // this.goBackTo(this.history[1]);
        this._log(`XRouter: going ${ steps } steps back in history to ${ this.history[steps] }. old history = ${ JSON.stringify(this.history) }`);
        // forget all the history "in between"
        this.history = this.history.slice(steps);
        this._log(`XRouter: new history = ${ JSON.stringify(this.history) }`);
        window.history.go(-steps);
    }

    showAside(tag, parameters) {
        this.goTo(this._putAside(this._router.currentRoute, tag, parameters));
    }

    _putAside(path, tag, parameters) {
        const aside = this.asides.get(tag);
        if (!aside) throw new Error(`XRouter: aside "${ tag } unknown"`);

        return path.match(aside.regex) ? path : `${ path }${ this._makeAside(tag, parameters)}`;
    }

    _makeAside(tag, parameters) {
        let param = '';
        if (parameters) {
            param = (parameters instanceof Array) ? parameters : [parameters];
            param = '/' + [...param].join('/');
        }
        return `_${ tag }${ param }_`;
    }

    hideAside(tag, replaceWith = '') {
        const aside = this.asides.get(tag);
        if (!aside) throw new Error(`XRouter: aside "${ tag } unknown"`);
        this.goTo(this._router.currentRoute.replace(aside.replace, replaceWith));
    }

    replaceAside(oldTag, newTag, parameters) {
        this.hideAside(oldTag, this._makeAside(newTag, parameters));
    }

    get goingBackwards() { return this.reverse; }


    _getRoute(path) { return this.routes.get(XRouter._sanitizePath(path)); }

    async _show(path) {
        if (this.running) {
            return setTimeout(() => this._show(path));
        }
        this.running = true;

        const hash = this._router.currentRoute;
        const route = this._getRoute(path);
        this._log(`XRouter: showing ${ path }, hash = ${ hash }, route = `, route);

        this._changeRoute(route);
        this._checkAsides(hash);
        this._highlightLinks(route);

        this.running = false;
    }

    _changeRoute(route) {
        if (this.current && route.path === this.current.path) return;
        [ this.previous, this.current ] = [ this.current, route ];

        if (this.previous) {
            this.animateIn = this.current.nodes.filter(node => !this.previous.nodes.includes(node));
            this.animateOut = this.previous.nodes.filter(node => !this.current.nodes.includes(node));
        } else {
            this.animateIn = [...this.current.nodes];
            this.animateOut = [];
        }

        this._toggleInOut(this.animateOut, false);
        this._setClass(this.animateOut, this.CSS_SHOW, false);
        if (this.previous) {
            this._doRouteCallback(this.previous, 'onBeforeExit');
            this.previous.element.classList.remove('current');
        }

        this.current.element.classList.add('current');
        this._doRouteCallback(this.current, 'onEntry');
        this._toggleInOut(this.animateIn, true);
        this._setClass(this.animateIn, this.CSS_VISIBLE, true);

        this.routing = true;
    }

    _checkAsides(hash) {
        let onEntries = [];
        let onExits = [];
        for (const [tag, aside] of this.asides) {
            const match = hash.match(aside.regex);
            if (match && !aside.visible) {
                const params = match[1] ? match[1].split('/') : [];
                aside.visible = true;
                onEntries.push({ tag, element: aside.element, name: 'onEntry', params });
            }
            if (!match && aside.visible) {
                aside.visible = false;
                onExits.push({ tag, element: aside.element, name: 'onExit' });
            }
        }
        for (const callback of [...onEntries, ...onExits]) {
            this._log(`XRouter: aside "${ callback.tag }" ${ callback.name }`, callback.params);
            this._doCallback(callback.element, callback.name, callback.params);
        }
    }

    _highlightLinks(route) {
        for (const { path, link } of this.links) {
            link.classList.toggle('current', path == route.path);
        }
    }

    _doRouteCallback(route, name, args = []) {
        if (!route) {
            throw new Error('XRouter: no route!');
        }
        for (const node of route.nodes) {
            this._doCallback(node, name, args);
        }
    }

    _doCallback(element, name, args = []) {
        const xElement = XElement.get(element);
        // element is undefined if el is a plain html node, e.g. section, main, ...
        if (!xElement) return;

        if (xElement[name] instanceof Function) {
            xElement[name](...args);
        } else if (Config.devMode) {
            console.warn(`XRouter: ${ element.tagName }.${ name } not found.`);
        }
    }

    _toggleInOut(route, setIn, setOut = !setIn) {
        this._setClass(route, this.CSS_IN, setIn && !this.reverse);
        this._setClass(route, this.CSS_IN_REVERSE, setIn && this.reverse);
        this._setClass(route, this.CSS_OUT, setOut && !this.reverse);
        this._setClass(route, this.CSS_OUT_REVERSE, setOut && this.reverse);
    }

    _setClass(route, css, on) {
        const nodes = (route instanceof Array) ? route : route.nodes;
        if (route) {
            for (const node of nodes) node.classList.toggle(css, on);
        } else {
            throw new Error('XRouter: no route!');
        }
    }

    _log(...args) {
        // console.log(...args);
    }
}

// todo [low] support change of parameters while staying in same aside

class XModals extends MixinSingleton(XElement) {
    onCreate() {
        super.onCreate();
        this._visibleModal = null;
        this._hideTimer = null;
        this._isSwitchingModal = false;
        this._isSwitchingBack = false;
        this._switchHistory = [];
    }

    static async show(triggeredByRouter, modal, ...parameters) {
        const visibleModal = XModals.visibleModal;
        if (modal === null || modal === visibleModal /*|| modal === incomingModal*/
            || !modal.allowsShow(...parameters)
            || (visibleModal && !visibleModal.allowsHide(modal))) return;
        let router = null;

        if (!triggeredByRouter && modal.route && visibleModal && visibleModal.route) {
            router = await XRouter.instance;
            router.replaceAside(visibleModal.route, modal.route, ...parameters);
            return;
        }

        if (triggeredByRouter || !modal.route) {
            XModals.instance._show(modal, ...parameters);
        } else {
            router = await XRouter.instance;
            router.showAside(modal.route, ...parameters);
        }

        if (!visibleModal) return;

        if (triggeredByRouter || !visibleModal.route) {
            XModals.instance._hide(visibleModal);
        } else {
            router = router || await XRouter.instance;
            router.hideAside(visibleModal.route);
        }
    }

    _setIncomingModal(modal) {
        this._incomingModal = modal;
        // check whether we're switching modals (i.e. there is another modal to be hidden).
        // _setIncomingModal is always called before hide of the old modal, so we can be sure there is no
        // race condition on _visibleModal.
        this._isSwitchingModal = !!this._visibleModal;
        this._isSwitchingBack = this._isSwitchingModal && this._switchHistory.length>=2
            && this._switchHistory[this._switchHistory.length-2] === modal;
    }

    _clearIncomingModal() {
        this._incomingModal = null;
        this._isSwitchingModal = false;
        this._isSwitchingBack = false;
    }

    _show(modal, ...parameters) {
        clearTimeout(this._hideTimer);
        clearTimeout(this._showTimer); // stop potential other incoming modal
        this._setIncomingModal(modal);

        // show background
        this.$el.style.display = 'block';
        this.$el.offsetWidth; // style update
        this.$el.style.background = 'rgba(0,0,0,0.5)';

        // avoid page scroll below the modal
        // TODO this leads to a jumping of the page cause by the disappearing scroll bar. Test whether we can
        // block the scrolling by preventDefault of the scroll event
        document.documentElement.style.overflow = 'hidden';

        // Show new modal
        // Do it with a small delay as the router invokes hide on the old modal after show on the new one but we
        // actually want to wait for the router to hide the old one first such that the hiding knows the _isSwitching flag.
        this._showTimer = setTimeout(() => {
            this._visibleModal = modal;
            if (!this._isSwitchingModal) this._switchHistory = [];
            if (this._isSwitchingBack) {
                this._switchHistory.pop();
            } else {
                this._switchHistory.push(modal);
            }
            modal.onShow(...parameters);
            modal.container.animateShow(this._isSwitchingModal, this._isSwitchingBack);
            this._clearIncomingModal();
        }, 20);
    }

    static async hide(triggeredByRouter, modal) {
        const visibleModal = XModals.visibleModal;
        if (modal === null || modal !== visibleModal
            || !modal.allowsHide(XModals.instance._incomingModal)) return;
        if (triggeredByRouter || !modal.route) {
            this.instance._hide(modal);
        } else {
            // let the router trigger the hide
            const router = await XRouter.instance;
            router.hideAside(modal.route);
        }
    }

    _hide(modal = this._visibleModal) {
        // Note that the router ensures that hide always gets called after show, so to determine _isSwitchingModal
        // we don't have to wait for a potential _show call after _hide

        if (!this._isSwitchingModal) {
            this._visibleModal = null;
            document.documentElement.style.overflow = null;
            this.$el.style.background = null;
            this._hideTimer = setTimeout(() => this.$el.style.display = null, XModals.ANIMATION_TIME);
            this._switchHistory = [];
        }
        modal.container.animateHide(this._isSwitchingModal, this._isSwitchingBack);
        modal.onHide();
    }

    static get visibleModal() {
        return this.instance._visibleModal;
    }
}
XModals.ANIMATION_TIME = 400;

class XModalContainer extends XElement {
    onCreate() {
        super.onCreate();
        this._modal = null;
        this._hideTimer = null;
        this.$el.setAttribute('tabindex', '-1');
        this.$el.addEventListener('click', e => this._onBackdropClick(e));
        this.$el.addEventListener('keydown', e => this._onEscape(e));
    }

    static createFor(modal) {
        let parent = modal.$el.parentNode;
        let modalContainer;
        if (parent && parent.nodeName.toLowerCase() === 'x-modal-container') {
            modalContainer = new XModalContainer(parent);
        } else {
            modalContainer = XModalContainer.createElement();
        }
        modalContainer._modal = modal;
        return modalContainer;
    }

    animateShow(isSwitching, isSwitchingBack) {
        clearTimeout(this._hideTimer);
        this.$el.style.display = 'flex';
        this._modal.$el.style.animationName = null;
        this.$el.offsetWidth; // style update
        this._modal.$el.offsetWidth; // style update
        this.$el.focus();
        this.$el.style.zIndex = 1;
        this._modal.$el.style.animationDelay = isSwitching? XModalContainer.ANIMATION_TIME / 2 + 'ms' : '0s';
        this._modal.$el.style.animationDirection = 'normal';
        this._modal.$el.style.animationName = !isSwitching? 'grow, fade'
            : isSwitchingBack? 'from-left   ' : 'from-right';
    }

    animateHide(isSwitching, isSwitchingBack) {
        this._modal.$el.style.animationName = null;
        this.$el.offsetWidth; // style update
        this._modal.$el.offsetWidth; // style update
        this.$el.blur();
        this.$el.style.zIndex = 0;
        this._modal.$el.style.animationDelay = '0s';
        this._modal.$el.style.animationDirection = 'reverse';
        this._modal.$el.style.animationName = !isSwitching? 'grow, fade'
            : isSwitchingBack? 'from-right' : 'from-left';
        this._hideTimer = setTimeout(() => this.$el.style.display = 'none', XModalContainer.ANIMATION_TIME);
    }

    _onBackdropClick(e) {
        if (e.target !== this.$el) return; // clicked on a child
        this._modal.hide();
    }

    _onEscape(e) {
        if (e.keyCode !== 27) return; // other key than escape
        this._modal.hide();
    }
}
XModalContainer.ANIMATION_TIME = 400;

const MixinModal = XElementBase => class extends MixinSingleton(XElementBase) {
    onCreate() {
        super.onCreate();
        this._route = this.attribute('x-route-aside');
        this._container = XModalContainer.createFor(this);
        this._container.$el.appendChild(this.$el); // append to the container if not already the case
        XModals.instance.$el.appendChild(this._container.$el); // append to x-modals if not already the case
        this.$closeButton = this.$el.querySelector('[x-modal-close]');
        if (this.$closeButton) this.$closeButton.addEventListener('click', () => this.hide());
    }

    styles() {
        return [ ...super.styles(), 'x-modal', 'nimiq-dark' ];
    }

    static show(...parameters) {
        this.instance.show(...parameters);
    }

    show(...parameters) {
        XModals.show(false, this, ...parameters);
    }

    static hide() {
        this.instance.hide();
    }

    hide() {
        XModals.hide(false, this);
    }

    allowsShow(...parameters) {
        return true;
    }

    allowsHide(incomingModal) {
        return true;
    }

    onShow(...parameters) {
        // abstract method
    }

    onHide() {
        // abstract method
    }

    get container() {
        return this._container;
    }

    get route() {
        return this._route;
    }

    // callbacks for router
    onEntry(...parameters) {
        XModals.show(true, this, ...parameters);
    }

    onExit() {
        XModals.hide(true, this);
    }
};

class LazyLoading {
    static async loadScript(src) {
        let request = LazyLoading.REQUESTS.get(src);
        if (request) return request;
        request = new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.addEventListener('load', resolve, { once: true });
            script.addEventListener('error', reject, { once: true });
            script.type = 'text/javascript';
            script.src = src;
            document.head.appendChild(script);
        });
        LazyLoading.REQUESTS.set(src, request);
        return request;
    }

    static async loadNimiq() {
        let request = LazyLoading.REQUESTS.get('nimiq');
        if (request) return request;
        if (typeof Nimiq === "undefined")
            request = LazyLoading.loadScript(Config.cdn).then(() => Nimiq.loadOffline());
        else if (!Nimiq._loaded) // only nimiq loader was loaded but not actual nimiq code
            request = Nimiq.load();
        else
            request = Promise.resolve();
        request = request.then(() => {
            let genesisConfigInitialized = true;
            try {
                Nimiq.GenesisConfig.NETWORK_ID;
            } catch(e) {
                genesisConfigInitialized = false;
            }
            if (!genesisConfigInitialized) {
                Nimiq.GenesisConfig[Config.network]();
            }
        });
        LazyLoading.REQUESTS.set('nimiq', request);
        return request;
    }
}
LazyLoading.REQUESTS = new Map();

// TODO check for every API call the following flows:
// - ledger not connected yet
// - ledger connected
// - ledger connected but relocked
// - user approved action
// - user denied action
// - request timed out
// - user cancel
// - when in another app: fires unknown error

// TODO handle "device is busy" exception (appears when another request is running ?)

class XLedgerUi extends XElement {
    html() {
        return `
            <div ledger-device-container>
                <div ledger-cable></div>
                <div ledger-device></div>
                <div ledger-screen-pin class="ledger-screen">
                    <div ledger-pin-dot></div>
                    <div ledger-pin-dot></div>
                    <div ledger-pin-dot></div>
                    <div ledger-pin-dot></div>
                    <div ledger-pin-dot></div>
                    <div ledger-pin-dot></div>
                    <div ledger-pin-dot></div>
                    <div ledger-pin-dot></div>
                </div>
                <div ledger-screen-home class="ledger-screen"></div>
                <div ledger-screen-app class="ledger-screen"></div>
                <div ledger-screen-confirm-address class="ledger-screen"></div>
                <div ledger-screen-confirm-transaction class="ledger-screen"></div>
            </div>
            <h3 instructions-title></h3>
            <h4 instructions-text></h4>
        `;
    }

    styles() {
        return [ ...super.styles(), 'x-ledger-ui' ];
    }

    onCreate() {
        this.$instructionsTitle = this.$('[instructions-title]');
        this.$instructionsText = this.$('[instructions-text]');
        this._requests = new Set();
    }

    cancelRequests() {
        for (const request of this._requests) {
            request.cancel();
        }
        this._showInstructions('none');
    }


    async getAddress() {
        const request = this._createRequest(async api => {
            const result = await api.getAddress(XLedgerUi.BIP32_PATH, true, false);
            return result.address;
        });
        return this._callLedger(request);
    }


    async confirmAddress(userFriendlyAddress) {
        const request = this._createRequest(async api => {
            const result = await api.getAddress(XLedgerUi.BIP32_PATH, true, true);
            return result.address;
        }, 'confirm-address', 'Confirm Address', [
            'Confirm that the address on your Ledger matches',
            userFriendlyAddress
        ]);
        return this._callLedger(request);
    }


    async getPublicKey() {
        const request = this._createRequest(async api => {
            const result = await api.getPublicKey(XLedgerUi.BIP32_PATH, true, false);
            return result.publicKey;
        });
        return this._callLedger(request);
    }


    async getConfirmedAddress() {
        const address = await this.getAddress();
        const confirmedAddress = await this.confirmAddress(address);
        if (address !== confirmedAddress) throw Error('Address missmatch');
        return confirmedAddress;
    }


    async signTransaction(transaction) {
        if (!transaction) throw Error('Invalid transaction');
        if (typeof transaction.value !== 'number') throw Error('Invalid transaction value');
        if (typeof transaction.fee !== 'number') throw Error('Invalid transaction fee');
        if (typeof transaction.validityStartHeight !== 'number'
            || Math.round(transaction.validityStartHeight) !== transaction.validityStartHeight)
            throw Error('Invalid validity start height');
        const senderPubKeyBytes = await this.getPublicKey(); // also loads Nimiq as a side effect
        const senderPubKey = Nimiq.PublicKey.unserialize(new Nimiq.SerialBuffer(senderPubKeyBytes));
        const senderAddress = senderPubKey.toAddress().toUserFriendlyAddress();
        if (transaction.sender.replace(/ /g, '') !== senderAddress.replace(/ /g, ''))
            throw Error('Sender Address doesn\'t match this ledger account');
        const genesisConfig = Nimiq.GenesisConfig.CONFIGS[transaction.network];
        if (!genesisConfig) throw Error('Invalid network');
        const networkId = genesisConfig.NETWORK_ID;
        const recipient = Nimiq.Address.fromUserFriendlyAddress(transaction.recipient);
        const value = Nimiq.Policy.coinsToSatoshis(transaction.value);
        const fee = Nimiq.Policy.coinsToSatoshis(transaction.fee);
        // for now only basic transactions allowed
        const nimiqTx = new Nimiq.BasicTransaction(senderPubKey, recipient, value, fee, transaction.validityStartHeight,
            undefined, networkId);

        const request = this._createRequest(async api => {
            const signature = (await api.signTransaction(XLedgerUi.BIP32_PATH, nimiqTx.serializeContent())).signature;
            transaction.signature = signature;
            transaction.senderPubKey = senderPubKeyBytes;
            transaction.hash = nimiqTx.hash().toBase64();
            return transaction;
        }, 'confirm-transaction', 'Confirm transaction', [
            'Confirm on your Ledger if you want to send the following transaction:',
            `From: ${transaction.sender}`,
            `To: ${transaction.recipient}`,
            `Value: ${transaction.value}`,
            `Fee: ${transaction.fee}`
        ]);
        return this._callLedger(request);
    }

    _showInstructions(type, title=null, text=null) {
        this.$el.setAttribute('instructions', type || 'none');
        this.$instructionsTitle.textContent = title? title : '';
        if (Array.isArray(text)) {
            this.$instructionsText.textContent = ''; // clear
            text.forEach(line => {
                const el = document.createElement('div');
                el.textContent = line;
                this.$instructionsText.appendChild(el);
            });
        } else {
            this.$instructionsText.textContent = text? text : '';
        }
    }

    _createRequest(call, instructions=null, instructionsTitle=null, instructionsText=null) {
        const request = {
            call,
            instructions,
            instructionsTitle,
            instructionsText,
            cancelled: false,
            cancel: () => {
                request.cancelled=true;
                request._reject('Request cancelled');
                this._requests.delete(request);
            },
            setReject: reject => request._reject = reject
        };
        return request;
    }


    async _callLedger(request) {
        if (request.cancelled) throw Error('Request cancelled');
        return new Promise(async (resolve, reject) => {
            try {
                request.setReject(reject);
                this._requests.add(request);
                // TODO should not set the instructions to none on retry after timeout
                this._showInstructions('none'); // don't show any instructions until we know we should show connect
                // instructions or the provided instructions for this call.
                const api = await this._connect(request);
                this._showInstructions(request.instructions, request.instructionsTitle, request.instructionsText);
                var start = Date.now();
                const result = await request.call(api);
                this._requests.delete(request);
                this._showInstructions('none');
                resolve(result);
            } catch(e) {
                console.log('Timeout after', (Date.now() - start) / 1000);
                reject(e);
            }
        }).catch(async e => {
            // catch outside of the promise to also be able to catch rejections by request.cancel
            // TODO refactor request cancellation
            console.log(e);
            const message = (e.message || e || '').toLowerCase();
            if (message.indexOf('denied') !== -1 // for confirmAddress
                || message.indexOf('rejected') !== -1 // for signTransaction
                || message.indexOf('cancelled') !== -1) { // for cancellation in the ui
                // user cancelled or denied the request
                this._requests.delete(request);
                this._showInstructions('none');
                throw e;
            } else {
                if (message.indexOf('timeout') === -1) {
                    console.warn('Unknown ledger call error', e);
                }
                // TODO experiment with lower wait times
                await new Promise(resolve => setTimeout(resolve, 3000)); // wait some time to make sure the call also
                // time outed on the ledger device before we resend the request to be able to replace the old one
                return this._callLedger(request);
            }
        });
    }

    async _connect(request) {
        // resolves when connected to unlocked ledger with open Nimiq app
        if (request.cancelled) throw Error('Request cancelled');
        // if the Ledger is already connected and the library already loaded, the call typically takes < 200ms.
        // If it takes longer, we ask the user to connect his ledger.
        const connectInstructionsTimeout = setTimeout(() => this._showInstructions('connect', 'Connect'), 250);
        try {
            const api = await this._getApi();
            // TODO check whether app configurations says that actually the nimiq app is opened
            await api.getAppConfiguration(); // to check whether the connection is established
            return api;
        } catch(e) {
            console.log(e);
            const message = (e.message || e || '').toLowerCase();
            if (message.indexOf('cancelled') !== -1) {
                throw e;
            } else if (message.indexOf('timeout') !== -1) {
                return await this._connect(request);
            } else {
                if (message.indexOf('locked') === -1) console.warn('Unknown ledger connect error', e);
                await new Promise(resolve => setTimeout(resolve, 500));
                return await this._connect(request);
            }
        } finally {
            this._showInstructions('none');
            clearTimeout(connectInstructionsTimeout);
        }
    }

    async _getApi() {
        XLedgerUi._api = XLedgerUi._api
            || this._loadLibraries().then(() => LedgerjsNimiq.Transport.create())
                .then(transport => new LedgerjsNimiq.Api(transport));
        return XLedgerUi._api;
    }

    async _loadLibraries() {
        // TODO also lazy load the illustrations
        await Promise.all([
            LazyLoading.loadScript(XLedgerUi.LIB_PATH),
            LazyLoading.loadNimiq()
        ]);
    }
}
XLedgerUi.BIP32_PATH = "44'/242'/0'/0'";
// @asset(ledgerjs-nimiq.min.js)
XLedgerUi.LIB_PATH = 'ledgerjs-nimiq.min.js';

class XLedgerUiModal extends MixinModal(XLedgerUi) {
    styles() {
        return [ ...super.styles(), 'nimiq-dark' ];
    }

    onHide() {
        this.cancelRequests();
    }

    _showInstructions(type, title, text) {
        if ((type && type !== 'none') || title || text) {
            this.show();
        }
        super._showInstructions(type, title, text);
    }

    cancelRequests() {
        super.cancelRequests();
        this.hide();
    }

/*  // TODO hiding modal for getAddress, confirmAddress and getPublicKey shouldn't be done this way, as they also get
    // called within getConfirmedAddress and signTransaction
    async getAddress() {
        try {
            return await super.getAddress();
        } finally {
            this.hide();
        }
    }

    async confirmAddress(userFriendlyAddress) {
        try {
            return await super.confirmAddress(userFriendlyAddress);
        } finally {
            this.hide();
        }
    }

    async getPublicKey() {
        try {
            return await super.getPublicKey();
        } finally {
            this.hide();
        }
    }*/

    async getConfirmedAddress() {
        try {
            return await super.getConfirmedAddress();
        } finally {
            this.hide();
        }
    }

    async signTransaction(transaction) {
        try {
            return await super.signTransaction(transaction);
        } finally {
            this.hide();
        }
    }
}

class XToast extends MixinSingleton(XElement) {

    html() {
        return '<div toast-content></div>';
    }

    onCreate() {
        this.$toastContent = this.$('[toast-content]');
    }

    show(message, type) {
        this.$toastContent.textContent = message;
        this.$toastContent.className = type;
        this.animate('x-toast-show');
    }

    static show(message, type = "normal"){
        XToast.instance.show(message, type);
    }

    static success(message){
        XToast.instance.show(message, 'success');
    }

    static warn(message){
        XToast.instance.show(message, 'warning');
    }

    static warning(message){
        XToast.instance.show(message, 'warning');
    }

    static error(message){
        XToast.instance.show(message, 'error');
    }
}

// Inspired by: https://material.io/guidelines/components/snackbars-toasts.html#snackbars-toasts-specs

class LedgerClient {
    async sign(transaction) {
        let signedTransaction = null;
        try {
            signedTransaction = await XLedgerUiModal.instance.signTransaction(transaction);
        } catch(e) {
            XToast.warning('Transaction cancelled');
        }
        return signedTransaction;
    }

    async getAddress(confirm = false) {
        if (confirm) {
            return XLedgerUiModal.instance.getConfirmedAddress();
        } else {
            return XLedgerUiModal.instance.getAddress();
        }
    }
}

const AccountType = {
    KEYGUARD_HIGH: 1,
    KEYGUARD_LOW: 2,
    LEDGER: 3,
    VESTING: 4
};

// todo, to be discussed: abstract the functionality we need here in a generic network store OR consider network-client
// as generic solution, so network-client should move to libraries? - We could also move the async functions to
// account-manager.js

const TypeKeys$1 = {
    ADD_KEY: 'accounts/add-key',
    SET_ALL_KEYS: 'accounts/set-all-keys',
    UPDATE_BALANCES: 'accounts/update-balances',
    UPDATE_LABEL: 'accounts/update-label',
    UPGRADE_CANCELED: 'accounts/upgrade-canceled',
    UPGRADE: 'accounts/upgrade'
};

function reducer$1(state, action) {
    if (state === undefined) {
        return {
            entries: new Map(),
            loading: false,
            hasContent: false,
            error: null
        }
    }

    switch (action.type) {
        case TypeKeys$1.ADD_KEY:
            return Object.assign({}, state, {
                hasContent: true,
                entries: new Map(state.entries)
                    .set(action.key.address, Object.assign({}, action.key, {
                        balance: undefined
                    }))
            });

        case TypeKeys$1.SET_ALL_KEYS:
            const newEntries = action.keys.map(x => {
                const oldEntry = state.entries.get(x.address);

                return [
                    x.address,
                    Object.assign({}, oldEntry, x)
                ];
            });

            return Object.assign({}, state, {
                hasContent: true,
                // convert array to map with address as key
                entries: new Map(newEntries)
            });

        case TypeKeys$1.UPDATE_BALANCES: {
            const entries = new Map(state.entries);
            for (const [address, balance] of action.balances) {
                entries.set(address, Object.assign({}, entries.get(address), { balance }));
            }

            return Object.assign({}, state, {
                entries
            });
        }

        case TypeKeys$1.UPDATE_LABEL: {
            const entries = new Map(state.entries);
            entries.set(action.address, Object.assign({}, state.entries.get(action.address), { label: action.label }));

            return Object.assign({}, state, {
                entries
            });
        }

        case TypeKeys$1.UPGRADE_CANCELED: {
            const entries = new Map(state.entries);
            entries.set(action.address, Object.assign({}, state.entries.get(action.address), {
                upgradeCanceled: Date.now()
            }));

            return Object.assign({}, state, {
                entries
            });
        }

        case TypeKeys$1.UPGRADE: {
            const entries = new Map(state.entries);
            entries.set(action.address, Object.assign({}, state.entries.get(action.address), {
                type: AccountType.KEYGUARD_HIGH
            }));

            return Object.assign({}, state, {
                entries
            });
        }

        default:
            return state
    }
}

function addAccount(key) {
    return async dispatch => {
        if (!Config.offline) {
            // when adding a new account, subscribe at network
            const rpcClient = await networkClient.rpcClient;
            rpcClient.subscribe(key.address);
        }

        dispatch({
            type: TypeKeys$1.ADD_KEY,
            key
        });
    }
}

function setAllKeys(keys) {
    return async dispatch => {
        if (!Config.offline) {
            // when adding a new account, subscribe at network.
            const rpcClient = await networkClient.rpcClient;
            rpcClient.subscribe(keys.map(key => key.address));
        }

        dispatch({
            type: TypeKeys$1.SET_ALL_KEYS,
            keys
        });
    }
}

function updateBalances(balances) {
    return {
        type: TypeKeys$1.UPDATE_BALANCES,
        balances
    }
}

function updateLabel(address, label) {
    return {
        type: TypeKeys$1.UPDATE_LABEL,
        address,
        label
    }
}

function upgradeCanceled(address) {
    return {
        type: TypeKeys$1.UPGRADE_CANCELED,
        address
    }
}

function upgrade(address) {
    return {
        type: TypeKeys$1.UPGRADE,
        address
    }
}

class AccountManager {
    static getInstance() {
        this._instance = this._instance || new AccountManager();
        window.accountManager = this._instance;
        return this._instance;
    }

    constructor() {
        this._launched = new Promise(res => this._resolveLaunched = res);
    }

    async launch() {
        const [keyguardClient, ledgerClient, vestingClient, accountStore] = await Promise.all([
            /* KeyguardClient */ KeyguardClient.create(Config.src('keyguard'), new SafePolicy(), () => {}),
            /* LedgerClient */ new LedgerClient(),
            /* VestingClient */ VestingClient.create(),
            /* AccountStore */ {
                get: (address) => MixinRedux.store.getState().accounts.entries.get(address),
                findLedgers: () => [...MixinRedux.store.getState().accounts.entries.values()].filter(x => x.type === 3)
            }
        ]);

        this._bindClients(keyguardClient, ledgerClient, vestingClient, accountStore);

        this._bindStore();

        // Kick off writing accounts to the store
        this._populateAccounts();

        this._resolveLaunched();
    }

    _bindClients(keyguardClient, ledgerClient, vestingClient, accountStore) {
        this.keyguard = keyguardClient;
        this.ledger = ledgerClient;
        this.vesting = vestingClient;
        this.accounts = accountStore;
    }

    _bindStore() {
        this.store = MixinRedux.store;

        this.actions = bindActionCreators({
            addAccount,
            setAllKeys,
            updateLabel,
            upgrade
        }, this.store.dispatch);
    }

    async _populateAccounts() {
        await this._launched;

        const keyguardKeys = (await this.keyguard.list())
            .map(key => Object.assign({}, key, {
                type: key.type === 'high' ? AccountType.KEYGUARD_HIGH : AccountType.KEYGUARD_LOW
            }));

        // Find all stored ledger accounts
        const ledgerKeys = this.accounts.findLedgers();

        let keys = keyguardKeys.concat(ledgerKeys);

        let vestingKeys;
        if (keys.length) {
            vestingKeys = (await this.vesting.find(keys.map(key => key.address)))
                .map((key, i) => Object.assign({}, key, {
                    type: AccountType.VESTING,
                    label: `Vesting Contract`
                }));
        }
        else vestingKeys = [];
        // console.log("Found contracts:", vestingKeys);

        keys = keys.concat(vestingKeys);

        this.actions.setAllKeys(keys);
    }

    /// PUBLIC API ///

    // async getDefaultAccount() {
    //     const defaultAccount = await this.keyguard.getDefaultAccount();
    //     defaultAccount.type = defaultAccount.type === 'high' ? AccountType.KEYGUARD_HIGH : AccountType.KEYGUARD_LOW;
    //     return defaultAccount;
    // }

    async createSafe() {
        await this._launched;
        // TODO Show UI for choice between Keyguard and Ledger account creation
        const newKey = await this._invoke('createSafe', {type: AccountType.KEYGUARD_HIGH});
        newKey.type = AccountType.KEYGUARD_HIGH;
        this.actions.addAccount(newKey);
    }

    async createWallet() {
        await this._launched;
        const newKey = await this._invoke('createWallet', {type: AccountType.KEYGUARD_LOW});
        newKey.type = AccountType.KEYGUARD_LOW;
        this.actions.addAccount(newKey);

        // TODO return encryptedPrivKey
    }

    async sign(tx) {
        await this._launched;
        const account = this.accounts.get(tx.sender);
        return this._invoke('sign', account, tx);
    }

    async rename(address) {
        await this._launched;
        const account = this.accounts.get(address);
        const label = await this._invoke('rename', account, address);
        this.actions.updateLabel(account.address, label);
    }

    async upgrade(address) {
        await this._launched;
        const account = this.accounts.get(address);
        const success = await this._invoke('upgrade', account, address);
        if (success) {
            this.actions.upgrade(account.address);
        }
    }

    async backupFile(address) {
        await this._launched;
        const account = this.accounts.get(address);
        return this._invoke('backupFile', account, address);
    }

    async backupWords(address) {
        await this._launched;
        const account = this.accounts.get(address);
        this._invoke('backupWords', account, address);
    }

    async importFromFile() {
        await this._launched;
        const newKey = await this.keyguard.importFromFile();
        newKey.type = newKey.type === 'high' ? AccountType.KEYGUARD_HIGH : AccountType.KEYGUARD_LOW;
        this.actions.addAccount(newKey);
    }

    async importFromWords() {
        await this._launched;
        const newKey = await this.keyguard.importFromWords();
        newKey.type = newKey.type === 'high' ? AccountType.KEYGUARD_HIGH : AccountType.KEYGUARD_LOW;
        this.actions.addAccount(newKey);
    }

    async importLedger() {
        await this._launched;
        const newKey = {
            address: await this.ledger.getAddress(true),
            type: AccountType.LEDGER,
            label: 'Ledger Account'
        };
        this.actions.addAccount(newKey);
    }

    // signMessage(msg, address) {
    //     throw new Error('Not implemented!'); return;

    //     const account = this.accounts.get(address);
    //     this._invoke('signMessage', account);
    // }

    _invoke(method, account, ...args) {
        // method = methodDict[method][account.type];
        // if (!method) throw new Error(`Method >${method}< not defined for accounts of type ${account.type}!`);

        switch (account.type) {
            case AccountType.KEYGUARD_HIGH:
                if (method === 'sign') method = 'signSafe';
                return this.keyguard[method](...args);
            case AccountType.KEYGUARD_LOW:
                if (method === 'sign') method = 'signWallet';
                return this.keyguard[method](...args);
            case AccountType.LEDGER:
                return this.ledger[method](...args);
            case AccountType.VESTING:
                return this.vesting[method](...args);
            default:
                throw new Error(`Account type ${account.type} not in use!`);
        }
    }
}

var accountManager = AccountManager.getInstance();

// export default methodDict = {
//     'sign': {
//         1: 'sign',
//         2: null,
//         3: null
//     },
//     'rename': {
//         1: 'rename',
//         2: null,
//         3: null
//     },
//     'export': {
//         1: 'export',
//         2: null,
//         3: null
//     },
//     'signMessage': {
//         1: 'signMessage',
//         2: null,
//         3: null
//     }
// }

function dashToSpace(string) {
    if (typeof string !== 'string') return null;
    return string.replace(/-/gi, ' ');
}

function spaceToDash(string) {
    if (typeof string !== 'string') return null;
    return string.replace(/ /gi, '-');
}

class XNetworkIndicator extends MixinRedux(XElement) {
    html() {
        return `
            <hr>
            <div><label>Consensus</label> <span consensus></span></div>
            <div><label>Connected peers</label> <span peerCount></span></div>
            <div><label>Blockchain height</label> <span height></span></div>
            <div><label>Global hashrate</label> <span globalHashrate></span></div>
        `;
    }

    onCreate() {
        this.$consensus = this.$('span[consensus]');
        this.$height = this.$('span[height]');
        this.$peerCount = this.$('span[peerCount]');
        this.$globalHashrate = this.$('span[globalHashrate]');
        super.onCreate();
    }

    static mapStateToProps(state) {
        return state.network
    }

    _onPropertiesChanged(changes) {
        for (const prop in changes) {
            this[prop] = changes[prop];
        }
    }

    set consensus(consensus) {
        this.$consensus.textContent = consensus;
        if (Config.offline) this.$consensus.textContent = 'offline';
    }

    set height(height) {
        this.$height.textContent = `#${height}`;
        if (Config.offline) this.$height.textContent = '-';
    }

    set peerCount(peerCount) {
        this.$peerCount.textContent = peerCount;
        if (Config.offline) this.$peerCount.textContent = '-';
    }

    set globalHashrate(globalHashrate) {
        this.$globalHashrate.textContent = this._formatHashrate(globalHashrate);
        if (Config.offline) this.$globalHashrate.textContent = '-';
    }

    _formatHashrate(hashrate) {
        // kilo, mega, giga, tera, peta, exa, zetta
        const unit_prefix = ['', 'K', 'M', 'G', 'T', 'P', 'E', 'Z'];

        for (let i = 0; i < unit_prefix.length - 1; i++) {
            if (hashrate < 1000) return `${hashrate.toFixed(2)} ${unit_prefix[i]}H/s`;
            hashrate = hashrate / 1000;
        }

        throw new Error('Hashrate higher than 1000 ZH/s');
    }
}

class XExpandable extends XElement {

    html() {
        // the content that goes into this component is expected to have an [expandable-trigger]
        // and an [expandable-content]
        return `
            <div data-x-content></div>
        `;
    }

    onCreate() {
        this._expanded = false;
        this._expandTimeout = null;
        this._collapseTimeout = null;
        this._isDropdown = this.$el.hasAttribute('dropdown');
        this._disabled = this.$el.hasAttribute('disabled');
        this.$content = this.$('[expandable-content]');
        this.$el.addEventListener('click', e => this._onClickToggle(e));
        if (this._isDropdown) {
            // if it is a dropdown, make it closable by a body click
            this.$el.addEventListener('click', e => e.stopPropagation()); // to avoid body click
            this.collapse = this.collapse.bind(this);
        }
        super.onCreate();
    }

    toggle() {
        if (this._expanded) {
            this.collapse();
        } else {
            this.expand();
        }
    }

    expand() {
        if (this._expanded || this._disabled) return;
        this._expanded = true;
        clearTimeout(this._collapseTimeout);
        this.$content.style.display = 'block';
        this.$content.offsetWidth; // style update
        this.$content.style.maxHeight = this.$content.scrollHeight + 'px';
        if (this._isDropdown) {
            document.body.addEventListener('click', this.collapse);
        }
        this._expandTimeout = setTimeout(() => {
            // while expanded remove the max height in case that the content changes in size
            this.$content.style.maxHeight = 'unset';
        }, XExpandable.ANIMATION_TIME);
    }

    collapse() {
        if (!this._expanded || this._disabled) return;
        this._expanded = false;
        clearTimeout(this._expandTimeout);
        // set the start height to transition from
        this.$content.style.maxHeight = this.$content.scrollHeight + 'px';
        this.$content.offsetWidth; // style update
        this.$content.style.maxHeight = '0';
        if (this._isDropdown) {
            document.body.removeEventListener('click', this.collapse);
        }
        this._collapseTimeout = setTimeout(() => {
            this.$content.style.display = 'none';
        }, XExpandable.ANIMATION_TIME);
    }

    disable() {
        this.collapse();
        this._disabled = true;
        this.$el.setAttribute('disabled', '');
    }

    enable() {
        this._disabled = false;
        this.$el.removeAttribute('disabled');
    }

    _onClickToggle(e) {
        // Toggle when clicked on the expandable but not on the content
        let isTargetContent = false;
        let target = e.target;
        while (target) {
            if (target === this.$content) {
                isTargetContent = true;
                break;
            }
            target = target.parentNode;
        }
        if (isTargetContent) return;
        this.toggle();
    }
}
XExpandable.ANIMATION_TIME = 500;

class XAmount extends XElement {
    html(){
        return `
            <label class="display-none"></label>
            <span class="dot-loader"></span>
            <x-currency-nim>
                <span class="integers"></span>.<span class="main-decimals"></span><span class="rest-decimals"></span> <span class="ticker">NIM</span>
            </x-currency-nim>
        `
    }

    onCreate() {
        if (Config.offline) {
            this.$el.removeChild(this.$('span.dot-loader'));
            this.$el.classList.add('display-none');
            return;
        }

        if (this.attributes.white !== undefined) this.$('.dot-loader').classList.add('white');
        this.$label = this.$('label');
        if (this.attributes.label !== undefined) {
            this.$label.textContent = this.attributes.label;
            this.$label.classList.remove('display-none');
        }
        this.$integers = this.$('span.integers');
        this.$mainDecimals = this.$('span.main-decimals');
        this.$restDecimals = this.$('span.rest-decimals');
        this.$currencyNim = this.$('x-currency-nim');
    }

    set type(type) {
        this.$el.classList.remove('incoming', 'outgoing', 'transfer');
        type && this.$el.classList.add(type);
    }

    set value(value) {
        if (Config.offline) return;

        value = Number(value) || 0;
        value = Math.round(value * 100000) / 100000;

        const valueStr = value.toFixed(5);
        let [i, d] = valueStr.split('.');

        const integers = this._formatThousands(i);
        const mainDecimals = d.slice(0, 2);
        const restDecimals = d.slice(2);

        if (this.$('span.dot-loader')) this.$el.removeChild(this.$('span.dot-loader'));

        this.$integers.textContent = integers;
        this.$mainDecimals.textContent = mainDecimals;
        this.$restDecimals.textContent = restDecimals;
        this.$currencyNim.style.display = 'inline';
    }

    // _formatThousands(number, separator = '‘') {
    // _formatThousands(number, separator = '\'') {
    _formatThousands(number, separator = ' ') {
        let reversed = number.split('').reverse();
        for(let i = 3; i < reversed.length; i += 4) {
            reversed.splice(i, 0, separator);
        }
        return reversed.reverse().join('');
    }
}

var IqonsCatalog = {
face : ['face_01','face_02','face_03','face_04','face_05','face_06','face_07','face_08','face_09','face_10','face_11','face_12','face_13','face_14','face_15','face_16','face_17','face_18','face_19','face_20','face_21',],
side : ['side_01','side_02','side_03','side_04','side_05','side_06','side_07','side_08','side_09','side_10','side_11','side_12','side_13','side_14','side_15','side_16','side_17','side_18','side_19','side_20','side_21',],
top : ['top_01','top_02','top_03','top_04','top_05','top_06','top_07','top_08','top_09','top_10','top_11','top_12','top_13','top_14','top_15','top_16','top_17','top_18','top_19','top_20','top_21',],
bottom : ['bottom_01','bottom_02','bottom_03','bottom_04','bottom_05','bottom_06','bottom_07','bottom_08','bottom_09','bottom_10','bottom_11','bottom_12','bottom_13','bottom_14','bottom_15','bottom_16','bottom_17','bottom_18','bottom_19','bottom_20','bottom_21',],
};

class Iqons{static async svg(t,s=!1){const e=this._hash(t);return this._svgTemplate(e[0],e[2],e[3]+e[4],e[5]+e[6],e[7]+e[8],e[9]+e[10],e[11],e[12],s)}static async render(t,s){s.innerHTML=await this.svg(t);}static async toDataUrl(t){return`data:image/svg+xml;base64, ${btoa(await this.svg(t,!0)).replace(/#/g,"%23")}`}static placeholder(t="#bbb",s=1){return`\n            <svg viewBox="0 0 160 160" width="160" height="160" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/2000/xlink" >\n                <path fill="none" stroke="${t}" stroke-width="${2*s}" transform="translate(0, 8) scale(0.5)" d="M251.6 17.34l63.53 110.03c5.72 9.9 5.72 22.1 0 32L251.6 269.4c-5.7 9.9-16.27 16-27.7 16H96.83c-11.43 0-22-6.1-27.7-16L5.6 159.37c-5.7-9.9-5.7-22.1 0-32L69.14 17.34c5.72-9.9 16.28-16 27.7-16H223.9c11.43 0 22 6.1 27.7 16z"/>\n                <g transform="scale(0.9) translate(9, 8)">\n                    <circle cx="80" cy="80" r="40" fill="none" stroke="${t}" stroke-width="${s}" opacity=".9"></circle>\n                    <g opacity=".1" fill="#010101"><path d="M119.21,80a39.46,39.46,0,0,1-67.13,28.13c10.36,2.33,36,3,49.82-14.28,10.39-12.47,8.31-33.23,4.16-43.26A39.35,39.35,0,0,1,119.21,80Z"/></g>\`\n                </g>\n            </svg>`}static renderPlaceholder(t,s=null,e=null){t.innerHTML=this.placeholder(s,e);}static placeholderToDataUrl(t=null,s=null){return`data:image/svg+xml;base64,${btoa(this.placeholder(t,s))}`}static async image(t){const s=await this.toDataUrl(t),e=await this._loadImage(s);return e.style.width="100%", e.style.height="100%", e}static async _svgTemplate(t,s,e,a,n,r,i,c,l){return this._$svg(await this._$iqons(t,s,e,a,n,r,i,l),c)}static async _$iqons(t,s,e,a,n,r,i,c){for(t=parseInt(t), s=parseInt(s), i=parseInt(i), t===s&&++t>9&&(t=0);i===t||i===s;)++i>9&&(i=0);return t=this.colors[t], s=this.colors[s], `\n            <g color="${t}" fill="${i=this.colors[i]}">\n                <rect fill="${s}" x="0" y="0" width="160" height="160"></rect>\n                <circle cx="80" cy="80" r="40" fill="${t}"></circle>\n                <g opacity=".1" fill="#010101"><path d="M119.21,80a39.46,39.46,0,0,1-67.13,28.13c10.36,2.33,36,3,49.82-14.28,10.39-12.47,8.31-33.23,4.16-43.26A39.35,39.35,0,0,1,119.21,80Z"/></g>\n                ${await this._generatePart("top",a,c)}\n                ${await this._generatePart("side",n,c)}\n                ${await this._generatePart("face",e,c)}\n                ${await this._generatePart("bottom",r,c)}\n            </g>`}static _$svg(t,s){const e=Random.getRandomId();return`\n            <svg viewBox="0 0 160 160" width="160" height="160" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/2000/xlink" >\n                <defs>\n                    <clipPath id="hexagon-clip-${e}" transform="scale(0.5) translate(0, 16)">\n                        <path d="M251.6 17.34l63.53 110.03c5.72 9.9 5.72 22.1 0 32L251.6 269.4c-5.7 9.9-16.27 16-27.7 16H96.83c-11.43 0-22-6.1-27.7-16L5.6 159.37c-5.7-9.9-5.7-22.1 0-32L69.14 17.34c5.72-9.9 16.28-16 27.7-16H223.9c11.43 0 22 6.1 27.7 16z"/>\n                    </clipPath>\n                </defs>\n                <path fill="white" stroke="#bbbbbb" transform="translate(0, 8) scale(0.5)" d="M251.6 17.34l63.53 110.03c5.72 9.9 5.72 22.1 0 32L251.6 269.4c-5.7 9.9-16.27 16-27.7 16H96.83c-11.43 0-22-6.1-27.7-16L5.6 159.37c-5.7-9.9-5.7-22.1 0-32L69.14 17.34c5.72-9.9 16.28-16 27.7-16H223.9c11.43 0 22 6.1 27.7 16z"/>\n                <g transform="scale(0.9) translate(9, 8)">\n                    <g clip-path="url(#hexagon-clip-${e})">\n                        ${t}\n                    </g>\n                </g>\n            </svg>`}static async _generatePart(t,s,e=!1){
/* @asset(iqons.min.svg) */
if(e){const e=await this._getAssets(),a="#"+t+"_"+this._assetIndex(s,t);return e.querySelector(a).innerHTML}return`<use width="160" height="160" xlink:href="iqons.min.svg#${t}_${this._assetIndex(s,t)}"/>`}static _loadImage(t){return new Promise((s,e)=>{const a=document.createElement("img");a.addEventListener("load",t=>s(a),{once:!0}), a.src=t;})}static async _getAssets(){return this._assets?this._assets:(this._assets=fetch("iqons.min.svg").then(t=>t.text()).then(t=>{const s=document.createElement("x-assets");return s.innerHTML=t,this._assets=s,s}), this._assets)}static get colors(){return["#fb8c00","#d32f2f","#fbc02d","#3949ab","#03a9f4","#8e24aa","#009688","#f06292","#7cb342","#795548"]}static get assetCounts(){return{face:IqonsCatalog.face.length,side:IqonsCatalog.side.length,top:IqonsCatalog.top.length,bottom:IqonsCatalog.bottom.length,gaze:2}}static _assetIndex(t,s){return(t=Number(t)%Iqons.assetCounts[s]+1)<10&&(t="0"+t), t}static _hash(t){return(""+t.split("").map(t=>Number(t.charCodeAt(0))+3).reduce((t,s)=>t*(1-t)*this.__chaosHash(s),.5)).split("").reduce((t,s)=>s+t,"").substr(4,17)}static __chaosHash(t){let s=1/t;for(let t=0;t<100;t++)s=(1-s)*s*3.569956786876;return s}}

class ValidationUtils {
    static isValidAddress(address) {
        if (!address) return false;
        try {
            this.isUserFriendlyAddress(address);
            return true;
        } catch (e) {
            return false;
        }
    }

    // Copied from: https://github.com/nimiq-network/core/blob/master/src/main/generic/consensus/base/account/Address.js

    static isUserFriendlyAddress(str) {
        if (!str) return;

        str = str.replace(/ /g, '');
        if (str.substr(0, 2).toUpperCase() !== 'NQ') {
            throw new Error('Addresses start with NQ', 201);
        }
        if (str.length !== 36) {
            throw new Error('Addresses are 36 chars (ignoring spaces)', 202);
        }
        if (this._ibanCheck(str.substr(4) + str.substr(0, 4)) !== 1) {
            throw new Error('Address Checksum invalid', 203);
        }
    }

    static _ibanCheck(str) {
        const num = str.split('').map((c) => {
            const code = c.toUpperCase().charCodeAt(0);
            return code >= 48 && code <= 57 ? c : (code - 55).toString();
        }).join('');
        let tmp = '';

        for (let i = 0; i < Math.ceil(num.length / 6); i++) {
            tmp = (parseInt(tmp + num.substr(i * 6, 6)) % 97).toString();
        }

        return parseInt(tmp);
    }

    static isValidHash(hash) {
        // not using Nimiq Api here to don't require it to be loaded already
        try {
            return atob(hash).length === 32;
        } catch(e) {
            return false;
        }
    }
}

class XIdenticon extends XElement {

    html() {
        return '<img width="100%" height="100%">';
    }

    onCreate() {
        this.$img = this.$('img');
        this.placeholderColor = 'white';
    }

    _onPropertiesChanged() {
        this.address = this.properties.address;
    }

    set placeholderColor(color) {
        this._placeholderColor = color;
        this.address = this._address; // rerender
    }

    set address(address) {
        this._address = address;
        if (ValidationUtils.isValidAddress(address)) {
            Iqons.toDataUrl(address.toUpperCase()).then(dataUrl => this.$img.src = dataUrl);
        } else {
            this.$img.src = Iqons.placeholderToDataUrl(this._placeholderColor, Infinity);
        }
    }

    get address() {
        return this._address;
    }

    set addressAsSvg(address) {
        // also clears the inner html of this tag
        if (ValidationUtils.isValidAddress(address)) {
            Iqons.render(address, this.$el);
        } else {
            Iqons.renderPlaceholder(this.$el, this._placeholderColor, Infinity);
        }
    }
}

class Clipboard {
    static copy(text) {
        // A <span> contains the text to copy
        const span = document.createElement('span');
        span.textContent = text;
        span.style.whiteSpace = 'pre'; // Preserve consecutive spaces and newlines

        // Paint the span outside the viewport
        span.style.position = 'absolute';
        span.style.left = '-9999px';
        span.style.top = '-9999px';

        const win = window;
        const selection = win.getSelection();
        win.document.body.appendChild(span);

        const range = win.document.createRange();
        selection.removeAllRanges();
        range.selectNode(span);
        selection.addRange(range);

        let success = false;
        try {
            success = win.document.execCommand('copy');
        } catch (err) {}

        selection.removeAllRanges();
        span.remove();

        return success;
    }
}

class XAddress extends XElement {
    styles() { return ['x-address'] }

    listeners() {
        return {
            'click': this._onCopy
        }
    }

    _onCopy() {
        Clipboard.copy(this.$el.textContent);
        XToast.show('Account number copied to clipboard!');
    }

    set address(address) {
        if (ValidationUtils.isValidAddress(address)) {
            this.$el.textContent = address;
        } else {
            this.$el.textContent = '';
        }
    }
}

class XAccount extends MixinRedux(XElement) {
    html() {
        return `
            <x-identicon></x-identicon>
            <i class="account-icon material-icons"></i>
            <div class="x-account-info">
                <span class="x-account-label"></span>
                <x-address></x-address>
                <div class="x-account-bottom">
                    <x-amount></x-amount>
                </div>
            </div>
        `
    }

    children() { return [XIdenticon, XAddress, XAmount] }

    onCreate() {
        this.$label = this.$('.x-account-label');
        this.$icon = this.$('.account-icon');
        this.$balance = this.$amount[0] || this.$amount;
        super.onCreate();
    }

    listeners() {
        return {
            'click': this._onAccountSelected
        }
    }

    static mapStateToProps(state, props) {
        return Object.assign({},
            state.accounts.entries.get(props.address)
        )
    }

    _onPropertiesChanged(changes) {
        for (const prop in changes) {
            if (changes[prop] !== undefined) {
                // Update display
                this[prop] = changes[prop];
            }
        }
    }

    set label(label) {
        this.$label.textContent = label;
    }

    set address(address) {
        this.$identicon.address = address;
        this.$address.address = address;
    }

    set balance(balance) {
        this.$balance.value = balance;
    }

    set type(type) {
        this.$icon.classList.remove('secure-icon', 'ledger-icon', 'vesting-icon');

        switch (type) {
            case 1: // KEYGUARD_HIGH
                this.$icon.classList.add('secure-icon');
                this.$icon.classList.remove('display-none');
                this.$icon.setAttribute('title', 'High security account');
                break;
            case 3: // LEDGER
                this.$icon.classList.add('ledger-icon');
                this.$icon.classList.remove('display-none');
                this.$icon.setAttribute('title', 'Ledger account');
                break;
            case 4: // VESTING
                this.$icon.classList.add('vesting-icon');
                this.$icon.classList.remove('display-none');
                this.$icon.setAttribute('title', 'Vesting contract');
                break;
            default: // KEYGUARD_LOW
                this.$icon.classList.add('display-none');
                this.$icon.setAttribute('title', '');
                break;
        }
    }

    set account(account) {
        this.setProperties(account, true);
    }

    get account() {
        return this.properties;
    }

    _onAccountSelected() {
        this.fire('x-account-selected', this.account.address);
    }
}

class XNoAccounts extends XElement {
    html() {
        return `
            <h1 class="material-icons">account_circle</h1>
            Click the <i class="material-icons">add</i> icon to add an account
        `
    }
}

class XAccountsList extends MixinRedux(XElement) {
    html() {
        return `
            <x-loading-animation></x-loading-animation>
            <h2>Loading accounts...</h2>
        `;
    }

    onCreate() {
        this._accountEntries = new Map();
        super.onCreate();
    }

    static mapStateToProps(state) {
        return {
            accounts: state.accounts.entries,
            hasContent: state.accounts.hasContent
        };
    }

    _onPropertiesChanged(changes) {
        const { hasContent, accounts } = this.properties;

        if (!hasContent) return;

        if (changes.accounts) {
            if (this.$('x-loading-animation') || this.$('x-no-accounts')) {
                this.$el.textContent = ''; // remove loading animation
            }

            for (const [ address, account ] of changes.accounts) {
                const $account = this._accountEntries.get(address);
                if (account === undefined) {
                    $account && $account.destroy && $account.destroy();
                    this._accountEntries.delete(address);
                } else if (!$account) {
                    // new entry
                    this._addAccountEntry(account);
                }
            }
        }

        if (accounts.size === 0) {
            this.$el.textContent = '';
            const $noContent = XNoAccounts.createElement();
            this.$el.appendChild($noContent.$el);
        }
    }

    /**
     * @param {object} account
     */
    _addAccountEntry(account) {
        if (this.attributes.noVesting && account.type === 4) {
            // Do not display vesting accounts
            this._accountEntries.set(account.address, true);
            return;
        }
        const accountEntry = this._createAccountEntry(account);
        this._accountEntries.set(account.address, accountEntry);
        this.$el.appendChild(accountEntry.$el);
    }

    _createAccountEntry(account) {
        const $account = XAccount.createElement();
        $account.account = account;

        return $account;
    }
}

class XAccountsDropdown extends MixinRedux(XElement) {

    html() {
        return `
            <x-expandable dropdown disabled>
                <div expandable-trigger>
                    <h3 status-message></h3>
                    <x-account></x-account>
                </div>
                <div expandable-content>
                    <x-accounts-list no-vesting></x-accounts-list>
                </div>
            </x-expandable>
            <input type="hidden">
        `;
    }

    children() {
        return [ XExpandable, XAccount, XAccountsList ];
    }

    onCreate() {
        this.$statusMessage = this.$('[status-message]');
        this.$input = this.$('input');
        if (this.attributes.name) {
            this.$input.setAttribute('name', this.attributes.name);
        }
        this.$account.addEventListener('x-account-selected', e => e.stopPropagation());
        super.onCreate();
    }

    static mapStateToProps(state) {
        return {
            accounts: state.accounts.entries,
            hasContent: state.accounts.hasContent,
            loading: state.accounts.loading
        };
    }

    _onPropertiesChanged(changes) {
        if (changes.loading === true || changes.hasContent === false
            || this.properties.accounts.size === 0) {
            this.$expandable.disable();
            this._showStatusMessage();
            return;
        }

        this.$expandable.enable();

        if (changes.accounts && !this.selectedAccount) {
            // pre select some arbitrary account
            this.selectedAccount = changes.accounts.values().next().value;
        }
    }

    listeners() {
        return {
            'x-account-selected x-accounts-list': this._onAccountSelected
        };
    }

    get selectedAccount() {
        const account = this.$account.account;
        // An XAccount.account always has the height property,
        // thus we check if there are any more than that one
        // todo remove height from account objects and find a less hacky solution
        return Object.keys(account).length > 1 ? account : null;
    }

    set selectedAccount(account) {
        if (typeof(account) === 'string') {
            // user friendly address
            account = this.properties.accounts.get(account);
        }
        if (!account) return;
        this.$account.account = account;
        this.$input.value = account.address;
        this.fire('x-account-selected', account.address);
    }

    _showStatusMessage() {
        if (this.properties.accounts.size === 0) {
            this.$statusMessage.textContent = '';
            const dots = document.createElement('span');
            dots.classList.add('dot-loader');
            this.$statusMessage.appendChild(dots);
        } else {
            this.$statusMessage.textContent = 'No accounts yet.';
        }
    }

    _onAccountSelected(address) {
        const account = this.properties.accounts.get(address);
        this.$account.setProperties(account);
        this.$input.value = account.address;
        this.$expandable.collapse();
    }
}

class XInput extends XElement {
    styles() { return ['x-input'] }

    onCreate() {
        this.$input = this.$('input');

        if (this.attributes.name) {
            this.$input.setAttribute('name', this.attributes.name);
        }

        this.$input.addEventListener('input', e => this.__onInput(e)); // Note: this doens't work with checkbox or radio button
        this.$input.addEventListener('keypress', e => this.__onKeypress(e));
        this.$input.addEventListener('input', e => this.__onValueChanged(e));
        this.$input.addEventListener('keyup', e => this.__onValueChanged(e));

        this.$form = this.$('form');

        if (this.$form){
            this.$form.addEventListener('submit', e => this._onSubmit(e));
        }

        this._autoSubmit = this.$el.hasAttribute('auto-submit');
        this._oldValue = this.$input.value;
    }

    get value() {
        return this.$input.value;
    }

    set value(value) {
        this._oldValue = this.$input.value;
        this.$input.value = value;
        if (value !== this._oldValue) {
            // Dispatch actual input event on input DOM node
            var event = new Event('input', {
                'bubbles': true,
                'cancelable': true
            });
            this.$input.dispatchEvent(event);

            this._onValueChanged();
        }
    }

    _onSubmit(e) {
        e.preventDefault();
        e.stopPropagation();
        this._submit();
    }

    __onValueChanged(e) {
        if (this._oldValue === this.$input.value) return;
        this._oldValue = this.$input.value;
        if (this._autosubmit) this._submit();
        this._onValueChanged(e);
        this._notifyValidity();
    }

    __onInput(e) {}

    __onKeyup(e) {}

    __onKeypress(e) {}

    _onValueChanged() {}

    _submit() {
        if (!this._validate(this.value)) return;
        requestAnimationFrame(_ => this.fire(this.__tagName, this.value)); // Hack to hide keyboard on iOS even after paste
    }

    focus() {
        requestAnimationFrame(_ => this.$input.focus());
    }

    setInvalid() {
        this._onInvalid();
    }

    async _onInvalid() {
        await this.animate('shake');
        this.value = '';
    }

    _validate() { return this.$input.checkValidity(); }

    _notifyValidity() {
        const isValid = this._validate(this.value);
        this.fire(this.__tagName + '-valid', isValid);
    }
}

// Note: If you override a setter you need to override the getter, too.
// See: https://stackoverflow.com/questions/28950760/override-a-setter-and-the-getter-must-also-be-overridden

class PasteHandler {
    static setDefaultTarget(target, sanitize) {
        if (PasteHandler.listener !== undefined) window.removeEventListener('paste', PasteHandler.listener);
        PasteHandler.listener = PasteHandler._listen.bind(target);
        window.addEventListener('paste', PasteHandler.listener);
    }

    static _listen(e) {
        const activeElement = document.activeElement && document.activeElement.className;
        const isInInput = activeElement === 'input' || activeElement === 'textarea';
        if (isInInput) return;  // We are interested in the case were we're NOT in an input yet
        this.focus();
        e.stopPropagation();
    }
}

class KeyboardHandler {
    // Set individual listener. Only one can be active at a time.
    static setGlobalListener(listener) {
        if (KeyboardHandler.listener !== undefined) {
            KeyboardHandler.removeGlobalListener();
        }

        KeyboardHandler.listener = listener;
        self.addEventListener('keypress', KeyboardHandler.listener);
    }

    static removeGlobalListener() {
        self.removeEventListener('keypress', KeyboardHandler.listener);
    }

    static setDefaultTarget(target) {
        KeyboardHandler.setGlobalListener(KeyboardHandler._listen.bind(target));
    }

    // For use with setDefaultTarget
    static _listen(e) {
        if (e.keyCode === 13) return; // enter key

        const activeElement = document.activeElement && document.activeElement.className;
        const isInInput = activeElement === 'input' || activeElement === 'textarea';

        if (isInInput) return;  // We are interested in the case were we're NOT in an input yet

        e.stopPropagation();
        this.focus();
    }
}

// Counts all occurences of a symbol in a string
function count_occurences(symbol, string)
{
	let count = 0;

	for (let character of string)
	{
		if (character === symbol)
		{
			count++;
		}
	}

	return count
}

function create_template_parser(template, placeholder, parse)
{
	if (typeof placeholder === 'function')
	{
		parse = placeholder;
		placeholder = 'x';
	}

	const max_characters = count_occurences(placeholder, template);

	return function parse_character(character, value)
	{
		if (value.length >= max_characters)
		{
			return
		}

		return parse(character, value)
	}
}

function close_braces(retained_template, template, placeholder = 'x', empty_placeholder = ' ')
{
	let cut_before = retained_template.length;

	const opening_braces = count_occurences('(', retained_template);
	const closing_braces = count_occurences(')', retained_template);

	let dangling_braces = opening_braces - closing_braces;

	while (dangling_braces > 0 && cut_before < template.length)
	{
		retained_template += template[cut_before].replace(placeholder, empty_placeholder);

		if (template[cut_before] === ')')
		{
			dangling_braces--;
		}

		cut_before++;
	}

	return retained_template
}

// Takes a `template` where character placeholders
// are denoted by 'x'es (e.g. 'x (xxx) xxx-xx-xx').
//
// Returns a function which takes `value` characters
// and returns the `template` filled with those characters.
// If the `template` can only be partially filled
// then it is cut off.
//
// If `should_close_braces` is `true`,
// then it will also make sure all dangling braces are closed,
// e.g. "8 (8" -> "8 (8  )" (iPhone style phone number input).
//
function create_template_formatter(template, placeholder = 'x', should_close_braces)
{
	if (!template)
	{
		return value => ({ text: value })
	}

	const characters_in_template = count_occurences(placeholder, template);

	return function(value)
	{
		if (!value)
		{
			return { text: '', template }
		}

		let value_character_index = 0;
		let filled_in_template = '';

		for (const character of template)
		{
			if (character !== placeholder)
			{
				filled_in_template += character;
				continue
			}

			filled_in_template += value[value_character_index];
			value_character_index++;

			// If the last available value character has been filled in,
			// then return the filled in template
			// (either trim the right part or retain it,
			//  if no more character placeholders in there)
			if (value_character_index === value.length)
			{
				// If there are more character placeholders
				// in the right part of the template
				// then simply trim it.
				if (value.length < characters_in_template)
				{
					break
				}
			}
		}

		if (should_close_braces)
		{
			filled_in_template = close_braces(filled_in_template, template);
		}

		return { text: filled_in_template, template }
	}
}

// Copied from `libphonenumber-js`:
// https://github.com/catamphetamine/libphonenumber-js/blob/master/source/parse.js
//
// These mappings map a character (key) to a specific digit that should
// replace it for normalization purposes. Non-European digits that
// may be used in phone numbers are mapped to a European equivalent.
//
// E.g. in Iraq they don't write `+442323234` but rather `+٤٤٢٣٢٣٢٣٤`.
//
const DIGITS =
{
	'0': '0',
	'1': '1',
	'2': '2',
	'3': '3',
	'4': '4',
	'5': '5',
	'6': '6',
	'7': '7',
	'8': '8',
	'9': '9',
	'\uFF10': '0', // Fullwidth digit 0
	'\uFF11': '1', // Fullwidth digit 1
	'\uFF12': '2', // Fullwidth digit 2
	'\uFF13': '3', // Fullwidth digit 3
	'\uFF14': '4', // Fullwidth digit 4
	'\uFF15': '5', // Fullwidth digit 5
	'\uFF16': '6', // Fullwidth digit 6
	'\uFF17': '7', // Fullwidth digit 7
	'\uFF18': '8', // Fullwidth digit 8
	'\uFF19': '9', // Fullwidth digit 9
	'\u0660': '0', // Arabic-indic digit 0
	'\u0661': '1', // Arabic-indic digit 1
	'\u0662': '2', // Arabic-indic digit 2
	'\u0663': '3', // Arabic-indic digit 3
	'\u0664': '4', // Arabic-indic digit 4
	'\u0665': '5', // Arabic-indic digit 5
	'\u0666': '6', // Arabic-indic digit 6
	'\u0667': '7', // Arabic-indic digit 7
	'\u0668': '8', // Arabic-indic digit 8
	'\u0669': '9', // Arabic-indic digit 9
	'\u06F0': '0', // Eastern-Arabic digit 0
	'\u06F1': '1', // Eastern-Arabic digit 1
	'\u06F2': '2', // Eastern-Arabic digit 2
	'\u06F3': '3', // Eastern-Arabic digit 3
	'\u06F4': '4', // Eastern-Arabic digit 4
	'\u06F5': '5', // Eastern-Arabic digit 5
	'\u06F6': '6', // Eastern-Arabic digit 6
	'\u06F7': '7', // Eastern-Arabic digit 7
	'\u06F8': '8', // Eastern-Arabic digit 8
	'\u06F9': '9'  // Eastern-Arabic digit 9
};

var parseDigit = function(character, value)
{
	return DIGITS[character]
};

// Parses the `text`.
//
// Returns `{ value, caret }` where `caret` is
// the caret position inside `value`
// corresponding to the `caret_position` inside `text`.
//
// The `text` is parsed by feeding each character sequentially to
// `parse_character(character, value)` function
// and appending the result (if it's not `undefined`) to `value`.
//
// Example:
//
// `text` is `8 (800) 555-35-35`,
// `caret_position` is `4` (before the first `0`).
// `parse_character` is `(character, value) =>
//   if (character >= '0' && character <= '9') { return character }`.
//
// then `parse()` outputs `{ value: '88005553535', caret: 2 }`.
//
function parse(text, caret_position, parse_character)
{
	let value = '';

	let focused_input_character_index = 0;

	let index = 0;
	while (index < text.length)
	{
		const character = parse_character(text[index], value);

		if (character !== undefined)
		{
			value += character;

			if (caret_position !== undefined)
			{
				if (caret_position === index)
				{
					focused_input_character_index = value.length - 1;
				}
				else if (caret_position > index)
				{
					focused_input_character_index = value.length;
				}
			 }
		}

		index++;
	}

	// If caret position wasn't specified
	if (caret_position === undefined)
	{
		// Then set caret position to "after the last input character"
		focused_input_character_index = value.length;
	}

	const result =
	{
		value,
		caret : focused_input_character_index
	};

	return result
}

// Formats `value` value preserving `caret` at the same character.
//
// `{ value, caret }` attribute is the result of `parse()` function call.
//
// Returns `{ text, caret }` where the new `caret` is the caret position
// inside `text` text corresponding to the original `caret` position inside `value`.
//
// `formatter(value)` is a function returning `{ text, template }`.
//
// `text` is the `value` value formatted using `template`.
// It may either cut off the non-filled right part of the `template`
// or it may fill the non-filled character placeholders
// in the right part of the `template` with `spacer`
// which is a space (' ') character by default.
//
// `template` is the template used to format the `value`.
// It can be either a full-length template or a partial template.
//
// `formatter` can also be a string — a `template`
// where character placeholders are denoted by 'x'es.
// In this case `formatter` function is automatically created.
//
// Example:
//
// `value` is '880',
// `caret` is `2` (before the first `0`)
//
// `formatter` is `'880' =>
//   { text: '8 (80 )', template: 'x (xxx) xxx-xx-xx' }`
//
// The result is `{ text: '8 (80 )', caret: 4 }`.
//
function format(value, caret, formatter)
{
	if (typeof formatter === 'string')
	{
		formatter = create_template_formatter(formatter);
	}

	let { text, template } = formatter(value) || {};

	if (text === undefined)
	{
		 text = value;
	}

	if (template)
	{
		if (caret === undefined)
		{
			caret = text.length;
		}
		else
		{
			let index = 0;
			let found = false;

			let possibly_last_input_character_index = -1;

			while (index < text.length && index < template.length)
			{
				// Character placeholder found
				if (text[index] !== template[index])
				{
					if (caret === 0)
					{
						found = true;
						caret = index;
						break
					}

					possibly_last_input_character_index = index;

					caret--;
				}

				index++;
			}

			// If the caret was positioned after last input character,
			// then the text caret index is just after the last input character.
			if (!found)
			{
				caret = possibly_last_input_character_index + 1;
			}
		}
	}

	return { text, caret }
}

// Edits text `value` (if `operation` is passed) and repositions the `caret` if needed.
//
// Example:
//
// value - '88005553535'
// caret - 2 // starting from 0; is positioned before the first zero
// operation - 'Backspace'
//
// Returns
// {
// 	value: '8005553535'
// 	caret: 1
// }
//
// Currently supports just 'Delete' and 'Backspace' operations
//
function edit(value, caret, operation)
{
	switch (operation)
	{
		case 'Backspace':
			// If there exists the previous character,
			// then erase it and reposition the caret.
			if (caret > 0)
			{
				// Remove the previous character
				value = value.slice(0, caret - 1) + value.slice(caret);
				// Position the caret where the previous (erased) character was
				caret--;
			}
			break

		case 'Delete':
			// Remove current digit (if any)
			value = value.slice(0, caret) + value.slice(caret + 1);
			break
	}

	return { value, caret }
}

// Gets <input/> selection bounds
function getSelection(element)
{
	// If no selection, return nothing
	if (element.selectionStart === element.selectionEnd)
	{
		return
	}

	return { start: element.selectionStart, end: element.selectionEnd }
}

// Key codes
const Keys =
{
	Backspace : 8,
	Delete    : 46
};

// Finds out the operation to be intercepted and performed
// based on the key down event `keyCode`.
function getOperation(event)
{
	switch (event.keyCode)
	{
		case Keys.Backspace:
			return 'Backspace'

		case Keys.Delete:
			return 'Delete'
	}
}

// Gets <input/> caret position
function getCaretPosition(element)
{
	return element.selectionStart
}

// Sets <input/> caret position
function setCaretPosition(element, caret_position)
{
	// Sanity check
	if (caret_position === undefined)
	{
		return
	}

	// Set caret position
	setTimeout(() => element.setSelectionRange(caret_position, caret_position), 0);
}

function onCut(event, input, _parse, _format, on_change)
{
	// The actual cut hasn't happened just yet hence the timeout.
	setTimeout(() => format_input_text(input, _parse, _format, undefined, on_change), 0);
}

function onPaste(event, input, _parse, _format, on_change)
{
	const selection = getSelection(input);

	// If selection is made,
	// just erase the selected text
	// prior to pasting
	if (selection)
	{
		erase_selection(input, selection);
	}

	format_input_text(input, _parse, _format, undefined, on_change);
}

function onChange(event, input, _parse, _format, on_change)
{
	format_input_text(input, _parse, _format, undefined, on_change);
}

// Intercepts "Delete" and "Backspace" keys.
// (hitting "Delete" or "Backspace" at any caret
//  position should always result in rasing a digit)
function onKeyDown(event, input, _parse, _format, on_change)
{
	const operation = getOperation(event);

	switch (operation)
	{
		case 'Delete':
		case 'Backspace':
			// Intercept this operation and perform it manually.
			event.preventDefault();

			const selection = getSelection(input);

			// If selection is made,
			// just erase the selected text,
			// and don't apply any more operations to it.
			if (selection)
			{
				erase_selection(input, selection);
				return format_input_text(input, _parse, _format, undefined, on_change)
			}

			// Else, perform the (character erasing) operation manually
			return format_input_text(input, _parse, _format, operation, on_change)

		default:
			// Will be handled when `onChange` fires.
	}
}

/**
 * Erases the selected text inside an `<input/>`.
 * @param  {DOMElement} input
 * @param  {Selection} selection
 */
function erase_selection(input, selection)
{
	let text = input.value;
	text = text.slice(0, selection.start) + text.slice(selection.end);

	input.value = text;
	setCaretPosition(input, selection.start);
}

/**
 * Parses and re-formats `<input/>` textual value.
 * E.g. when a user enters something into the `<input/>`
 * that raw input must first be parsed and the re-formatted properly.
 * Is called either after some user input (e.g. entered a character, pasted something)
 * or after the user performed an `operation` (e.g. "Backspace", "Delete").
 * @param  {DOMElement} input
 * @param  {Function} parse
 * @param  {Function} format
 * @param  {string} [operation] - The operation that triggered `<input/>` textual value change. E.g. "Backspace", "Delete".
 * @param  {Function} onChange
 */
function format_input_text(input, _parse, _format, operation, on_change)
{
	// Parse `<input/>` textual value.
	// Get `value` and `caret` position.
	let { value, caret } = parse(input.value, getCaretPosition(input), _parse);

	// If a user performed an operation (e.g. "Backspace", "Delete")
	// then apply that operation and get new `value` and `caret` position.
	if (operation)
	{
		const operation_applied = edit(value, caret, operation);

		value = operation_applied.value;
		caret = operation_applied.caret;
	}

	// Format the `value`.
	// (and reposition the caret accordingly)
	const formatted = format(value, caret, _format);

	const text = formatted.text;
	caret      = formatted.caret;

	// Set `<input/>` textual value manually
	// to prevent React from resetting the caret position
	// later inside subsequent `render()`.
	// Doesn't work for custom `inputComponent`s for some reason.
	input.value = text;
	// Position the caret properly.
	setCaretPosition(input, caret);

	// `<input/>` textual value may have changed,
	// so the parsed `value` may have changed too.
	// The `value` didn't neccessarily change
	// but it might have.
	on_change(value);
}

var InputFormat = {
	templateParser: create_template_parser,
	templateFormatter: create_template_formatter,
	parseDigit,
	parse,
	format,
	onChange,
	onPaste,
	onCut,
	onKeyDown
};

class XAddressInput extends XInput {
    html() {
        return `
            <div class="input-row">
                <x-identicon></x-identicon>
                <span class="prefix">NQ</span>
                <form action="/">
                    <input type="text" placeholder="Recipient Address" spellcheck="false" autocomplete="off">
                </form>
            </div>
        `
    }

    onCreate() {
        super.onCreate();
        const onChange = () => this._autoSubmit ? this._submit() : this._validate();
        this.$input.addEventListener('paste', e => InputFormat.onPaste(e, this.$input, this._parseAddressChars, this._format, onChange));
        this.$input.addEventListener('cut', e => InputFormat.onCut(e, this.$input, this._parseAddressChars, this._format, onChange));
        this.$input.addEventListener('keydown', e => InputFormat.onKeyDown(e, this.$input, this._parseAddressChars, this._format, onChange));
        // input event will be handled by _onValueChanged
        this.$el.addEventListener('click', () => this.$input.focus());
    }

    styles() { return ['x-address']; }

    children() { return [XIdenticon]; }

    get value() {
        const address = 'NQ' + this.$input.value;
        return ValidationUtils.isValidAddress(address)? address : null;
    }

    set value(value) {
        // Have to define setter as we have defined the getter as well, but we'll just call the setter of super.
        // This will also trigger _onValueChanged
        super.value = value;
    }

    set disabled(value) {
        this.$input.disabled = value;
    }

    _onValueChanged() {
        InputFormat.onChange(null, this.$input, this._parseAddressChars, this._format,
            () => this._autoSubmit? this._submit() : this._validate());
        this.$identicon.address = this.value;
    }

    _validate() {
        return this.value !== null;
    }

    set placeholderColor(color) {
        this.$identicon.placeholderColor = color;
    }

    _onEntry() {
        PasteHandler.setDefaultTarget(this.$input);
        KeyboardHandler.setDefaultTarget(this.$input);
    }

    _format(address) {
        let value = address;
        // remove leading NQ
        if (address.substr(0, 2) === 'NQ') {
            value = address.substr(2);
        }
        const template = 'xx xxxx xxxx xxxx xxxx xxxx xxxx xxxx xxxx';
        return InputFormat.templateFormatter(template)(value);
    }

    // Accept 0-9, a-Z. Convert to upper case and replace some letters by similar looking numbers.
    _parseAddressChars(character, value) {
        const prunedCharacter = character.toUpperCase()
            .replace('I', '1')
            .replace('O', '0')
            .replace('Z', '2')
            .replace(/[^\w]|_| /, '');

        if (prunedCharacter !== '') {
            return prunedCharacter;
        }
    }
}

class XNumpad extends XElement {
    html() {
        return `
            <span>1</span>
            <span>2</span>
            <span>3</span>
            <span>4</span>
            <span>5</span>
            <span>6</span>
            <span>7</span>
            <span>8</span>
            <span>9</span>
            <span dot>.</span>
            <span>0</span>
            <span delete>&lt;</span>`
    }

    onCreate() {
        this._maxDecimals = 2;
        this.$dot = this.$('[dot]');
        this.addEventListener('click', e => this._onKeyPressed(e));
        this.clear();
    }

    clear() {
        this._integerDigits = '';
        this._decimalDigits = '';
        this._hasDot = false;
        this._onValueChanged();
    }

    get stringValue() {
        let string = this._integerDigits;
        if (this._hasDot) {
            string = string || '0';
            string += '.' + this._decimalDigits;
        }
        return string;
    }

    get value() {
        return parseFloat(this.stringValue);
    }

    set value(value) {
        if (value < 0) throw Error('Only non-negative numbers supported');
        if (value === this.value) return;
        const string = String(value);
        const parts = string.split('.');
        this._hasDot = parts.length > 1;
        this._integerDigits = parts[0];
        this._decimalDigits = this._hasDot? parts[1] : '';
        this._onValueChanged();
    }

    set maxDecimals(maxDecimals) {
        this._maxDecimals = maxDecimals;
        this._checkMaxDecimals();
        this._onValueChanged();
    }

    _onKeyPressed(e) {
        const key = e.target;
        if (key === this.$el) return; // did not tap on a key but the numpad itself
        const keyValue = key.textContent;
        switch (keyValue) {
            case '<':
                this._remove();
                break;
            case '.':
                this._addDot();
                break;
            default:
                this._input(keyValue);
        }
        this._onValueChanged();
    }

    _input(digit) {
        if (!this._hasDot) {
            this._inputIntegerDigit(digit);
        } else {
            this._decimalDigits += digit;
        }
    }

    _inputIntegerDigit(digit) {
        if (this._integerDigits === '0') {
            // avoid leading zeros
            this._integerDigits = digit;
        } else {
            this._integerDigits += digit;
        }
    }

    _remove() {
        if (!this._hasDot) {
            this._integerDigits = this._removeLastDigit(this._integerDigits);
        } else {
            if (this._decimalDigits !== '') {
                this._decimalDigits = this._removeLastDigit(this._decimalDigits);
            } else {
                this._removeDot();
            }
        }
    }

    _removeLastDigit(digits) {
        return digits.substr(0, digits.length - 1);
    }

    _addDot() {
        this._hasDot = true;
        this.$el.classList.add('has-dot');
        if (this._integerDigits !== '') return;
        this._integerDigits = '0';
    }

    _removeDot() {
        this._hasDot = false;
        this.$el.classList.remove('has-dot');
    }

    _onValueChanged() {
        this._checkMaxDecimals();
        const stringValue = this.stringValue;
        this.fire('x-numpad-value', {
            value: parseFloat(stringValue) || 0,
            stringValue
        });
    }

    _checkMaxDecimals() {
        if (this._decimalDigits.length > this._maxDecimals) {
            this._decimalDigits = this._decimalDigits.substr(0, this._maxDecimals);
        }
        if (this._decimalDigits.length === this._maxDecimals) {
            this.$el.classList.add('max-decimals-reached');
        } else {
            this.$el.classList.remove('max-decimals-reached');
        }
    }
}

class XAmountInput extends XInput {
    html() {
        return `
            <form>
                <x-currency-nim>
                    <input placeholder="0.00" type="number" min="0">
                    <span class="ticker">NIM</span>
                    <button class="small secondary set-max">Max</button>
                </x-currency-nim>
                <x-currency-fiat></x-currency-fiat>
            </form>
            <x-numpad></x-numpad>`;
    }

    children() { return [XNumpad] }

    onCreate() {
        super.onCreate();
        this.$currency2 = this.$('x-currency-2');
        this._previousValue = '';
        this.maxDecimals = this.attributes.maxDecimals ? parseInt(this.attributes.maxDecimals) : 2;
        if (!this._isMobile || this.$el.hasAttribute('no-screen-keyboard')) {
            this.$numpad.$el.style.display = 'none';
            return;
        }
        this._initScreenKeyboard();
    }

    listeners() {
        return {
            'click button.set-max': this._onClickSetMax,
            'focus input': this._toggleMaxButton,
            'blur input': this._onBlur
        }
    }

    set value(value) {
        if (value === '') {
            super.value = '';
            return;
        }
        value = Number(value);
        const decimals = Math.pow(10, this.maxDecimals);
        super.value = Math.round(value * decimals) / decimals; // triggers _onValueChanged
    }

    get value() {
        return Number(this.$input.value);
    }

    set maxDecimals(maxDecimals) {
        this._maxDecimals = maxDecimals;
        this.$numpad.maxDecimals = maxDecimals;
        this.$input.step = 1 / Math.pow(10, maxDecimals); /* also has an influence on this._validate() */
    }

    get maxDecimals() {
        return this._maxDecimals;
    }

    set disabled(value) {
        this.$input.disabled = value;
    }

    _initScreenKeyboard() {
        this.$input.setAttribute('disabled', '1');
        this.$input.setAttribute('type', 'text'); // to be able to set the string "0."
        this.$numpad.addEventListener('x-numpad-value', e => this._onNumpadValue(e));
    }

    /** @overwrites */
    _onValueChanged() {
        if (!this._validate()) {
            this.value = this._previousValue;
            return;
        }
        this._previousValue = this.value;
        //this._currency2 = this.value;
        if (this.$input.value === '') {
            this.$numpad.clear();
        } else {
            this.$numpad.value = this.value;
        }
        this._toggleMaxButton();
    }

    /*
    set _currency2(value) {
        if (value === 0) {
            this.$currency2.textContent = '';
        } else {
            this.$currency2.textContent = NanoApi.formatValueInDollar(value);
        }
    }
    */

    get _isMobile() {
        return window.innerWidth < 420;
    }

    focus() {
        if (this.$input.hasAttribute('disabled')) return;
        super.focus();
    }

    _onNumpadValue(event) {
        super.value = event.detail.stringValue; // also triggers _onValueChanged
    }

    _onClickSetMax(_, e) {
        e.preventDefault();
        this.fire('x-amount-input-set-max');
    }

    _toggleMaxButton() {
        this.$el.classList.toggle('show-set-max-button', !this.$input.value);
    }

    _onBlur() {
        this.$el.classList.remove('show-set-max-button');
    }
}

// Todo: [low] [Max] refactor `_isMobile` into an own library for mobile-detection
    // then make it more sophisticated (regex ?)

class XFeeInput extends XInput {
    html() {
        return `
            <form>
                <div class="x-fee-labels">
                    <!-- <label free>free</label> --> <label free>free&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</label>
                    <!-- <label low>low</label>   --> <label low>standard</label>
                    <!-- <label high>high</label> --> <label high>express</label>
                </div>

                <input type="range" min="0" value="0">

                <div class="x-fee-value">
                    <span class="x-fee-sats">0</span>
                    <x-currency-nim>0.00</x-currency-nim> NIM
                    <x-currency-fiat>($0.00)</x-currency-fiat>
                </div>
            </form>`;
    }

    onCreate() {
        super.onCreate();
        this.$sats = this.$('.x-fee-sats');
        this.$nim = this.$('x-currency-nim');
        this.$fiat = this.$('x-currency-fiat');
        this._previousValue = '';
        this._maxSats = this.attributes.maxSats || 2;
        this.txSize = 138; // BasicTransaction, bytes
    }

    listeners() {
        return {
            'click label[free]': () => this._clickedLabel('free'),
            'click label[low]': () => this._clickedLabel('low'),
            'click label[high]': () => this._clickedLabel('high'),
        }
    }

    set value(value) {
        if (typeof value === "string") {
            this._clickedLabel(value);
            this._onValueChanged();
        } else {
            super.value = Number(value || 0); // triggers _onValueChanged
        }
    }

    get value() {
        return Number(this.$input.value);
    }

    set txSize(size) {
        const step = this.value / this._txSize;
        this._txSize = size;
        this.$input.setAttribute('max', this._txSize * this._maxSats / 1e5);
        this.$input.setAttribute('step', this._txSize / 1e5);
        this.value = step * this._txSize;
    }

    /** @overwrites */
    _onValueChanged() {
        if (!this._validate()) {
            this.value = this._previousValue;
            return;
        }
        this._previousValue = this.value;
        //this._currencyFiat = this.value;

        this.$sats.textContent = Math.round(this.value * 1e5 / this._txSize) + ' sat/byte:';
        this.$nim.textContent = this.value;
        // this._currencyFiat(this.value);

        this.fire('x-fee-input-changed', this.value);
    }

    _clickedLabel(type) {
        switch(type) {
            case 'free':
                this.value = 0;
                break;
            case 'low':
                this.value = Math.floor(this._maxSats * this._txSize / 2 / this._txSize) * this._txSize / 1e5;
                break;
            case 'high':
                this.value = this._maxSats * this._txSize;
                break;
        }
    }

    /*
    set _currencyFiat(value) {
        this.$fiat.textContent = NanoApi.formatValueInDollar(value);
    }
    */
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

class XExtraDataInput extends XInput {
    html() {
        return `
            <form>
                <input type="text" placeholder="Message">
                <div class="x-extra-data-info">
                    <span class="x-extra-data-help"></span>
                    <span class="x-extra-data-remaining"></span>
                </div>
            </form>`;
    }

    onCreate() {
        super.onCreate();
        this.$help = this.$('.x-extra-data-help');
        this.$remaining = this.$('.x-extra-data-remaining');
        this._maxBytes = this.attributes.maxBytes || 64;
        this._onValueChanged();
    }

    set valueAsBytes(bytes) {
        super.value = Utf8Tools.utf8ByteArrayToString(bytes); // triggers _onValueChanged
    }

    get valueAsBytes() {
        return Utf8Tools.stringToUtf8ByteArray(this.$input.value);
    }

    set maxBytes(maxBytes) {
        if (maxBytes === this._maxBytes) return;
        this.value = '';
        this._maxBytes = maxBytes;
        this._setRemaining();
    }

    set disabled(value) {
        this.$input.disabled = value;
    }

    /** @overwrites */
    _onValueChanged() {
        if (!this._validate()) {
            this.value = this._previousValue;
            return;
        }
        this._previousValue = this.value;

        this._setRemaining();
    }

    _setRemaining() {
        const byteLength = this.valueAsBytes.length;
        const bytesRemaining = this._maxBytes - byteLength;
        this.$remaining.textContent = bytesRemaining > 10 ? '' : `${bytesRemaining} bytes remaining`;
        this.fire('x-extra-data-input-changed-size', byteLength);
    }

    _validate() {
        return this.valueAsBytes.length <= this._maxBytes;
    }
}

class XPopupMenu extends XElement {
    html() {
        return `
            <button>
                <i class="material-icons"></i>
                <span class="dot-loader display-none"></span>
            </button>
            <div data-x-content></div>
        `
    }

    onCreate() {
        this.$button = this.$('button');
        this.$text = this.$('i');
        this.$loader = this.$('.dot-loader');
        this.$('i').textContent = this.attributes.xIcon || 'more_vert';
        this.$loader.setAttribute('title', this.attributes.xLoadingTooltip);
        this._noMenu = false;

        this._handleiOS();

        this._bodyClicked = this._bodyClicked.bind(this);
    }

    listeners() {
        return {
            'click button': this._buttonClicked,
        }
    }

    set disabled(disabled) {
        this.$button.disabled = !!disabled;
    }

    set loading(loading) {
        this.$text.classList.toggle('display-none', this._noMenu || !!loading);
        this.$loader.classList.toggle('display-none', !loading);
        this.disabled = this._noMenu || loading;
    }

    set noMenu(noMenu) {
        this._noMenu = !!noMenu;
        this.loading = !this.$loader.classList.contains('display-none'); // Trigger class setting once;
    }

    _buttonClicked(_, e) {
        e.stopPropagation();
        this.$el.classList.add('active');
        document.body.addEventListener('click', this._bodyClicked);
    }

    _bodyClicked(e) {
        this.$el.classList.remove('active');
        document.body.removeEventListener('click', this._bodyClicked);
    }

    _handleiOS() {
        var iOS = !!navigator.platform && /iPad|iPhone|iPod/.test(navigator.platform);
        if (iOS) {
            document.body.classList.add('is-ios');
        }
    }
}

class XSendTransaction extends MixinRedux(XElement) {
    html() {
        return `
            <div class="modal-header">
                <x-popup-menu left-align>
                    <button prepared><i class="material-icons">unarchive</i> Prepared transaction</button>
                </x-popup-menu>
                <i x-modal-close class="material-icons">close</i>
                <h2>New Transaction</h2>
            </div>
            <form class="modal-body">
                <h3>Send from</h3>
                <x-accounts-dropdown name="sender"></x-accounts-dropdown>
                <span error sender class="display-none"></span>

                <h3><i name="recipientAddressLock" class="material-icons">&#xe897;</i>Send to <span class="link-address-book">Address book</span></h3>
                <div class="row">
                    <x-address-input class="multiline" name="recipient"></x-address-input>
                </div>
                <span error recipient class="display-none"></span>

                <h3><i name="amountLock" class="material-icons">&#xe897;</i>Amount</h3>
                <div class="row">
                    <x-amount-input name="value" no-screen-keyboard enable-set-max></x-amount-input>
                </div>
                <span error amount class="display-none"></span>

                <x-expandable advanced-settings transparent>
                    <h3 expandable-trigger>Advanced Settings</h3>
                    <div expandable-content>
                        <div class="extra-data-section">
                            <h3><i name="messageLock" class="material-icons">&#xe897;</i>Message</h3>
                            <div class="row">
                                <x-extra-data-input name="extraData" max-bytes="64"></x-extra-data-input>
                            </div>
                        </div>

                        <h3>Fee</h3>
                        <div class="row">
                            <x-fee-input name="fee" max-sats="2"></x-fee-input>
                        </div>
                        <span error fees class="display-none"></span>

                        <h3><i name="validityLock" class="material-icons">&#xe897;</i>Valid from</h3>
                        <small>Only required for offline transaction creation</small>
                        <small>Setting a wrong valid-from height can invalidate your transaction!</small>
                        <div class="row">
                            <input name="validityStartHeight" validity-start placeholder="0" type="number" min="0" step="1">
                        </div>
                        <span error start-height class="display-none"></span>
                    </div>
                </x-expandable>

                <div class="center row">
                    <button send>Send</button>
                </div>
            </form>
        `
    }

    children() {
        return [ XPopupMenu, XAccountsDropdown, XAddressInput, XAmountInput, XFeeInput, XExpandable, XExtraDataInput ];
    }

    onCreate() {
        this.$form = this.$('form');
        this.$button = this.$('button[send]');
        this.$addressInput.placeholderColor = '#bbb';

        this.__debouncedValidateRecipient = this.debounce(this.__validateRecipient, 1000, true);

        // To work around the double x-address-input-valid event
        // which happens because of the address formatting when
        // pasting a full address
        this.__lastValidatedValue = null;
        this.__validateRecipientTimeout = null;

        this._errorElements = {};

        this._isSetMax = false;

        this.clear();

        super.onCreate();
    }

    styles() {
        return [ ...super.styles(), 'x-send-transaction' ];
    }

    static mapStateToProps(state) {
        return {
            hasConsensus: state.network.consensus === 'established'
        }
    }

    listeners() {
        return {
            'submit form': this._onSubmit.bind(this),
            'x-account-selected': () => this._validateField('sender'),
            'x-address-input-valid': () => this._validateField('recipient'),
            'input input[name="value"]': () => this._validateField('amount'),
            'input input[name="fee"]': () => this._validateField('fees'),
            'input input[name="validityStartHeight"]': () => this._validateField('validityStartHeight'),
            'click button[prepared]': () => this.fire('x-send-prepared-transaction'),
            'x-amount-input-set-max': this._onAmountSetMax,
            'x-fee-input-changed': this._onFeeChanged,
            'x-extra-data-input-changed-size': this._onExtraDataChangedSize
        }
    }

    set sender(accountOrAddress) {
        this.$accountsDropdown.selectedAccount = accountOrAddress;
    }

    set recipient(address) {
        this.$addressInput.value = address;
    }

    set amount(amount) {
        this.$amountInput.value = amount;
    }

    set extraData(extraData) {
        this.$extraDataInput.value = extraData;
    }

    set fee(fee) {
        this.$feeInput.value = fee;
    }

    set validity(validity) {
        this.$form.querySelector('input[name="validityStartHeight"]').value = validity;
    }

    set disabled(flags) {
        if (Number.isInteger(flags)) {
            this.$addressInput.disabled = flags & 1;
            this.$form.querySelector('i[name="recipientAddressLock"]').style.display = flags & 1 ? "block" : "none";
            this.$amountInput.disabled = flags & 2;
            this.$form.querySelector('i[name="amountLock"]').style.display = flags & 2 ? "block" : "none";
            this.$extraDataInput.disabled = flags & 4;
            this.$form.querySelector('i[name="messageLock"]').style.display = flags & 4 ? "block" : "none";
            this.$form.querySelector('input[name="validityStartHeight"]').disabled = flags & 8;
            this.$form.querySelector('i[name="validityLock"]').style.display = flags & 8 ? "block" : "none";
        } else {
            this.$address.disabled = false;
            this.$form.querySelector('i[name="recipientAddressLock"]').style.display = "none";
            this.$amountInput.disabled = false;
            this.$form.querySelector('i[name="amountLock"]').style.display = "none";            
            this.$extraDataInput.disabled = false;
            this.$form.querySelector('i[name="messageLock"]').style.display = "none";
            this.$form.querySelector('input[name="validityStartHeight"]').disabled = false;
            this.$form.querySelector('i[name="validityLock"]').style.display = "none";
        }
    }

    _onSubmit(e) {
        e.preventDefault();
        if (!this._isValid()) return;

        const tx = this._getFormData(this.$form);
        tx.network = Config.network;
        this.fire('x-send-transaction', tx);
    }

    clear(shouldExpand = false) {
        this.recipient = '';
        this.amount = '';
        this.extraData = '';
        this.fee = 0;
        this.validity = '';
        this.disabled = 0;
        if (shouldExpand) {
            this.$expandable.expand();
        } else {
            this.$expandable.collapse();
        }
        this.loading = false;
    }

    validateAllFields() {
        this._validateSender();
        this._validateRecipient();
        this._validateAmountAndFees();
        this._validateValidityStartHeight();
        this.setButton();
    }

    set loading(isLoading) {
        this._isLoading = !!isLoading;
        this.$button.textContent = this._isLoading ? 'Loading' : 'Send';
        this.setButton();
    }

    _getFormData(form) {
        const formData = {};
        form.querySelectorAll('input').forEach(i => formData[i.getAttribute('name')] = i.value);
        return formData;
    }

    _onAmountSetMax() {
        const account = this.$accountsDropdown.selectedAccount;
        this.$amountInput.maxDecimals = 5;
        this.$amountInput.value = account.balance - this.$feeInput.value;
        this._isSetMax = true;
    }

    _onFeeChanged(fee) {
        if (this._isSetMax) this._onAmountSetMax();
    }

    _onExtraDataChangedSize(size) {
        if (size > 0) this.$feeInput.txSize = 166 + size;
        else this.$feeInput.txSize = 138;
    }

    /**
     * VALIDATION METHODS
     */

    setButton() {
        this.$button.disabled = !this._isValid() || this._isLoading;
    }

    /**
     * @returns {nothing valuable} The return statement is just used for quitting the function early
     */
    async _validateField(field) {
        switch (field) {
            case 'recipient':
                this._validateRecipient();
                break;
            case 'sender':
                this._validateSender();
                // Fall through
            case 'amount':
                this._isSetMax = (this.$amountInput.value + this.$feeInput.value) === this.$accountsDropdown.selectedAccount.balance;
                // Fall through
            case 'fees':
                this._validateAmountAndFees();
                break;
            case 'validityStartHeight':
                this._validateValidityStartHeight();
                break;
        }

        return this.setButton();
    }

    _validateSender() {
        const account = this.$accountsDropdown.selectedAccount;

        // TODO FIXME Move this somewhere more reasonable
        if (account.type !== AccountType.KEYGUARD_HIGH && account.type !== AccountType.KEYGUARD_LOW) {
            this.$extraDataInput.value = '';
            this.$('.extra-data-section').classList.add('display-none');
        } else {
            this.$('.extra-data-section').classList.remove('display-none');
        }

        if (this.properties.hasConsensus) {
            this._validSender = !!(account && account.balance > 0);
            if (this._validSender) {
                this._clearError('sender');
            } else {
                this._setError('This account has no balance', 'sender');
            }
        }
        else {
            this._validSender = !!account;
        }

        this._validateRecipient(true);
    }

    _validateRecipient(forceValidate) {
        const address = this.$addressInput.value;
        const value = this.$addressInput.$input.value;

        if (value === this.__lastValidatedValue && !this.__validateRecipientTimeout && !forceValidate) return;
        this.__lastValidatedValue = value;

        clearTimeout(this.__validateRecipientTimeout);
        this.__validateRecipientTimeout = null;

        this._validRecipient = false;

        if (address === this.$accountsDropdown.selectedAccount.address) {
            this._setError('This is the same address as the sender', 'recipient');
            return;
        }

        // TODO Skip network request when doing airgapped tx creation
        if (address) {
            if (!this.properties.hasConsensus) {
                if (Config.offline) {
                    this._setError('Cannot validate address in offline mode', 'recipient');
                    this._validRecipient = true;
                } else {
                    this._setError('Cannot validate address (not connected). Retrying...', 'recipient');
                    this.__validateRecipientTimeout = setInterval(this._validateRecipient.bind(this), 1000);
                    this._validRecipient = true;
                }
            } else {
                this.__debouncedValidateRecipient(address);
            }
        } else if (value.length === 0) {
            this._clearError('recipient');
        } else {
            this._setError('Invalid address', 'recipient');
        }
    }

    async __validateRecipient(address) {
        this._validatingRecipientTimeout = setTimeout(() => this._setError('Validating address type, please wait...', 'recipient'), 1000);

        const accountType = await (await networkClient.rpcClient).getAccountTypeString(address);

        this._validRecipient = (accountType === 'basic');

        clearTimeout(this._validatingRecipientTimeout);

        if (this._validRecipient) {
            this._clearError('recipient');
        } else {
            this._setError('Cannot send to this account type', 'recipient');
        }

        // Because this is a debounced async function, there is no external way
        // no know if this function finished, so we need to do that action in here
        this.setButton();
    }

    _validateAmountAndFees() {
        const account = this.$accountsDropdown.selectedAccount;

        const amount = this.$amountInput.value;
        const fees = this.$feeInput.value;

        if (amount < 0) {
            this._setError('You cannot send a negative amount', 'amount');
        }
        if (amount === 0) {
            this._clearError('amount');
        }

        if (amount <= 0 || fees < 0) {
            this._validAmountAndFees = false;
            return;
        }

        if (this.properties.hasConsensus) {
            this._validAmountAndFees = !!(account && account.balance >= Math.round((amount + fees) * 1e5) / 1e5);

            if (!this._validAmountAndFees) {
                this._setError('You do not have enough funds', 'amount');
            } else {
                this._clearError('amount');
            }
        }
        else {
            this._validAmountAndFees = true;
        }
    }

    _validateValidityStartHeight() {
        // TODO: Validate validityStartHeight?
        const value = this.$('input[validity-start]').value || 0;

        this._validValidityStartHeight = !!(value >= 0);

        if (this._validValidityStartHeight) {
            this._clearError('start-height');
        } else {
            this._setError('Cannot set a negative start height', 'start-height');
        }
    }

    _isValid() {
        // console.log(
        //     "sender", this._validSender,
        //     "recipient", this._validRecipient,
        //     "amountandFees", this._validAmountAndFees,
        //     "validityStartHeight", this._validValidityStartHeight
        // );
        return this._validSender && this._validRecipient && this._validAmountAndFees && this._validValidityStartHeight;
    }

    // Returns a function, that, as long as it continues to be invoked, will not
    // be triggered. The function will be called after it stops being called for
    // N milliseconds. If `immediate` is passed, trigger the function on the
    // leading edge, instead of the trailing.
    debounce(func, wait) {
        var timeout;
        return function() {
            var context = this, args = arguments;
            var later = function(isDummy) {
                timeout = null;
                if (!isDummy) func.apply(context, args);
            };
            var callNow = !timeout;
            clearTimeout(timeout);
            if (callNow) {
                timeout = setTimeout(later, wait, true);
                func.apply(context, args);
            } else {
                timeout = setTimeout(later, wait);
            }
        }
    }

    _setError(msg, field) {
        let $el = this._errorElements[field];
        if (!$el) this._errorElements[field] = $el = this.$(`span[error][${field}]`);

        if (msg) {
            $el.textContent = msg;
            $el.classList.remove('display-none');
        } else {
            $el.classList.add('display-none');
        }
    }

    _clearError(field) {
        this._setError('', field);
    }
}

// TODO make fee a slider
// TODO make validity start a slider

class XSendTransactionModal extends MixinModal(XSendTransaction) {
    allowsShow(...params) {
        this._shouldExpand = false;
        try {
            var bytes = Base64.decode(params[0]);
            var string = LZMA.decompress(bytes);
            params = JSON.parse(string);
            this._shouldExpand = true;
        } catch {
            params = this._parseRouterParams(params);
            if (params.sender) {
                params.sender = dashToSpace(params.sender);
            }
            if (params.recipient) {
                params.recipient = dashToSpace(params.recipient);
            }
        }
        this._params = params;
        return (!params.sender || ValidationUtils.isValidAddress(params.sender))
            && (!params.recipient || ValidationUtils.isValidAddress(params.recipient));
    }

    onShow(...params) {
        this.clear(this._shouldExpand);

        this.$amountInput.maxDecimals = document.body.classList.contains('setting-show-all-decimals') ? 5 : 2;

        params = this._params;

        if (params.sender) {
            this.sender = params.sender;
        }

        if (params.recipient) {
            this.recipient = params.recipient;
        }

        if (params.amount) {
            this.amount = params.amount;
        }

        if (params.extraData) {
            this.extraData = params.extraData;            
        }

        if (params.fee) {
            this.fee = params.fee;            
        }

        if (params.validity) {
            this.validity = params.validity;                        
        }

        if (params.disabled) {
            this.disabled = params.disabled;                        
        }

        this.validateAllFields();
    }

    _parseRouterParams(params) {
        return params.reduce((result, param) => {
            const [key, value] = param.split('=');
            result[key] = value;
            return result;
        }, {});
    }
}

// todo refactor params parsing to router

class XAccountModal extends MixinModal(XAccount) {
    html() {
        return `
            <div class="modal-header">
                <x-popup-menu left-align>
                    <button rename><i class="material-icons">mode_edit</i> Rename</button>
                    <button backupWords><i class="material-icons">text_format</i> Backup Recovery Words</button>
                    <button upgrade><i class="material-icons">check_circle</i> Upgrade</button>
                </x-popup-menu>
                <i x-modal-close class="material-icons">close</i>
                <h2>Account</h2>
            </div>
            <div class="modal-body">
                <div class="center">
                    <x-identicon></x-identicon>
                    <i class="display-none account-icon material-icons"></i>

                    <span class="x-account-label"></span>

                    <x-address></x-address>

                    <div class="x-account-bottom">
                        <x-amount display label="Balance"></x-amount>
                    </div>

                    <div class="vesting-info">
                        <x-amount display available-amount label="Available now"></x-amount>
                    </div>
                </div>

                <div class="action-button">
                    <button send class="small">Send from this account</button>
                </div>
            </div>
        `
    }

    children() { return [ ...super.children(), XPopupMenu ] }

    onCreate() {
        this.$availableAmount = this.$amount[1];
        this.$balanceSection = this.$('.x-account-bottom');
        this.$vestingInfo = this.$('.vesting-info');
        this.$sendButton = this.$('button[send]');
        this.$actionButton = this.$('.action-button');

        this.$renameButton = this.$('button[rename]');
        this.$backupWordsButton = this.$('button[backupWords]');
        this.$upgradeButton = this.$('button[upgrade]');

        this._height = 0;
        super.onCreate();
    }

    listeners() {
        return {
            'click button[upgrade]': _ => this.fire('x-upgrade-account', this.properties.address),
            'click button[backupWords]': _ => this.fire('x-account-modal-backup-words', this.properties.address),
            'click button[rename]': _ => this.fire('x-account-modal-rename', this.properties.address),
            'click button[send]': _ => this.fire('x-account-modal-new-tx', this.properties.address)
        }
    }

    static mapStateToProps(state, props) {
        return Object.assign({},
            state.accounts.entries.get(props.address),
            {
                height: state.network.height
            }
        )
    }

    _onPropertiesChanged(changes) {
        for (const prop in changes) {
            if (changes[prop] !== undefined) {
                // Update display
                this[prop] = changes[prop];
            }
        }

        if (changes.type === AccountType.VESTING || (!changes.type && this.properties.type === AccountType.VESTING)) {
            this.$balanceSection.classList.add('display-none');
            // Is a vesting contract
            if (changes.start
             || changes.stepAmount
             || changes.stepBlocks
             || changes.totalAmount
             || (changes.height && !this._height)
             || changes.balance
            ) {
                this._height = this.properties.height;
                const balance = changes.balance || this.properties.balance || 0;
                const start = changes.start || this.properties.start || 0;
                const stepAmount = changes.stepAmount || this.properties.stepAmount;
                const stepBlocks = changes.stepBlocks || this.properties.stepBlocks;
                const totalAmount = changes.totalAmount || this.properties.totalAmount;

                const steps = [];

                const numberSteps = Math.ceil(totalAmount/stepAmount);

                for (let i = 1; i <= numberSteps; i++) {
                    const stepHeight = start + stepBlocks * i;
                    const stepHeightDelta = stepHeight - this._height;
                    steps.push({
                        height: stepHeight,
                        heightDelta: stepHeightDelta,
                        amount: i < numberSteps ? stepAmount : totalAmount - stepAmount * (i - 1),
                    });
                }

                const pastSteps = steps.filter(step => step.heightDelta <= 0);

                const availableAmount = (balance - totalAmount) + pastSteps.reduce((acc, step) => acc + step.amount, 0);
                const futureSteps = steps.filter(step => step.heightDelta > 0);

                this.$availableAmount.value = availableAmount;
                if (availableAmount > 0) this.$sendButton.disabled = false;
                else                     this.$sendButton.disabled = true;

                // Remove all steps
                while (this.$vestingInfo.querySelector('x-amount:not([available-amount])')) {
                    this.$vestingInfo.removeChild(this.$vestingInfo.querySelector('x-amount:not([available-amount])'));
                }

                // Add future steps
                futureSteps.forEach(step => {
                    const time = Date.now() / 1000 + step.heightDelta * 60;
                    const timeString = moment.unix(time).calendar();
                    const $amount = XAmount.createElement([['label', `Available ${timeString}`]]);
                    $amount.value = step.amount;
                    this.$vestingInfo.appendChild($amount.$el);
                });

                this.$vestingInfo.classList.remove('display-none');
            }
        }
        else {
            this.$vestingInfo.classList.add('display-none');
            this.$balanceSection.classList.remove('display-none');
        }

        if (this.properties.label === undefined) this.$el.classList.add('pending'); // Used for gradient animation
        else this.$el.classList.remove('pending');
    }

    set balance(balance) {
        super.balance = balance;

        if (balance > 0) this.$sendButton.disabled = false;
        else             this.$sendButton.disabled = true;
    }

    set type(type) {
        super.type = type;

        // Disable popup menu for Ledger and Vesting
        this.$popupMenu.$el.classList.toggle('display-none', type === AccountType.LEDGER || type === AccountType.VESTING);

        // Disable send button for Vesting
        this.$actionButton.classList.toggle('display-none', type === AccountType.VESTING);

        // Enable rename and backupWords button only for Safe
        this.$renameButton.classList.toggle('display-none', type !== AccountType.KEYGUARD_HIGH);
        this.$backupWordsButton.classList.toggle('display-none', type !== AccountType.KEYGUARD_HIGH);

        // Enable upgrade button only for Wallet
        this.$upgradeButton.classList.toggle('display-none', type !== AccountType.KEYGUARD_LOW);
    }

    set account(account) {
        // Preserve height property through hard setting
        account.height = this.properties.height;

        super.account = account;
    }

    allowsShow(address) {
        if (!address) return true;

        address = dashToSpace(address);
        return ValidationUtils.isValidAddress(address);
    }

    onShow(address) {
        if (!address) return;

        address = dashToSpace(address);

        let account = MixinRedux.store.getState().accounts.entries.get(address);
        if (!account) account = { address };
        this.account = account;
    }
}

class XAccounts extends MixinRedux(XElement) {

    html() {
        return `
            <x-popup-menu x-icon="add">
                <button class="waiting create"><i class="material-icons">add</i> Create New Account</button>
                <button class="import-ledger"><i class="material-icons ledger-icon">&nbsp;</i> Import Ledger Account</button>
                <button class="waiting import-words"><i class="material-icons">text_format</i> Import Recovery Words</button>
                <button class="waiting import-file"><i class="material-icons">crop_portrait</i> Import Access File</button>
            </x-popup-menu>
            <x-accounts-list></x-accounts-list>
            <x-account-modal x-route-aside="account"></x-account-modal>
        `;
    }

    children() {
        return [ XPopupMenu, XAccountsList, XAccountModal ];
    }

    static mapStateToProps(state) {
        return {
            keyguardReady: state.connection.keyguard
        }
    }

    _onPropertiesChanged(changes) {
        if (changes.keyguardReady) {
            this.$('.create').classList.remove('waiting');
            this.$('.import-words').classList.remove('waiting');
            this.$('.import-file').classList.remove('waiting');
        }
    }

    listeners() {
        return {
            'click button.create': this._onCreateAccount,
            'click button.import-ledger': this._onImportLedger,
            'click button.import-words': this._onImportFromWords,
            'click button.import-file': this._onImportFromFile,
            'x-account-selected': this._onAccountSelected
        };
    }

    _onCreateAccount() {
        this.fire('x-accounts-create');
    }

    _onImportLedger() {
        this.fire('x-accounts-import-ledger');
    }

    _onImportFromWords() {
        this.fire('x-accounts-import-words');
    }

    _onImportFromFile() {
        this.fire('x-accounts-import-file');
    }

    _onAccountSelected(address) {
        address = spaceToDash(address);
        XAccountModal.show(address);
    }
}

class XTransaction extends MixinRedux(XElement) {
    html() {
        return `
            <div class="timestamp" title="">pending...</div>
            <x-identicon sender></x-identicon>
            <div class="label" sender></div>
            <div><i class="material-icons">arrow_forward</i></div>
            <x-identicon recipient></x-identicon>
            <div class="label" recipient></div>
            <x-amount></x-amount>
        `
    }

    children() { return [ XIdenticon, XAmount ] }

    onCreate() {
        super.onCreate();
        this.$senderIdenticon = this.$identicon[0];
        this.$senderLabel = this.$('div.label[sender]');
        this.$recipientIdenticon = this.$identicon[1];
        this.$recipientLabel = this.$('div.label[recipient]');

        this.$timestamp = this.$('div.timestamp');

        this._timeagoUpdateInterval = null;
    }

    listeners() {
        return {
            'click': this._onTransactionSelected
        }
    }

    static mapStateToProps(state, props) {
        return Object.assign({},
            state.transactions.entries.get(props.hash),
            {
                currentHeight: state.network.height
            }
        )
    }

    _onPropertiesChanged(changes) {
        // TODO Prevent update when update is handled by transaction list
        // delete changes.triggeredByList;

        for (const prop in changes) {
            if (changes[prop] !== undefined) {
                // Update display
                this[prop] = changes[prop];

                if (prop === 'timestamp' && !this._timeagoUpdateInterval) {
                    this._timeagoUpdateInterval = setInterval(_ => this._updateTimeago(), 60 * 1000); // Update every minute
                }

                continue;
            }

            // Doesn't need to be in else{}, because of 'continue' statement above
            switch (prop) {
                case 'timestamp':
                    this.$timestamp.textContent = 'pending...';
                    this.$timestamp.setAttribute('title', '');
                    break;
                case 'blockHeight':
                    this.blockHeight = 0;
                    break;
                case 'removed':
                case 'expired':
                    this.$el.classList.remove('removed', 'expired');
                    this._updateTimeago();
                default:
                    // console.warn('Possible unhandled reset of property', prop);
                    break;
            }
        }

        if (!this.properties.timestamp) this.$el.classList.add('pending'); // Used for gradient animation
        else this.$el.classList.remove('pending');

        if (this.properties.removed) {
            this.$timestamp.textContent = 'removed';
            this.$timestamp.setAttribute('title', 'Transaction was removed');
        }

        if (this.properties.expired) {
            this.$timestamp.textContent = 'expired';
            this.$timestamp.setAttribute('title', 'Transaction has expired');
        }
    }


    set sender(address) {
        this.$senderIdenticon.address = address;
    }

    set senderLabel(label) {
        this.$senderLabel.textContent = label;
    }

    set recipient(address) {
        this.$recipientIdenticon.address = address;
    }

    set recipientLabel(label) {
        this.$recipientLabel.textContent = label;
    }

    set value(value) {
        this.$amount.value = value;
    }

    set timestamp(timestamp) {
        const dateTime = moment.unix(timestamp);

        if (dateTime.isSame(moment(), 'day')) {
            this.$timestamp.textContent = dateTime.format('HH:mm');
        } else {
            this.$timestamp.textContent = dateTime.format('DD MMM');
        }

        this.$timestamp.setAttribute('title', dateTime.toDate().toLocaleString());
    }

    set type(type) {
        this.$amount.type = type;

        this.$el.classList.remove('incoming', 'outgoing', 'transfer');
        type && this.$el.classList.add(type);
    }

    set removed(removed) {
        this.$el.classList.add('removed');
    }

    set expired(expired) {
        this.$el.classList.add('expired');
    }

    set transaction(transaction) {
        // Preserve currentHeight property through hard setting
        transaction.currentHeight = this.properties.currentHeight;

        this.setProperties(transaction, true);
    }

    get transaction() {
        return this.properties;
    }

    _onTransactionSelected() {
        this.fire('x-transaction-selected', this.transaction.hash);
    }

    _updateTimeago() {
        // Trigger timeago update
        if (this.properties.timestamp) this.timestamp = this.properties.timestamp;
    }
}

class XTransactionModal extends MixinModal(XTransaction) {
    html() {
        return `
            <div class="modal-header">
                <i x-modal-close class="material-icons">close</i>
                <h2>Transaction</h2>
            </div>
            <div class="modal-body">
                <div class="center">
                    <x-identicon sender></x-identicon>
                    <i class="arrow material-icons">arrow_forward</i>
                    <x-identicon recipient></x-identicon>
                </div>

                <div class="center">
                    <x-amount></x-amount>
                </div>

                <div class="row">
                    <label>From</label>
                    <div class="row-data">
                        <div class="label" sender></div>
                        <x-address sender></x-address>
                    </div>
                </div>

                <div class="row">
                    <label>To</label>
                    <div class="row-data">
                        <div class="label" recipient></div>
                        <x-address recipient></x-address>
                    </div>
                </div>

                <div class="extra-data-section display-none row">
                    <label>Message</label>
                    <div class="row-data">
                        <div class="extra-data"></div>
                    </div>
                </div>

                <div class="row">
                    <label>Date</label>
                    <div class="row-data">
                        <div class="timestamp" title="">pending...</div>
                    </div>
                </div>

                <div class="row">
                    <label>Block</label>
                    <div class="row-data">
                        <span class="blockHeight"></span> <span class="confirmations"></span>
                    </div>
                </div>

                <div class="fee-section display-none row">
                    <label>Fee</label>
                    <div class="row-data">
                        <div class="fee"></div>
                    </div>
                </div>
            </div>
        `
    }

    children() { return super.children().concat([XAddress]) }

    listeners() { return [] }

    onCreate() {
        this.$senderAddress = this.$address[0];
        this.$recipientAddress = this.$address[1];
        this.$blockHeight = this.$('span.blockHeight');
        this.$confirmations = this.$('span.confirmations');
        this.$fee = this.$('div.fee');
        this.$message = this.$('div.extra-data');
        super.onCreate();
        this.$senderIdenticon.placeholderColor = '#bbb';
        this.$recipientIdenticon.placeholderColor = '#bbb';
    }

    set sender(address) {
        this.$senderIdenticon.address = address;
        this.$senderAddress.address = address;
    }

    set recipient(address) {
        this.$recipientIdenticon.address = address;
        this.$recipientAddress.address = address;
    }

    set senderLabel(label) {
        this.$senderLabel.textContent = label;
        this.$senderLabel.classList.toggle('default-label', label.startsWith('NQ'));
    }

    set recipientLabel(label) {
        this.$recipientLabel.textContent = label;
        this.$recipientLabel.classList.toggle('default-label', label.startsWith('NQ'));
    }

    set extraData(extraData) {
        this.$('.extra-data-section').classList.toggle('display-none', !extraData);
        this.$message.textContent = extraData;
    }

    set fee(fee) {
        this.$('.fee-section').classList.toggle('display-none', !fee);
        this.$fee.textContent = fee + ' NIM';
    }

    set blockHeight(blockHeight) {
        if (this.properties.removed || this.properties.expired) {
            this.$blockHeight.textContent = '-';
        } else {
            this.$blockHeight.textContent = blockHeight > 0 ? `#${blockHeight}` : '';
        }
        this._calcConfirmations();
    }

    set timestamp(timestamp) {
        const time = moment.unix(timestamp);
        this.$timestamp.textContent = `${time.toDate().toLocaleString()} (${time.fromNow()})`;
    }

    set currentHeight(height) {
        this._calcConfirmations();
    }

    _calcConfirmations() {
        if (!this.properties.currentHeight || !this.properties.blockHeight || this.properties.removed || this.properties.expired) {
            if (this.$confirmations) this.$confirmations.textContent = '';
            return;
        }
        const confirmations = this.properties.currentHeight - this.properties.blockHeight;
        this.$confirmations.textContent = `(${confirmations} confirmation${confirmations === 1 ? '' : 's'})`;
    }

    allowsShow(hash) {
        if (!hash) return true;
        hash = decodeURIComponent(hash);
        return ValidationUtils.isValidHash(hash);
    }

    onShow(hash) {
        if (!hash) return;

        hash = decodeURIComponent(hash);

        let transaction = MixinRedux.store.getState().transactions.entries.get(hash);
        if (!transaction) transaction = { hash };
        this.transaction = transaction;
    }
}

class XNoTransactions extends XElement {
    html() {
        return `
            <h1 class="material-icons">inbox</h1>
            <span>You have no transactions yet</span>
        `
    }

    onCreate() {
        if (Config.offline) {
            this.$('h1').textContent = 'cloud_off';
            this.$('span').textContent = 'Transactions are not available in offline mode';
        }
    }
}

const TypeKeys$2 = {
    ADD_TXS: 'transactions/add-transactions',
    MARK_REMOVED: 'transactions/mark-removed',
    REMOVE_TXS: 'transactions/remove-transactions',
    UPDATE_BLOCK: 'transactions/updateBlock',
    SET_PAGE: 'transactions/set-page',
    SET_ITEMS_PER_PAGE: 'transactions/set-items-per-page',
    SET_REQUESTING_HISTORY: 'transactions/set-requesting-history'
};

function reducer$2(state, action) {
    if (state === undefined) {
        return {
            entries: new Map(),
            hasContent: false,
            error: null,
            page: 1,
            itemsPerPage: 25
        }
    }

    switch (action.type) {
        case TypeKeys$2.ADD_TXS: {
            let entries = new Map(state.entries);

            if (action.transactions && action.transactions.length === 1) {
                // Check if this is a pending tx
                const tx = action.transactions[0];
                if (!tx.blockHeight) {
                    entries.set(tx.hash, tx); // Add to end of map
                    return Object.assign({}, state, {
                        entries,
                        hasContent: true
                    });
                }
            }

            action.transactions.forEach(tx => entries.set(tx.hash, tx));
            // Sort as array
            entries = new Map([...entries].sort(_transactionSort));

            return Object.assign({}, state, {
                entries,
                hasContent: true
            });
        }
        case TypeKeys$2.MARK_REMOVED: {
            const entries = new Map(state.entries);

            action.hashes.forEach(hash => {
                const tx = entries.get(hash);
                // If the blockHeight is set, it means it's not a pending tx and can be marked as removed
                if (tx.blockHeight) {
                    entries.set(hash, Object.assign({},
                        tx,
                        {
                            'removed': true,
                            blockHeight: action.currentHeight
                        }
                    ));
                }
                // If the blockHeight is not set, it means it's a pending tx. Receipts of pending tx are
                // also sent into the requestTransactionHistory function and thus come back in the
                // removedTransactions array, but should only be marked as expired if they are expired (older than 120 blocks)
                if (action.currentHeight >= tx.validityStartHeight + 120 || action.currentHeight === true) {
                    entries.set(hash, Object.assign({},
                        tx,
                        {
                            'expired': true,
                            blockHeight: action.currentHeight
                        }
                    ));
                }
            });

            return Object.assign({}, state, {
                entries
            });
        }
        case TypeKeys$2.REMOVE_TXS: {
            const entries = new Map(state.entries);

            action.hashes.forEach(hash => {
                entries.delete(hash);
            });

            return Object.assign({}, state, {
                entries
            });
        }
        case TypeKeys$2.UPDATE_BLOCK:
            const oldEntry = state.entries.get(action.hash);
            return Object.assign({}, state, {
                entries: new Map(state.entries)
                    .set(action.hash, Object.assign({}, oldEntry, {
                        blockHeight: action.blockHeight,
                        timestamp: action.timestamp
                    }))
            });

        case TypeKeys$2.SET_PAGE:
            return Object.assign({}, state, {
                page: action.page
            });

        case TypeKeys$2.SET_ITEMS_PER_PAGE:
            return Object.assign({}, state, {
                itemsPerPage: action.itemsPerPage
            });

        case TypeKeys$2.SET_REQUESTING_HISTORY:
            return Object.assign({}, state, {
                isRequestingHistory: action.isRequestingHistory
            });

        default:
            return state
    }
}

/**
 * @param {Array<{}>} transactions
 */
function addTransactions(transactions) {
    return {
        type: TypeKeys$2.ADD_TXS,
        transactions
    }
}

/**
 * @param {Array<string>} hashes
 * @param {Number|Boolean} currentHeight
 */
function markRemoved(hashes, currentHeight) {
    return {
        type: TypeKeys$2.MARK_REMOVED,
        hashes,
        currentHeight
    }
}

/**
 * @param {Array<string>} hashes
 */




function setPage(page) {
    return {
        type: TypeKeys$2.SET_PAGE,
        page
    }
}



function setRequestingHistory(isRequestingHistory) {
    return {
        type: TypeKeys$2.SET_REQUESTING_HISTORY,
        isRequestingHistory
    }
}

function _transactionSort(left, right) {
    if (!left[1].blockHeight && !right[1].blockHeight) {
        // Both tx are pending, sort by validityStartHeight
        return left[1].validityStartHeight - right[1].validityStartHeight;
    }
    else if (!left[1].blockHeight) return 1; // sort left after
    else if (!right[1].blockHeight) return -1; // sort left before
    else return left[1].blockHeight - right[1].blockHeight;
}

class XPaginator extends MixinRedux(XElement) {
    html() {
        return `
            <br>
            <button toStart class="small secondary"><i class="material-icons">skip_previous</i></button>
            <button prev class="small secondary"><i class="material-icons">keyboard_arrow_left</i></button>
            &nbsp;&nbsp;&nbsp;&nbsp;<span page></span>&nbsp;&nbsp;&nbsp;&nbsp;
            <button next class="small secondary"><i class="material-icons">keyboard_arrow_right</i></button>
            <button toEnd class="small secondary"><i class="material-icons">skip_next</i></button>
        `
    }

    onCreate() {
        this.$toStart = this.$('button[toStart]');
        this.$prev = this.$('button[prev]');
        this.$page = this.$('span[page]');
        this.$next = this.$('button[next]');
        this.$toEnd = this.$('button[toEnd]');
        this.setProperty('storePath', this.attributes.storePath);
        super.onCreate();
    }

    listeners() {
        return {
            'click button[toStart]': () => this._pageSelected(1),
            'click button[prev]': () => this._pageSelected(this.properties.page - 1),
            'click button[next]': () => this._pageSelected(this.properties.page + 1),
            'click button[toEnd]': () => this._pageSelected(this.properties.totalPages)
        }
    }

    static get actions() { return { setPage } }

    static mapStateToProps(state, props) {
        if (!props.storePath) return;
        return {
            page: state[props.storePath].page,
            itemsPerPage: state[props.storePath].itemsPerPage,
            totalPages: Math.ceil(state[props.storePath].entries.size / state[props.storePath].itemsPerPage)
        }
    }

    /**
     * @param {Array|Set|Map} items
     * @param {integer} page 1-indexed
     * @param {integer} itemsPerPage
     * @param {boolean} [backwards]
     * @returns {Array|Set|Map} Returns the same type that is items
     */
    static getPagedItems(items, page, itemsPerPage, backwards) {
        const keys = items instanceof Map
            ? [...items.keys()]
            : items instanceof Set
                ? [...items]
                : items instanceof Array
                    ? items
                    : false;

        if (!keys) throw new Error('Cannot paginate type', items.__proto__.constructor.name);

        if (backwards) keys.reverse();

        // Pagination
        const indexStart = (page - 1) * itemsPerPage;
        const indexEnd = indexStart + itemsPerPage;
        const pagedKeys = keys.slice(indexStart, indexEnd);

        if (backwards) pagedKeys.reverse();

        if (items instanceof Array) return pagedKeys;
        if (items instanceof Set) return new Set(pagedKeys);

        // items instanceof Map
        const pagedItems = new Map();
        pagedKeys.forEach(key => pagedItems.set(key, items.get(key)));
        return pagedItems;
    }

    _onPropertiesChanged(changes) {
        // todo think about that code. Should be either simplified or really use change information.
        const page = changes.page || this.properties.page;
        const totalPages = changes.totalPages || this.properties.totalPages;

        this.$page.textContent = page;

        if (page === 1) {
            this.$toStart.disabled = true;
            this.$prev.disabled = true;
        } else {
            this.$toStart.disabled = false;
            this.$prev.disabled = false;
        }

        if (page >= totalPages) {
            this.$toEnd.disabled = true;
            this.$next.disabled = true;
        } else {
            this.$toEnd.disabled = false;
            this.$next.disabled = false;
        }
    }

    _pageSelected(page) {
        if (page < 1 || page > this.properties.totalPages) return;
        this.actions.setPage(page);
    }
}

class AddressBook {
    static getLabel(address) {
        return AddressBook.BOOK[address] || null;
    }
}

AddressBook.BOOK = {
    // Mainnet
    'NQ58 U4HN TVVA FCRS VLYL 8XTL K0B7 2FVD EC6B': 'Skypool US',
    'NQ88 D1R3 KR4H KSY2 CQYR 5G0C 80X4 0KED 32G8': 'Skypool EU',
    'NQ48 8CKH BA24 2VR3 N249 N8MN J5XX 74DB 5XJ8': 'Skypool',
    'NQ43 GQ0B R7AJ 7SUG Q2HC 3XMP MNRU 8VM0 AJEG': 'Skypool HK',
    'NQ32 473Y R5T3 979R 325K S8UT 7E3A NRNS VBX2': 'SushiPool',
    'NQ76 R7R0 DCKG N0RC 35XK ULTS N41J VGA7 3CMP': 'Porky Pool',
    'NQ10 76JC KSSE 5S2R U401 NC5P M3N2 8TKQ YATP': 'Nimiqchain.info Pool',
    'NQ33 DH76 PHUK J41Q LX3A U4E0 M0BM QJH9 QQL1': 'Beeppool',
    'NQ90 P00L 2EG5 3SBU 7TB5 NPGG 8FNL 4JC7 A4ML': 'NIMIQ.WATCH Pool',
    'NQ11 P00L 2HYP TUK8 VY6L 2N22 MMBU MHHR BSAA': 'Nimpool.io',
    'NQ04 3GHQ RAV6 75FD R9XA VS7N 146Q H230 2KER': 'Nimiqpool.com',
    'NQ07 SURF KVMX XF1U T3PH GXSN HYK1 RG71 HBKR': 'Nimiq.Surf',
    'NQ90 PH1L 7MT2 VTUH PJYC 17RV Q61B 006N 4KP7': 'PhilPool',
    'NQ06 NG1G 83YG 5D59 LK8G Y2JB VYTH EL6D 7AKY': 'Nimbus Pool',

    // Testnet
    'NQ31 QEPR ED7V 00KC P7UC P1PR DKJC VNU7 E461': 'pool.nimiq-testnet.com',
    'NQ36 P00L 1N6T S3QL KJY8 6FH4 5XN4 DXY0 L7C8': 'NIMIQ.WATCH Test-Pool',
    'NQ50 CXGC 14C6 Y7Q4 U3X2 KF0S 0Q88 G09C PGA0': 'SushiPool TESTNET',
};

class XTransactions extends MixinRedux(XElement) {
    html() {
        return `
            <x-popup-menu x-loading-tooltip="Refreshing transaction history" x-icon="refresh">
                <button refresh><i class="material-icons">refresh</i> Refresh</button>
            </x-popup-menu>
            <x-transactions-list>
                <x-loading-animation></x-loading-animation>
                <h2>Loading transactions...</h2>
            </x-transactions-list>
            <x-paginator store-path="transactions"></x-paginator>
            <a secondary x-href="history" class="display-none">View more</a>
        `
    }

    children() { return [ XPopupMenu, XPaginator ] }

    onCreate() {
        this._$transactions = new Map();
        this.$transactionsList = this.$('x-transactions-list');
        this.properties.onlyRecent = !!this.attributes.onlyRecent;
        if (this.properties.onlyRecent) {
            this.$paginator.$el.classList.add('display-none');
            this.$('a[secondary]').classList.remove('display-none');
        }
        this.$popupMenu.noMenu = this.attributes.noMenu;
        super.onCreate();
    }

    listeners() {
        return {
            'x-transaction-selected': this._onTransactionSelected,
            'click button[refresh]': () => this.requestTransactionHistory()
        }
    }

    static get actions() { return { addTransactions, markRemoved, setRequestingHistory } }

    static mapStateToProps(state, props) {
        return {
            transactions: XTransactions._labelTransactions(
                XPaginator.getPagedItems(
                    state.transactions.entries,
                    props.onlyRecent ? 1 : state.transactions.page,
                    props.onlyRecent ? 4 : state.transactions.itemsPerPage,
                    true
                ),
                state.accounts ? state.accounts.entries : false
            ),
            hasTransactions: state.transactions.hasContent,
            addresses: state.accounts ? [...state.accounts.entries.keys()] : [],
            hasAccounts: state.accounts.hasContent,
            lastKnownHeight: state.network.height || state.network.oldHeight,
            isRequestingHistory: state.transactions.isRequestingHistory
        }
    }

    static _labelTransactions(txs, accounts) {
        if (!accounts) return txs;
        txs.forEach(tx => {
            const sender = accounts.get(tx.sender);
            const recipient = accounts.get(tx.recipient);

            tx.senderLabel = sender ? sender.label : AddressBook.getLabel(tx.sender) || tx.sender.slice(0, 14) + '...';
            tx.recipientLabel = recipient ? recipient.label : AddressBook.getLabel(tx.recipient) || tx.recipient.slice(0, 14) + '...';

            if (sender) tx.type = 'outgoing';
            if (recipient) tx.type = 'incoming';
            if (sender && recipient) tx.type = 'transfer';
        });

        return txs;
    }

    _onPropertiesChanged(changes) {
        if (!this.attributes.passive) {
            if (changes.hasAccounts && this.properties.addresses.length === 0) {
                // Empty state
                this.actions.addTransactions([]);
            }
            else if (changes.addresses && changes.addresses instanceof Array && changes.addresses.length > 0) {
                // Called when state is loaded from persisted state (deepdiff returns the accounts as the new array)
                this.requestTransactionHistory(changes.addresses);
            }
            else if (changes.addresses && !(changes.addresses instanceof Array)) {
                // Called when an account is added (deepdiff returns array diff as object)
                let newAddresses = Object.values(changes.addresses);
                // Filter out deleted addresses
                newAddresses = newAddresses.filter(a => !!a);
                // console.log("ADDRESSES CHANGED, REQUESTING TX HISTORY FOR", newAddresses);
                this.requestTransactionHistory(newAddresses);
            }
        }

        if (changes.isRequestingHistory) {
            this.$popupMenu.loading = true;
        }
        else if (changes.isRequestingHistory !== undefined) {
            this.$popupMenu.loading = false;
        }

        if (!this.properties.hasTransactions) return;

        if (changes.transactions) {
            if (this.$('x-loading-animation') || this.$('x-no-transactions')) {
                this.$transactionsList.textContent = '';
            }

            // Transaction-internal updates are handled by the XTransaction
            // elements themselves, so we only need to handle reordering and
            // removed tx here.

            // Check if the changes include a new hash or a
            // blockHeight, which would make sorting necessary
            let needsSorting = false;

            let removedTx = [];

            for (const [hash, transaction] of changes.transactions) {
                if (transaction === undefined) removedTx.push(hash);
                else if (transaction.hash || transaction.blockHeight) {
                    needsSorting = true;
                }
            }

            // Remove the XTransaction elements of removed tx
            if (removedTx.length > 0) {
                for (const hash of removedTx) {
                    const $transaction = this._$transactions.get(hash);
                    $transaction && $transaction.destroy();
                    this._$transactions.delete(hash);
                }
            }

            if (needsSorting) {
                // Reorder existing elements and create new ones as required

                // Get XTransaction elements in reverse DOM order
                const xTransactions = [...this._$transactions.values()];
                this._$transactions = new Map();

                // Set XTransaction transaction to object in this.properties.transactions
                let i = 0;
                for (const [hash, transaction] of this.properties.transactions) {
                    if (xTransactions[i]) {
                        // transaction.triggeredByList = true;
                        xTransactions[i].transaction = transaction;
                        this._$transactions.set(hash, xTransactions[i]);
                    }
                    else {
                        // When no more XTransactions, create new ones
                        this.addTransaction(transaction);
                    }
                    i++;
                }

                // DEBUGGING: Validate order of this._$transactions map
                // let lastBlockHeight = 0;
                // for (const [hash, xTransaction] of this._$transactions) {
                //     if (xTransaction.properties.blockHeight >= lastBlockHeight)
                //         lastBlockHeight = xTransaction.properties.blockHeight;
                //     else if (!xTransaction.properties.blockHeight)
                //         continue;
                //     else
                //         console.log("isSorted", false);
                // }
            }

        }

        if (this.properties.transactions.size === 0) {
            this.$transactionsList.textContent = '';
            const $noContent = XNoTransactions.createElement();
            this.$transactionsList.appendChild($noContent.$el);
        }
    }

    /**
     * @param {string[]} [addresses]
     */
    async requestTransactionHistory(addresses) {
        if (!this.properties.hasAccounts) return;
        if (Config.offline) {
            this.actions.addTransactions([]);
            return;
        }

        this.actions.setRequestingHistory(true);
        addresses = addresses || this.properties.addresses;
        const { newTransactions, removedTransactions } = await this._requestTransactionHistory(addresses);
        this.actions.addTransactions(newTransactions);
        this.actions.markRemoved(removedTransactions, this.properties.lastKnownHeight);
        this.actions.setRequestingHistory(false);
    }

    /**
     * @param {object} tx
     */
    addTransaction(tx) {
        this._$transactions.set(tx.hash, this._createTransaction(tx));
    }

    _createTransaction(transaction) {
        const $transaction = XTransaction.createElement();

        $transaction.transaction = transaction;

        // FIXME: Use `prepend` when Edge supports it
        this.$transactionsList.insertBefore($transaction.$el, this.$transactionsList.firstChild || null);

        return $transaction;
    }

    _onTransactionSelected(hash) {
        hash = encodeURIComponent(hash);
        XTransactionModal.show(hash);
    }

    async _requestTransactionHistory(addresses) {
        const knownReceipts = this._generateKnownReceipts(addresses);

        // TODO: only ask from knownLastHeight when this function is called at app start,
        // not when requesting txs after a new account has been added!
        // const height = this.properties.lastKnownHeight - 10;
        const height = 0;

        return (await networkClient.rpcClient).requestTransactionHistory(addresses, knownReceipts, height);
    }

    _generateKnownReceipts(addresses) {
        // Create an emtpy map of knownReceiptsbyAddress
        const knownReceipts = new Map(addresses.map(a => [a, new Map()]));

        for (const [hash, tx] of MixinRedux.store.getState().transactions.entries) {
            if (tx.removed || tx.expired) continue;

            if (knownReceipts.has(tx.sender)) {
                knownReceipts.get(tx.sender).set(hash, tx.blockHash);
            }

            if (knownReceipts.has(tx.recipient)) {
                knownReceipts.get(tx.recipient).set(hash, tx.blockHash);
            }
        }
        return knownReceipts;
    }
}

class XReceiveRequestLinkModal extends MixinModal(XElement) {
    html() {
        return `
            <div class="modal-header">
                <i x-modal-close class="material-icons">close</i>
                <h2>Transaction Request</h2>
            </div>
            <div class="modal-body">
                <div class="center">
                    <x-identicon></x-identicon>
                    <i class="display-none account-icon"></i>
                    <x-address></x-address>
                    <div class="x-message">Someone sent you a link to request a transaction.</div>

                    <button class="confirm">Ok</button>
                    <a class="cancel" secondary>Cancel</a>
                </div>
            </div>
        `;
    }

    children() {
        return [ XIdenticon, XAddress ];
    }

    allowsShow(params) {
        var address = dashToSpace(params);
        if (ValidationUtils.isValidAddress(address)) {
            this._address = address;
        } else{
            try {
                var bytes = Base64.decode(params);
                var string = LZMA.decompress(bytes);
                address = JSON.parse(string).recipient;
            } catch {
                return false;
            }
            if (!ValidationUtils.isValidAddress(address)) {
                return false;
            }
            this._params = params;            
        }
        this.$identicon.address = address;
        this.$address.address = address;
        return true;    
    }

    onShow(params) {
    }

    listeners() {
        return {
            'click a.cancel': () => this.hide(),
            'click button.confirm': async () =>
                (await XRouter.instance).replaceAside('request', 'new-transaction', typeof this._address === "string" ? `recipient=${spaceToDash(this._address)}` : this._params)
        }
    }
}

// todo [v2] handle message and value

// @asset(web-share-shim.html)
navigator.share=navigator.share||function(){if(navigator.share)return navigator.share;let a=navigator.userAgent.match(/Android/i),b=navigator.userAgent.match(/iPhone|iPad|iPod/i),c=!(b||a),d={whatsapp:(a)=>(c?'https://api.whatsapp.com/send?text=':'whatsapp://send?text=')+a,telegram:(a)=>(c?'https://telegram.me/share/msg?url='+location.host+'&text=':'tg://msg?text=')+a,facebook:(a,b,d)=>b?(c?'https://www.facebook.com/dialog/share?app_id='+b+'&display=popup&href='+d+'&redirect_uri='+encodeURIComponent(location.href)+'&quote=':'fb-messenger://share/?message=')+a:'',email:(a,b)=>'mailto:?subject='+b+'&body='+a,sms:(a)=>'sms:?body='+a};const e=new class{_init(){if(this._initialized)return Promise.resolve();this._initialized=!0;const a=fetch('web-share-shim.html').then((a)=>a.text());return a.then((a)=>{const b=document.createElement('div');b.innerHTML=a, this.$root=b.querySelector('.web-share'), this.$whatsapp=b.querySelector('.web-share-whatsapp'), this.$facebook=b.querySelector('.web-share-facebook'), this.$telegram=b.querySelector('.web-share-telegram'), this.$email=b.querySelector('.web-share-email'), this.$sms=b.querySelector('.web-share-sms'), this.$copy=b.querySelector('.web-share-copy'), this.$copy.onclick=()=>this._copy(), this.$root.onclick=()=>this._hide(), this.$root.classList.toggle('desktop',c), document.body.appendChild(b);})}_setPayload(a){let b=a.text+' '+a.url,c=a.title,e=a.facebookId||'158651941570418';this.url=a.url, b=encodeURIComponent(b), c=encodeURIComponent(c), this.$whatsapp.href=d.whatsapp(b), this.$facebook.href=d.facebook(b,e,a.url), this.$telegram.href=d.telegram(b), this.$email.href=d.email(b,c), this.$sms.href=d.sms(b);}_copy(){const a=document.createElement('span');a.textContent=this.url, a.style.whiteSpace='pre', a.style.position='absolute', a.style.left='-9999px', a.style.top='-9999px';const b=window,c=b.getSelection();b.document.body.appendChild(a);const d=b.document.createRange();c.removeAllRanges(), d.selectNode(a), c.addRange(d);let e=!1;try{e=b.document.execCommand('copy');}catch(a){}return c.removeAllRanges(), a.remove(), e}show(a){return this._init().then(()=>{clearTimeout(this._hideTimer), this._setPayload(a), this.$root.style.display='flex', this.$root.style.background='rgba(0,0,0,.4)', document.querySelectorAll('.web-share-container').forEach((a)=>{a.style.transform='translateY(0)',a.style.opacity=1});})}_hide(){this.$root.style.background=null, document.querySelectorAll('.web-share-container').forEach((a)=>{a.style.transform=null,a.style.opacity=null}), this._hideTimer=setTimeout(()=>this.$root.style.display=null,400);}};return(a)=>e.show(a)}();var share = navigator.share;

class XCreateRequestLinkModal extends MixinModal(XElement) {
    html() {
        return `
            <div class="modal-header">
                <i x-modal-close class="material-icons">close</i>
                <h2>Transaction Request</h2>
            </div>
            <div class="modal-body">
                <div class="center">
                    <x-accounts-dropdown name="recipient"></x-accounts-dropdown>
                    <ul>
                        <li>
                            <div>Copy your address:</div>
                            <x-address></x-address>
                        </li>
                        <li>
                            <div>OR use the following link to request a transaction:</div>
                            <div class="x-request-link"></div>
                        </li>
                    </ul>
                </div>
            </div>
        `;
    }

    children() {
        return [ XAddress, XAccountsDropdown ];
    }

    onCreate() {
        navigator.share = share;
        super.onCreate();
    }

    listeners() {
        return {
            'x-account-selected': this._onAccountSelected.bind(this),
            'click .x-request-link': () => navigator.share({
                title: 'Nimiq Transaction Request',
                text: 'Please send me Nimiq using this link:',
                url: this._link
            })
        }
    }

    _onAccountSelected(address) {
        this._setAccount(address);
    }

    _setAccount(address) {
        this.$address.address = address;

        const $requestLink = this.$('.x-request-link');

        this._link = `${ Config.offlinePackaged ? 'https://safe.nimiq.com' : this.attributes.dataXRoot }/#_request/${spaceToDash(address)}_`;

        $requestLink.textContent = this._link;
    }
}

class XSendTransactionOfflineModal extends MixinModal(XElement) {
    html() {
        return `
            <div class="modal-header">
                <i x-modal-close class="material-icons">close</i>
                <h2>Offline Transaction</h2>
            </div>
            <div class="modal-body">
                <p><strong>It looks like you are not connected to the network.</strong></p>
                <p>You can copy the text below to save your transaction and submit it when you are connected.</p>
                <small>Note: the transaction is only valid for 120 blocks (~2 hours) after its validity-start-height.</small>
                <br><br>
                <textarea></textarea>
                <!-- <button>Send now</button> -->
            </div>
        `
    }

    onCreate() {
        this.$textarea = this.$('textarea');
        this._sent = false;
        super.onCreate();
    }

    // listeners() {
    //     return {
    //         'click button': () => this.fire('x-send-transaction-confirm', JSON.parse(this._txString))
    //     }
    // }

    sent() {
        this._sent = true;
    }

    set transaction(tx) {
        if (typeof tx === 'string') {
            this._txString = tx;
        } else {
            const clonedTx = Object.assign({}, tx, {});
            clonedTx.senderPubKey = [...tx.senderPubKey];
            clonedTx.signature = [...tx.signature];

            this._txString = JSON.stringify(clonedTx).replace(/,"/g, ', "');
        }

        this.$textarea.value = this._txString;
    }

    allowsHide() {
        return this._sent || confirm("Close the transaction window?");
    }
}

class XSendPreparedTransactionModal extends MixinModal(XElement) {
    html() {
        return `
            <div class="modal-header">
                <i x-modal-close class="material-icons">close</i>
                <h2>Prepared Transaction</h2>
            </div>
            <div class="modal-body">
                <p>Insert the text of your transaction below:</p>
                <small>Note: a transaction is only valid for 120 blocks (~2 hours) after its validity-start-height.</small>
                <br><br>
                <textarea></textarea>
                <button>Send now</button>
            </div>
        `
    }

    onCreate() {
        this.$textarea = this.$('textarea');
        this.$button = this.$('button');
        super.onCreate();
    }

    listeners() {
        return {
            'click button': () => this.fire('x-send-prepared-transaction-confirm', JSON.parse(this.$textarea.value))
        }
    }

    onShow() {
        this.$textarea.value = '';
        this.loading = false;
    }

    set loading(isLoading) {
        this._isLoading = !!isLoading;
        this.$button.textContent = this._isLoading ? 'Loading' : 'Send now';
        this.$button.disabled = this._isLoading;
    }
}

class XEducationSlide extends MixinModal(XElement) {
    onCreate() {
        super.onCreate();
        this.$nextButton = this.$('[next]');
        if (this.$nextButton) {
            this.$nextButton.addEventListener('click', XEducationSlides.next);
        }
        this.$backButton = this.$('[back]');
        if (this.$backButton) {
            this.$backButton.addEventListener('click', XEducationSlides.back);
        }
        this.container.addEventListener('keydown', e => this._onArrowNavigation(e));
    }

    styles() {
        return [...super.styles(), 'x-education-slide'];
    }

    _onArrowNavigation(e) {
        if (e.keyCode === 37) {
            // left arrow
            XEducationSlides.back();
        } else if (e.keyCode === 39) {
            // right arrow
            XEducationSlides.next();
        }
    }

    allowsHide(incomingModal) {
        if (XEducationSlides.isFinished
            || (incomingModal && (XEducationSlides.nextSlide === incomingModal
            || XEducationSlides.previousSlide === incomingModal))) return true;
        XToast.warn('Please read through this important information.');
        return false;
    }

    onShow() {
        XEducationSlides.currentSlide = this;
    }
}

class XEducationSlideNOW extends XEducationSlide {
    html() {
        return `
            <h1 class="modal-header">
                Welcome to the Nimiq Open Wallet
            </h1>
            <div class="modal-body">
                <div class="has-side-image">
                    <div>
                        <h3>What is Nimiq Open Wallet?</h3>
                        <p>
                        Nimiq Open Wallet, or NOW for short, is a free and open-source Nimiq wallet powered by the community.
                        </p>
                        <br>
                        <p>
                        Given that nodes in the Nimiq blockchain can run and process transactions on a web browser
                        without the need for a browser extension, it allows to add features to the wallet to skip
                        middleman fees like those in traditional payment processors.
                        </p>
                        <br>
                        <p>
                        The features added to the wallet allow easy integration in third party applications like games,
                        e-comerce websites, subscription magazines, crypto currency exchanges, etc. and allow the user
                        to request or send micro transactions and payments just by sharing a link to the wallet.
                        </p>
                        <br>
                        <div class="warning">
                            This website is not powered nor endorsed by the <a href="https://nimiq.com/#team">Nimiq development team</a>
                            nor the official <a href="https://safe.nimiq.com">Nimiq wallet</a>.
                        </div>
                    </div>
                    <div class="side-image-now"></div>
                </div>

                <button next class="center">Welcome to Nimiq Safe</button>

                <div class="spacing-top -center">
                    Already watched the full presentation?
                    <input type="text" placeholder="enter keyword to skip it" spellcheck="false" autocomplete="off">
                </div>
            </div>
        `;
    }

    onCreate() {
        super.onCreate();
        this.$input = this.$('input');
        this.$input.addEventListener('keypress', e => this._onKeypress(e));
    }

    _onKeypress(e) {
        if (e.keyCode !== 13) return; // any key
        if (this.$input.value === 'safe') {
            XEducationSlides.finish();
        } else {
            this.$input.value = '';                
        }
    }
}

class XEducationSlideIntro extends XEducationSlide {
    html() {
        return `
            <h1 class="modal-header">
                Welcome to the Nimiq Safe
            </h1>
            <div class="modal-body">
                <div class="has-side-image">
                    <div>
                        <div class="warning">
                            <p>Please take some time to understand this for your own safety. 🙏</p>
                            <p>Your funds will be stolen if you do not heed these warnings.</p>
                        </div>
                        <div class="warning">
                            We cannot recover your funds or freeze your account if you visit a phishing site or lose your private key.
                        </div>
                        <h3>What is the Nimiq Safe?</h3>
                        <ul>
                            <li>The Nimiq Safe is a free, open-source, client-side interface.</li>
                            <li>It allows you to interact directly with the Nimiq blockchain while remaining in full control of your keys & your funds.</li>
                            <li><strong>You</strong> and <strong>only you</strong> are responsible for your security.</li>
                        </ul>
                    </div>
                    <div class="side-image-intro"></div>
                </div>

                <button next class="center">Nimiq is not a Bank</button>
            </div>
        `;
    }
}

class XEducationSlideNotABank extends XEducationSlide {
    html() {
        return `
            <h1 class="modal-header">
                Nimiq Safe is <strong>not</strong> part of a bank
            </h1>
            <div class="modal-body">
                <div class="has-side-image">
                    <div class="side-image-not-a-bank"></div>
                    <div>
                        <h3>Nimiq Safe is an Interface.</h3>
                        <ul>
                            <li>When you create an account in Nimiq Safe, you are generating a cryptographic set of numbers: your private key (represented by 24 Account Recovery Words) and your public key (represented by the Account Number).</li>
                            <li>The handling of your keys happens entirely on your computer, inside your browser.</li>
                            <li>We never transmit, receive or store your private key, 24 Recovery Words, Pass Phrase, PIN, Account Access File or other account information.</li>
                            <li>You are simply using our interface to <strong>interact directly with the blockchain</strong>.</li>
                            <li>If you send your account number (public key) to someone, they can send you NIM.</li>
                            <li>If you send your private key, 24 Recovery Words or Account Access File with PIN / Pass Phrase to someone, they now have full control of your account.</li>
                        </ul>
                    </div>
                </div>

                <div class="button-bar">
                    <button back>Introduction</button>
                    <button next>What is a Blockchain?</button>
                </div>
            </div>
        `;
    }
}

class XEducationSlideBlockchain extends XEducationSlide {
    html() {
        return `
            <h1 class="modal-header">
                Wait, what is a Blockchain?
            </h1>
            <div class="modal-body">
                <div class="has-side-image">
                    <ul>
                        <li>The blockchain is like a huge, global, decentralized spreadsheet.</li>
                        <li>It keeps track of who sent how many coins to whom, and what the balance of every account is.</li>
                        <li>It is stored and maintained by thousands of people (miners) across the globe connected to the blockchain with their computers.</li>
                        <li>When you see your balance on safe.nimiq.com or view your transactions on nimiq.watch, you are seeing data on the blockchain, not in our personal systems.</li>
                        <li>Again: <strong>Nimiq Safe accounts are not part of a bank.</strong></li>
                    </ul>
                    <div class="side-image-blockchain"></div>
                </div>

                <div class="button-bar">
                    <button back>Not a Bank</button>
                    <button next>But... Why?</button>
                </div>
            </div>
        `;
    }
}

class XEducationSlideWhy extends XEducationSlide {
    html() {
        return `
            <h1 class="modal-header">
                Why are you making me read all this?
            </h1>
            <div class="modal-body">
                <div class="has-side-image">
                    <div class="side-image-why"></div>
                    <div>
                        <h3>Because we need you to understand that we cannot...</h3>
                        <ul class="important">
                            <li>Access your account or send your funds for you.</li>
                            <li>Recover or change your private key or 24 Recovery Words.</li>
                            <li>Recover or reset your Pass Phrase or PIN.</li>
                            <li>Reverse, cancel, or refund transactions.</li>
                            <li>Freeze accounts.</li>
                        </ul>

                        <h3><strong>You</strong> and <strong>only you</strong> are responsible for your security.</h3>
                        <ul>
                            <li>Be diligent to keep your private key and associated 24 Recovery Words, Account Access File and Pass Phrase safe.</li>
                            <li>If you lose your private key (24 Recovery Words), Pass Phrase or PIN, no one can recover it.</li>
                            <li>If you enter your private key (24 Recovery Words) on a phishing website, you will have <strong>all your funds taken</strong>.</li>
                        </ul>
                    </div>
                </div>

                <div class="button-bar">
                    <button back>What is a Blockchain?</button>
                    <button next>So what's the point?</button>
                </div>
            </div>
        `;
    }
}

class XEducationSlidePointOfNimiq extends XEducationSlide {
    html() {
        return `
            <h1 class="modal-header">
                Why can't Nimiq Safe do those things?
            </h1>
            <div class="modal-body">
                <div class="has-side-image">
                    <div class="side-image-point-of-nimiq"></div>
                    <div>
                        <ul>
                            <li>Because that is the point of decentralization and the blockchain.</li>
                            <li>You don't have to rely on your bank, government, or anyone else when you want to move your funds.</li>
                            <li>You don't have to rely on the security of an exchange or bank to keep your funds safe.</li>
                            <li>If you don't find these things valuable, ask yourself why you think the blockchain and cryptocurrencies are valuable. 😉</li>
                        </ul>
                    </div>
                </div>

                <div class="button-bar">
                    <button back>But... Why?</button>
                    <button next>Protect your Funds</button>
                </div>
            </div>
        `;
    }
}

class XEducationSlidePhishers extends XEducationSlide {
    html() {
        return `
            <h1 class="modal-header">
                How To Protect Yourself from Phishers
            </h1>
            <div class="modal-body">
                <h3>Phishers send you a message with a link to a website that looks just like the Nimiq Safe, Paypal, or your bank, but is not the real website. They steal your information and then steal your money.</h3>
                <div class="has-side-image">
                    <ul>
                        <li>Always validate the URL: https://safe.nimiq.com</li>
                        <li><strong>The only authorized view that will ever ask you for your Pass Phrase, PIN or 24 Recovery Words is the Nimiq Keyguard at https://keyguard.nimiq.com</strong></li>
                        <!-- <li>Always make sure the URL bar has NIMIQ in green</li> -->
                        <li>Do not trust messages or links sent to you randomly via email, Slack, Reddit, Twitter, etc.
Always navigate directly to a site before you enter information. Do not enter information after clicking a link from a message or email.</li>
                        <li>Install an AdBlocker and do not click ads on your search engine (e.g. Google).</li>
                    </ul>
                    <div class="side-image-phishers"></div>
                </div>

                <div class="button-bar">
                    <button back>What's the point?</button>
                    <button next>Protect from Scams</button>
                </div>
            </div>
        `;
    }
}

class XEducationSlideScams extends XEducationSlide {
    html() {
        return `
            <h1 class="modal-header">
                How To Protect Yourself from Scams
            </h1>
            <div class="modal-body">
                <h3>People will try to get you to give them money in return for nothing.</h3>
                <div class="has-side-image">
                    <ul>
                        <li>If it is too good to be true, it probably is.</li>
                        <li>Research before sending money to someone or some project. Look for information on a variety of websites and forums. Be wary.</li>
                        <li>Ask questions when you don't understand something or it doesn't seem right.</li>
                        <li>Don't let fear, FUD (fear, uncertainty and doubt), or FOMO (fear of missing out) win over common sense. If something is very urgent, ask yourself "why?". It may be to create FOMO or prevent you from doing research.</li>
                    </ul>
                    <div class="side-image-scams"></div>
                </div>

                <div class="button-bar">
                    <button back>Phishers</button>
                    <button next>Protect From Loss</button>
                </div>
            </div>
        `;
    }
}

class XEducationSlideLoss extends XEducationSlide {
    html() {
        return `
            <h1 class="modal-header">
                How To Protect Yourself from Loss
            </h1>
            <div class="modal-body">
                <h3>If you lose your 24 Recovery Words, Pass Phrase or PIN, they are gone forever. Don't lose them.</h3>
                <div class="has-side-image">
                    <ul>
                        <li>Make a backup of your 24 Recovery Words and Pass Phrase. Do NOT just store it on your computer. Print it out or write it down on a piece of paper.</li>
                        <li>Store one or more copies of this paper in one or more secure and private physical locations. A backup is not useful if it is destroyed by a fire or flood along with your computer.</li>
                        <li>Do not store your 24 Recovery Words in Dropbox, Google Drive, or other cloud storage. If that account is compromised, your funds will be stolen.</li>
                    </ul>
                    <div class="side-image-loss"></div>
                </div>

                <div class="button-bar">
                    <button back>Scams</button>
                    <button next>Got it</button>
                </div>

                <div class="spacing-top -center">
                    The next time you see this presentation enter the keyword <strong>"safe"</strong> to skip it.
                </div>
            </div>
        `;
    }
}

class XEducationSlides {
    static get slides() {
        return [ XEducationSlideNOW, XEducationSlideIntro, XEducationSlideNotABank, XEducationSlideBlockchain, XEducationSlideWhy,
            XEducationSlidePointOfNimiq, XEducationSlidePhishers, XEducationSlideScams, XEducationSlideLoss];
    }

    static start() {
        XEducationSlides.currentSlideIndex = 0;
        XEducationSlides.currentSlide.show();
    }

    static resume() {
        XEducationSlides.currentSlide.show();
    }

    static hide() {
        XEducationSlides.currentSlide.hide();
    }

    static next() {
        const nextSlide = XEducationSlides.nextSlide;
        if (nextSlide) {
            nextSlide.show();
        } else {
            XEducationSlides.finish();
        }
    }

    static back() {
        const previousSlide = XEducationSlides.previousSlide;
        if (!previousSlide) return;
        previousSlide.show();
    }

    static finish() {
        localStorage[XEducationSlides.KEY_FINISHED] = 'yes';
        XEducationSlides.hide();
        XEducationSlides.onFinished();
    }

    static get currentSlide() {
        return XEducationSlides.slides[XEducationSlides.currentSlideIndex].instance;
    }

    static get nextSlide() {
        const nextSlide = XEducationSlides.slides[XEducationSlides.currentSlideIndex + 1];
        return nextSlide? nextSlide.instance : null;
    }

    static get previousSlide() {
        const previousSlide = XEducationSlides.slides[XEducationSlides.currentSlideIndex - 1];
        return previousSlide? previousSlide.instance : null;
    }

    static get lastSlide() {
        return XEducationSlides.slides[XEducationSlides.slides.length - 1];
    }

    static set currentSlide(slide) {
        const index = XEducationSlides.slides.indexOf(slide.constructor);
        if (index < 0) return;
        XEducationSlides.currentSlideIndex = index;
    }

    static get currentSlideIndex() {
        return parseInt(localStorage[XEducationSlides.KEY_CURRENT_SLIDE]) || 0;
    }

    static set currentSlideIndex(index) {
        if (index < 0 || index >= XEducationSlides.slides.length) return;
        localStorage[XEducationSlides.KEY_CURRENT_SLIDE] = index;
        XEducationSlides.currentSlide.show();
    }

    static get isFinished() {
        return localStorage[XEducationSlides.KEY_FINISHED] === 'yes';
    }

    /* Override if needed */
    static onFinished() { }
}
XEducationSlides.KEY_CURRENT_SLIDE = 'education-slides-current-slide';
XEducationSlides.KEY_FINISHED = 'education-slides-finished';

// TODO lazy loading

/*
    patternLock.js v 1.1.1
    Author: Sudhanshu Yadav, Nimiq Foundation
    Copyright (c) 2015,2016 Sudhanshu Yadav - ignitersworld.com , released under the MIT license.
    Copyright (c) 2018 Nimiq Foundation - nimiq.com , released under the MIT license.
*/

var PatternLock = (function(window, undefined) {
    "use strict";

    var document = window.document;

    var nullFunc = function() {},
        objectHolder = {};

    //internal functions
    function readyDom(iObj) {
        var holder = iObj.holder,
            option = iObj.option,
            matrix = option.matrix,
            margin = option.margin,
            radius = option.radius,
            html = ['<ul class="patt-wrap" style="padding:' + margin + 'px">'];
        for (var i = 0, ln = matrix[0] * matrix[1]; i < ln; i++) {
            html.push('<li class="patt-circ" style="margin:' + margin + 'px; width : ' + (radius * 2) + 'px; height : ' + (radius * 2) + 'px; -webkit-border-radius: ' + radius + 'px; -moz-border-radius: ' + radius + 'px; border-radius: ' + radius + 'px; "><div class="patt-dots"></div></li>');
        }
        html.push('</ul>');
        holder.innerHTML = html.join('');
        holder.style.width = (matrix[1] * (radius * 2 + margin * 2) + margin * 2) + 'px';
        holder.style.height = (matrix[0] * (radius * 2 + margin * 2) + margin * 2) + 'px';

        //select pattern circle
        iObj.pattCircle = iObj.holder.querySelectorAll('.patt-circ');

    }

    //return height and angle for lines
    function getLengthAngle(x1, x2, y1, y2) {
        var xDiff = x2 - x1,
            yDiff = y2 - y1;

        return {
            length: Math.ceil(Math.sqrt(xDiff * xDiff + yDiff * yDiff)),
            angle: Math.round((Math.atan2(yDiff, xDiff) * 180) / Math.PI)
        };
    }


    var startHandler = function(e, obj) {
            e.preventDefault();
            var iObj = objectHolder[obj.token];

            if (iObj.disabled) return;

            //check if pattern is visible or not
            if (!iObj.option.patternVisible) {
                iObj.holder.classList.add('patt-hidden');
            }

            var touchMove = e.type == "touchstart" ? "touchmove" : "mousemove",
                touchEnd = e.type == "touchstart" ? "touchend" : "mouseup";

            //assign events
            window.__patternLockMoveHandler = function(e) {
                moveHandler.call(this, e, obj);
            };

            this.addEventListener(touchMove, window.__patternLockMoveHandler);
            document.addEventListener(touchEnd, function() {
                endHandler.call(this, e, obj);
            }, {once: true});
            //set pattern offset
            var wrap = iObj.holder.querySelector('.patt-wrap'),
                offset = wrap.getBoundingClientRect();
            iObj.wrapper = wrap;
            iObj.wrapTop = offset.top;
            iObj.wrapLeft = offset.left;

            //reset pattern
            obj.reset();
        },
        moveHandler = function(e, obj) {
            e.preventDefault();
            var x = e.clientX || e.touches[0].clientX,
                y = e.clientY || e.touches[0].clientY,
                iObj = objectHolder[obj.token],
                option = iObj.option,
                li = iObj.pattCircle,
                patternAry = iObj.patternAry,
                posObj = iObj.getIdxFromPoint(x, y),
                idx = posObj.idx,
                pattId = iObj.mapperFunc(idx) || idx;


            if (patternAry.length > 0) {
                var laMove = getLengthAngle(iObj.lineX1, posObj.x, iObj.lineY1, posObj.y);
                iObj.line.style.width = (laMove.length + 10) + 'px';
                iObj.line.style.transform = 'rotate(' + laMove.angle + 'deg)';
            }


            if (idx && ((option.allowRepeat && patternAry[patternAry.length - 1] !== pattId) || patternAry.indexOf(pattId) === -1)) {
                var elm = li[idx - 1];

                //mark if any points are in middle of previous point and current point, if it does check them
                if (iObj.lastPosObj) {
                    var lastPosObj = iObj.lastPosObj,
                        ip = lastPosObj.i,
                        jp = lastPosObj.j,
                        xDelta = posObj.i - lastPosObj.i > 0 ? 1 : -1,
                        yDelta = posObj.j - lastPosObj.j > 0 ? 1 : -1,
                        iDiff = Math.abs(posObj.i - ip),
                        jDiff = Math.abs(posObj.j - jp);

                    while (((iDiff === 0 && jDiff > 1) || (jDiff === 0 && iDiff > 1) || (jDiff == iDiff && jDiff > 1))) {
                        ip = iDiff ? ip + xDelta : ip;
                        jp = jDiff ? jp + yDelta : jp;
                        iDiff = Math.abs(posObj.i - ip);
                        jDiff = Math.abs(posObj.j - jp);

                        var nextIdx = (jp - 1) * option.matrix[1] + ip,
                            nextPattId = iObj.mapperFunc(nextIdx) || nextIdx;

                        if (option.allowRepeat || patternAry.indexOf(nextPattId) == -1) {

                            //add direction to previous point and line
                            iObj.addDirectionClass({i: ip, j: jp});

                            //mark a point added
                            iObj.markPoint(li[nextPattId - 1], nextPattId);

                            //add line between the points
                            iObj.addLine({i: ip,j: jp});
                        }
                    }
                }

                //add direction to last point and line
                if (iObj.lastPosObj) iObj.addDirectionClass(posObj);

                //mark the initial point added
                iObj.markPoint(elm, pattId);

                //add initial line
                iObj.addLine(posObj);

                iObj.lastPosObj = posObj;
            }
        },
        endHandler = function(e, obj) {
            e.preventDefault();
            var iObj = objectHolder[obj.token],
                option = iObj.option,
                pattern = iObj.patternAry.join(option.delimiter);

            //remove hidden pattern class and remove event
            iObj.holder.removeEventListener("touchmove", window.__patternLockMoveHandler);
            iObj.holder.removeEventListener("mousemove", window.__patternLockMoveHandler);
            iObj.holder.classList.remove('patt-hidden');

            if (!pattern) return;

            option.onDraw(pattern);

            //to remove last line
            if (iObj.line.parentNode) iObj.line.parentNode.removeChild(iObj.line);



            if (iObj.rightPattern) {
                if (pattern == iObj.rightPattern) {
                    iObj.onSuccess();
                } else {
                    iObj.onError();
                    obj.error();
                }
            }
        };

    function InternalMethods() {}

    InternalMethods.prototype = {
        constructor: InternalMethods,
        getIdxFromPoint: function(x, y) {
            var option = this.option,
                matrix = option.matrix,
                xi = x - this.wrapLeft,
                yi = y - this.wrapTop,
                idx = null,
                margin = option.margin,
                plotLn = option.radius * 2 + margin * 2,
                qsntX = Math.ceil(xi / plotLn),
                qsntY = Math.ceil(yi / plotLn),
                remX = xi % plotLn,
                remY = yi % plotLn;

            if (qsntX <= matrix[1] && qsntY <= matrix[0] && remX > margin * 2 && remY > margin * 2) {
                idx = (qsntY - 1) * matrix[1] + qsntX;
            }
            return {
                idx: idx,
                i: qsntX,
                j: qsntY,
                x: xi,
                y: yi
            };
        },
        markPoint: function(elm, pattId) {
            //add the current element on pattern
            elm.classList.add('hovered');

            //push pattern on array
            this.patternAry.push(pattId);

            this.lastElm = elm;
        },
        //method to add lines between two element
        addLine: function(posObj) {
            var _this = this,
                patternAry = _this.patternAry,
                option = _this.option;

            //add start point for line
            var lineOnMove = option.lineOnMove,
                margin = option.margin,
                radius = option.radius,
                newX = (posObj.i - 1) * (2 * margin + 2 * radius) + 2 * margin + radius,
                newY = (posObj.j - 1) * (2 * margin + 2 * radius) + 2 * margin + radius;

            if (patternAry.length > 1) {
                //to fix line
                var lA = getLengthAngle(_this.lineX1, newX, _this.lineY1, newY);
                _this.line.style.width = (lA.length + 10) + 'px';
                _this.line.style.transform = 'rotate(' + lA.angle + 'deg)';

                if (!lineOnMove) _this.line.style.display = 'block';
            }


            //to create new line
            var line = document.createElement('div');
            line.classList.add('patt-lines');
            line.style.top = (newY - 5) + 'px';
            line.style.left = (newX - 5) + 'px';
            _this.line = line;
            _this.lineX1 = newX;
            _this.lineY1 = newY;

            //add on dom
            _this.wrapper.appendChild(line);
            if (!lineOnMove) _this.line.style.display = 'none';
        },
        // add direction on point and line
        addDirectionClass: function(curPos) {
            var point = this.lastElm,
                line = this.line,
                lastPos = this.lastPosObj;

            var direction = [];
            curPos.j - lastPos.j > 0 ? direction.push('s') : curPos.j - lastPos.j < 0 ? direction.push('n') : 0;
            curPos.i - lastPos.i > 0 ? direction.push('e') : curPos.i - lastPos.i < 0 ? direction.push('w') : 0;
            direction = direction.join('-');

            if (direction) {
                point.classList.add(direction, "dir");
                line.classList.add(direction, "dir");
            }
        }

    };

    function PatternLock(selector, option) {
        var self = this,
            token = self.token = Math.random(),
            iObj = objectHolder[token] = new InternalMethods(),
            holder = iObj.holder = selector instanceof Node ? selector : document.querySelector(selector);

        //if holder is not present return
        if (!holder) {
            console.error('PatternLock: selector ' + selector + ' not found!');
            return;
        }

        iObj.object = self;

        //optimizing options
        option = option || {};
        var defaultsFixes = {
            onDraw: nullFunc
        };
        var matrix = option.matrix;
        if (matrix && matrix[0] * matrix[1] > 9) defaultsFixes.delimiter = ",";

        option = iObj.option = Object.assign({}, PatternLock.defaults, defaultsFixes, option);
        readyDom(iObj);

        //add class on holder
        holder.classList.add('patt-holder');

        //change offset property of holder if it does not have any property
        if (holder.style.position == "static") holder.style.position = 'relative';

        //assign event
        holder.addEventListener("touchstart", function(e) {
            startHandler.call(this, e, self);
        });
        holder.addEventListener("mousedown", function(e) {
            startHandler.call(this, e, self);
        });

        //adding a mapper function
        var mapper = option.mapper;
        if (typeof mapper == "object") {
            iObj.mapperFunc = function(idx) {
                return mapper[idx];
            };
        } else if (typeof mapper == "function") {
            iObj.mapperFunc = mapper;
        } else {
            iObj.mapperFunc = nullFunc;
        }

        //to delete from option object
        iObj.option.mapper = null;
    }

    PatternLock.prototype = {
        constructor: PatternLock,
        //method to set options after initializtion
        option: function(key, val) {
            var iObj = objectHolder[this.token],
                option = iObj.option;
            //for set methods
            if (val === undefined) {
                return option[key];
            }
            //for setter
            else {
                option[key] = val;
                if (key == "margin" || key == "matrix" || key == "radius") {
                    readyDom(iObj);
                }
            }
        },
        //get drawn pattern as string
        getPattern: function() {
            var iObj = objectHolder[this.token];
            return (iObj.patternAry || []).join(iObj.option.delimiter);
        },
        //method to draw a pattern dynamically
        setPattern: function(pattern) {
            var iObj = objectHolder[this.token],
                option = iObj.option,
                matrix = option.matrix,
                margin = option.margin,
                radius = option.radius;

            //allow to set password manually only when enable set pattern option is true
            if (!option.enableSetPattern) return;

            //check if pattern is string break it with the delimiter
            if (typeof pattern === "string") {
                pattern = pattern.split(option.delimiter);
            }

            this.reset();
            iObj.wrapLeft = 0;
            iObj.wrapTop = 0;

            for (var i = 0; i < pattern.length; i++) {
                var idx = pattern[i] - 1,
                    x = idx % matrix[1],
                    y = Math.floor(idx / matrix[1]),
                    clientX = x * (2 * margin + 2 * radius) + 2 * margin + radius,
                    clientY = y * (2 * margin + 2 * radius) + 2 * margin + radius;

                moveHandler.call(null, {
                    clientX: clientX,
                    clientY: clientY,
                    preventDefault: nullFunc
                }, this);

            }
        },
        //to temprory enable disable plugin
        enable: function() {
            var iObj = objectHolder[this.token];
            iObj.disabled = false;
        },
        disable: function() {
            var iObj = objectHolder[this.token];
            iObj.disabled = true;
        },
        //reset pattern lock
        reset: function() {
            var iObj = objectHolder[this.token];
            //to remove lines
            iObj.pattCircle.forEach(el => el.classList.remove('hovered', 'dir', 's', 'n', 'w', 'e', 's-w', 's-e', 'n-w', 'n-e'));
            iObj.holder.querySelectorAll('.patt-lines').forEach(el => iObj.wrapper.removeChild(el));

            //add/reset a array which capture pattern
            iObj.patternAry = [];

            //remove last Obj
            iObj.lastPosObj = null;

            //remove error class if added
            iObj.holder.classList.remove('patt-error');

        },
        //to display error if pattern is not drawn correct
        error: function() {
            objectHolder[this.token].holder.classList.add('patt-error');
        },
        //to check the drawn pattern against given pattern
        checkForPattern: function(pattern, success, error) {
            var iObj = objectHolder[this.token];
            iObj.rightPattern = pattern;
            iObj.onSuccess = success || nullFunc;
            iObj.onError = error || nullFunc;
        }
    };

    PatternLock.defaults = {
        matrix: [3, 3],
        margin: 20,
        radius: 25,
        patternVisible: true,
        lineOnMove: true,
        delimiter: "", // a delimiter between the pattern
        enableSetPattern: false,
        allowRepeat: false
    };

    return PatternLock;

})(window);

class XSettingVisualLockModal extends MixinModal(XElement) {
    html() {
        return `
            <div class="modal-header">
                <i x-modal-close class="material-icons">close</i>
                <h2>Set up visual lock</h2>
            </div>
            <div class="modal-body">
                <p>Draw a pattern to visually lock the Safe:</p>
                <div id="setting-patternLock"></div>
            </div>
        `
    }

    onCreate() {
        super.onCreate();
        this.lock = new PatternLock("#setting-patternLock", {
            mapper: {1: 3, 2: 8, 3: 4, 4: 2, 5: 9, 6: 7, 7: 5, 8: 1, 9: 6},
            onDraw: this._onEnterPin.bind(this)
        });
    }

    onShow() {
        this._pin = null;
        this.lock.reset();
    }

    onHide() {
        this.lock.reset();
    }

    _onEnterPin(pin) {
        pin = this._hash(pin);
        if (!this._pin) {
            this._pin = pin;
            this.lock.reset();
            XToast.show('Please repeat pattern to confirm');
        } else if (this._pin !== pin) {
            this.lock.error();
            setTimeout(this.lock.reset.bind(this.lock), 500);
            this._pin = null;
            XToast.error('Pattern not matching. Please try again.');
        } else {
            this.fire('x-setting-visual-lock-pin', pin);
        }
    }

    _hash(text) {
        return ('' + text
                .split('')
                .map(c => Number(c.charCodeAt(0)) + 3)
                .reduce((a, e) => a * (1 - a) * this.__chaosHash(e), 0.5))
            .split('')
            .reduce((a, e) => e + a, '')
            .substr(4, 17);
    }

    __chaosHash(number) {
        const k = 3.569956786876;
        let a_n = 1 / number;
        for (let i = 0; i < 100; i++) {
            a_n = (1 - a_n) * a_n * k;
        }
        return a_n;
    }
}

const TypeKeys$3 = {
    SHOW_ALL_DECIMALS: 'settings/show-all-decimals',
};

const initialState = {
    showAllDecimals: false
};

function reducer$3(state, action) {
    if (state === undefined) {
        return initialState;
    }

    switch (action.type) {
        case TypeKeys$3.SHOW_ALL_DECIMALS:
            return Object.assign({}, state, {
                showAllDecimals: action.showAllDecimals
            });

        default:
           return state
    }
}

function showAllDecimals(showAllDecimals) {
    return {
        type: TypeKeys$3.SHOW_ALL_DECIMALS,
        showAllDecimals
    }
}

class XSettings extends MixinRedux(XElement) {
    html(){
        return `
             <x-card>
                <h2>Settings</h2>
                <hr>
                <span class="setting" show-all-decimals>
                    Show all decimals
                    <input type="checkbox" disabled>
                    <small>Show all five decimals when displaying balances.</small>
                </span>
                <!--
                <span class="setting" visual-lock>
                    Visual lock
                    <input type="checkbox" disabled>
                    <small>Lock access to the Safe with a pattern whenever the website is visited.</small>
                </span>
                -->
                <span class="setting" prepared-tx>
                    Send prepared transaction
                </span>
                <span class="setting" onclick="localStorage.removeItem('persistedState'); window.skipPersistingState = true; location.reload();">
                    Delete persistence
                    <small>This does not delete your accounts. It only deletes your transaction history and balances, which will be loaded again from the network.</small>
                </span>
             </x-card>
        `
    }

    onCreate() {
        if (localStorage.lock) this.$('[visual-lock] input').checked = true;
        super.onCreate();
    }

    listeners() {
        return {
            'click [show-all-decimals]': this._onClickShowAllDecimals,
            //'click [visual-lock]': this._onClickVisualLock,
            'click [prepared-tx]': () => XSendPreparedTransactionModal.show()
        }
    }

    static get actions() { return { showAllDecimals } }

    _onClickShowAllDecimals() {
        this.actions.showAllDecimals(!this.$('[show-all-decimals] input').checked);
    }

    _onClickVisualLock() {
        if (localStorage.lock) {
            const remove = confirm('Do you want to remove the lock?');
            if (remove) {
                localStorage.removeItem('lock');
                this.$('[visual-lock] input').checked = false;
            }
            return;
        }

        XSettingVisualLockModal.show();
    }

    static mapStateToProps(state) {
        return state.settings;
    }

    _onPropertiesChanged(changes) {

        if (changes.showAllDecimals !== undefined) {
            document.body.classList.toggle('setting-show-all-decimals', this.settings.showAllDecimals);
            this.$('[show-all-decimals] input').checked = this.settings.showAllDecimals;
        }
    }

    get settings() {
        return this.properties;
    }
}

function defaultEqualityCheck(a, b) {
  return a === b
}

function areArgumentsShallowlyEqual(equalityCheck, prev, next) {
  if (prev === null || next === null || prev.length !== next.length) {
    return false
  }

  // Do this in a for loop (and not a `forEach` or an `every`) so we can determine equality as fast as possible.
  const length = prev.length;
  for (let i = 0; i < length; i++) {
    if (!equalityCheck(prev[i], next[i])) {
      return false
    }
  }

  return true
}

function defaultMemoize(func, equalityCheck = defaultEqualityCheck) {
  let lastArgs = null;
  let lastResult = null;
  // we reference arguments instead of spreading them for performance reasons
  return function () {
    if (!areArgumentsShallowlyEqual(equalityCheck, lastArgs, arguments)) {
      // apply arguments instead of spreading for performance.
      lastResult = func.apply(null, arguments);
    }

    lastArgs = arguments;
    return lastResult
  }
}

function getDependencies(funcs) {
  const dependencies = Array.isArray(funcs[0]) ? funcs[0] : funcs;

  if (!dependencies.every(dep => typeof dep === 'function')) {
    const dependencyTypes = dependencies.map(
      dep => typeof dep
    ).join(', ');
    throw new Error(
      'Selector creators expect all input-selectors to be functions, ' +
      `instead received the following types: [${dependencyTypes}]`
    )
  }

  return dependencies
}

function createSelectorCreator(memoize, ...memoizeOptions) {
  return (...funcs) => {
    let recomputations = 0;
    const resultFunc = funcs.pop();
    const dependencies = getDependencies(funcs);

    const memoizedResultFunc = memoize(
      function () {
        recomputations++;
        // apply arguments instead of spreading for performance.
        return resultFunc.apply(null, arguments)
      },
      ...memoizeOptions
    );

    // If a selector is called with the exact same arguments we don't need to traverse our dependencies again.
    const selector = defaultMemoize(function () {
      const params = [];
      const length = dependencies.length;

      for (let i = 0; i < length; i++) {
        // apply arguments instead of spreading and mutate a local list of params for performance.
        params.push(dependencies[i].apply(null, arguments));
      }

      // apply arguments instead of spreading for performance.
      return memoizedResultFunc.apply(null, params)
    });

    selector.resultFunc = resultFunc;
    selector.recomputations = () => recomputations;
    selector.resetRecomputations = () => recomputations = 0;
    return selector
  }
}

const createSelector = createSelectorCreator(defaultMemoize);

const accounts$ = state => state.accounts.entries;

const hasContent$ = state => state.accounts.hasContent;

const accountsArray$ = createSelector(
    accounts$,
    hasContent$,
    (accounts, hasContent) => hasContent && [...accounts.values()]
);

const balancesLoaded$ = createSelector(
    accountsArray$,
    accounts => {
        if (!accounts) return false;

        if (accounts.filter(x => x.balance === undefined).length > 0) return false;

        return true;
    }
);

var totalAmount$ = createSelector(
    accountsArray$,
    balancesLoaded$,
    (accounts, balancesLoaded) => {
        if (!balancesLoaded) return undefined;

        if (accounts.length === 0) return 0;

        return accounts.reduce((acc, account) => acc + account.balance, 0);
    }
);

class XTotalAmount extends MixinRedux(XElement) {
    html(){
        return `
            <x-amount white display label="Total balance"></x-amount>
        `
    }

    children() {
        return [ XAmount ];
    }

    onCreate(){
        this.$currencyNim = this.$('x-currency-nim');
        super.onCreate();
    }

    static mapStateToProps(state) {
        return {
            totalAmount: totalAmount$(state)
        };
    }

    _onPropertiesChanged(changes) {
        const { totalAmount } = changes;

        if (totalAmount !== undefined) {
            this.value = totalAmount;
        }
    }

    set value(value) {
        this.$amount.value = value;
    }
}

class XWelcomeModal extends MixinRedux(MixinModal(XElement)) {

    html() {
        return `
            <style>
                body:not(.enable-ledger) [import-ledger] {
                    display: none;
                }
            </style>
            <div class="modal-header">
                <i x-modal-close class="material-icons">close</i>
                <h2>Welcome to Nimiq Safe</h2>
            </div>
            <div class="modal-body center">
                <button class="create waiting">Create New Account</button>
                <a secondary import-ledger>Import Ledger Account</a>
                <a secondary class="waiting" import-words>Import Recovery Words</a>
                <a secondary class="waiting" import-file>Import Access File</a>
            </div>
            `
    }

    static mapStateToProps(state) {
        return {
            keyguardReady: state.connection.keyguard
        }
    }

    _onPropertiesChanged(changes) {
        if (changes.keyguardReady) {
            this.$('.create').classList.remove('waiting');
            this.$('[import-words]').classList.remove('waiting');
            this.$('[import-file]').classList.remove('waiting');
        }
    }

    listeners() {
        return {
            'click button.create': this._onCreateAccount.bind(this),
            'click [import-ledger]': this._onImportLedger.bind(this),
            'click [import-words]': this._onImportWords.bind(this),
            'click [import-file]': this._onImportFile.bind(this)
        }
    }

    _onCreateAccount() {
        this.fire('x-accounts-create');
    }

    _onImportLedger() {
        this.fire('x-accounts-import-ledger');
    }

    _onImportWords() {
        this.fire('x-accounts-import-words');
    }

    _onImportFile() {
        this.fire('x-accounts-import-file');
    }
}

// Todo wording, content of this element

class XDisclaimerModal extends MixinModal(XElement) {
    html() {
        return `
            <div class="modal-header">
                <i x-modal-close class="material-icons">close</i>
                <h2>Disclaimer</h2>
            </div>
            <div class="modal-body">
                <!-- <p>Be safe & secure: <a href="">We highly recommend that you read our guide on How to Prevent Loss & Theft for some guidelines on how to be proactive about your security.</a></p> -->

                <p>Always backup your recovery words, passphrase, pin and keys. Please note that safe.nimiq.com, keyguard.nimiq.com & miner.nimiq.com are not "web wallets". <strong>You do not create an account or give us your funds to hold onto.</strong> You hold your keys. We only make it easy for you, through a browser, to create, save, and access your information and interact with the blockchain.</p>

                <p>We are not responsible for any loss. Nimiq, safe.nimiq.com, keyguard.nimiq.com & miner.nimiq.com, and some of the underlying libraries are under active development. While we thoroughly test, there is always the possibility something unexpected happens that causes your funds to be lost. Please do not place more than you are willing to lose, and please be careful.</p>

                <p><strong>MIT License Copyright © 2018 Nimiq Foundation</strong></p>

                <p>Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:</p>

                <p>The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.</p>

                <p>THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.</p>
            </div>
        `
    }
}

const walletAccounts$ = createSelector(
    accountsArray$,
    accounts => accounts && accounts.filter(x => x.type === AccountType.KEYGUARD_LOW)
);

var needsUpgrade$ = createSelector(
    walletAccounts$,
    accounts => accounts && accounts.find(x => x.balance > 0)
);

class XUpgradeModal extends MixinRedux(MixinModal(XElement)) {
    html() {
        return `
            <div class="modal-header">
                <i x-modal-close class="material-icons">close</i>
                <h2>Please Upgrade your Account</h2>
            </div>
            <div class="modal-body center">
                <x-account></x-account>
                <div class="spacing-bottom spacing-top -left">
                    To protect your funds, please upgrade your account to a Nimiq Safe Account. You will create a backup and get a nice green checkmark.
                </div>
                <button>Upgrade now</button>
            </div>
        `
    }

    children() {
        return [ XAccount ];
    }

    onHide() {
        if (this.properties.account) {
            // When the upgrade is cancelled, this property is still set
            this.actions.upgradeCanceled(this.properties.account.address);
        }
    }

    static get actions() {
        return {
            upgradeCanceled
        }
    }

    static mapStateToProps(state) {
        return {
            account: needsUpgrade$(state)
        }
    }

    _onPropertiesChanged(changes) {
        const account = changes.account;

        if (account) {
            this.$account.account = account;

            if (!account.upgradeCanceled || Date.now() - account.upgradeCanceled > 1000 * 3600 * 24) {
                this.show();
            }
        }
    }

    listeners() {
        return {
            'click button': _ => this.fire('x-upgrade-account', this.properties.account.address)
        }
    }
}

class XSafe extends MixinRedux(XElement) {

    html() {
        return `
            <div class="header-warning display-none">
                <i class="close-warning material-icons" onclick="this.parentNode.remove(this);">close</i>
                You are connecting to the Nimiq Testnet. Please <strong>do not</strong> use your Mainnet accounts in the Testnet!
            </div>
            <header>
                <div class="header-top content-width">
                    <div class="nimiq-app-name">
                        <nimiq-logo>
                            NIMIQ SAFE<sup>BETA</sup>
                            <a logo-link href="#"></a>
                        </nimiq-logo>
                    </div>
                    <nav class="secondary-links">
                        <!-- <a href="https://nimiq.com">Homepage</a> -->
                        <!-- <a href="https://medium.com/nimiq-network">Blog</a> -->
                        <!-- <a href="https://nimiq.com/explorer">Explorer</a> -->
                    </nav>
                </div>
                <x-total-amount></x-total-amount>
                <div class="header-bottom content-width">
                    <nav class="main">
                        <a x-href="">Dashboard</a>
                        <a x-href="history">History</a>
                        <a x-href="settings">Settings</a>
                    </nav>
                </div>
            </header>

            <section class="content nimiq-dark content-width">
                <nav class="actions floating-actions">
                    <div class="floating-btn">
                        <button new-tx disabled><span>Send</span></button>
                        <div class="btn-text">Send</div>
                    </div>
                    <div class="floating-btn">
                        <button receive disabled><span>Receive</span></button>
                        <div class="btn-text">Receive</div>
                    </div>
                    <x-send-transaction-modal x-route-aside="new-transaction"></x-send-transaction-modal>
                </nav>
                <x-view-dashboard x-route="" class="content-width">
                    <!-- <h1>Dashboard</h1> -->
                    <x-card style="max-width: 960px;">
                        <h2>Recent Transactions</h2>
                        <x-transactions class="no-animation" only-recent no-menu></x-transactions>
                    </x-card>
                    <x-card style="max-width: 536px;">
                        <h2>Your Accounts</h2>
                        <x-accounts></x-accounts>
                    </x-card>
                    <x-card style="max-width: 344px;">
                        <h2>Nimiq Network</h2>
                        <x-network-indicator></x-network-indicator>
                    </x-card>
                </x-view-dashboard>
                <x-view-history x-route="history" class="content-width">
                    <!-- <h1>History</h1> -->
                    <x-card>
                        <h2>Transaction history</h2>
                        <x-transactions class="no-animation" passive></x-transactions>
                    </x-card>
                </x-view-history>
                <x-view-settings x-route="settings" class="content-width">
                    <!-- <h1>Settings</h1> -->
                    <x-settings></x-settings>
                </x-view-settings>
                <x-welcome-modal x-route-aside="welcome"></x-welcome-modal>
                <x-upgrade-modal x-route-aside="please-upgrade"></x-upgrade-modal>
                <x-transaction-modal x-route-aside="transaction"></x-transaction-modal>
                <x-receive-request-link-modal x-route-aside="request"></x-receive-request-link-modal>
                <x-create-request-link-modal x-route-aside="receive" data-x-root="${Config.src('safe')}"></x-create-request-link-modal>
                <x-disclaimer-modal x-route-aside="disclaimer"></x-disclaimer-modal>
            </section>
            <footer class="nimiq-dark">
                &copy; 2017-2018 Nimiq Foundation<br>
                <a disclaimer>Disclaimer</a>
            </footer>
            `
    }

    children() {
        return [
            XTotalAmount,
            XSendTransactionModal,
            XAccounts,
            XTransactions,
            XSettings,
            XNetworkIndicator,
            XTransactionModal,
            XWelcomeModal,
            XReceiveRequestLinkModal,
            XCreateRequestLinkModal,
            XDisclaimerModal,
            XUpgradeModal
        ];
    }

    async onCreate() {
        super.onCreate();

        XRouter.create();

        this._introFinished = XEducationSlides.isFinished || Config.network === 'test' // on testnet don't show the slides
            || document.body.classList.contains('enable-ledger'); // TODO only temporary. Remove when not needed anymore

        if (!this._introFinished) {
            XEducationSlides.onFinished = () => this._onIntroFinished();
            XEducationSlides.start();
        }

        if (Config.network !== 'main') {
            this.$('.header-warning').classList.remove('display-none');
        }

        this.$('[logo-link]').href = 'https://' + Config.tld;

        this.relayedTxResolvers = new Map();
    }

    static mapStateToProps(state) {
        return {
            height: state.network.height,
            hasConsensus: state.network.consensus === 'established',
            accountsInitialized: state.accounts.hasContent,
            accountsPresent: state.accounts.entries.size > 0,
            totalAmount: totalAmount$(state),
            upgradeAccount: needsUpgrade$(state)
        }
    }

    _onPropertiesChanged(changes) {
        if (changes.accountsInitialized && !this.properties.accountsPresent
            // TODO remove check for temporary enable-ledger flag when not needed anymore
            && !document.body.classList.contains('enable-ledger')
        ) {
            if (this._introFinished) this.$welcomeModal.show();
            else this._showWelcomeAfterIntro = true;
        }

        if (changes.accountsPresent) {
            this.$welcomeModal.hide();
            this.$('button[receive]').disabled = false;

            if (Config.offline) {
                this.$('button[new-tx]').disabled = false;
            }
        }

        if (changes.totalAmount !== undefined) {
            this.$('button[new-tx]').disabled = changes.totalAmount === 0;
        }
    }

    _onIntroFinished() {
        this._introFinished = true;

        if (this._showWelcomeAfterIntro) {
            this.$welcomeModal.show();
        }

        if (this.properties.upgradeAccount) {
            this.$upgradeModal.show();
        }
    }

    listeners() {
        return {
            'x-accounts-create': this._clickedCreateAccount.bind(this),
            'x-accounts-import-file': this._clickedImportAccountFile.bind(this),
            'x-accounts-import-words': this._clickedImportAccountWords.bind(this),
            'x-accounts-import-ledger': this._clickedImportAccountLedger.bind(this),
            'click button[new-tx]': this._clickedNewTransaction.bind(this),
            'click button[receive]': this._clickedReceive.bind(this),
            'x-send-transaction': this._signTransaction.bind(this),
            'x-send-prepared-transaction': this._clickedPreparedTransaction.bind(this),
            'x-send-prepared-transaction-confirm': this._sendTransactionNow.bind(this),
            'x-account-modal-new-tx': this._newTransactionFrom.bind(this),
            'x-upgrade-account': this._clickedAccountUpgrade.bind(this),
            'x-account-modal-backup-words': this._clickedAccountBackupWords.bind(this),
            'x-account-modal-rename': this._clickedAccountRename.bind(this),
            'click a[disclaimer]': () => XDisclaimerModal.show(),
            'x-setting-visual-lock-pin': this._onSetVisualLock
        }
    }

    async _clickedCreateAccount() {
        try {
            await accountManager.createSafe();
            XToast.success('Account created successfully.');
        } catch (e) {
            console.error(e);
            XToast.warning('Account was not created.');
        }
    }

    async _clickedImportAccountLedger() {
        try {
            await accountManager.importLedger();
            XToast.success('Account imported successfully.');
        } catch(e) {
            XToast.warning('Account was not imported.');
        }
    }

    async _clickedImportAccountFile() {
        try {
            await accountManager.importFromFile();
            XToast.success('Account imported successfully.');
        } catch (e) {
            console.error(e);
            XToast.warning('Account was not imported.');
        }
    }

    async _clickedImportAccountWords() {
        try {
            await accountManager.importFromWords();
            XToast.success('Account imported successfully.');
        } catch (e) {
            console.error(e);
            XToast.warning('Account was not imported.');
        }
    }

    async _clickedAccountUpgrade(address) {
        try {
            await accountManager.upgrade(address);
            XToast.success('Account upgraded successfully.');
            XUpgradeModal.hide();
        } catch (e) {
            console.error(e);
            XToast.warning('Upgrade not completed.');
        }
    }

    async _clickedAccountBackupWords(address) {
        try {
            await accountManager.backupWords(address);
            XToast.success('Account backed up successfully.');
        } catch (e) {
            console.error(e);
            XToast.warning('No backup created.');
        }
    }

    async _clickedAccountRename(address) {
        try {
            await accountManager.rename(address);
            XToast.success('Account renamed successfully.');
        } catch (e) {
            console.error(e);
            XToast.warning('Account was not renamed.');
        }
    }

    _clickedNewTransaction() {
        this._newTransactionFrom();
    }

    _newTransactionFrom(address) {
        if (address) {
            XSendTransactionModal.show(`sender=${ spaceToDash(address) }`);
        } else {
            XSendTransactionModal.show();
        }
    }

    _clickedPreparedTransaction() {
        XSendPreparedTransactionModal.show();
    }

    _clickedReceive() {
        XCreateRequestLinkModal.show();
    }

    async _signTransaction(tx) {
        // To allow for airgapped transaction creation, the validityStartHeight needs
        // to be allowed to be set by the user. Thus we need to parse what the user
        // put in and react accordingly.

        const setValidityStartHeight = parseInt(tx.validityStartHeight.trim());

        if (isNaN(setValidityStartHeight) && !this.properties.height) {
            if (Config.offline) {
                XToast.warning('In offline mode, the validity-start-height needs to be set (advanced settings).');
            } else {
                XToast.warning('Consensus not yet established, please try again in a few seconds.');
            }
            return;
        }

        tx.value = Number(tx.value);
        tx.fee = Number(tx.fee) || 0;
        tx.validityStartHeight = isNaN(setValidityStartHeight) ? this.properties.height : setValidityStartHeight;
        tx.recipient = 'NQ' + tx.recipient;

        const signedTx = await accountManager.sign(tx);

        if (!this.properties.hasConsensus) {
            XSendTransactionOfflineModal.instance.transaction = signedTx;
            XSendTransactionOfflineModal.show();
        } else {
            this._sendTransactionNow(signedTx);
        }
    }

    async _sendTransactionNow(signedTx) {
        if (!signedTx) return;

        if (Config.offline) {
            XSendTransactionOfflineModal.instance.transaction = signedTx;
            XSendTransactionOfflineModal.show();
            return;
        }

        // Give user feedback that something is happening
        XSendTransactionModal.instance.loading = true;
        XSendPreparedTransactionModal.instance.loading = true;

        const network = await networkClient.rpcClient;
        try {
            const relayedTx = new Promise((resolve, reject) => {
                this.relayedTxResolvers.set(signedTx.hash, resolve);
                setTimeout(reject, 8000, new Error('Transaction could not be sent'));
            });

            await network.relayTransaction(signedTx);

            try {
                await relayedTx;
            } catch(e) {
                this.relayedTxResolvers.delete(signedTx.hash);
                network.removeTxFromMempool(signedTx);
                throw e;
            }

            XSendTransactionModal.hide();
            XSendPreparedTransactionModal.hide();

            XToast.success('Transaction sent!');
        } catch(e) {
            XToast.error(e.message || e);
            XSendTransactionModal.instance.loading = false;
            XSendPreparedTransactionModal.instance.loading = false;
        }
    }

    _onSetVisualLock(pin) {
        console.log(pin);
        localStorage.setItem('lock', pin);
        this.$('x-settings [visual-lock] input').checked = true;
        XToast.success('Visual lock set!');
        XSettingVisualLockModal.hide();
    }
}

const repeat = (str, times) => (new Array(times + 1)).join(str);

const pad = (num, maxLength) => repeat('0', maxLength - num.toString().length) + num;

const formatTime = time => `${pad(time.getHours(), 2)}:${pad(time.getMinutes(), 2)}:${pad(time.getSeconds(), 2)}.${pad(time.getMilliseconds(), 3)}`;

// Use performance API if it's available in order to get better precision
const timer =
(typeof performance !== 'undefined' && performance !== null) && typeof performance.now === 'function' ?
  performance :
  Date;

'use strict';
var $scope;
var conflict;
var conflictResolution = [];
if (typeof global === 'object' && global) {
  $scope = global;
} else if (typeof window !== 'undefined') {
  $scope = window;
} else {
  $scope = {};
}
conflict = $scope.DeepDiff;
if (conflict) {
  conflictResolution.push(
    function() {
      if ('undefined' !== typeof conflict && $scope.DeepDiff === accumulateDiff) {
        $scope.DeepDiff = conflict;
        conflict = undefined;
      }
    });
}

// nodejs compatible on server side and in the browser.
function inherits(ctor, superCtor) {
  ctor.super_ = superCtor;
  ctor.prototype = Object.create(superCtor.prototype, {
    constructor: {
      value: ctor,
      enumerable: false,
      writable: true,
      configurable: true
    }
  });
}

function Diff(kind, path) {
  Object.defineProperty(this, 'kind', {
    value: kind,
    enumerable: true
  });
  if (path && path.length) {
    Object.defineProperty(this, 'path', {
      value: path,
      enumerable: true
    });
  }
}

function DiffEdit(path, origin, value) {
  DiffEdit.super_.call(this, 'E', path);
  Object.defineProperty(this, 'lhs', {
    value: origin,
    enumerable: true
  });
  Object.defineProperty(this, 'rhs', {
    value: value,
    enumerable: true
  });
}
inherits(DiffEdit, Diff);

function DiffNew(path, value) {
  DiffNew.super_.call(this, 'N', path);
  Object.defineProperty(this, 'rhs', {
    value: value,
    enumerable: true
  });
}
inherits(DiffNew, Diff);

function DiffDeleted(path, value) {
  DiffDeleted.super_.call(this, 'D', path);
  Object.defineProperty(this, 'lhs', {
    value: value,
    enumerable: true
  });
}
inherits(DiffDeleted, Diff);

function DiffArray(path, index, item) {
  DiffArray.super_.call(this, 'A', path);
  Object.defineProperty(this, 'index', {
    value: index,
    enumerable: true
  });
  Object.defineProperty(this, 'item', {
    value: item,
    enumerable: true
  });
}
inherits(DiffArray, Diff);

function arrayRemove(arr, from, to) {
  var rest = arr.slice((to || from) + 1 || arr.length);
  arr.length = from < 0 ? arr.length + from : from;
  arr.push.apply(arr, rest);
  return arr;
}

function realTypeOf(subject) {
  var type = typeof subject;
  if (type !== 'object') {
    return type;
  }

  if (subject === Math) {
    return 'math';
  } else if (subject === null) {
    return 'null';
  } else if (Array.isArray(subject)) {
    return 'array';
  } else if (Object.prototype.toString.call(subject) === '[object Date]') {
    return 'date';
  } else if (typeof subject.toString === 'function' && /^\/.*\//.test(subject.toString())) {
    return 'regexp';
  }
  return 'object';
}

function deepDiff(lhs, rhs, changes, prefilter, path, key, stack) {
  path = path || [];
  stack = stack || [];
  var currentPath = path.slice(0);
  if (typeof key !== 'undefined') {
    if (prefilter) {
      if (typeof(prefilter) === 'function' && prefilter(currentPath, key)) {
        return; } else if (typeof(prefilter) === 'object') {
        if (prefilter.prefilter && prefilter.prefilter(currentPath, key)) {
          return; }
        if (prefilter.normalize) {
          var alt = prefilter.normalize(currentPath, key, lhs, rhs);
          if (alt) {
            lhs = alt[0];
            rhs = alt[1];
          }
        }
      }
    }
    currentPath.push(key);
  }

  // Use string comparison for regexes
  if (realTypeOf(lhs) === 'regexp' && realTypeOf(rhs) === 'regexp') {
    lhs = lhs.toString();
    rhs = rhs.toString();
  }

  var ltype = typeof lhs;
  var rtype = typeof rhs;

  var ldefined = ltype !== 'undefined' || (stack && stack[stack.length - 1].lhs && stack[stack.length - 1].lhs.hasOwnProperty(key));
  var rdefined = rtype !== 'undefined' || (stack && stack[stack.length - 1].rhs && stack[stack.length - 1].rhs.hasOwnProperty(key));

  if (!ldefined && rdefined) {
    changes(new DiffNew(currentPath, rhs));
  } else if (!rdefined && ldefined) {
    changes(new DiffDeleted(currentPath, lhs));
  } else if (realTypeOf(lhs) !== realTypeOf(rhs)) {
    changes(new DiffEdit(currentPath, lhs, rhs));
  } else if (realTypeOf(lhs) === 'date' && (lhs - rhs) !== 0) {
    changes(new DiffEdit(currentPath, lhs, rhs));
  } else if (ltype === 'object' && lhs !== null && rhs !== null) {
    if (!stack.filter(function(x) {
        return x.lhs === lhs; }).length) {
      stack.push({ lhs: lhs, rhs: rhs });
      if (Array.isArray(lhs)) {
        var i;
        for (i = 0; i < lhs.length; i++) {
          if (i >= rhs.length) {
            changes(new DiffArray(currentPath, i, new DiffDeleted(undefined, lhs[i])));
          } else {
            deepDiff(lhs[i], rhs[i], changes, prefilter, currentPath, i, stack);
          }
        }
        while (i < rhs.length) {
          changes(new DiffArray(currentPath, i, new DiffNew(undefined, rhs[i++])));
        }
      } else {
        var akeys = Object.keys(lhs);
        var pkeys = Object.keys(rhs);
        akeys.forEach(function(k, i) {
          var other = pkeys.indexOf(k);
          if (other >= 0) {
            deepDiff(lhs[k], rhs[k], changes, prefilter, currentPath, k, stack);
            pkeys = arrayRemove(pkeys, other);
          } else {
            deepDiff(lhs[k], undefined, changes, prefilter, currentPath, k, stack);
          }
        });
        pkeys.forEach(function(k) {
          deepDiff(undefined, rhs[k], changes, prefilter, currentPath, k, stack);
        });
      }
      stack.length = stack.length - 1;
    } else if (lhs !== rhs) {
      // lhs is contains a cycle at this element and it differs from rhs
      changes(new DiffEdit(currentPath, lhs, rhs));
    }
  } else if (lhs !== rhs) {
    if (!(ltype === 'number' && isNaN(lhs) && isNaN(rhs))) {
      changes(new DiffEdit(currentPath, lhs, rhs));
    }
  }
}

function accumulateDiff(lhs, rhs, prefilter, accum) {
  accum = accum || [];
  deepDiff(lhs, rhs,
    function(diff) {
      if (diff) {
        accum.push(diff);
      }
    },
    prefilter);
  return (accum.length) ? accum : undefined;
}

function applyArrayChange(arr, index, change) {
  if (change.path && change.path.length) {
    var it = arr[index],
      i, u = change.path.length - 1;
    for (i = 0; i < u; i++) {
      it = it[change.path[i]];
    }
    switch (change.kind) {
      case 'A':
        applyArrayChange(it[change.path[i]], change.index, change.item);
        break;
      case 'D':
        delete it[change.path[i]];
        break;
      case 'E':
      case 'N':
        it[change.path[i]] = change.rhs;
        break;
    }
  } else {
    switch (change.kind) {
      case 'A':
        applyArrayChange(arr[index], change.index, change.item);
        break;
      case 'D':
        arr = arrayRemove(arr, index);
        break;
      case 'E':
      case 'N':
        arr[index] = change.rhs;
        break;
    }
  }
  return arr;
}

function applyChange(target, source, change) {
  if (target && source && change && change.kind) {
    var it = target,
      i = -1,
      last = change.path ? change.path.length - 1 : 0;
    while (++i < last) {
      if (typeof it[change.path[i]] === 'undefined') {
        it[change.path[i]] = (typeof change.path[i] === 'number') ? [] : {};
      }
      it = it[change.path[i]];
    }
    switch (change.kind) {
      case 'A':
        applyArrayChange(change.path ? it[change.path[i]] : it, change.index, change.item);
        break;
      case 'D':
        delete it[change.path[i]];
        break;
      case 'E':
      case 'N':
        it[change.path[i]] = change.rhs;
        break;
    }
  }
}

function revertArrayChange(arr, index, change) {
  if (change.path && change.path.length) {
    // the structure of the object at the index has changed...
    var it = arr[index],
      i, u = change.path.length - 1;
    for (i = 0; i < u; i++) {
      it = it[change.path[i]];
    }
    switch (change.kind) {
      case 'A':
        revertArrayChange(it[change.path[i]], change.index, change.item);
        break;
      case 'D':
        it[change.path[i]] = change.lhs;
        break;
      case 'E':
        it[change.path[i]] = change.lhs;
        break;
      case 'N':
        delete it[change.path[i]];
        break;
    }
  } else {
    // the array item is different...
    switch (change.kind) {
      case 'A':
        revertArrayChange(arr[index], change.index, change.item);
        break;
      case 'D':
        arr[index] = change.lhs;
        break;
      case 'E':
        arr[index] = change.lhs;
        break;
      case 'N':
        arr = arrayRemove(arr, index);
        break;
    }
  }
  return arr;
}

function revertChange(target, source, change) {
  if (target && source && change && change.kind) {
    var it = target,
      i, u;
    u = change.path.length - 1;
    for (i = 0; i < u; i++) {
      if (typeof it[change.path[i]] === 'undefined') {
        it[change.path[i]] = {};
      }
      it = it[change.path[i]];
    }
    switch (change.kind) {
      case 'A':
        // Array was modified...
        // it will be an array...
        revertArrayChange(it[change.path[i]], change.index, change.item);
        break;
      case 'D':
        // Item was deleted...
        it[change.path[i]] = change.lhs;
        break;
      case 'E':
        // Item was edited...
        it[change.path[i]] = change.lhs;
        break;
      case 'N':
        // Item is new...
        delete it[change.path[i]];
        break;
    }
  }
}

function applyDiff(target, source, filter) {
  if (target && source) {
    var onChange = function(change) {
      if (!filter || filter(target, source, change)) {
        applyChange(target, source, change);
      }
    };
    deepDiff(target, source, onChange);
  }
}

Object.defineProperties(accumulateDiff, {

  diff: {
    value: accumulateDiff,
    enumerable: true
  },
  observableDiff: {
    value: deepDiff,
    enumerable: true
  },
  applyDiff: {
    value: applyDiff,
    enumerable: true
  },
  applyChange: {
    value: applyChange,
    enumerable: true
  },
  revertChange: {
    value: revertChange,
    enumerable: true
  },
  isConflict: {
    value: function() {
      return 'undefined' !== typeof conflict;
    },
    enumerable: true
  },
  noConflict: {
    value: function() {
      if (conflictResolution) {
        conflictResolution.forEach(function(it) {
          it();
        });
        conflictResolution = null;
      }
      return accumulateDiff;
    },
    enumerable: true
  }
});

// https://github.com/flitbit/diff#differences
const dictionary = {
  E: {
    color: '#2196F3',
    text: 'CHANGED:',
  },
  N: {
    color: '#4CAF50',
    text: 'ADDED:',
  },
  D: {
    color: '#F44336',
    text: 'DELETED:',
  },
  A: {
    color: '#2196F3',
    text: 'ARRAY:',
  },
};

function style(kind) {
  return `color: ${dictionary[kind].color}; font-weight: bold`;
}

function render(diff) {
  const { kind, path, lhs, rhs, index, item } = diff;

  switch (kind) {
    case 'E':
      return [path.join('.'), lhs, '→', rhs];
    case 'N':
      return [path.join('.'), rhs];
    case 'D':
      return [path.join('.')];
    case 'A':
      return [`${path.join('.')}[${index}]`, item];
    default:
      return [];
  }
}

function diffLogger(prevState, newState, logger, isCollapsed) {
  const diff = accumulateDiff(prevState, newState);

  try {
    if (isCollapsed) {
      logger.groupCollapsed('diff');
    } else {
      logger.group('diff');
    }
  } catch (e) {
    logger.log('diff');
  }

  if (diff) {
    diff.forEach((elem) => {
      const { kind } = elem;
      const output = render(elem);

      logger.log(`%c ${dictionary[kind].text}`, style(kind), ...output);
    });
  } else {
    logger.log('—— no diff ——');
  }

  try {
    logger.groupEnd();
  } catch (e) {
    logger.log('—— diff end —— ');
  }
}

/**
 * Get log level string based on supplied params
 *
 * @param {string | function | object} level - console[level]
 * @param {object} action - selected action
 * @param {array} payload - selected payload
 * @param {string} type - log entry type
 *
 * @returns {string} level
 */
function getLogLevel(level, action, payload, type) {
  switch (typeof level) {
    case 'object':
      return typeof level[type] === 'function' ? level[type](...payload) : level[type];
    case 'function':
      return level(action);
    default:
      return level;
  }
}

function defaultTitleFormatter(options) {
  const { timestamp, duration } = options;

  return (action, time, took) => {
    const parts = ['action'];

    parts.push(`%c${String(action.type)}`);
    if (timestamp) parts.push(`%c@ ${time}`);
    if (duration) parts.push(`%c(in ${took.toFixed(2)} ms)`);

    return parts.join(' ');
  };
}

function printBuffer(buffer, options) {
  const {
    logger,
    actionTransformer,
    titleFormatter = defaultTitleFormatter(options),
    collapsed,
    colors,
    level,
    diff,
  } = options;

  const isUsingDefaultFormatter = typeof options.titleFormatter === 'undefined';

  buffer.forEach((logEntry, key) => {
    const { started, startedTime, action, prevState, error } = logEntry;
    let { took, nextState } = logEntry;
    const nextEntry = buffer[key + 1];

    if (nextEntry) {
      nextState = nextEntry.prevState;
      took = nextEntry.started - started;
    }

    // Message
    const formattedAction = actionTransformer(action);
    const isCollapsed = typeof collapsed === 'function'
      ? collapsed(() => nextState, action, logEntry)
      : collapsed;

    const formattedTime = formatTime(startedTime);
    const titleCSS = colors.title ? `color: ${colors.title(formattedAction)};` : '';
    const headerCSS = ['color: gray; font-weight: lighter;'];
    headerCSS.push(titleCSS);
    if (options.timestamp) headerCSS.push('color: gray; font-weight: lighter;');
    if (options.duration) headerCSS.push('color: gray; font-weight: lighter;');
    const title = titleFormatter(formattedAction, formattedTime, took);

    // Render
    try {
      if (isCollapsed) {
        if (colors.title && isUsingDefaultFormatter) {
          logger.groupCollapsed(`%c ${title}`, ...headerCSS);
        } else logger.groupCollapsed(title);
      } else if (colors.title && isUsingDefaultFormatter) {
        logger.group(`%c ${title}`, ...headerCSS);
      } else {
        logger.group(title);
      }
    } catch (e) {
      logger.log(title);
    }

    const prevStateLevel = getLogLevel(level, formattedAction, [prevState], 'prevState');
    const actionLevel = getLogLevel(level, formattedAction, [formattedAction], 'action');
    const errorLevel = getLogLevel(level, formattedAction, [error, prevState], 'error');
    const nextStateLevel = getLogLevel(level, formattedAction, [nextState], 'nextState');

    if (prevStateLevel) {
      if (colors.prevState) {
        const styles = `color: ${colors.prevState(prevState)}; font-weight: bold`;

        logger[prevStateLevel]('%c prev state', styles, prevState);
      } else logger[prevStateLevel]('prev state', prevState);
    }

    if (actionLevel) {
      if (colors.action) {
        const styles = `color: ${colors.action(formattedAction)}; font-weight: bold`;

        logger[actionLevel]('%c action    ', styles, formattedAction);
      } else logger[actionLevel]('action    ', formattedAction);
    }

    if (error && errorLevel) {
      if (colors.error) {
        const styles = `color: ${colors.error(error, prevState)}; font-weight: bold;`;

        logger[errorLevel]('%c error     ', styles, error);
      } else logger[errorLevel]('error     ', error);
    }

    if (nextStateLevel) {
      if (colors.nextState) {
        const styles = `color: ${colors.nextState(nextState)}; font-weight: bold`;

        logger[nextStateLevel]('%c next state', styles, nextState);
      } else logger[nextStateLevel]('next state', nextState);
    }

    if (logger.withTrace) {
      logger.groupCollapsed('TRACE');
      logger.trace();
      logger.groupEnd();
    }

    if (diff) {
      diffLogger(prevState, nextState, logger, isCollapsed);
    }

    try {
      logger.groupEnd();
    } catch (e) {
      logger.log('—— log end ——');
    }
  });
}

var defaults = {
  level: 'log',
  logger: console,
  logErrors: true,
  collapsed: undefined,
  predicate: undefined,
  duration: false,
  timestamp: true,
  stateTransformer: state => state,
  actionTransformer: action => action,
  errorTransformer: error => error,
  colors: {
    title: () => 'inherit',
    prevState: () => '#9E9E9E',
    action: () => '#03A9F4',
    nextState: () => '#4CAF50',
    error: () => '#F20404',
  },
  diff: false,
  diffPredicate: undefined,

  // Deprecated options
  transformer: undefined,
};

/* eslint max-len: ["error", 110, { "ignoreComments": true }] */
/**
 * Creates logger with following options
 *
 * @namespace
 * @param {object} options - options for logger
 * @param {string | function | object} options.level - console[level]
 * @param {boolean} options.duration - print duration of each action?
 * @param {boolean} options.timestamp - print timestamp with each action?
 * @param {object} options.colors - custom colors
 * @param {object} options.logger - implementation of the `console` API
 * @param {boolean} options.logErrors - should errors in action execution be caught, logged, and re-thrown?
 * @param {boolean} options.collapsed - is group collapsed?
 * @param {boolean} options.predicate - condition which resolves logger behavior
 * @param {function} options.stateTransformer - transform state before print
 * @param {function} options.actionTransformer - transform action before print
 * @param {function} options.errorTransformer - transform error before print
 *
 * @returns {function} logger middleware
 */
function createLogger(options = {}) {
  const loggerOptions = Object.assign({}, defaults, options);

  const {
    logger,
    stateTransformer,
    errorTransformer,
    predicate,
    logErrors,
    diffPredicate,
  } = loggerOptions;

  // Return if 'console' object is not defined
  if (typeof logger === 'undefined') {
    return () => next => action => next(action);
  }

  // Detect if 'createLogger' was passed directly to 'applyMiddleware'.
  if (options.getState && options.dispatch) {
    // eslint-disable-next-line no-console
    console.error(`[redux-logger] redux-logger not installed. Make sure to pass logger instance as middleware:
// Logger with default options
import { logger } from 'redux-logger'
const store = createStore(
  reducer,
  applyMiddleware(logger)
)
// Or you can create your own logger with custom options http://bit.ly/redux-logger-options
import { createLogger } from 'redux-logger'
const logger = createLogger({
  // ...options
});
const store = createStore(
  reducer,
  applyMiddleware(logger)
)
`);

    return () => next => action => next(action);
  }

  const logBuffer = [];

  return ({ getState }) => next => (action) => {
    // Exit early if predicate function returns 'false'
    if (typeof predicate === 'function' && !predicate(getState, action)) {
      return next(action);
    }

    const logEntry = {};

    logBuffer.push(logEntry);

    logEntry.started = timer.now();
    logEntry.startedTime = new Date();
    logEntry.prevState = stateTransformer(getState());
    logEntry.action = action;

    let returnedValue;
    if (logErrors) {
      try {
        returnedValue = next(action);
      } catch (e) {
        logEntry.error = errorTransformer(e);
      }
    } else {
      returnedValue = next(action);
    }

    logEntry.took = timer.now() - logEntry.started;
    logEntry.nextState = stateTransformer(getState());

    const diff = loggerOptions.diff && typeof diffPredicate === 'function'
      ? diffPredicate(getState, action)
      : loggerOptions.diff;

    printBuffer(logBuffer, Object.assign({}, loggerOptions, { diff }));
    logBuffer.length = 0;

    if (logEntry.error) throw logEntry.error;
    return returnedValue;
  };
}

function createThunkMiddleware(extraArgument) {
  return ({ dispatch, getState }) => next => action => {
    if (typeof action === 'function') {
      return action(dispatch, getState, extraArgument);
    }

    return next(action);
  };
}

const thunk = createThunkMiddleware();
thunk.withExtraArgument = createThunkMiddleware;

const TypeKeys$4 = {
    SET_CONSENSUS: 'network/set-consensus',
    SET_HEIGHT: 'network/set-height',
    SET_PEER_COUNT: 'network/set-peer-count',
    SET_GLOBAL_HASHRATE: 'network/set-global-hashrate'
};

const initialState$1 = {
    consensus: 'initializing',
    height: 0,
    oldHeight: 0,
    peerCount: 0,
    globalHashrate: 0
};

function reducer$4(state, action) {
    if (state === undefined) {
        return initialState$1;
    }

    switch (action.type) {
        case TypeKeys$4.SET_CONSENSUS:
            return Object.assign({}, state, {
                consensus: action.consensus
            })

        case TypeKeys$4.SET_HEIGHT:
            return Object.assign({}, state, {
                height: action.height
            })

        case TypeKeys$4.SET_PEER_COUNT:
            return Object.assign({}, state, {
                peerCount: action.peerCount
            })

        case TypeKeys$4.SET_GLOBAL_HASHRATE:
            return Object.assign({}, state, {
                globalHashrate: action.globalHashrate
            })

        default:
            return state
    }
}

function setConsensus(consensus) {
    return {
        type: TypeKeys$4.SET_CONSENSUS,
        consensus
    }
}

function setHeight(height) {
    return {
        type: TypeKeys$4.SET_HEIGHT,
        height
    }
}

function setPeerCount(peerCount) {
    return {
        type: TypeKeys$4.SET_PEER_COUNT,
        peerCount
    }
}

function setGlobalHashrate(globalHashrate) {
    return {
        type: TypeKeys$4.SET_GLOBAL_HASHRATE,
        globalHashrate
    }
}

const reducers = {
    accounts: reducer$1,
    transactions: reducer$2,
    network: reducer$4,
    connection: reducer,
    settings: reducer$3
};

const logger = createLogger({
    collapsed: true,
    predicate: (getState, action) => true
});

function configureStore(initialState$$1) {

    const createStoreWithMiddleware = compose(
        applyMiddleware(
            thunk,
            logger
        )
    )(createStore);

    // Combine all reducers and instantiate the app-wide store instance
    const allReducers = buildRootReducer(reducers);
    const store = createStoreWithMiddleware(allReducers, initialState$$1);

    return store;
}

function buildRootReducer (allReducers) {
    return combineReducers(allReducers);
}

/* Redux store as singleton */
class Store {
    static get instance() {
        this._instance = this._instance || this._initialize();

        return this._instance;
    }

    static _initialize() {
        // initialize from localStorage
        const stringifiedState = localStorage.getItem('persistedState');

        if (!stringifiedState) {
            return configureStore();
        }

        let persistedState = JSON.parse(stringifiedState);

        persistedState = Object.assign({},
            persistedState,
            {
                transactions: Object.assign({}, persistedState.transactions, {
                    entries: new Map(persistedState.transactions.entries)
                }),
                accounts: Object.assign({}, persistedState.accounts, {
                    entries: new Map(persistedState.accounts.entries)
                }),
                network: Object.assign({}, initialState$1, persistedState.network),
                settings: Object.assign({}, initialState, persistedState.settings)
            }
        );

        return configureStore(persistedState);
    }

    static persist() {
        const state = Store.instance.getState();

        const transactions = Object.assign({},
            state.transactions,
            {
                entries: [...state.transactions.entries.entries()],
                isRequestingHistory: undefined
            }
        );

        const accounts =  Object.assign({},
            state.accounts,
            { entries: [...state.accounts.entries.entries()] }
        );

        const persistentState = {
            transactions,
            accounts,
            network: {
                oldHeight: state.network.height
            },
            settings: state.settings
        };

        const stringifiedState = JSON.stringify(persistentState);

        localStorage.setItem('persistedState', stringifiedState);
    }
}

var store = Store.instance;

class XSafeLock extends XElement {
    html() {
        return `
            <i class="material-icons">locked</i>
            <h1>Your Nimiq Safe is locked</h1>
            <p>Draw your pattern to unlock:</p>
            <div id="unlock-patternLock"></div>
        `
    }

    onCreate() {
        this.lock = new PatternLock(this.$('#unlock-patternLock'), {
            mapper: {1: 3, 2: 8, 3: 4, 4: 2, 5: 9, 6: 7, 7: 5, 8: 1, 9: 6},
            onDraw: this._onEnterPin.bind(this)
        });
    }

    _onEnterPin(pin) {
        pin = this._hash(pin);
        if (pin === localStorage.getItem('lock')) {
            this.destroy();

            // Launch Safe app
            window.safe.launchApp();
        } else {
            this.lock.error();
            setTimeout(this.lock.reset.bind(this.lock), 500);
            this._pin = null;
            XToast.error('Wrong pattern');
        }
    }

    _hash(text) {
        return ('' + text
                .split('')
                .map(c => Number(c.charCodeAt(0)) + 3)
                .reduce((a, e) => a * (1 - a) * this.__chaosHash(e), 0.5))
            .split('')
            .reduce((a, e) => e + a, '')
            .substr(4, 17);
    }

    __chaosHash(number) {
        const k = 3.569956786876;
        let a_n = 1 / number;
        for (let i = 0; i < 100; i++) {
            a_n = (1 - a_n) * a_n * k;
        }
        return a_n;
    }
}

class Safe {
    constructor() {
        // TODO just temporary code
        if (window.location.hash.indexOf('enable-ledger') !== -1) {
            document.body.classList.add('enable-ledger');
        }

        if (localStorage.getItem('lock')) {
            const $safeLock = XSafeLock.createElement();
            $safeLock.$el.classList.add('nimiq-dark');
            document.getElementById('app').appendChild($safeLock.$el);
        } else {
            this.launchApp();
        }

        // FIXME
        setTimeout(() => document.body.classList.remove('preparing'));
    }

    launchApp() {
        const $appContainer = document.getElementById('app');

        // set redux store
        this.store = store;
        MixinRedux.store = this.store;

        // set singleton app container
        MixinSingleton.appContainer = $appContainer;

        // Launch account manager
        accountManager.launch();

        // start UI
        this._xApp = new XSafe($appContainer);

        this.actions = bindActionCreators({
            setAllKeys,
            updateBalances,
            addTransactions,
            markRemoved,
            setConsensus,
            setHeight,
            setPeerCount,
            setGlobalHashrate
        }, this.store.dispatch);

        this.launchNetwork();

        // Persist store before closing
        self.onunload = () => {
            if (!window.skipPersistingState) Store.persist();
        };

        self.onerror = (error) => {
            XToast.show(error.message || error, 'error');
        };

        // cancel request and close window when there is an unhandled promise rejection
        self.onunhandledrejection = (event) => {
            XToast.show(event.reason, 'error');
        };
    }

    async launchNetwork() {
        if (Config.offline) return;

        // Launch network
        networkClient.launch();

        // launch network rpc client
        this.network = await networkClient.rpcClient;
        window.network = this.network; // for debugging

        // launch network event client
        this.networkListener = await networkClient.eventClient;
        this.networkListener.on('nimiq-api-ready', () => console.log('NanoNetworkApi ready'));
        this.networkListener.on('nimiq-consensus-syncing', this._onConsensusSyncing.bind(this));
        this.networkListener.on('nimiq-consensus-established', this._onConsensusEstablished.bind(this));
        this.networkListener.on('nimiq-consensus-lost', this._onConsensusLost.bind(this));
        this.networkListener.on('nimiq-balances', this._onBalanceChanged.bind(this));
        this.networkListener.on('nimiq-different-tab-error', e => alert('Nimiq is already running in a different tab.'));
        this.networkListener.on('nimiq-api-fail', e => alert('Nimiq initialization error:', e.message || e));
        this.networkListener.on('nimiq-transaction-pending', this._onTransaction.bind(this));
        this.networkListener.on('nimiq-transaction-expired', this._onTransactionExpired.bind(this));
        this.networkListener.on('nimiq-transaction-mined', this._onTransaction.bind(this));
        this.networkListener.on('nimiq-transaction-relayed', this._onTransactionRelayed.bind(this));
        this.networkListener.on('nimiq-peer-count', this._onPeerCountChanged.bind(this));
        this.networkListener.on('nimiq-head-change', this._onHeadChange.bind(this));
    }

    // todo refactor: move following methods to new class NetworkHandler(?)

    _onConsensusSyncing() {
        console.log('Consensus syncing');
        this.actions.setConsensus('syncing');
    }

    _onConsensusEstablished() {
        console.log('Consensus established');
        this.actions.setConsensus('established');
    }

    _onConsensusLost() {
        console.log('Consensus lost');
        this.actions.setConsensus('lost');
    }

    _onBalanceChanged(balances) {
        this.actions.updateBalances(balances);
    }

    _onTransaction(tx) {
        // Check if we know the sender or recipient of the tx
        const accounts = this.store.getState().accounts.entries;
        if (!accounts.has(tx.sender) && !accounts.has(tx.recipient)) {
            console.warn('Not displaying transaction because sender and recipient are unknown:', tx);
            return;
        }

        this.actions.addTransactions([tx]);
    }

    _onTransactionExpired(hash) {
        this.actions.markRemoved([hash], this.store.getState().network.height + 1);
    }

    _onTransactionRelayed(tx) {
        this._onTransaction(tx);

        const resolver = this._xApp.relayedTxResolvers.get(tx.hash);
        resolver && resolver();
    }

    _onHeadChange({height, globalHashrate}) {
        this.actions.setHeight(height);
        this.actions.setGlobalHashrate(globalHashrate);
    }

    _onPeerCountChanged(peerCount) {
        this.actions.setPeerCount(peerCount);
    }
}

window.safe = new Safe();

}());
