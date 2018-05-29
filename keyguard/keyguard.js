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

class Key {
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
        // todo implement
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
     * @param {string} extraData Text to add to the transaction, requires extended format
     * @param {string} format basic or extended
     * @returns {Transaction} A prepared and signed Transaction object. This still has to be sent to the network.
     */
    async createTransaction(recipient, value, fee, validityStartHeight, extraData, format) {
        if (typeof recipient === 'string') {
            recipient = await Key.getUnfriendlyAddress(recipient);
        }

        if (format === 'basic') {
            const transaction = new Nimiq.BasicTransaction(this._keyPair.publicKey, recipient, value, fee, validityStartHeight);
            transaction.signature = Nimiq.Signature.create(this._keyPair.privateKey, this._keyPair.publicKey, transaction.serializeContent());
            return transaction;
        }

        if (format === 'extended') {
            const transaction = new Nimiq.ExtendedTransaction(
                this._keyPair.publicKey.toAddress(), Nimiq.Account.Type.BASIC,
                recipient, Nimiq.Account.Type.BASIC,
                value,
                fee,
                validityStartHeight,
                Nimiq.Transaction.Flag.NONE,
                Utf8Tools.stringToUtf8ByteArray(extraData),
            );
            const signature = Nimiq.Signature.create(this._keyPair.privateKey, this._keyPair.publicKey, transaction.serializeContent());
            const proof = Nimiq.SignatureProof.singleSig(this._keyPair.publicKey, signature);
            transaction.proof = proof.serialize();
            return transaction;
        }

        // todo extended transactions
    }

    /**
     * Sign a transaction by the owner of this Wallet.
     * @param {Transaction} transaction The transaction to sign.
     * @returns {SignatureProof} A signature proof for this transaction.
     */
    // todo Do we need this?
    /*signTransaction(transaction) {
        const signature = Nimiq.Signature.create(this._keyPair.privateKey, this._keyPair.publicKey, transaction.serializeContent());
        return Nimiq.SignatureProof.singleSig(this._keyPair.publicKey, signature);
    }*/

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

class KeyStore {

    static get instance() {
        this._instance = this._instance || new KeyStore();
        return this._instance;
    }

    /**
     * @param {string} dbName
     * @constructor
     */
    constructor(dbName = 'accounts') {
        this._dbName = dbName;
        this._db = null;
        this._connected = false;
    }

    /**
     * @returns {Promise.<IDBDatabase>}
     * @private
     */
    connect() {
        if (this._connected) return Promise.resolve(this._db);

        return new Promise((resolve, reject) => {
            const request = self.indexedDB.open(this._dbName, KeyStore.VERSION);

            request.onsuccess = () => {
                this._connected = true;
                this._db = request.result;
                resolve(this._db);
            };

            request.onerror = () => reject(request.error);
            request.onupgradeneeded = event => {
                const db = event.target.result;
                db.createObjectStore(KeyStore.ACCOUNT_DATABASE, { keyPath: 'userFriendlyAddress' });
                // TODO: multiSigStore
            };
        });
    }

    /**
     * @param {string} userFriendlyAddress
     * @returns {Promise.<object>}
     */
    async getPlain(userFriendlyAddress) {
        const db = await this.connect();
        return new Promise((resolve, reject) => {
            const getTx = db.transaction([KeyStore.ACCOUNT_DATABASE])
                .objectStore(KeyStore.ACCOUNT_DATABASE)
                .get(userFriendlyAddress);
            getTx.onsuccess = event => {
                resolve(event.target.result);
            };
            getTx.onerror = reject;
        });
    }

    /**
     * @param {string} userFriendlyAddress
     * @param {Uint8Array|string} passphrase
     * @returns {Promise.<Key>}
     */
    async get(userFriendlyAddress, passphrase) {
        const key = await this.getPlain(userFriendlyAddress);
        const result = await Key.loadEncrypted(key.encryptedKeyPair, passphrase);
        result.type = key.type;
        result.label = key.label;

        return result;
    }

    /**
     * @param {Key} key
     * @param {Uint8Array|string} [passphrase]
     * @param {Uint8Array|string} [unlockKey]
     * @returns {Promise}
     */
    async put(key, passphrase, unlockKey) {
        /** @type {Uint8Array} */
        const encryptedKeyPair = await key.exportEncrypted(passphrase, unlockKey);

        const keyInfo = {
            encryptedKeyPair: encryptedKeyPair,
            userFriendlyAddress: key.userFriendlyAddress,
            type: key.type,
            label: key.label
        };

        return await this.putPlain(keyInfo);
    }

    async putPlain(keyInfo) {
        const db = await this.connect();
        return new Promise((resolve, reject) => {
            const putTx = db.transaction([KeyStore.ACCOUNT_DATABASE], 'readwrite')
                .objectStore(KeyStore.ACCOUNT_DATABASE)
                .put(keyInfo);
            putTx.onsuccess = event => resolve(event.target.result);
            putTx.onerror = reject;
        });
    }

    /**
     * @param {string} userFriendlyAddress
     * @returns {Promise}
     */
    async remove(userFriendlyAddress) {
        const db = await this.connect();
        return new Promise((resolve, reject) => {
            const deleteTx = db.transaction([KeyStore.ACCOUNT_DATABASE], 'readwrite')
                .objectStore(KeyStore.ACCOUNT_DATABASE)
                .delete(userFriendlyAddress);
            deleteTx.onsuccess = event => resolve(event.target.result);
            deleteTx.onerror = reject;
        });
    }

    /**
     * @returns {Promise.<Array.<object>>}
     */
    async list() {
        const db = await this.connect();
        return new Promise((resolve, reject) => {
            const results = [];
            const openCursorRequest = db.transaction([KeyStore.ACCOUNT_DATABASE], 'readonly')
                .objectStore(KeyStore.ACCOUNT_DATABASE)
                .openCursor();
            openCursorRequest.onsuccess = event => {
                const cursor = event.target.result;
                if (cursor) {
                    const key = cursor.value;

                    // Because: To use Key.getPublicInfo(), we would need to create Key instances out of the key object that we receive from the DB.
                    const keyInfo = {
                        address: key.userFriendlyAddress,
                        type: key.type,
                        label: key.label
                    };

                    results.push(keyInfo);
                    cursor.continue();
                } else {
                    resolve(results);
                }
            };
            openCursorRequest.onerror = () => reject(openCursorRequest.error);
        });
    }

    close() {
        if (!this._connected) return;
        return this._db.close();
    }
}

KeyStore.VERSION = 2;
KeyStore.ACCOUNT_DATABASE = 'accounts';
KeyStore.MULTISIG_WALLET_DATABASE = 'multisig-wallets';

var keyStore = KeyStore.instance;

const KeyType =  {
    HIGH: 'high',
    LOW: 'low'
};

/*
import { default as keyStoreIndexeddb } from './key-store-indexeddb.js';
import { default as keyStoreLocalstorage } from './key-store-localstorage.js';

let keyStore;

var isSafari = !!navigator.userAgent.match(/Version\/[\d\.]+.*Safari/);
var iOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
if (isSafari || iOS) {
    keyStore = keyStoreLocalstorage;
} else {
    keyStore = keyStoreIndexeddb;
}*/

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

// eslint-disable-next-line consistent-return

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

const RequestTypes = {
    SIGN_SAFE_TRANSACTION: 'sign-safe-transaction',
    SIGN_WALLET_TRANSACTION: 'sign-wallet-transaction',
    SIGN_MESSAGE: 'sign-message',
    CREATE_SAFE: 'create-safe',
    CREATE_WALLET: 'create-wallet',
    IMPORT_FROM_FILE: 'import-from-file',
    IMPORT_FROM_WORDS: 'import-from-words',
    BACKUP_FILE: 'backup-file',
    BACKUP_WORDS: 'backup-words',
    RENAME: 'rename',
    UPGRADE: 'upgrade'
};

// basic action types
const TypeKeys$1 = {
    START: 'request/start',
    SET_DATA: 'request/setData',
    SET_EXECUTING: 'request/executing',
    SET_RESULT: 'request/result',
    SET_ERROR: 'request/error',
};

const SATOSHIS = 1e5;

function reducer$1(state, action) {
    const initialState = {
        requestType: undefined, // type of current request, set when it starts and won't change

        executing: undefined, // true if we are doing async actions which can take longer, like storing in keystore

        error: undefined, // setting an error here will throw it at the calling app

        result: undefined, // result which is returned to calling app (keyguard-api will be notified when state changes)

        reject: undefined, // used to cancel the request when the window is closed

        data: { // additional request data specific to some request types
            address: undefined, // the address of the account we are using for this request
            isWrongPassphrase: undefined, // boolean set to true after user tried wrong passphrase
            privateKey: undefined, // unencrypted; we need it to show mnemonic phrase
            label: undefined, // label BEFORE rename
            type: undefined, // key type (high/low),
            encryptedKeyPair: undefined // the encrypted key pair
        }
    };

    if (state === undefined) {
        return initialState;
    }

    // check if request type of action matches running request, if present
    if (action.type !== TypeKeys$1.START && state.requestType !== action.requestType) {
        return {
            error: new Error('Request type does not match')
        };
    }

    // describe state changes for each possible action
    switch (action.type) {
        case TypeKeys$1.START:
            if (state.requestType) {
                return Object.assign({}, initialState, {
                    error: new Error('Multiple Requests')
                });
            }

            return Object.assign({}, state, {
                requestType: action.requestType,
                reject: action.reject,
                data: Object.assign({},
                    state.data,
                    action.data
                )
            });

            case TypeKeys$1.SET_DATA:
                return Object.assign({}, state, {
                    executing: false,
                    data: Object.assign({},
                        state.data,
                        action.data
                    )
                });

            case TypeKeys$1.SET_EXECUTING:
                return Object.assign({}, state, {
                    executing: true,
                    data: Object.assign({},
                        state.data,
                        { isWrongPassphrase: false }
                    )
                });

            case TypeKeys$1.SET_RESULT:
                return Object.assign({}, state, {
                    result: action.result
                });

            case TypeKeys$1.SET_ERROR:
                return Object.assign({}, state, {
                    error: action.error
                });

            default:
                return state
        }
}

function start(requestType, reject, data) {
    return {
        type: TypeKeys$1.START,
        requestType,
        reject,
        data
    };
}

function setData(requestType, data) {
    return {
        type: TypeKeys$1.SET_DATA,
        requestType,
        data
    };
}

function deny(requestType) {
    return setError(requestType, new Error('Denied by user'));
}

function setResult(requestType, result) {
    return {
        type: TypeKeys$1.SET_RESULT,
        requestType,
        result
    }
}

function setError(requestType, error) {
    return {
        type: TypeKeys$1.SET_ERROR,
        requestType,
        error
    }
}

function setExecuting(requestType) {
    return {
        type: TypeKeys$1.SET_EXECUTING,
        requestType
    }
}

// load key info to data, so we can show it in UI.
function loadAccountData(requestType) {
    return async (dispatch, getState) => {
        const { address } = getState().request.data;

        try {
            const key = await keyStore.getPlain(address);

            dispatch(
                setData(requestType, key)
            );
        } catch (e) {
            dispatch(
                setError(requestType, `Account ${address} does not exist`)
            );
        }
    }
}

const TypeKeys = {
    ADD: 'keys/add',
    CLEAR: 'keys/clear'
};

function reducer(state, action) {
    if (state === undefined) {
        return {
            volatileKeys: new Map()
        }
    }

    switch (action.type) {
        case TypeKeys.ADD:
            const map = new Map(state.volatileKeys);

            for (const key of action.payload) {
                map.set(key.userFriendlyAddress, key);
            }

            return Object.assign({}, state, {
                volatileKeys: map
            });

        case TypeKeys.CLEAR:
            return Object.assign({}, state, {
                volatileKeys: new Map()
            });

        default:
            return state
    }
}

function clearVolatile(requestType) {
    return {
        type: TypeKeys.CLEAR,
        requestType
    }
}

function createVolatile(requestType, number) {
    const keys = [];

    for (let i = 0; i < number; i++) {
        const keyPair = Nimiq.KeyPair.generate();
        const key = new Key(keyPair);
        keys.push(key);
    }

    return {
        type: TypeKeys.ADD,
        payload: keys,
        requestType
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

const reducers = {
    keys: reducer,
    request: reducer$1
};

const logger = createLogger({
    collapsed: true,
    predicate: (getState, action) => true
});

function configureStore(initialState) {

    const createStoreWithMiddleware = compose(
        Config.devMode ? applyMiddleware(
            thunk,
            logger
        ) : applyMiddleware(thunk)
    )(createStore);

    // Combine all reducers and instantiate the app-wide store instance
    const allReducers = buildRootReducer(reducers);
    const store = createStoreWithMiddleware(allReducers, initialState);

    return store;
}

function buildRootReducer (allReducers) {
    return combineReducers(allReducers);
}

class Store {
    static get instance() {
        this._instance = this._instance || configureStore();
        return this._instance;
    }

    static initialize(initialState) {
        Store._instance = configureStore(initialState);
        return Store._instance;
    }
}

var store = Store.instance;

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

class XRouter$1 extends XElement {

    static get instance() {
        return new Promise((resolve, reject) => {
            if (XRouter$1._instance) resolve(XRouter$1._instance);
            else _waitingForInit.push(resolve);
        });
    }

    static create(initialPath = location.hash, classes = DEFAULT_CLASSES) {
        location.hash = initialPath;
        XRouter$1._classes = classes;

        new XRouter$1();
    }

    static _sanitizePath(path) { return path.replace(/(^\s*\/|\s*\/$|_[^_]*_)/g, ''); }
    static _isRoot(path = '') { return XRouter$1._sanitizePath(path) == ''; }

    constructor() {
        super(document.body);
    }

    onCreate() {
        window.XRouter = XRouter$1;
        this.reverse = false;
        this.routing = false;
        this.running = false;
        this.history = [];

        // read XRouter.classes, then <x-router animations="...", or fall back to DEFAULT_CLASSES
        if (XRouter$1.classes instanceof Array) this.classes = XRouter$1.classes;
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

        XRouter$1._instance = this;
        for (const callback of _waitingForInit) callback(this);

        // make sure that anyone that was listening can act first, e.g. update the route
        setTimeout(() => this._router.listen());
    }

    parseRoutes(routeElements) {
        this.routes = new Map();
        this.routeByElement = new Map();
        for (const element of routeElements) {
            const { path, nodes } = this._absolutePathOf(element);
            const regex = XRouter$1._isRoot(path) ? /^\/?$|^\/?_.*/ : new RegExp(`^\/?${ path }$|^\/?${ path }_.*$`);
            const route = { path, element, regex, nodes };

            // relative route '/' might overwrite parent route
            this.routes.set(XRouter$1._sanitizePath(path), route);
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
                const path = XRouter$1._sanitizePath(linkPath);
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
                    absolutePath = XRouter$1._sanitizePath(path);
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
                path.unshift(XRouter$1._sanitizePath(segment));
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


    _getRoute(path) { return this.routes.get(XRouter$1._sanitizePath(path)); }

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

class BrowserDetection {

    static isDesktopSafari() {
        // see https://stackoverflow.com/a/23522755
        return /^((?!chrome|android).)*safari/i.test(navigator.userAgent) && !/mobile/i.test(navigator.userAgent);
    }

    static isSafari() {
        return !!navigator.userAgent.match(/Version\/[\d\.]+.*Safari/);
    }

    static isIOS() {
        return /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
    }

    static iOSversion() {
        if (/iP(hone|od|ad)/.test(navigator.platform)) {
            var v = (navigator.appVersion).match(/OS (\d+)_(\d+)_?(\d+)?/);
            return [parseInt(v[1], 10), parseInt(v[2], 10), parseInt(v[3] || 0, 10)];
        }
    }

    static isBadIOS() {
        const version = this.iOSversion();
        if (version[0] < 11 || (version[0] === 11 && version[1] === 2)) {
            return true;
        }
    }
}

class KeyguardApi {

    constructor() {
        this.actions = bindActionCreators({
            createVolatile,
            clearVolatile,
            start,
            loadAccountData
        }, store.dispatch);
    }

    /** WITHOUT UI */

    async list() {
        if (BrowserDetection.isIOS() || BrowserDetection.isSafari()) {
            return this._listFromCookie();
        }

        const keys = await keyStore.list();
        return keys;
    }

    async _listFromCookie() {
        const match = document.cookie.match(new RegExp('accounts=([^;]+)'));

        if (match) {
            const decoded = decodeURIComponent(match[1]);
            return JSON.parse(decoded);
        }

        return [];
    }

    async getMinerAccount() {
        const keys = await this.list();

        const firstMinerKey = keys.find(key => key.label === 'Miner Account');
        if (firstMinerKey) return firstMinerKey;

        // Return first Safe key or NULL
        return keys.find(key => key.type === KeyType.HIGH) || null;
    }

    /*createVolatile(number) {

        this.actions.clearVolatile();

        this.actions.createVolatile(number);

        const keys = store.getState().keys.volatileKeys;

        return [...keys.keys()]; // = addresses
    }

    async persistWithPin(userFriendlyAddress, pin) {

        const key = store.getState().keys.volatileKeys.get(userFriendlyAddress);

        if (!key) throw new Error('Key not found');

        key._type = KeyType.low;

        if (!await keyStore.put(key, pin)) {
            throw new Error('Key could not be persisted');
        }

        return true;
    }*/

    /*async lock(userFriendlyAddress, pin) {
        const key = keyStore.get(userFriendlyAddress);
        return key.lock(pin);
    }

    async unlock(userFriendlyAddress, pin) {
        const key = keyStore.get(userFriendlyAddress);
        return key.unlock(pin);
    }*/

    /** WITH UI */

    /** Set request state to started and wait for UI to set the result
     *
     * @param { RequestType} requestType
     * @param { Object } data - additional request data
     * @return {Promise<any>} - answer for calling app
     * @private
     */
    _startRequest(requestType, data = {}) {
        return new Promise((resolve, reject) => {

            // only one request at a time
            if (store.getState().request.requestType) {
                throw new Error('Request already started');
            }

            // Set request state to started. Save reject so we can cancel the request when the window is closed
            this.actions.start(requestType, reject, data);

            // open corresponding UI
            XRouter$1.create(requestType);

            // load account data, if we already know the account this request is about
            if (data.address) {
                this.actions.loadAccountData(requestType);
            }

            // wait until the ui dispatches the user's feedback
            store.subscribe(async () => {
                const request = store.getState().request;

                if (request.error) {
                    reject(request.error);
                    self.close();
                }

                if (request.result) {
                    if (BrowserDetection.isIOS() || BrowserDetection.isSafari()) {
                        // Save result in cookie, so lovely Safari can find them without IndexedDB access
                        const keys = (await keyStore.list()).slice(0, 10);
                        const keysWithLabelsEncoded = keys.map(x => Object.assign({}, x, {
                            label: encodeURIComponent(x.label)
                        }));

                        const encodedKeys = JSON.stringify(keysWithLabelsEncoded);

                        const expireDate = new Date('23 Jun 2038 00:00:00 PDT');
                        document.cookie = `accounts=${encodedKeys }; expires=${ expireDate.toUTCString() }`;
                    }

                    resolve(request.result);
                }
            });
        });
    }

    async createSafe() {
        return this._startRequest(RequestTypes.CREATE_SAFE);
    }

    async createWallet() {
        return this._startRequest(RequestTypes.CREATE_WALLET);
    }

    // todo later: test if transaction or generic message and react accordingly
    /*async sign(message) {
        const {sender, recipient, value, fee} = message;
        const signature = 'mySign';
        return signature;
    }*/

    async signSafe(transaction) {
        if (transaction.value < 1/Nimiq.Policy.SATOSHIS_PER_COIN) {
            throw new Error('Amount is too small');
        }
        if (transaction.network !== Nimiq.GenesisConfig.NETWORK_NAME) throw Error(`Network missmatch: ${transaction.network} in transaction, but ${Nimiq.GenesisConfig.NETWORK_NAME} in Keyguard`);

        const key = await keyStore.getPlain(transaction.sender);
        if (key.type !== KeyType.HIGH) throw new Error('Unauthorized: sender is not a Safe account');

        transaction.value = Nimiq.Policy.coinsToSatoshis(transaction.value);
        transaction.fee = Nimiq.Policy.coinsToSatoshis(transaction.fee);

        return this._startRequest(RequestTypes.SIGN_SAFE_TRANSACTION, {
            transaction,
            address: transaction.sender // for basic transactions, todo generalize
        });
    }

    async signWallet(transaction) {
        if (transaction.value < 1/Nimiq.Policy.SATOSHIS_PER_COIN) {
            throw new Error('Amount is too small');
        }
        if (transaction.network !== Nimiq.GenesisConfig.NETWORK_NAME) throw Error(`Network missmatch: ${transaction.network} in transaction, ${Nimiq.GenesisConfig.NETWORK_NAME} in Keyguard`);

        const key = await keyStore.getPlain(transaction.sender);
        if (key.type !== KeyType.LOW) throw new Error('Unauthorized: sender is not a Wallet account');

        transaction.value = Nimiq.Policy.coinsToSatoshis(transaction.value);
        transaction.fee = Nimiq.Policy.coinsToSatoshis(transaction.fee);

        return this._startRequest(RequestTypes.SIGN_WALLET_TRANSACTION, {
            transaction,
            address: transaction.sender // for basic transactions, todo generalize
        });
    }

    importFromFile() {
        return this._startRequest(RequestTypes.IMPORT_FROM_FILE);
    }

    importFromWords() {
        return this._startRequest(RequestTypes.IMPORT_FROM_WORDS);
    }

    async backupFile(address) {
        if (!ValidationUtils.isValidAddress(address)) return;

        const key = await keyStore.getPlain(address);
        if (key.type !== KeyType.LOW) throw new Error('Unauthorized: address is not a Wallet account');

        return this._startRequest(RequestTypes.BACKUP_FILE, {
            address
        });
    }

    async backupWords(address) {
        if (!ValidationUtils.isValidAddress(address)) return;

        const key = await keyStore.getPlain(address);
        if (key.type !== KeyType.HIGH) throw new Error('Unauthorized: address is not a Safe account');

        return this._startRequest(RequestTypes.BACKUP_WORDS, {
            address
        });
    }

    rename(address) {
        if (!ValidationUtils.isValidAddress(address)) return;

        return this._startRequest(RequestTypes.RENAME, {
            address
        });
    }

    async upgrade(address) {
         if (!ValidationUtils.isValidAddress(address)) return;

        const key = await keyStore.getPlain(address);
        if (key.type !== KeyType.LOW) throw new Error('Unauthorized: Address is not a Wallet account');
        if (key.label !== 'Miner Account') throw new Error('Unauthorized: Only Miner accounts can be upgraded');

        return this._startRequest(RequestTypes.UPGRADE, {
            address
        });
    }
}

KeyguardApi.RPC_WHITELIST = [
    'list',
    'getMinerAccount',
    'createSafe',
    'createWallet',
    'signSafe',
    'signWallet',
    'importFromFile',
    'importFromWords',
    'backupFile',
    'backupWords',
    'rename',
    'upgrade'
];

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

/** - For third-party apps requesting access to keystore
 *  - For wallet app to set spending limit
 *  - Intended use: when receiving a sign(tx) request check if policy requests ui and here is a method with this name,
 *  then we call this method here fist. To be discussed
 */

class UI {
    static async requestAuthorize(policy, origin) {
        return new Promise(resolve => {
            // deactivate for now
            resolve(false);
            //resolve(confirm(`An app from origin ${origin} is requesting access. Do you want to grant it?`));

        })
    }
}

class NoUIError extends Error {

    static get code() {
        return 'K2';
    }

    constructor(method) {
        super(`Method ${method} needs user interface`);
    }
}

class ACL {
    static get STORAGE_KEY() {
        return 'policies';
    }

    static addAccessControl(clazz, getState, defaultPolicies) {
        const ClassWithAcl = class {
            constructor() {
                this._isEmbedded = self !== top;

                const storedPolicies = self.localStorage.getItem(ACL.STORAGE_KEY);
                /** @type {Map<string,Policy>} */
                this._appPolicies = storedPolicies ? ACL._parseAppPolicies(storedPolicies) : new Map();

                // Init defaults
                for (const defaultPolicy of defaultPolicies){
                    if (!this._appPolicies.get(defaultPolicy.origin)) {
                        this._appPolicies.set(defaultPolicy.origin, defaultPolicy.policy);
                    }
                }

                // Listen for policy changes from other instances
                self.addEventListener('storage', ({key, newValue}) =>
                    key === ACL.STORAGE_KEY && (this._appPolicies = ACL._parseAppPolicies(newValue)));

                this._innerClass = new clazz();
            }

            getPolicy({ callingOrigin }) {
                return this._appPolicies.get(callingOrigin);
            }

            async authorize({ callingOrigin }, policy) {
                // abort if embedded
                if (this._isEmbedded) throw new Error('Authorization cannot be requested in iframe');

                const userAuthorizesApp = await UI.requestAuthorize(policy, callingOrigin);

                if (userAuthorizesApp) {
                    this._appPolicies.set(callingOrigin, policy);
                    self.localStorage.setItem(ACL.STORAGE_KEY, JSON.stringify([...this._appPolicies]));
                }

                return userAuthorizesApp;
            }
        };

        for (const functionName of Reflection.userFunctions(clazz.prototype)) {
            ClassWithAcl.prototype[functionName] = (async function ({ callingOrigin }, ...args) {
                const policyDescription = this._appPolicies.get(callingOrigin);

                if (!policyDescription) throw new Error('Not authorized from ' + callingOrigin);

                const policy = Policy.parse(policyDescription);

                const state = getState();

                if (!policy.allows(functionName, args, state)) throw new Error('Not authorized (function call with wrong number of arguments)');

                if (policy.needsUi(functionName, args, state)) {
                    if (this._isEmbedded) {
                        throw new NoUIError(functionName);
                    }/* else {
                        const userConfirms = await UI[functionName](...args);
                        if (!userConfirms) throw 'User declined action';
                    }*/
                }

                return this._innerClass[functionName](...args);
            });
        }

        // keep class name of clazz
        Object.defineProperty(ClassWithAcl, 'name', {value: clazz.name});

        return ClassWithAcl;
    }

    static _parseAppPolicies(encoded) {
        try {
            return new Map(JSON.parse(encoded));
        } catch (e) {
            return new Map();
        }
    }
}

ACL.RPC_WHITELIST = [
    'getPolicy',
    'authorize'
];

class XLoader extends XElement {

    html() { return `
        <x-loading-animation></x-loading-animation>
        <h2>Loading&hellip;</h2>
        `;
    }

    set loading(loading) {
        this.$el.classList.toggle('showing', loading);
    }

    set label(label) {
        this.$('h2').innerText = label;
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

var IqonsCatalog = {
face : ['face_01','face_02','face_03','face_04','face_05','face_06','face_07','face_08','face_09','face_10','face_11','face_12','face_13','face_14','face_15','face_16','face_17','face_18','face_19','face_20','face_21',],
side : ['side_01','side_02','side_03','side_04','side_05','side_06','side_07','side_08','side_09','side_10','side_11','side_12','side_13','side_14','side_15','side_16','side_17','side_18','side_19','side_20','side_21',],
top : ['top_01','top_02','top_03','top_04','top_05','top_06','top_07','top_08','top_09','top_10','top_11','top_12','top_13','top_14','top_15','top_16','top_17','top_18','top_19','top_20','top_21',],
bottom : ['bottom_01','bottom_02','bottom_03','bottom_04','bottom_05','bottom_06','bottom_07','bottom_08','bottom_09','bottom_10','bottom_11','bottom_12','bottom_13','bottom_14','bottom_15','bottom_16','bottom_17','bottom_18','bottom_19','bottom_20','bottom_21',],
};

class Iqons{static async svg(t,s=!1){const e=this._hash(t);return this._svgTemplate(e[0],e[2],e[3]+e[4],e[5]+e[6],e[7]+e[8],e[9]+e[10],e[11],e[12],s)}static async render(t,s){s.innerHTML=await this.svg(t);}static async toDataUrl(t){return`data:image/svg+xml;base64, ${btoa(await this.svg(t,!0)).replace(/#/g,"%23")}`}static placeholder(t="#bbb",s=1){return`\n            <svg viewBox="0 0 160 160" width="160" height="160" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/2000/xlink" >\n                <path fill="none" stroke="${t}" stroke-width="${2*s}" transform="translate(0, 8) scale(0.5)" d="M251.6 17.34l63.53 110.03c5.72 9.9 5.72 22.1 0 32L251.6 269.4c-5.7 9.9-16.27 16-27.7 16H96.83c-11.43 0-22-6.1-27.7-16L5.6 159.37c-5.7-9.9-5.7-22.1 0-32L69.14 17.34c5.72-9.9 16.28-16 27.7-16H223.9c11.43 0 22 6.1 27.7 16z"/>\n                <g transform="scale(0.9) translate(9, 8)">\n                    <circle cx="80" cy="80" r="40" fill="none" stroke="${t}" stroke-width="${s}" opacity=".9"></circle>\n                    <g opacity=".1" fill="#010101"><path d="M119.21,80a39.46,39.46,0,0,1-67.13,28.13c10.36,2.33,36,3,49.82-14.28,10.39-12.47,8.31-33.23,4.16-43.26A39.35,39.35,0,0,1,119.21,80Z"/></g>\`\n                </g>\n            </svg>`}static renderPlaceholder(t,s=null,e=null){t.innerHTML=this.placeholder(s,e);}static placeholderToDataUrl(t=null,s=null){return`data:image/svg+xml;base64,${btoa(this.placeholder(t,s))}`}static async image(t){const s=await this.toDataUrl(t),e=await this._loadImage(s);return e.style.width="100%", e.style.height="100%", e}static async _svgTemplate(t,s,e,a,n,r,i,c,l){return this._$svg(await this._$iqons(t,s,e,a,n,r,i,l),c)}static async _$iqons(t,s,e,a,n,r,i,c){for(t=parseInt(t), s=parseInt(s), i=parseInt(i), t===s&&++t>9&&(t=0);i===t||i===s;)++i>9&&(i=0);return t=this.colors[t], s=this.colors[s], `\n            <g color="${t}" fill="${i=this.colors[i]}">\n                <rect fill="${s}" x="0" y="0" width="160" height="160"></rect>\n                <circle cx="80" cy="80" r="40" fill="${t}"></circle>\n                <g opacity=".1" fill="#010101"><path d="M119.21,80a39.46,39.46,0,0,1-67.13,28.13c10.36,2.33,36,3,49.82-14.28,10.39-12.47,8.31-33.23,4.16-43.26A39.35,39.35,0,0,1,119.21,80Z"/></g>\n                ${await this._generatePart("top",a,c)}\n                ${await this._generatePart("side",n,c)}\n                ${await this._generatePart("face",e,c)}\n                ${await this._generatePart("bottom",r,c)}\n            </g>`}static _$svg(t,s){const e=Random.getRandomId();return`\n            <svg viewBox="0 0 160 160" width="160" height="160" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/2000/xlink" >\n                <defs>\n                    <clipPath id="hexagon-clip-${e}" transform="scale(0.5) translate(0, 16)">\n                        <path d="M251.6 17.34l63.53 110.03c5.72 9.9 5.72 22.1 0 32L251.6 269.4c-5.7 9.9-16.27 16-27.7 16H96.83c-11.43 0-22-6.1-27.7-16L5.6 159.37c-5.7-9.9-5.7-22.1 0-32L69.14 17.34c5.72-9.9 16.28-16 27.7-16H223.9c11.43 0 22 6.1 27.7 16z"/>\n                    </clipPath>\n                </defs>\n                <path fill="white" stroke="#bbbbbb" transform="translate(0, 8) scale(0.5)" d="M251.6 17.34l63.53 110.03c5.72 9.9 5.72 22.1 0 32L251.6 269.4c-5.7 9.9-16.27 16-27.7 16H96.83c-11.43 0-22-6.1-27.7-16L5.6 159.37c-5.7-9.9-5.7-22.1 0-32L69.14 17.34c5.72-9.9 16.28-16 27.7-16H223.9c11.43 0 22 6.1 27.7 16z"/>\n                <g transform="scale(0.9) translate(9, 8)">\n                    <g clip-path="url(#hexagon-clip-${e})">\n                        ${t}\n                    </g>\n                </g>\n            </svg>`}static async _generatePart(t,s,e=!1){
/* @asset(iqons.min.svg) */
if(e){const e=await this._getAssets(),a="#"+t+"_"+this._assetIndex(s,t);return e.querySelector(a).innerHTML}return`<use width="160" height="160" xlink:href="iqons.min.svg#${t}_${this._assetIndex(s,t)}"/>`}static _loadImage(t){return new Promise((s,e)=>{const a=document.createElement("img");a.addEventListener("load",t=>s(a),{once:!0}), a.src=t;})}static async _getAssets(){return this._assets?this._assets:(this._assets=fetch("iqons.min.svg").then(t=>t.text()).then(t=>{const s=document.createElement("x-assets");return s.innerHTML=t,this._assets=s,s}), this._assets)}static get colors(){return["#fb8c00","#d32f2f","#fbc02d","#3949ab","#03a9f4","#8e24aa","#009688","#f06292","#7cb342","#795548"]}static get assetCounts(){return{face:IqonsCatalog.face.length,side:IqonsCatalog.side.length,top:IqonsCatalog.top.length,bottom:IqonsCatalog.bottom.length,gaze:2}}static _assetIndex(t,s){return(t=Number(t)%Iqons.assetCounts[s]+1)<10&&(t="0"+t), t}static _hash(t){return(""+t.split("").map(t=>Number(t.charCodeAt(0))+3).reduce((t,s)=>t*(1-t)*this.__chaosHash(s),.5)).split("").reduce((t,s)=>s+t,"").substr(4,17)}static __chaosHash(t){let s=1/t;for(let t=0;t<100;t++)s=(1-s)*s*3.569956786876;return s}}

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

class XAddressNoCopy extends XElement {
    styles() { return ['x-address'] }

    listeners() {
        return {
            'click': this._onCopy
        }
    }

    set address(address) {
        if (ValidationUtils.isValidAddress(address)) {
            this.$el.textContent = address;
        } else {
            this.$el.textContent = '';
        }
    }
}

class XAccount extends XElement {
    html() {
        return `
            <x-identicon></x-identicon>
            <div class="x-account-info">
                <div class="x-account-label"></div>
                <x-address-no-copy></x-address-no-copy>
            </div>
        `
    }

    children() { return [ XIdenticon, XAddressNoCopy ] }

    onCreate() {
        this.$label = this.$('.x-account-label');
        super.onCreate();
    }

    listeners() {
        return {
            'click': this._onAccountSelected
        }
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
        this.$addressNoCopy.address = address;
        this._address = address;
    }

    set account(account) {
        this.setProperties(account, true);
    }
}

class XMyAccount extends MixinRedux(XAccount) {
    static mapStateToProps(state) {
        return Object.assign({},
            state.request.data
        )
    }
}

class XSetLabel extends XElement {

    html() { return `
        <h1>Label your Account</h1>
        <h2>This label is only visible to you</h2>
        <x-grow></x-grow>
        <x-my-account></x-my-account>
        <x-grow></x-grow>
        <input type="text" placeholder="Account label" maxlength="24">
        <x-grow x-grow="2"></x-grow>
        <button>Confirm</button>
        `;
    }

    children() {
        return [ XMyAccount ];
    }

    onCreate() {
        this.$input = this.$('input');
        this._oldInput = '';
    }

    onAfterEntry() {
        this.$input.focus();
    }

    listeners() {
        return {
            'keydown input': this._submitIfReturn.bind(this),
            'input input': this._cleanInput.bind(this),
            'click button': this._returnValue.bind(this)
        }
    }

    _submitIfReturn(d, e) {
        if (e.keyCode == 13) {
            this._returnValue();
        }
    }

    _cleanInput() {
        if (!BrowserDetection.isSafari() && !BrowserDetection.isIOS()) return;

        const currentValue = this.$input.value;
        const encoded = encodeURIComponent(currentValue);

        if (encoded.length > 24) {
            this.$input.value = this._oldInput;
        } else {
            this._oldInput = currentValue;
        }
    }

    _returnValue() {
        this.fire('x-set-label', this.$input.value);
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

class XPassphraseInput extends XInput {
    html() {
        const { placeholder } = this.attributes;

        return `
            <form action="/">
                <input class="password" type="password" placeholder="${ placeholder || 'Enter Pass Phrase' }">
                <span id="eye" icon-eye />
            </form>
        `;
    }

    onCreate() {
        super.onCreate();
        this.$eye = this.$('#eye');
        this.$input = this.$('input');
    }

    listeners() { return {
        'click #eye': e => this._toggleVisibility()
    }}

    _onValueChanged() {
        const { id } = this.attributes;
        if (id) {
            this.fire(`${ this.__tagName }-${ id }-change`, this.value);
        } else {
            this.fire(`${ this.__tagName }-change`, this.value);
        }
    }

    _toggleVisibility() {
        if (this.$input.getAttribute('type') === 'password') {
            this.$input.setAttribute('type', 'text');
            this.$eye.setAttribute('icon-eye-off', true);
            this.$eye.removeAttribute('icon-eye', true);
        } else {
            this.$input.setAttribute('type', 'password');
            this.$eye.setAttribute('icon-eye', true);
            this.$eye.removeAttribute('icon-eye-off', true);
        }
        this.$input.focus();
    }
}

class XPassphraseIndicator extends XElement {
    html() {
        return `
            <div class="label">Strength:</div>
            <meter max="130" low="10" optimum="100"></meter>
        `;
    }

    setStrength(strength) { // 0 for none, 1 for bad, 2 for ok, 3 for good
      this.$('meter').setAttribute('value', this._getMeterValue(strength));
    }

    _getMeterValue(strength) {
      switch(strength) {
        case 0:
          return 0;
        case 1:
          return 10;
        case 2:
          return 70;
        case 3:
          return 100;
        case 4:
          return 130;
      }
    }

    listeners() {
        return {
            'click i': this.fire('x-passphrase-indicator-help')
        }
    }
}

class XPassphraseSetter extends XElement {
    html() {
        const { buttonLabel } = this.attributes;

        return `
            <h2>Choose your Pass Phrase:</h2>
            <x-passphrase-input></x-passphrase-input>
            <x-passphrase-indicator></x-passphrase-indicator>
            <x-grow></x-grow>
            <button disabled>${ buttonLabel || 'Confirm' }</button>
        `;
    }

    onCreate() {
        this.$button = this.$('button');
        this.$('input').setAttribute('autocomplete', 'new-password');
    }

    children() {
        return [ XPassphraseInput, XPassphraseIndicator];
    }

    listeners() {
        return {
            'x-passphrase-input-change': value => this._onPassphraseUpdate(value),
            'click button': e => this._onPassphraseSubmit(),
            'keydown input': (d, e) => { if (e.keyCode == 13) this._onPassphraseSubmit(); }
        }
    }

    focus() {
        this.$passphraseInput.focus();
    }

    get value() {
        return this.$passphraseInput.value;
    }

    clear() {
        this.$passphraseInput.value = '';
    }

    _passphraseIsValid(passphrase) {
        return this._getPassphraseStrength(passphrase) >= 3;
    }

    _onPassphraseUpdate(passphrase) {
        const strength = this._getPassphraseStrength(passphrase);
        this.$passphraseIndicator.setStrength(strength);
        if (this._passphraseIsValid(passphrase)) {
            this.$button.removeAttribute('disabled');
        } else {
            this.$button.setAttribute('disabled', 'disabled');
        }
    }

    _onPassphraseSubmit() {
        if (this._passphraseIsValid (this.value)) {
            this.fire(this.__tagName + '-submitted', this.value);
        }
    }

    /** @param {string} passphrase
     * @return {number} */
    _getPassphraseStrength(passphrase) {
        if (passphrase.length === 0) return 0;
        if (passphrase.length < 7) return 1;
        if (passphrase.length < 10) return 2;
        if (passphrase.length < 14) return 3;
        return 4;
    }
}

class XPassphraseGetter extends XElement {
    html() {
        const { buttonLabel } = this.attributes;

        return `
            <x-passphrase-input></x-passphrase-input>
            <x-grow></x-grow>
            <button>${ buttonLabel || 'Confirm' }</button>
        `;
    }

    onCreate() {
        this.$button = this.$('button');
        // TODO is it correct to disable autocompletion and force users to re-enter password?
        this.$('input').setAttribute('autocomplete', 'off');
    }

    children() {
        return [ XPassphraseInput ];
    }

    listeners() {
        return {
            'click button': e => this._onPassphraseSubmit(),
            'keydown input': (d, e) => { if (e.keyCode == 13) this._onPassphraseSubmit(); }
        }
    }

    focus() {
        this.$passphraseInput.focus();
    }

    wrongPassphrase() {
        this.$passphraseInput.setInvalid();
    }


    get value() {
        return this.$passphraseInput.value;
    }

    _onPassphraseSubmit() {
        this.fire(this.__tagName + '-submitted', this.value);
    }
}

class XSetPassphrase extends XElement {

    html() { return `
        <h1>Set a Pass Phrase</h1>
        <h2>Please enter a Pass Phrase to secure your account.</h2>
        <p>The Pass Phrase is <strong>not</strong> an alternative for your 24 Recovery Words and it cannot be changed or reset!</p>
        <x-grow x-grow="0.5"></x-grow>
        <x-my-account></x-my-account>
        <x-grow x-grow="0.5"></x-grow>
        <x-passphrase-setter x-route="" button-label="Confirm" show-indicator="true"></x-passphrase-setter>
        <section class="center" x-route="confirm">
            <h2>Please repeat your Pass Phrase:</h2>
            <x-passphrase-getter button-label="Confirm"></x-passphrase-getter>
        </section>
        `;
    }

    children() {
        return [ XPassphraseSetter, XPassphraseGetter, XMyAccount ];
    }

    onAfterEntry() {
        this.$passphraseSetter.focus();
    }

    listeners() {
        return {
            'x-passphrase-setter-submitted': this._onSetterSubmit.bind(this),
            'x-passphrase-getter-submitted': this._onConfirmationSubmit.bind(this)
        }
    }

    async _onSetterSubmit(passphrase) {
        this._passphrase = passphrase;
        (await XRouter$1.instance).goTo(this, 'confirm');
        this.$passphraseGetter.focus();
    }

    _onConfirmationSubmit(passphrase2) {
        if (this._passphrase === passphrase2) {
            this.fire('x-set-passphrase', passphrase2);
        } else {
            this.$passphraseSetter.clear();
            this.$passphraseGetter.wrongPassphrase();
            setTimeout(async () => (await XRouter$1.instance).goTo(this, ''), 700);
        }
    }
}

class XPrivacyAgent extends XElement {
    html() {
        return `
			<x-privacy-agent-container>
					<svg width="162" height="144" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
				  <defs>
				    <path d="M108 27.54l53.28 30.76a16 16 0 0 1 8 13.86v61.53a16 16 0 0 1-8 13.85L108 178.3a16 16 0 0 1-16 0l-53.28-30.76a16 16 0 0 1-8-13.85V72.16a16 16 0 0 1 8-13.86L92 27.54a16 16 0 0 1 16 0z" id="a"/>
				  </defs>
				  <g transform="translate(-19 -31)" fill="none" fill-rule="evenodd">
				    <mask id="b" fill="#fff">
				      <use xlink:href="#a"/>
				    </mask>
				    <use stroke="#000" stroke-width="5" transform="rotate(30 100 102.92)" xlink:href="#a"/>
				    <path d="M86.38 50c-3.45 0-6.33 2.07-8.52 4.82-2.2 2.77-3.9 6.35-5.35 10.26-2.7 7.3-4.34 15.57-5.34 21.62-5.07.98-9.64 2.12-12.86 3.58-1.8.82-3.3 1.7-4.45 2.82a5.94 5.94 0 0 0-2.05 4.23 5.7 5.7 0 0 0 1.6 3.78 12.95 12.95 0 0 0 3.51 2.6c2.84 1.5 6.64 2.74 11.28 3.8.08 0 .17.02.24.04a6.03 6.03 0 0 0-.75 2.86c0 1.46.45 2.71.8 3.93l.48 1.62c.11.44.14.86.14.53 0 3.07 2.59 5.46 5.64 5.57.07 1.63.3 3.21.62 4.75-3.87.7-7.41 2.74-10.23 4.69a45.92 45.92 0 0 0-5.87 4.82l-1.48 1.49 6.8 7.74a54.56 54.56 0 0 0-12.36 10.93C44.1 161.44 41 166.71 41 171.71V192h118v-20.29c0-5.04-3.01-10.41-7.06-15.45a53.15 53.15 0 0 0-12.2-11.1l6.47-7.35-1.48-1.49s-2.4-2.42-5.87-4.82c-2.82-1.95-6.36-3.98-10.23-4.69.33-1.54.55-3.13.62-4.75 3.05-.1 5.64-2.5 5.64-5.57 0 .33.03-.1.14-.53l.47-1.62c.36-1.22.8-2.47.8-3.93 0-1.04-.28-2-.74-2.86l.24-.05c4.64-1.05 8.44-2.29 11.28-3.8 1.4-.75 2.6-1.58 3.52-2.59a5.7 5.7 0 0 0 1.6-3.78c0-1.67-.9-3.13-2.06-4.23-1.16-1.11-2.65-2-4.45-2.82-3.22-1.46-7.79-2.6-12.86-3.58-1-6.05-2.64-14.32-5.34-21.62-1.45-3.9-3.16-7.49-5.35-10.26-2.19-2.75-5.07-4.82-8.52-4.82-3.91 0-6.72 1.37-8.79 2.55-2.06 1.17-3.31 1.96-4.83 1.96s-2.77-.79-4.83-1.96A17.01 17.01 0 0 0 86.38 50zm0 4.5c2.9 0 4.63.89 6.54 1.97 1.9 1.08 4.06 2.55 7.08 2.55 3.02 0 5.18-1.47 7.08-2.55 1.9-1.08 3.64-1.96 6.54-1.96 1.65 0 3.26.96 4.96 3.1 1.7 2.16 3.3 5.39 4.65 9.03 2.7 7.3 4.44 16.25 5.38 22.19.16.95.9 1.7 1.85 1.86 5.69 1.02 10.32 2.32 13.34 3.7 1.5.68 2.6 1.4 3.2 1.96.61.57.65.86.65.98 0 .1-.01.31-.42.77a9.13 9.13 0 0 1-2.3 1.63c-2.23 1.19-5.74 2.38-10.14 3.38-1.66.37-3.5.71-5.4 1.03-.2.03-.4.04-.5.09a184.71 184.71 0 0 1-28.89 2.12c-10.83 0-20.82-.81-28.9-2.12-.1-.05-.3-.06-.5-.1-1.9-.3-3.73-.65-5.4-1.02-4.39-1-7.9-2.2-10.12-3.38a9.13 9.13 0 0 1-2.3-1.63c-.42-.46-.43-.66-.43-.77 0-.12.04-.41.64-.98.6-.57 1.7-1.28 3.21-1.97 3.02-1.37 7.65-2.67 13.34-3.69.26-.04.5-.14.74-.27l1.25.1 1.35-1.5-.4-1.98-.6-.53-.09-.05c1-5.8 2.6-13.4 4.98-19.82 1.34-3.64 2.95-6.87 4.65-9.02 1.7-2.15 3.3-3.11 4.96-3.11zm38.63 34.44l-.78.13-.22.08-1.42 1.45.33 1.99 1.8.94.8-.13.21-.08 1.41-1.45-.33-2-1.8-.93zm-45.4 1.02l-2.01.33-.92 1.8.9 1.82.71.36.21.06 2-.34.93-1.8-.9-1.8-.7-.37-.22-.06zm36.74 1.35l-.81.03-.22.04-1.6 1.23.04 2.03 1.65 1.18.8-.03.22-.04 1.6-1.23-.03-2.02-1.65-1.19zm-28.02.67l-1.93.63-.65 1.9 1.16 1.67.75.26.22.02 1.94-.62.65-1.91-1.15-1.67-.76-.25-.23-.03zm18.3.59h-.21l-1.77 1.03-.23 2 1.47 1.39.81.09.22-.02 1.76-1 .23-2.01-1.47-1.4-.8-.08zm-9.32.2l-1.84.87-.4 1.98 1.36 1.5.78.15.23.01 1.83-.86.4-1.98-1.35-1.5-.8-.17h-.21zM70 108.66l.1.06c.39.19.93.49 1.52.82l3.4 2v-2.2c1.59.21 3.2.4 4.87.57a5.4 5.4 0 0 0-.32 1.84c0 4.48 4.06 8.11 9.07 8.11 5.02 0 9.08-3.63 9.08-8.1 0-.35-.07-.64-.11-.94.8.01 1.57.03 2.38.03.8 0 1.59-.02 2.38-.03-.04.3-.11.6-.11.93 0 4.48 4.06 8.11 9.08 8.11 5.01 0 9.07-3.63 9.07-8.1 0-.72-.13-1.3-.32-1.85 1.67-.17 3.28-.36 4.86-.57v2.2l3.41-2c.59-.33 1.13-.63 1.51-.82l.1-.06c1.04.1 1.79.83 1.79 1.74 0 .17-.27 1.49-.61 2.67-.18.58-.36 1.17-.5 1.7-.16.54-.3.92-.3 1.71 0 .6-.5 1.13-1.29 1.13h-4.1v3.08a24.81 24.81 0 0 1-20.56 24.39l-.65.1-.49.45a4.8 4.8 0 0 1-6.54 0l-.49-.45-.65-.1a24.81 24.81 0 0 1-20.55-24.39v-3.08h-4.11c-.78 0-1.28-.53-1.28-1.13 0-.79-.15-1.17-.3-1.7l-.5-1.71a20.4 20.4 0 0 1-.62-2.67c0-.9.75-1.63 1.78-1.74zm2.66 22.5a29.25 29.25 0 0 0 11.47 14.05c.13 9.44 3.56 20.04 6.95 28.46a143.28 143.28 0 0 0 6.37 13.81h-9.79l-23.02-18.35 11.1-13.24-15.63-17.74c.83-.77 1.47-1.48 3.62-2.97 2.66-1.84 6-3.56 8.93-4.02zm54.66 0c2.93.46 6.27 2.18 8.93 4.02 2.15 1.5 2.79 2.2 3.62 2.97l-15.63 17.74 11.1 13.24-23.02 18.35h-9.79c.72-1.35 3.35-6.33 6.37-13.81 3.4-8.42 6.82-19.01 6.95-28.45a29.23 29.23 0 0 0 11.47-14.06zm-38.54 16.48c1.73.7 3.52 1.28 5.4 1.66a9.35 9.35 0 0 0 5.81 2.12 9.4 9.4 0 0 0 5.78-2.11c1.89-.37 3.7-.95 5.43-1.66-.63 7.85-3.54 16.98-6.5 24.34-2.36 5.85-3.52 7.82-4.71 10.13-1.19-2.3-2.35-4.28-4.7-10.13-2.97-7.36-5.88-16.49-6.51-24.35zm47.93.93a49.02 49.02 0 0 1 11.67 10.5c3.7 4.6 6.07 9.57 6.07 12.63v15.78h-34.89l22.23-17.71-11.6-13.8 6.52-7.4zm-73.09.41l6.16 6.98-11.6 13.8 22.24 17.72h-34.9V171.7c0-2.93 2.41-7.82 6.2-12.35a50.38 50.38 0 0 1 11.9-10.37z" fill="#000" fill-rule="nonzero" mask="url(#b)"/>
				  </g>
				</svg>
				<h1>Are you being watched?</h1>
				<p>Now is the perfect time to assess your surroundings. Nearby windows? Hidden cameras? Shoulder spies?</p><p><strong>Anyone with the following information can steal all your funds!</strong></p>
			</x-privacy-agent-container>
			<x-grow></x-grow>
			<button>OK, all good</button>
		`
    }
    onCreate() {
        this.$('button').addEventListener('click', e => this.fire('x-surrounding-checked'));
    }
}

class MnemonicPhrase{static _hexToArray(e){return e=e.trim(), Uint8Array.from(e.match(/.{2}/g)||[],e=>parseInt(e,16))}static _arrayToHex(e){let r="";for(let a=0;a<e.length;a++){const t=e[a];r+=MnemonicPhrase.HEX_ALPHABET[t>>>4], r+=MnemonicPhrase.HEX_ALPHABET[15&t];}return r}static _crc8(e){for(var r=[],a=0;a<256;++a){for(var t=a,o=0;o<8;++o)t=0!=(128&t)?(t<<1^151)%256:(t<<1)%256;r[a]=t;}var i=0;for(a=0;a<e.length;a++)i=r[(i^e[a])%256];return i}static _lpad(e,r,a){for(;e.length<a;)e=r+e;return e}static _binaryToBytes(e){return parseInt(e,2)}static _bytesToBinary(e){return e.reduce((e,r)=>e+MnemonicPhrase._lpad(r.toString(2),"0",8),"")}static _deriveChecksumBits(e){var r=MnemonicPhrase._crc8(e);return MnemonicPhrase._bytesToBinary([r])}static keyToMnemonic(e,r){if("string"==typeof e&&(e=MnemonicPhrase._hexToArray(e)), e instanceof ArrayBuffer&&(e=new Uint8Array(e)), r=r||MnemonicPhrase.DEFAULT_WORDLIST, e.length<16)throw new TypeError("Invalid key, length < 16");if(e.length>32)throw new TypeError("Invalid key, length > 32");if(e.length%4!=0)throw new TypeError("Invalid key, length % 4 != 0");return(MnemonicPhrase._bytesToBinary(e)+MnemonicPhrase._deriveChecksumBits(e)).match(/(.{11})/g).reduce((e,a)=>{var t=MnemonicPhrase._binaryToBytes(a);return e+(e?" ":"")+r[t]},"")}static mnemonicToKey(e,r){r=r||MnemonicPhrase.DEFAULT_WORDLIST;var a=e.normalize("NFKD").trim().split(/\s+/g);if(a.length<12)throw new Error("Invalid mnemonic, less than 12 words");if(a.length>24)throw new Error("Invalid mnemonic, more than 24 words");if(a.length%3!=0)throw new Error("Invalid mnemonic, words % 3 != 0");var t=a.map(function(e){var a=r.indexOf(e.toLowerCase());if(-1===a)throw new Error("Invalid mnemonic, word >"+e+"< is not in wordlist");return MnemonicPhrase._lpad(a.toString(2),"0",11)}).join(""),o=t.length-(t.length%8||8),i=t.slice(0,o),n=t.slice(o),s=i.match(/(.{8})/g).map(MnemonicPhrase._binaryToBytes);if(s.length<16)throw new Error("Invalid generated key, length < 16");if(s.length>32)throw new Error("Invalid generated key, length > 32");if(s.length%4!=0)throw new Error("Invalid generated key, length % 4 != 0");var l=new Uint8Array(s);if(MnemonicPhrase._deriveChecksumBits(l).slice(0,n.length)!==n)throw new Error("Invalid checksum");return MnemonicPhrase._arrayToHex(l)}}MnemonicPhrase.HEX_ALPHABET="0123456789abcdef", MnemonicPhrase.ENGLISH_WORDLIST="abandon ability able about above absent absorb abstract absurd abuse access accident account accuse achieve acid acoustic acquire across act action actor actress actual adapt add addict address adjust admit adult advance advice aerobic affair afford afraid again age agent agree ahead aim air airport aisle alarm album alcohol alert alien all alley allow almost alone alpha already also alter always amateur amazing among amount amused analyst anchor ancient anger angle angry animal ankle announce annual another answer antenna antique anxiety any apart apology appear apple approve april arch arctic area arena argue arm armed armor army around arrange arrest arrive arrow art artefact artist artwork ask aspect assault asset assist assume asthma athlete atom attack attend attitude attract auction audit august aunt author auto autumn average avocado avoid awake aware away awesome awful awkward axis baby bachelor bacon badge bag balance balcony ball bamboo banana banner bar barely bargain barrel base basic basket battle beach bean beauty because become beef before begin behave behind believe below belt bench benefit best betray better between beyond bicycle bid bike bind biology bird birth bitter black blade blame blanket blast bleak bless blind blood blossom blouse blue blur blush board boat body boil bomb bone bonus book boost border boring borrow boss bottom bounce box boy bracket brain brand brass brave bread breeze brick bridge brief bright bring brisk broccoli broken bronze broom brother brown brush bubble buddy budget buffalo build bulb bulk bullet bundle bunker burden burger burst bus business busy butter buyer buzz cabbage cabin cable cactus cage cake call calm camera camp can canal cancel candy cannon canoe canvas canyon capable capital captain car carbon card cargo carpet carry cart case cash casino castle casual cat catalog catch category cattle caught cause caution cave ceiling celery cement census century cereal certain chair chalk champion change chaos chapter charge chase chat cheap check cheese chef cherry chest chicken chief child chimney choice choose chronic chuckle chunk churn cigar cinnamon circle citizen city civil claim clap clarify claw clay clean clerk clever click client cliff climb clinic clip clock clog close cloth cloud clown club clump cluster clutch coach coast coconut code coffee coil coin collect color column combine come comfort comic common company concert conduct confirm congress connect consider control convince cook cool copper copy coral core corn correct cost cotton couch country couple course cousin cover coyote crack cradle craft cram crane crash crater crawl crazy cream credit creek crew cricket crime crisp critic crop cross crouch crowd crucial cruel cruise crumble crunch crush cry crystal cube culture cup cupboard curious current curtain curve cushion custom cute cycle dad damage damp dance danger daring dash daughter dawn day deal debate debris decade december decide decline decorate decrease deer defense define defy degree delay deliver demand demise denial dentist deny depart depend deposit depth deputy derive describe desert design desk despair destroy detail detect develop device devote diagram dial diamond diary dice diesel diet differ digital dignity dilemma dinner dinosaur direct dirt disagree discover disease dish dismiss disorder display distance divert divide divorce dizzy doctor document dog doll dolphin domain donate donkey donor door dose double dove draft dragon drama drastic draw dream dress drift drill drink drip drive drop drum dry duck dumb dune during dust dutch duty dwarf dynamic eager eagle early earn earth easily east easy echo ecology economy edge edit educate effort egg eight either elbow elder electric elegant element elephant elevator elite else embark embody embrace emerge emotion employ empower empty enable enact end endless endorse enemy energy enforce engage engine enhance enjoy enlist enough enrich enroll ensure enter entire entry envelope episode equal equip era erase erode erosion error erupt escape essay essence estate eternal ethics evidence evil evoke evolve exact example excess exchange excite exclude excuse execute exercise exhaust exhibit exile exist exit exotic expand expect expire explain expose express extend extra eye eyebrow fabric face faculty fade faint faith fall false fame family famous fan fancy fantasy farm fashion fat fatal father fatigue fault favorite feature february federal fee feed feel female fence festival fetch fever few fiber fiction field figure file film filter final find fine finger finish fire firm first fiscal fish fit fitness fix flag flame flash flat flavor flee flight flip float flock floor flower fluid flush fly foam focus fog foil fold follow food foot force forest forget fork fortune forum forward fossil foster found fox fragile frame frequent fresh friend fringe frog front frost frown frozen fruit fuel fun funny furnace fury future gadget gain galaxy gallery game gap garage garbage garden garlic garment gas gasp gate gather gauge gaze general genius genre gentle genuine gesture ghost giant gift giggle ginger giraffe girl give glad glance glare glass glide glimpse globe gloom glory glove glow glue goat goddess gold good goose gorilla gospel gossip govern gown grab grace grain grant grape grass gravity great green grid grief grit grocery group grow grunt guard guess guide guilt guitar gun gym habit hair half hammer hamster hand happy harbor hard harsh harvest hat have hawk hazard head health heart heavy hedgehog height hello helmet help hen hero hidden high hill hint hip hire history hobby hockey hold hole holiday hollow home honey hood hope horn horror horse hospital host hotel hour hover hub huge human humble humor hundred hungry hunt hurdle hurry hurt husband hybrid ice icon idea identify idle ignore ill illegal illness image imitate immense immune impact impose improve impulse inch include income increase index indicate indoor industry infant inflict inform inhale inherit initial inject injury inmate inner innocent input inquiry insane insect inside inspire install intact interest into invest invite involve iron island isolate issue item ivory jacket jaguar jar jazz jealous jeans jelly jewel job join joke journey joy judge juice jump jungle junior junk just kangaroo keen keep ketchup key kick kid kidney kind kingdom kiss kit kitchen kite kitten kiwi knee knife knock know lab label labor ladder lady lake lamp language laptop large later latin laugh laundry lava law lawn lawsuit layer lazy leader leaf learn leave lecture left leg legal legend leisure lemon lend length lens leopard lesson letter level liar liberty library license life lift light like limb limit link lion liquid list little live lizard load loan lobster local lock logic lonely long loop lottery loud lounge love loyal lucky luggage lumber lunar lunch luxury lyrics machine mad magic magnet maid mail main major make mammal man manage mandate mango mansion manual maple marble march margin marine market marriage mask mass master match material math matrix matter maximum maze meadow mean measure meat mechanic medal media melody melt member memory mention menu mercy merge merit merry mesh message metal method middle midnight milk million mimic mind minimum minor minute miracle mirror misery miss mistake mix mixed mixture mobile model modify mom moment monitor monkey monster month moon moral more morning mosquito mother motion motor mountain mouse move movie much muffin mule multiply muscle museum mushroom music must mutual myself mystery myth naive name napkin narrow nasty nation nature near neck need negative neglect neither nephew nerve nest net network neutral never news next nice night noble noise nominee noodle normal north nose notable note nothing notice novel now nuclear number nurse nut oak obey object oblige obscure observe obtain obvious occur ocean october odor off offer office often oil okay old olive olympic omit once one onion online only open opera opinion oppose option orange orbit orchard order ordinary organ orient original orphan ostrich other outdoor outer output outside oval oven over own owner oxygen oyster ozone pact paddle page pair palace palm panda panel panic panther paper parade parent park parrot party pass patch path patient patrol pattern pause pave payment peace peanut pear peasant pelican pen penalty pencil people pepper perfect permit person pet phone photo phrase physical piano picnic picture piece pig pigeon pill pilot pink pioneer pipe pistol pitch pizza place planet plastic plate play please pledge pluck plug plunge poem poet point polar pole police pond pony pool popular portion position possible post potato pottery poverty powder power practice praise predict prefer prepare present pretty prevent price pride primary print priority prison private prize problem process produce profit program project promote proof property prosper protect proud provide public pudding pull pulp pulse pumpkin punch pupil puppy purchase purity purpose purse push put puzzle pyramid quality quantum quarter question quick quit quiz quote rabbit raccoon race rack radar radio rail rain raise rally ramp ranch random range rapid rare rate rather raven raw razor ready real reason rebel rebuild recall receive recipe record recycle reduce reflect reform refuse region regret regular reject relax release relief rely remain remember remind remove render renew rent reopen repair repeat replace report require rescue resemble resist resource response result retire retreat return reunion reveal review reward rhythm rib ribbon rice rich ride ridge rifle right rigid ring riot ripple risk ritual rival river road roast robot robust rocket romance roof rookie room rose rotate rough round route royal rubber rude rug rule run runway rural sad saddle sadness safe sail salad salmon salon salt salute same sample sand satisfy satoshi sauce sausage save say scale scan scare scatter scene scheme school science scissors scorpion scout scrap screen script scrub sea search season seat second secret section security seed seek segment select sell seminar senior sense sentence series service session settle setup seven shadow shaft shallow share shed shell sheriff shield shift shine ship shiver shock shoe shoot shop short shoulder shove shrimp shrug shuffle shy sibling sick side siege sight sign silent silk silly silver similar simple since sing siren sister situate six size skate sketch ski skill skin skirt skull slab slam sleep slender slice slide slight slim slogan slot slow slush small smart smile smoke smooth snack snake snap sniff snow soap soccer social sock soda soft solar soldier solid solution solve someone song soon sorry sort soul sound soup source south space spare spatial spawn speak special speed spell spend sphere spice spider spike spin spirit split spoil sponsor spoon sport spot spray spread spring spy square squeeze squirrel stable stadium staff stage stairs stamp stand start state stay steak steel stem step stereo stick still sting stock stomach stone stool story stove strategy street strike strong struggle student stuff stumble style subject submit subway success such sudden suffer sugar suggest suit summer sun sunny sunset super supply supreme sure surface surge surprise surround survey suspect sustain swallow swamp swap swarm swear sweet swift swim swing switch sword symbol symptom syrup system table tackle tag tail talent talk tank tape target task taste tattoo taxi teach team tell ten tenant tennis tent term test text thank that theme then theory there they thing this thought three thrive throw thumb thunder ticket tide tiger tilt timber time tiny tip tired tissue title toast tobacco today toddler toe together toilet token tomato tomorrow tone tongue tonight tool tooth top topic topple torch tornado tortoise toss total tourist toward tower town toy track trade traffic tragic train transfer trap trash travel tray treat tree trend trial tribe trick trigger trim trip trophy trouble truck true truly trumpet trust truth try tube tuition tumble tuna tunnel turkey turn turtle twelve twenty twice twin twist two type typical ugly umbrella unable unaware uncle uncover under undo unfair unfold unhappy uniform unique unit universe unknown unlock until unusual unveil update upgrade uphold upon upper upset urban urge usage use used useful useless usual utility vacant vacuum vague valid valley valve van vanish vapor various vast vault vehicle velvet vendor venture venue verb verify version very vessel veteran viable vibrant vicious victory video view village vintage violin virtual virus visa visit visual vital vivid vocal voice void volcano volume vote voyage wage wagon wait walk wall walnut want warfare warm warrior wash wasp waste water wave way wealth weapon wear weasel weather web wedding weekend weird welcome west wet whale what wheat wheel when where whip whisper wide width wife wild will win window wine wing wink winner winter wire wisdom wise wish witness wolf woman wonder wood wool word work world worry worth wrap wreck wrestle wrist write wrong yard year yellow you young youth zebra zero zone zoo".split(" "), MnemonicPhrase.DEFAULT_WORDLIST=MnemonicPhrase.ENGLISH_WORDLIST, "undefined"!=typeof module&&(module.exports=MnemonicPhrase);

class XMnemonicPhrase extends XElement {

    styles() { return ['x-recovery-phrase'] }

    _onPropertiesChanged(changes) {
        if (changes.privateKey) {
            this.privateKey = changes.privateKey;
        }
    }

    set privateKey(privateKey) {
        const phrase = MnemonicPhrase.keyToMnemonic(privateKey);
        const words = phrase.split(/\s+/g);

        const html = words.map((word, index) => `<div class="x-word">
            <span id="word${index}" class="x-word-content" title="word # ${index + 1}">${ index + 1 }</span>
        </div>`).reduce((a,b) => a.concat(b));

        this.$el.innerHTML = html;

        for (let i = 0; i < 24; i++) {
            this.$(`#word${i}`).addEventListener('click', () => this._showWord(words[i], i));
            this.$(`#word${i}`).addEventListener('mouseenter', () => this._showWord(words[i], i));
            this.$(`#word${i}`).addEventListener('mouseleave', () => this._hideWord(i));
        }
    }

    _showWord(word, i) {
        // check if word is already visible
        if (this._revealedWord === i) return;

        // reveal content
        this.$(`#word${ i }`).textContent = word;

        // hide word which was revealed before
        if (this._revealedWord !== undefined) {
            this._hideWord(this._revealedWord);
        }

        this._revealedWord = i;
    }

    _hideWord(i) {
        this.$(`#word${ i }`).textContent = i + 1;

        this._revealedWord = undefined;
    }
}

class XShowWords extends MixinRedux(XElement) {

    html() { return `
        <h1>Backup your 24 Recovery Words</h1>
        <h2 secondary>Write down and physically store the complete following list of 24 Account Recovery Words at a <strong>SAFE and SECRET</strong> place to recover this account in the future.</h2>
        <x-grow></x-grow>
        <x-mnemonic-phrase></x-mnemonic-phrase>
        <div class="info-box">
            <i class="info-icon"></i>
            <p class="info-text">Move your mouse over the numbers or tap them to reveal each word.</p>
        </div>
        <div class="spacing-bottom center warning">
            <strong>Anyone with access to these words can steal all your funds!</strong>
        </div>
        <x-grow></x-grow>
        <button>Continue</button>
        `;
    }

    children() {
        return [ XMnemonicPhrase ];
    }

    static mapStateToProps(state) {
        return {
            privateKey: state.request.data.privateKey,
        };
    }

    _onPropertiesChanged(changes) {
        const { privateKey } = changes;

        if (privateKey) {
            this.$mnemonicPhrase.setProperty('privateKey', privateKey);
        }
    }

    listeners() {
        return {
            'click button': () => this.fire('x-show-words')
        };
    }
}

class XValidateWords extends XElement {
    html() {
        return `
            <h1>Validate Recovery Words</h1>
            <p>Please select the following word from your list:</p>
            <x-grow></x-grow>
            <x-target-index></x-target-index>
            <x-wordlist>
                <button class="small"></button>
                <button class="small"></button>
                <button class="small"></button>
                <button class="small"></button>
                <button class="small"></button>
                <button class="small"></button>
                <button class="small"></button>
                <button class="small"></button>
            </x-wordlist>
            <x-grow></x-grow>
            <a secondary>Back to words</a>
        `
    }

    listeners() {
        return {
            'click a[secondary]': _ => this.fire('x-validate-words-back')
        }
    }

    set privateKey(privateKey) {
        this.mnemonic = MnemonicPhrase.keyToMnemonic(privateKey);
    }

    set mnemonic(mnemonic) {
        if (!mnemonic) return;
        this._mnemonic = mnemonic.split(/\s+/g);
    }

    onCreate() {
        this.$buttons = this.$$('button');
        this.$targetIndex = this.$('x-target-index');
        this.addEventListener('click', e => this._onClick(e));
    }

    onEntry() {
        this._reset();
    }

    _reset() {
        if (!this._mnemonic) return;
        this._round = 0;
        this.mnemonic = this._mnemonic.join(' ');
        this._generateIndices();
        this._setContent(this._round);
    }

    _next() {
        this._round += 1;
        if (this._round < 3) {
            this._setContent(this._round);
        } else {
            this.fire('x-validate-words');
        }
    }

    _generateIndices() {
        this.requiredWords = [0, 1, 2].map(this._generateIndex);
    }

    _generateIndex(index) {
        return Math.floor(Math.random() * 8) + index * 8;
    }

    _setContent(round) {
        this._set(
            this._generateWords(this.requiredWords[round]), // wordlist
            this.requiredWords[round] + 1, // targetIndex
            this._mnemonic[this.requiredWords[round]] // targetWord
        );
    }

    _generateWords(wordIndex) {
        const words = {};

        words[this._mnemonic[wordIndex]] = wordIndex;

        // Select 7 additional unique words from the mnemonic phrase
        while (Object.keys(words).length < 8) {
            const index = Math.floor(Math.random() * 24);
            words[this._mnemonic[index]] = index;
        }

        return Object.keys(words).sort();
    }

    // per round

    /**
     * @param {string[]} wordlist
     * @param {number} targetIndex
     * @param {string} targetWord
     */
    _set(wordlist, targetIndex, targetWord) {
        this.$$('.correct').forEach(button => button.classList.remove('correct'));
        this.$$('.wrong').forEach(button => button.classList.remove('wrong'));
        this.setWordlist(wordlist);
        this.setTargetIndex(targetIndex);
        this._targetWord = targetWord;
    }

    setWordlist(wordlist) {
        this._wordlist = wordlist;
        wordlist.forEach((word, index) => this.$buttons[index].textContent = word);
        this.$buttons.forEach(button => button.removeAttribute('disabled'));
    }

    setTargetIndex(index) {
        this.$targetIndex.textContent = index;
    }

    _onClick(e) {
        if (e.target.localName !== 'button') return;
        this._onButtonPressed(e.target);
    }

    _onButtonPressed($button) {
        this.$buttons.forEach(button => button.setAttribute('disabled', 'disabled'));

        if ($button.textContent !== this._targetWord) {
            // wrong choice
            this._showAsWrong($button);
            const correctButtonIndex = this._wordlist.indexOf(this._targetWord);
            this._showAsCorrect(this.$buttons[correctButtonIndex]);
            setTimeout(() => this._reset(), 820);
        } else {
            // correct choice
            this._showAsCorrect($button);
            setTimeout(() => this._next(), 500);
        }
    }

    _showAsWrong($el) {
        $el.classList.add('wrong');
        this.animate('shake', $el);
    }

    _showAsCorrect($el) {
        $el.classList.add('correct');
    }
}

class XValidateWordsConnected extends MixinRedux(XValidateWords) {

    static mapStateToProps(state) {
        return {
            privateKey: state.request.data.privateKey
        };
    }

    _onPropertiesChanged(changes) {
        const { privateKey } = changes;

        if (privateKey) {
            this.privateKey = privateKey;
        }
    }
}

if (Config.network !== 'main') {
    window.pass = () => {
        const $validateWords = document.body.querySelector('x-validate-words-connected').xDebug;
        $validateWords.fire('x-validate-words');
    };
}

class XIdenticons extends MixinRedux(XElement) {

    html() {
        return `
            <h1>Choose Your Account Avatar</h1>
            <h2>The Avatar will be 'unique' to this Account. You can not change it later.</h2>
            <x-grow></x-grow>
            <x-container>
                <div class="center" id="loading">
                    <x-loading-animation></x-loading-animation>
                    <h2>Mixing colors</h2>
                </div>
            </x-container>
            <x-grow></x-grow>
            <a secondary class="generate-more">Generate New</a>
            <x-grow></x-grow>

            <x-backdrop class="center">
                <a button>Confirm</a>
                <a secondary>Back</a>
            </x-backdrop>
            `;
    }

    onCreate() {
        this.$container = this.$('x-container');
        this.$loading = this.$('#loading');
        this.$confirmButton = this.$('x-backdrop [button]');
        super.onCreate();
    }

    listeners() {
        return {
            'click .generate-more': e => this._generateIdenticons(),
            'click x-backdrop': e => this._clearSelection()
        };
    }

    static mapStateToProps(state) {
        return {
            // volatileKeys is a map whose keys are addresses ;)
            addresses: [...state.keys.volatileKeys.keys()],
            requestType: state.request.requestType
        };
    }

    static get actions() {
        return { createVolatile, clearVolatile, setData };
    }

    _onPropertiesChanged(changes) {
        const { requestType } = this.properties;

        if (requestType !== RequestTypes.CREATE_SAFE && requestType !== RequestTypes.CREATE_WALLET) return;

        const { addresses } = changes;

        if (!addresses) return;

        this.$container.textContent = '';
        this.$el.removeAttribute('active');

        for (const address of this.properties.addresses) {
            const $identicon = XIdenticon.createElement();
            this.$container.appendChild($identicon.$el);
            $identicon.address = address;
            const $address = XAddressNoCopy.createElement();
            $address.address = address;
            $identicon.$el.appendChild($address.$el);
            $identicon.addEventListener('click', e => this._onIdenticonSelected($identicon));
        }

        setTimeout(() => this.$el.setAttribute('active', true), 100);
    }

    onEntry() {
        setTimeout(() => this._generateIdenticons(), 100);
    }

    onExit(){
        this.$container.textContent = '';
    }

    async _generateIdenticons() {
        this.actions.clearVolatile(this.properties.requestType);
        this.actions.createVolatile(this.properties.requestType, 7);
    }

    _onIdenticonSelected($identicon) {
        this.$('x-identicon.returning') && this.$('x-identicon.returning').classList.remove('returning');
        this.$confirmButton.onclick = () => this.fire('x-choose-identicon', $identicon.address);
        this._selectedIdenticon = $identicon;
        this.$el.setAttribute('selected', true);
        $identicon.$el.setAttribute('selected', true);
    }

    _clearSelection() {
        this._selectedKeyPair = null;
        if (!this._selectedIdenticon) return;
        this._selectedIdenticon.$el.classList.add('returning');
        this.$el.removeAttribute('selected');
        this._selectedIdenticon.$el.removeAttribute('selected');
    }
}

// Todo: [low priority] remove hack for overlay and find a general solution

function createPersistent() {
    return async (dispatch, getState) => {
        dispatch( setExecuting(RequestTypes.CREATE_SAFE) );

        const state = getState();
        const { address, label, passphrase } = state.request.data;
        const key = state.keys.volatileKeys.get(address);

        key.type = KeyType.HIGH;
        key.label = label;

        if (await keyStore.put(key, passphrase)) {
            dispatch(
                setResult(RequestTypes.CREATE_SAFE, Object.assign({}, key.getPublicInfo()))
            );
        } else {
            dispatch(
                setError(RequestTypes.CREATE_SAFE, 'Key could not be persisted')
            );
        }
    }
}

class XCreateSafe extends MixinRedux(XElement) {

    html() { return `
          <x-identicons x-route=""></x-identicons>
          <section x-route="warning">
            <h1>Backup your Account</h1>
            <x-grow></x-grow>
            <x-privacy-agent></x-privacy-agent>
          </section>
          <x-show-words x-route="words"></x-show-words>
          <x-validate-words-connected x-route="validate-words"></x-validate-words-connected>
          <x-set-passphrase x-route="set-passphrase"></x-set-passphrase>
          <x-set-label x-route="set-label"></x-set-label>
        `;
    }

    children() {
        return [
            XSetPassphrase,
            XSetLabel,
            XIdenticons,
            XPrivacyAgent,
            XShowWords,
            XValidateWordsConnected,
        ];
    }

    static mapStateToProps(state) {
        if (state.request.requestType !== RequestTypes.CREATE_SAFE) return;

        return {
            volatileKeys: state.keys.volatileKeys,
            volatileKey: state.request.data.volatileKey
        }
    }

    static get actions() {
        return { setData, createPersistent };
    }

    async onCreate() {
        super.onCreate();
        this._router = await XRouter$1.instance;
    }

    listeners() {
        return {
            'x-choose-identicon': this._onChooseIdenticon.bind(this),
            'x-surrounding-checked': this._onSurroundingChecked.bind(this),
            'x-show-words': this._onWordsSeen.bind(this),
            'x-validate-words-back': _ => this._router.goTo(this, 'words'),
            'x-validate-words': this._onWordsValidated.bind(this),
            'x-set-passphrase': this._onSetPassphrase.bind(this),
            'x-set-label': this._onSetLabel.bind(this)
        }
    }

    _onChooseIdenticon(address) {
        const volatileKey = this.properties.volatileKeys.get(address);
        this.actions.setData(RequestTypes.CREATE_SAFE, { address, volatileKey } );
        this._router.goTo(this, 'warning');
    }

    _onSurroundingChecked() {
        this.actions.setData(RequestTypes.CREATE_SAFE, {
            privateKey: this.properties.volatileKey.keyPair.privateKey.toHex()
        });
        this._router.goTo(this, 'words');
    }

    _onWordsSeen() {
        this._router.goTo(this, 'validate-words');
    }

    async _onWordsValidated() {
        this._router.goTo(this, 'set-passphrase');
    }

    _onSetPassphrase(passphrase) {
        this.actions.setData(RequestTypes.CREATE_SAFE, { passphrase });
        this._router.goTo(this, 'set-label');
    }

    _onSetLabel(label) {
        this.actions.setData(RequestTypes.CREATE_SAFE, { label });
        this.actions.createPersistent();
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

class XPinpad extends XElement {
    styles() { return ['center'] }

    html() {
        return `
            <x-pin>
                <x-dot></x-dot>
                <x-dot></x-dot>
                <x-dot></x-dot>
                <x-dot></x-dot>
                <x-dot></x-dot>
                <x-dot></x-dot>
            </x-pin>
            <x-pinpad-container>
                <button>1</button>
                <button>2</button>
                <button>3</button>
                <button>4</button>
                <button>5</button>
                <button>6</button>
                <button>7</button>
                <button>8</button>
                <button>9</button>
                <button>0</button>
                <x-delete></x-delete>
            </x-pinpad-container>`
    }

    onCreate() {
        this.$pin = this.$('x-pin');
        this.$dots = this.$pin.querySelectorAll('x-dot');
        this.addEventListener('click', e => this._onClick(e));
        this.$('x-delete').addEventListener('click', e => this._onDelete());
        this._attempts = 0;
        this._waitingTime = 50;
        this._handleKeyboardInput = this.__handleKeyboardInput.bind(this);
    }

    reset() {
        this._pin = '';
        this._setMaskedPin();
        this.$el.classList.remove('unlocking');
        this.$el.classList.remove('shake-pinpad');
        this._unlocking = false;
    }

    open() {
        this.reset();
        KeyboardHandler.setGlobalListener(this._handleKeyboardInput);
    }

    close() {
        KeyboardHandler.removeGlobalListener();
        this.reset();
    }

    get unlocking() {
        return this._unlocking;
    }

    __handleKeyboardInput (e) {
        const inputCharString = e.key;
        const inputNumber = parseInt(inputCharString);
        if(isNaN(inputNumber)){
            e.preventDefault(); //stop character from entering input
        }
        else {
          this._onKeyPressed(inputNumber); 
        }
    }

    _onClick(e) {
        if (e.target.localName !== 'button') return;
        const key = e.target.textContent;
        this._onKeyPressed(key);
    }

    _onKeyPressed(key) {
        if (this._unlocking) return;
        this._pin += key;
        this._setMaskedPin();
        if (this._pin.length === 6) this._submit();
    }

    _submit() {
        this._unlocking = true;
        this.$el.classList.add('unlocking');
        this.fire('x-pin', this._pin);
    }

    onPinIncorrect() {
        this.$el.classList.remove('unlocking');
        this.$el.classList.add('shake-pinpad');
        this._attempts++;
        if (this._attempts === 3) {
          this._waitingTime *= this._waitingTime;
          this._attempts = 0;
        }
        setTimeout(() => this.reset(), this._waitingTime);
    }

    _onDelete() {
        if (this._unlocking) return;
        this._pin = this._pin.substr(0, this._pin.length - 1);
        this._setMaskedPin();
    }

    _setMaskedPin() {
        const length = this._pin.length;
        this.$dots.forEach((e, i) => {
            if (i < length) {
                e.setAttribute('on', 1);
            } else {
                e.removeAttribute('on');
            }
        });
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

class XSetPin extends XElement {

    html() { return `
        <h1>Choose your pin</h1>
        <h2>Please enter an account control PIN</h2>
        <div class="spacing-bottom center">
            <span>
                Careful, this PIN is <strong>not recoverable!</strong> If you lose it, you lose access to your funds.     
            </span>
        </div>
        <x-grow></x-grow>
        <x-pinpad></x-pinpad>
        <x-grow></x-grow>
        `;
    }

    children() { return [ XPinpad ]; }

    listeners() {
        return {
            'x-pin': this._onEnterPin.bind(this)
        }
    }

    onEntry() {
        this._pin = null;
        this.$pinpad.open();
    }

    onBeforeExit() {
        this.$pinpad.close();
    }

    async _onEnterPin(pin) {
        if (!this._pin) {
            this._pin = pin;
            this.$pinpad.reset();
            XToast.show('Please repeat PIN to confirm');
        } else if (this._pin !== pin) {
            this.$pinpad.onPinIncorrect();
            this._pin = null;
            XToast.show('PIN not matching. Please try again.', 'error');
        } else {
            this.fire('x-set-pin', pin);
        }
    }
}

function createWalletPersistent() {
    return async (dispatch, getState) => {
        dispatch( setExecuting(RequestTypes.CREATE_WALLET) );

        const state = getState();
        const { address, label, pin } = state.request.data;
        const key = state.keys.volatileKeys.get(address);

        key.type = KeyType.LOW;
        key.label = label;

        if (await keyStore.put(key, pin)) {
            dispatch(
                setResult(RequestTypes.CREATE_WALLET, Object.assign({}, key.getPublicInfo()))
            );
        } else {
            dispatch(
                setError(RequestTypes.CREATE_WALLET, 'Key could not be persisted')
            );
        }
    }
}

class XCreateWallet extends MixinRedux(XElement) {

    html() { return `
          <x-identicons x-route=""></x-identicons>
          <x-set-pin x-route="set-pin"></x-set-pin>
          <section x-route="download">
            <x-download-file></x-download-file>
          </section>
        `;
    }

    children() {
        return [
            XSetPin,
            XIdenticons,
        ];
    }

    static mapStateToProps(state) {
        if (state.request.requestType !== RequestTypes.CREATE_WALLET) return;

        const { address } = state.request.data;

        return {
            volatileKey: address && state.keys.volatileKeys.get(address)
        }
    }

    static get actions() {
        return { setData, createWalletPersistent };
    }

    async onCreate() {
        super.onCreate();
        this._router = await XRouter$1.instance;
    }

    listeners() {
        return {
            'x-choose-identicon': this._onChooseIdenticon.bind(this),
            'x-set-pin': this._onSetPin.bind(this)
        }
    }

    _onChooseIdenticon(address) {
        this.actions.setData(RequestTypes.CREATE_WALLET, { address } );
        this.actions.setData(RequestTypes.CREATE_WALLET, { label: 'Miner Account' });
        this._router.goTo(this, 'set-pin');
    }

    async _onSetPin(pin) {
        this.actions.setData(RequestTypes.CREATE_WALLET, { pin });
        this.actions.createWalletPersistent();
    }
}

// JavaScript autoComplete v1.0.4
// https://github.com/Pixabay/JavaScript-autoComplete
var AutoComplete=function(){function e(e){function t(e,t){return e.classList?e.classList.contains(t):new RegExp("\\b"+t+"\\b").test(e.className)}function o(e,t,o){e.attachEvent?e.attachEvent("on"+t,o):e.addEventListener(t,o);}function s(e,t,o){e.detachEvent?e.detachEvent("on"+t,o):e.removeEventListener(t,o);}function n(e,s,n,l){o(l||document,s,function(o){for(var s,l=o.target||o.srcElement;l&&!(s=t(l,e));)l=l.parentElement;s&&n.call(l,o);});}if(document.querySelector){var l={selector:0,source:0,minChars:3,delay:150,offsetLeft:0,offsetTop:1,cache:1,menuClass:"",renderItem:function(e,t){t=t.replace(/[-\/\\^$*+?.()|[\]{}]/g,"\\$&");var o=new RegExp("("+t.split(" ").join("|")+")","gi");return'<div class="autocomplete-suggestion" data-val="'+e+'">'+e.replace(o,"<b>$1</b>")+"</div>"},onSelect:function(){}};for(var c in e)e.hasOwnProperty(c)&&(l[c]=e[c]);for(var a="object"==typeof l.selector?[l.selector]:document.querySelectorAll(l.selector),u=0;u<a.length;u++){var i=a[u];i.sc=document.createElement("div"), i.sc.className="autocomplete-suggestions "+l.menuClass, i.autocompleteAttr=i.getAttribute("autocomplete"), i.setAttribute("autocomplete","off"), i.cache={}, i.last_val="", i.updateSC=function(e,t){var o=i.getBoundingClientRect();if(i.sc.style.left=Math.round(o.left+(window.pageXOffset||document.documentElement.scrollLeft)+l.offsetLeft)+"px",i.sc.style.top=Math.round(o.bottom+(window.pageYOffset||document.documentElement.scrollTop)+l.offsetTop)+"px",i.sc.style.width=Math.round(o.right-o.left)+"px",!e&&(i.sc.style.display="block",i.sc.maxHeight||(i.sc.maxHeight=parseInt((window.getComputedStyle?getComputedStyle(i.sc,null):i.sc.currentStyle).maxHeight)),i.sc.suggestionHeight||(i.sc.suggestionHeight=i.sc.querySelector(".autocomplete-suggestion").offsetHeight),i.sc.suggestionHeight))if(t){var s=i.sc.scrollTop,n=t.getBoundingClientRect().top-i.sc.getBoundingClientRect().top;n+i.sc.suggestionHeight-i.sc.maxHeight>0?i.sc.scrollTop=n+i.sc.suggestionHeight+s-i.sc.maxHeight:0>n&&(i.sc.scrollTop=n+s)}else i.sc.scrollTop=0}, o(window,"resize",i.updateSC), document.body.appendChild(i.sc), n("autocomplete-suggestion","mouseleave",function(){var e=i.sc.querySelector(".autocomplete-suggestion.selected");e&&setTimeout(function(){e.className=e.className.replace("selected","")},20)},i.sc), n("autocomplete-suggestion","mouseover",function(){var e=i.sc.querySelector(".autocomplete-suggestion.selected");e&&(e.className=e.className.replace("selected","")),this.className+=" selected"},i.sc), n("autocomplete-suggestion","mousedown",function(e){if(t(this,"autocomplete-suggestion")){var o=this.getAttribute("data-val");i.value=o,l.onSelect(e,o,this),i.sc.style.display="none"}},i.sc), i.blurHandler=function(){try{var e=document.querySelector(".autocomplete-suggestions:hover")}catch(t){var e=0}e?i!==document.activeElement&&setTimeout(function(){i.focus()},20):(i.last_val=i.value,i.sc.style.display="none",setTimeout(function(){i.sc.style.display="none"},350))}, o(i,"blur",i.blurHandler);var r=function(e){var t=i.value;if(i.cache[t]=e, e.length&&t.length>=l.minChars){for(var o="",s=0;s<e.length;s++)o+=l.renderItem(e[s],t);i.sc.innerHTML=o, i.updateSC(0);}else i.sc.style.display="none";};i.keydownHandler=function(e){var t=window.event?e.keyCode:e.which;if((40==t||38==t)&&i.sc.innerHTML){var o,s=i.sc.querySelector(".autocomplete-suggestion.selected");return s?(o=40==t?s.nextSibling:s.previousSibling,o?(s.className=s.className.replace("selected",""),o.className+=" selected",i.value=o.getAttribute("data-val")):(s.className=s.className.replace("selected",""),i.value=i.last_val,o=0)):(o=40==t?i.sc.querySelector(".autocomplete-suggestion"):i.sc.childNodes[i.sc.childNodes.length-1],o.className+=" selected",i.value=o.getAttribute("data-val")),i.updateSC(0,o),!1}if(27==t)i.value=i.last_val,i.sc.style.display="none";else if(13==t||9==t){var s=i.sc.querySelector(".autocomplete-suggestion.selected");s&&"none"!=i.sc.style.display&&(l.onSelect(e,s.getAttribute("data-val"),s),setTimeout(function(){i.sc.style.display="none"},20))}}, o(i,"keydown",i.keydownHandler), i.keyupHandler=function(e){var t=window.event?e.keyCode:e.which;if(!t||(35>t||t>40)&&13!=t&&27!=t){var o=i.value;if(o.length>=l.minChars){if(o!=i.last_val){if(i.last_val=o,clearTimeout(i.timer),l.cache){if(o in i.cache)return void r(i.cache[o]);for(var s=1;s<o.length-l.minChars;s++){var n=o.slice(0,o.length-s);if(n in i.cache&&!i.cache[n].length)return void r([])}}i.timer=setTimeout(function(){l.source(o,r)},l.delay)}}else i.last_val=o,i.sc.style.display="none"}}, o(i,"keyup",i.keyupHandler), i.focusHandler=function(e){i.last_val="\n",i.keyupHandler(e)}, l.minChars||o(i,"focus",i.focusHandler);}this.destroy=function(){for(var e=0;e<a.length;e++){var t=a[e];s(window,"resize",t.updateSC), s(t,"blur",t.blurHandler), s(t,"focus",t.focusHandler), s(t,"keydown",t.keydownHandler), s(t,"keyup",t.keyupHandler), t.autocompleteAttr?t.setAttribute("autocomplete",t.autocompleteAttr):t.removeAttribute("autocomplete"), document.body.removeChild(t.sc), t=null;}};}}return e}();

class XMnemonicInputField extends XElement {

    html() {
        return `<input type="text" autocorrect="off" autocapitalize="none" spellcheck="false">`;
    }

    onCreate() {
        this.$input = this.$('input');
    }

    styles() { return ['x-input'] }

    setupAutocomplete() {
        this.autocomplete = new AutoComplete({
            selector: this.$input,
            source: (term, response) => {
                term = term.toLowerCase();
                const list = MnemonicPhrase.DEFAULT_WORDLIST.filter(word => {
                    return word.slice(0, term.length) === term;
                });
                response(list);
            },
            onSelect: () => {
                const index = parseInt(this.attributes.dataXId);
                this.fire('x-set-focus-to-next-input', index + 1);
            },
            minChars: 3,
            delay: 0
        });
    }

    focus() {
        requestAnimationFrame(_ => this.$input.focus());
    }

    set value(value) {
        this.$input.value = value;
        this._checkValidity();
    }

    get value() {
        return this.$input.value;
    }

    listeners() {
        return {
            'keydown input': this._onKeydown.bind(this),
            'blur input': this._onBlur.bind(this)
        }
    }

    _onBlur(_, e) {
        this._checkValidity();
    }

    _onKeydown(_, e) {
        this._onValueChanged();

        if (e.keyCode === 32 /* space */ ) e.preventDefault();

        const triggerKeyCodes = [32 /* space */, 13 /* enter */];
        if (triggerKeyCodes.includes(e.keyCode)) {
            this._checkValidity(true);
        }
    }

    _checkValidity(setFocusToNextInput) {
        if (MnemonicPhrase.DEFAULT_WORDLIST.includes(this.value.toLowerCase())) {
            this.$el.classList.add('complete');
            this.complete = true;
            this.fire(this.__tagName + '-valid', this.value);

            if (setFocusToNextInput) {
                const index = parseInt(this.attributes.dataXId);
                this.fire('x-set-focus-to-next-input', index + 1);
            }
        } else {
            this._onInvalid();
        }
    }

    async _onInvalid() {
        // todo await animation before setting empty value and coordinate this with XMnemonicInput._showPlaceholder
        this.$input.value = '';
        await this.animate('shake');
    }

    _onValueChanged() {
        if (this._value === this.value) return;

        if (this.value.length > 2) {
             this.$input.setAttribute('list', 'x-mnemonic-wordlist');
        } else {
             this.$input.removeAttribute('list');
        }

        this.complete = false;
        this.$el.classList.remove('complete');
        this._value = this.value;
    }
}

class XMnemonicInput extends XElement {
    html() {
        return `
            <form autocomplete="off"></form>
            <x-mnemonic-input-success></x-mnemonic-input-success>`;
    }

    styles() {
        return ['x-recovery-phrase']
    }

    focus() {
        this.$fields[0].$input.focus();
    }

    onCreate() {
        this.$fields = [];
        this.$form = this.$('form');

        for (let i = 0; i < 24; i++) {
            this._createField(i);
        }

        this._datalistSupport = false; // this._hasDatalistSupport();

        if (this._datalistSupport) {
            this._createDatalist();
        } else {
            this.$fields.forEach(field => field.setupAutocomplete());
        }

        this._mnemonic = '';
        setTimeout(() => this.$('input').focus(), 100);
    }

    listeners() {
        return {
            'x-mnemonic-input-field-valid': this._onFieldComplete.bind(this),
            'x-set-focus-to-next-input': this._setFocusToNextInput.bind(this)
        }
    }

    _createField(index) {
        const field = XMnemonicInputField.createElement();
        field.$input.placeholder = 'word #' + (index + 1);
        field.$el.setAttribute('data-x-id', index);

        field.addEventListener('click', this._showInput.bind(this));
        field.addEventListener('mouseenter', this._showInput.bind(this));
        field.addEventListener('mouseleave', this._showPlaceholder.bind(this));
        field.addEventListener('paste', this._pasteInput.bind(this));

        this.$form.appendChild(field.$el);
        this.$fields.push(field);
    }

    _hasDatalistSupport() {
        return !!('list' in document.createElement('input'))
            && !!(document.createElement('datalist') && window.HTMLDataListElement);
    }

    _createDatalist() {
        const datalist = document.createElement('datalist');
        datalist.setAttribute('id', 'x-mnemonic-wordlist');
        MnemonicPhrase.DEFAULT_WORDLIST.forEach(word => {
            const option = document.createElement('option');
            option.textContent = word;
            datalist.appendChild(option);
        });
        this.$el.appendChild(datalist);
    }

    _onFieldComplete(value, e) {
        if (!value) return;

        this._showPlaceholder(e);

        this._checkPhraseComplete();
    }

    _checkPhraseComplete() {
        const check = this.$fields.find(field => !field.complete);
        if (typeof check !== 'undefined') return;

        const mnemonic = this.$fields.map(field => field.$input.value).join(' ');
        try {
            const privateKey = MnemonicPhrase.mnemonicToKey(mnemonic);
            this.fire(this.__tagName, privateKey);
        } catch (e) {
            console.log(e.message);
            this._animateError();
        }
    }

    _setFocusToNextInput(index) {
        if (index < this.$fields.length) {
            this.$fields[index].focus();
        }
    }

    _animateError() {
        this.animate('shake');
    }

    _showPlaceholder({ target }) {
        if (target.classList.contains('has-placeholder')) return;

        // don't hide empty input fields
        const $input = XElement.get(target).$input;
        if ($input.value === '') return;

        // don't hide focused input fields
        if (document.activeElement === $input) return;

        target.classList.add('has-placeholder');

        const $placeholder = document.createElement('div');
        $placeholder.className = 'placeholder';
        const id = parseInt(target.getAttribute('data-x-id'));
        $placeholder.textContent = (id + 1).toString();

        target.replaceChild($placeholder, target.childNodes[0]);

        this._revealedWord = undefined;
    }

    _showInput({ target }) {
        if (this._revealedWord === target || !target.classList.contains('has-placeholder')) return;

        const $input = XElement.get(target).$input;

        target.replaceChild($input, target.childNodes[0]);

        // hide word which was revealed before
        if (this._revealedWord !== undefined) {
            this._showPlaceholder({ target: this._revealedWord });
        }

        this._revealedWord = target;

        target.classList.remove('has-placeholder');
    }

    _pasteInput(e) {
        var clipboardData, pastedData;

        // Stop data actually being pasted into div
        e.stopPropagation();
        e.preventDefault();
    
        // Get pasted data via clipboard API
        clipboardData = e.clipboardData || window.clipboardData;
        pastedData = clipboardData.getData('Text');
    
        var words = pastedData.split(/[\s,]+/);

        var start = this.$fields.findIndex(field => field.$input == e.target);
        var end = start + Math.min(words.length, this.$fields.length - start);

        for (var i = start; i < end; i++) {
            var field = this.$fields[i];
            field.value = words[i - start];
        }
    }
}

window.test = async () => {
    const randomKey = window.crypto.getRandomValues(new Uint8Array(32));
    const hexKey = MnemonicPhrase._arrayToHex(randomKey);
    const testPassphrase = MnemonicPhrase.keyToMnemonic(hexKey).split(' ');
    function putWord(field, word, index) {
        setTimeout(() => {
            field.$input.value = word;
            field._value = word;
            field._onBlur();
        }, index * 50);
    }
    const $mnemonicInput = document.body.querySelector('x-mnemonic-input').xDebug;
    $mnemonicInput.$fields.forEach((field, index) => {
        putWord(field, testPassphrase[index], index);
    });
};

class XEnterWords extends MixinRedux(XElement) {

    html() { return `
        <h1>Account Recovery</h1>
        <h2>Please enter your 24 Account Recovery Words.</h2>
        <x-grow></x-grow>
        <x-mnemonic-input class="x-recovery-phrase"></x-mnemonic-input>
        <p class="pad-bottom">
            Press <code>Space</code> or <code>Tab</code> at the end of a word to jump to the next field.
        </p>
        <x-grow x-grow="2"></x-grow>
        `;
    }

    children() {
        return [ XMnemonicInput ];
    }

    static get actions() {
        return { deny, setData };
    }

    listeners() {
        return {
            'x-mnemonic-input': this._onSuccess.bind(this)
        }
    }

    _onSuccess(hexKey) {
        this.actions.setData(RequestTypes.IMPORT_FROM_WORDS, { hexKey });
        this.fire('x-enter-words');
    }
}

function createKey() {
    return async (dispatch, getState) => {
        dispatch(setExecuting(RequestTypes.IMPORT_FROM_WORDS));

        try {
            const hexKey = getState().request.data.hexKey;

            const serializedKey = new Nimiq.SerialBuffer(Nimiq.BufferUtils.fromHex(hexKey));

            const privateKey = Nimiq.PrivateKey.unserialize(serializedKey);

            const keyPair = Nimiq.KeyPair.derive(privateKey);

            const key = await Key.loadPlain(keyPair.serialize());

            dispatch(
                setData(RequestTypes.IMPORT_FROM_WORDS, Object.assign({}, key.getPublicInfo(), { key }))
            );

            (await XRouter$1.instance).goTo('import-from-words/set-passphrase');

        } catch (e) {
            console.error(e);
            dispatch(
                setError(RequestTypes.IMPORT_FROM_WORDS, e)
            );
        }
    }
}

function importFromWords() {
    return async (dispatch, getState) => {
        dispatch(setExecuting(RequestTypes.IMPORT_FROM_WORDS));

        try {
            const { key, passphrase, label } = getState().request.data;

            key.type = KeyType.HIGH;
            key.label = label;

            // actual import
            await keyStore.put(key, passphrase);

            dispatch(
                setResult(RequestTypes.IMPORT_FROM_WORDS, key.getPublicInfo())
            );
        } catch (e) {
            console.error(e);
            dispatch(
                setError(RequestTypes.IMPORT_FROM_WORDS, e)
            );
        }
    }
}

class XImportWords extends MixinRedux(XElement) {

    html() {
        return `
            <section x-route="">
                <h1>Account Recovery</h1>
                <x-grow></x-grow>
                <x-privacy-agent></x-privacy-agent>
            </section>
            <x-enter-words x-route="enter-words"></x-enter-words>
            <x-set-passphrase x-route="set-passphrase"></x-set-passphrase>
            <x-set-label x-route="set-label"></x-set-label>
        `;
    }

    children() {
        return [ XPrivacyAgent, XSetLabel, XEnterWords, XSetPassphrase ];
    }

    static get actions() {
        return { setData, createKey, importFromWords };
    }

    listeners() {
        return {
            'x-surrounding-checked': async () => (await XRouter$1.instance).goTo(this, 'enter-words'),
            'x-enter-words': this._onEnterWords.bind(this),
            'x-set-passphrase': this._onSetPassphrase.bind(this),
            'x-set-label': this._onSetLabel.bind(this)
        }
    }

    _onEnterWords() {
        this.actions.createKey();
    }

    async _onSetPassphrase(passphrase) {
        this.actions.setData(RequestTypes.IMPORT_FROM_WORDS, { passphrase });
        (await XRouter$1.instance).goTo(this, 'set-label');
    }

    _onSetLabel(label) {
        this.actions.setData(RequestTypes.IMPORT_FROM_WORDS, { label });
        this.actions.importFromWords();
    }
}

class XAuthenticate extends MixinRedux(XPassphraseGetter) {

    styles() {
        return [ 'x-passphrase-input' ];
    }

    static mapStateToProps(state) {
        return {
            isWrongPassphrase: state.request.data.isWrongPassphrase,
            requestType: state.request.requestType
        };
    }

    static get actions() {
        return { setData }
    }

    _onPropertiesChanged(changes) {
        if (changes.isWrongPassphrase) {
            this.wrongPassphrase();
            XToast.error('Incorrect passphrase');
            this.actions.setData(this.properties.requestType, { isWrongPassphrase: false });
        }
    }
}

class XDecryptSafe extends MixinRedux(XElement) {

    html() { return `
        <h1>Enter your Passphrase</h1>
        <h2>Please enter your passphrase to unlock your Account Access File.</h2>
        <x-grow></x-grow>
        <x-authenticate button-label="Import"></x-authenticate>
        `;
    }

    children() {
        return [ XAuthenticate ];
    }

    static mapStateToProps(state) {
        return {
            keyType: state.request.data.type
        }
    }

    listeners() {
        return {
            'x-authenticate-submitted': this._onSubmit.bind(this)
        };
    }

    onEntry() {
        if (this.properties.keyType !== KeyType.HIGH) {
            throw new Error('Key type does not match');
        }
    }

    static get actions() {
        return { setData };
    }

    _onSubmit(passphrase) {
        this.actions.setData(RequestTypes.IMPORT_FROM_FILE, { passphrase });
        this.fire('x-decrypt');
    }
}

class XAuthenticatePin extends MixinRedux(XElement) {

    html() {
        return `
            <x-pinpad></x-pinpad>
        `
    }

    children() { return [ XPinpad ] }

    static mapStateToProps(state) {
        return {
            isWrongPin: state.request.data.isWrongPin,
            requestType: state.request.requestType
        };
    }

    static get actions() {
        return { setData }
    }

    _onPropertiesChanged(changes) {
        if (changes.isWrongPin) {
            this.$pinpad.onPinIncorrect();
            XToast.error('Incorrect PIN');
            this.actions.setData(this.properties.requestType, { isWrongPin: false });
        }
    }

    listeners() {
        return {
            'x-pin': (pin) => this.fire('x-authenticate-pin-submitted', pin)
        }
    }
}

class XDecryptWallet extends MixinRedux(XElement) {

    html() { return `
        <h1>Enter your PIN</h1>
        <h2>Please enter your PIN to unlock your Account Access File.</h2>
        <x-grow></x-grow>
        <x-authenticate-pin button-label="Import"></x-authenticate-pin>
        <x-grow></x-grow>
        `;
    }

    children() {
        return [ XAuthenticatePin ];
    }

    static mapStateToProps(state) {
        return {
            keyType: state.request.data.type
        }
    }

    listeners() {
        return {
            'x-authenticate-pin-submitted': this._onSubmit.bind(this)
        };
    }

    onEntry() {
        if (this.properties.keyType !== KeyType.LOW) {
            throw new Error('Key type does not match');
        }

        this.$authenticatePin.$pinpad.open();
    }

    onBeforeExit() {
        this.$authenticatePin.$pinpad.close();
    }

    static get actions() {
        return { setData };
    }

    _onSubmit(pin) {
        this.actions.setData(RequestTypes.IMPORT_FROM_FILE, { pin });
        this.fire('x-decrypt');
    }
}

function decrypt() {
    return async (dispatch, getState) => {
        dispatch( setExecuting(RequestTypes.IMPORT_FROM_FILE) );

        const { encryptedKeyPair64, passphrase } = getState().request.data;

        try {
            const encryptedKeyPair = Nimiq.BufferUtils.fromBase64(encryptedKeyPair64);

            // test if we can decrypt
            const key = await Key.loadEncrypted(encryptedKeyPair, passphrase);

            dispatch(
                setData(RequestTypes.IMPORT_FROM_FILE, Object.assign({}, key.getPublicInfo()) )
            );

            (await XRouter$1.instance).goTo('import-from-file/set-label');

        } catch (e) {
            console.error(e);
            // assume the password was wrong
            dispatch(
                setData(RequestTypes.IMPORT_FROM_FILE, { isWrongPassphrase: true })
            );
        }
    }
}


function importFromFile() {
    return async (dispatch, getState) => {
        dispatch( setExecuting(RequestTypes.IMPORT_FROM_FILE) );

        const { encryptedKeyPair64, passphrase, label } = getState().request.data;

        try {
            const encryptedKeyPair = Nimiq.BufferUtils.fromBase64(encryptedKeyPair64);

            const key = await Key.loadEncrypted(encryptedKeyPair, passphrase);

            key.type = KeyType.HIGH;
            key.label = label;

            // actual import
            const keyInfo = {
                encryptedKeyPair: encryptedKeyPair,
                userFriendlyAddress: key.userFriendlyAddress,
                type: key.type,
                label: key.label
            };

            await keyStore.putPlain(keyInfo);

            dispatch(
                setResult(RequestTypes.IMPORT_FROM_FILE, key.getPublicInfo())
            );
        } catch (e) {
            console.error(e);
            dispatch(
                setError(RequestTypes.IMPORT_FROM_FILE, e)
            );
        }
    }
}

function decrypt$1() {
    return async (dispatch, getState) => {
        dispatch( setExecuting(RequestTypes.IMPORT_FROM_FILE) );

        const { encryptedKeyPair64, pin } = getState().request.data;

        try {
            const encryptedKeyPair = Nimiq.BufferUtils.fromBase64(encryptedKeyPair64);

            // test if we can decrypt
            const key = await Key.loadEncrypted(encryptedKeyPair, pin);

            dispatch(
                setData(RequestTypes.IMPORT_FROM_FILE, Object.assign({}, key.getPublicInfo(), {
                    label: 'Miner Account'
                }) )
            );

            dispatch(importFromFile$1());

        } catch (e) {
            console.error(e);
            // assume the password was wrong
            dispatch(
                setData(RequestTypes.IMPORT_FROM_FILE, { isWrongPin: true })
            );
        }
    }
}


function importFromFile$1() {
    return async (dispatch, getState) => {
        dispatch( setExecuting(RequestTypes.IMPORT_FROM_FILE) );

        const { encryptedKeyPair64, pin, label } = getState().request.data;

        try {
            const encryptedKeyPair = Nimiq.BufferUtils.fromBase64(encryptedKeyPair64);

            const key = await Key.loadEncrypted(encryptedKeyPair, pin);

            key.type = KeyType.LOW;
            key.label = label;

            // actual import
            const keyInfo = {
                encryptedKeyPair: encryptedKeyPair,
                userFriendlyAddress: key.userFriendlyAddress,
                type: key.type,
                label: key.label
            };

            await keyStore.putPlain(keyInfo);

            dispatch(
                setResult(RequestTypes.IMPORT_FROM_FILE, key.getPublicInfo())
            );
        } catch (e) {
            console.error(e);
            dispatch(
                setError(RequestTypes.IMPORT_FROM_FILE, e)
            );
        }
    }
}

/*
 @asset(qr-scanner-worker.min.js) */
'use strict';class QrScanner{constructor(video,onDecode,canvasSize=QrScanner.DEFAULT_CANVAS_SIZE){this.$video=video;this.$canvas=document.createElement("canvas");this._onDecode=onDecode;this._active=false;this.$canvas.width=canvasSize;this.$canvas.height=canvasSize;this._sourceRect={x:0,y:0,width:canvasSize,height:canvasSize};this.$video.addEventListener("canplay",()=>this._updateSourceRect());this.$video.addEventListener("play",()=>{this._updateSourceRect();this._scanFrame();},false);
this._qrWorker=new Worker(QrScanner.WORKER_PATH);}_updateSourceRect(){const smallestDimension=Math.min(this.$video.videoWidth,this.$video.videoHeight);const sourceRectSize=Math.round(2/3*smallestDimension);this._sourceRect.width=this._sourceRect.height=sourceRectSize;this._sourceRect.x=(this.$video.videoWidth-sourceRectSize)/2;this._sourceRect.y=(this.$video.videoHeight-sourceRectSize)/2;}_scanFrame(){if(this.$video.paused||this.$video.ended)return false;requestAnimationFrame(()=>{QrScanner.scanImage(this.$video,
this._sourceRect,this._qrWorker,this.$canvas,true).then(this._onDecode,(error)=>{if(error!=="QR code not found.")console.error(error);}).then(()=>this._scanFrame());});}_getCameraStream(facingMode,exact=false){const constraintsToTry=[{width:{min:1024}},{width:{min:768}},{}];if(facingMode){if(exact)facingMode={exact:facingMode};constraintsToTry.forEach((constraint)=>constraint.facingMode=facingMode);}return this._getMatchingCameraStream(constraintsToTry)}_getMatchingCameraStream(constraintsToTry){if(constraintsToTry.length===
0)return Promise.reject("Camera not found.");return navigator.mediaDevices.getUserMedia({video:constraintsToTry.shift()}).catch(()=>this._getMatchingCameraStream(constraintsToTry))}start(){if(this._active)return Promise.resolve();this._active=true;clearTimeout(this._offTimeout);let facingMode="environment";return this._getCameraStream("environment",true).catch(()=>{facingMode="user";return this._getCameraStream()}).then((stream)=>{this.$video.srcObject=stream;this._setVideoMirror(facingMode);}).catch((e)=>
{this._active=false;throw e;})}stop(){if(!this._active)return;this._active=false;this.$video.pause();this._offTimeout=setTimeout(()=>{this.$video.srcObject.getTracks()[0].stop();this.$video.srcObject=null;},3E3);}_setVideoMirror(facingMode){const scaleFactor=facingMode==="user"?-1:1;this.$video.style.transform="scaleX("+scaleFactor+")";}setGrayscaleWeights(red,green,blue){this._qrWorker.postMessage({type:"grayscaleWeights",data:{red,green,blue}});}static scanImage(imageOrFileOrUrl,sourceRect=null,worker=
null,canvas=null,fixedCanvasSize=false,alsoTryWithoutSourceRect=false){const promise=new Promise((resolve,reject)=>{worker=worker||new Worker(QrScanner.WORKER_PATH);let timeout,onMessage,onError;onMessage=(event)=>{if(event.data.type!=="qrResult")return;worker.removeEventListener("message",onMessage);worker.removeEventListener("error",onError);clearTimeout(timeout);if(event.data.data!==null)resolve(event.data.data);else reject("QR code not found.");};onError=()=>{worker.removeEventListener("message",
onMessage);worker.removeEventListener("error",onError);clearTimeout(timeout);reject("Worker error.");};worker.addEventListener("message",onMessage);worker.addEventListener("error",onError);timeout=setTimeout(onError,3E3);QrScanner._loadImage(imageOrFileOrUrl).then((image)=>{const imageData=QrScanner._getImageData(image,sourceRect,canvas,fixedCanvasSize);worker.postMessage({type:"decode",data:imageData},[imageData.data.buffer]);}).catch(reject);});if(sourceRect&&alsoTryWithoutSourceRect)return promise.catch(()=>
QrScanner.scanImage(imageOrFileOrUrl,null,worker,canvas,fixedCanvasSize));else return promise}static _getImageData(image,sourceRect=null,canvas=null,fixedCanvasSize=false){canvas=canvas||document.createElement("canvas");const sourceRectX=sourceRect&&sourceRect.x?sourceRect.x:0;const sourceRectY=sourceRect&&sourceRect.y?sourceRect.y:0;const sourceRectWidth=sourceRect&&sourceRect.width?sourceRect.width:image.width||image.videoWidth;const sourceRectHeight=sourceRect&&sourceRect.height?sourceRect.height:
image.height||image.videoHeight;if(!fixedCanvasSize&&(canvas.width!==sourceRectWidth||canvas.height!==sourceRectHeight)){canvas.width=sourceRectWidth;canvas.height=sourceRectHeight;}const context=canvas.getContext("2d",{alpha:false});context.imageSmoothingEnabled=false;context.drawImage(image,sourceRectX,sourceRectY,sourceRectWidth,sourceRectHeight,0,0,canvas.width,canvas.height);return context.getImageData(0,0,canvas.width,canvas.height)}static _loadImage(imageOrFileOrUrl){if(imageOrFileOrUrl instanceof
HTMLCanvasElement||imageOrFileOrUrl instanceof HTMLVideoElement||window.ImageBitmap&&imageOrFileOrUrl instanceof window.ImageBitmap||window.OffscreenCanvas&&imageOrFileOrUrl instanceof window.OffscreenCanvas)return Promise.resolve(imageOrFileOrUrl);else if(imageOrFileOrUrl instanceof Image)return QrScanner._awaitImageLoad(imageOrFileOrUrl).then(()=>imageOrFileOrUrl);else if(imageOrFileOrUrl instanceof File||imageOrFileOrUrl instanceof URL||typeof imageOrFileOrUrl==="string"){const image=new Image;
if(imageOrFileOrUrl instanceof File)image.src=URL.createObjectURL(imageOrFileOrUrl);else image.src=imageOrFileOrUrl;return QrScanner._awaitImageLoad(image).then(()=>{if(imageOrFileOrUrl instanceof File)URL.revokeObjectURL(image.src);return image})}else return Promise.reject("Unsupported image type.")}static _awaitImageLoad(image){return new Promise((resolve,reject)=>{if(image.complete&&image.naturalWidth!==0)resolve();else{let onLoad,onError;onLoad=()=>{image.removeEventListener("load",onLoad);image.removeEventListener("error",
onError);resolve();};onError=()=>{image.removeEventListener("load",onLoad);image.removeEventListener("error",onError);reject("Image load error");};image.addEventListener("load",onLoad);image.addEventListener("error",onError);}})}}QrScanner.DEFAULT_CANVAS_SIZE=400;QrScanner.WORKER_PATH="qr-scanner-worker.min.js";

/* jquery-qrcode v0.14.0 - https://larsjung.de/jquery-qrcode/ */
var qrCodeGenerator=null;
var QrEncoder=function(){};QrEncoder.render=function(A,C){C.appendChild(qrCodeGenerator(A));};
(function(A){function C(u,k,n,f){var g={},b=A(n,k);b.addData(u);b.make();f=f||0;var a=b.getModuleCount(),h=b.getModuleCount()+2*f;g.text=u;g.level=k;g.version=n;g.moduleCount=h;g.isDark=function(h,d){h-=f;d-=f;return 0>h||h>=a||0>d||d>=a?!1:b.isDark(h,d)};return g}function D(u,k,n,f,g,b,a,h,z,d){function c(h,a,d,c,l,e,f){h?(u.lineTo(a+e,d+f), u.arcTo(a,d,c,l,b)):u.lineTo(a,d);}a?u.moveTo(k+b,n):u.moveTo(k,n);c(h,f,n,f,g,-b,0);c(z,f,g,k,g,0,-b);c(d,k,g,k,n,b,0);c(a,k,n,f,n,0,b);}function B(u,k,n,f,g,
b,a,h,z,d){function c(a,h,d,c){u.moveTo(a+d,h);u.lineTo(a,h);u.lineTo(a,h+c);u.arcTo(a,h,a+d,h,b);}a&&c(k,n,b,b);h&&c(f,n,-b,b);z&&c(f,g,-b,-b);d&&c(k,g,b,-b);}var v={minVersion:1,maxVersion:40,ecLevel:"L",left:0,top:0,size:200,fill:"#000",background:null,text:"no text",radius:.5,quiet:0};qrCodeGenerator=function(u){var k={};Object.assign(k,v,u);u=document.createElement("canvas");u.width=k.size;u.height=k.size;b:{var n=k.text,f=k.ecLevel,g=k.minVersion,b=k.maxVersion,a=k.quiet;g=Math.max(1,g||1);for(b=
Math.min(40,b||40);g<=b;g+=1)try{var h=C(n,f,g,a);break b}catch(r){}h=void 0;}if(h){n=u.getContext("2d");k.background&&(n.fillStyle=k.background, n.fillRect(k.left,k.top,k.size,k.size));f=h.moduleCount;b=k.size/f;n.beginPath();for(a=0;a<f;a+=1)for(g=0;g<f;g+=1){var z=n,d=k.left+g*b,c=k.top+a*b,t=a,x=g,m=h.isDark,w=d+b,l=c+b,e=t-1,p=t+1,G=x-1,E=x+1,H=Math.floor(Math.max(.5,k.radius)*b),q=m(t,x),I=m(e,G),y=m(e,x);e=m(e,E);var F=m(t,E);E=m(p,E);x=m(p,x);p=m(p,G);t=m(t,G);q?D(z,d,c,w,l,H,!y&&!t,!y&&!F,
!x&&!F,!x&&!t):B(z,d,c,w,l,H,y&&t&&I,y&&F&&e,x&&F&&E,x&&t&&p);}n.fillStyle=k.fill;n.fill();k=u;}else k=null;return k};})(function(){return function(){function A(f,g){if("undefined"==typeof f.length)throw Error(f.length+"/"+g);var b=function(){for(var a=0;a<f.length&&0==f[a];)a+=1;for(var b=Array(f.length-a+g),d=0;d<f.length-a;d+=1)b[d]=f[d+a];return b}(),a={getAt:function(a){return b[a]},getLength:function(){return b.length},multiply:function(h){for(var b=Array(a.getLength()+h.getLength()-1),d=0;d<a.getLength();d+=
1)for(var c=0;c<h.getLength();c+=1)b[d+c]^=v.gexp(v.glog(a.getAt(d))+v.glog(h.getAt(c)));return A(b,0)},mod:function(h){if(0>a.getLength()-h.getLength())return a;for(var b=v.glog(a.getAt(0))-v.glog(h.getAt(0)),d=Array(a.getLength()),c=0;c<a.getLength();c+=1)d[c]=a.getAt(c);for(c=0;c<h.getLength();c+=1)d[c]^=v.gexp(v.glog(h.getAt(c))+b);return A(d,0).mod(h)}};return a}var C=function(f,g){var b=D[g],a=null,h=0,z=null,d=[],c={},t=function(c,g){for(var l=h=4*f+17,e=Array(l),p=0;p<l;p+=1){e[p]=Array(l);
for(var m=0;m<l;m+=1)e[p][m]=null;}a=e;x(0,0);x(h-7,0);x(0,h-7);l=B.getPatternPosition(f);for(e=0;e<l.length;e+=1)for(p=0;p<l.length;p+=1){m=l[e];var t=l[p];if(null==a[m][t])for(var n=-2;2>=n;n+=1)for(var q=-2;2>=q;q+=1)a[m+n][t+q]=-2==n||2==n||-2==q||2==q||0==n&&0==q;}for(l=8;l<h-8;l+=1)null==a[l][6]&&(a[l][6]=0==l%2);for(l=8;l<h-8;l+=1)null==a[6][l]&&(a[6][l]=0==l%2);l=B.getBCHTypeInfo(b<<3|g);for(e=0;15>e;e+=1)p=!c&&1==(l>>e&1), a[6>e?e:8>e?e+1:h-15+e][8]=p, a[8][8>e?h-e-1:9>e?15-e:14-e]=p;a[h-8][8]=
!c;if(7<=f){l=B.getBCHTypeNumber(f);for(e=0;18>e;e+=1)p=!c&&1==(l>>e&1), a[Math.floor(e/3)][e%3+h-8-3]=p;for(e=0;18>e;e+=1)p=!c&&1==(l>>e&1), a[e%3+h-8-3][Math.floor(e/3)]=p;}if(null==z){l=u.getRSBlocks(f,b);e=k();for(p=0;p<d.length;p+=1)m=d[p], e.put(m.getMode(),4), e.put(m.getLength(),B.getLengthInBits(m.getMode(),f)), m.write(e);for(p=m=0;p<l.length;p+=1)m+=l[p].dataCount;if(e.getLengthInBits()>8*m)throw Error("code length overflow. ("+e.getLengthInBits()+">"+8*m+")");for(e.getLengthInBits()+4<=8*m&&
e.put(0,4);0!=e.getLengthInBits()%8;)e.putBit(!1);for(;!(e.getLengthInBits()>=8*m);){e.put(236,8);if(e.getLengthInBits()>=8*m)break;e.put(17,8);}var w=0;m=p=0;t=Array(l.length);n=Array(l.length);for(q=0;q<l.length;q+=1){var y=l[q].dataCount,v=l[q].totalCount-y;p=Math.max(p,y);m=Math.max(m,v);t[q]=Array(y);for(var r=0;r<t[q].length;r+=1)t[q][r]=255&e.getBuffer()[r+w];w+=y;r=B.getErrorCorrectPolynomial(v);y=A(t[q],r.getLength()-1).mod(r);n[q]=Array(r.getLength()-1);for(r=0;r<n[q].length;r+=1)v=r+y.getLength()-
n[q].length, n[q][r]=0<=v?y.getAt(v):0;}for(r=e=0;r<l.length;r+=1)e+=l[r].totalCount;e=Array(e);for(r=w=0;r<p;r+=1)for(q=0;q<l.length;q+=1)r<t[q].length&&(e[w]=t[q][r], w+=1);for(r=0;r<m;r+=1)for(q=0;q<l.length;q+=1)r<n[q].length&&(e[w]=n[q][r], w+=1);z=e;}l=z;e=-1;p=h-1;m=7;t=0;n=B.getMaskFunction(g);for(q=h-1;0<q;q-=2)for(6==q&&--q;;){for(r=0;2>r;r+=1)null==a[p][q-r]&&(w=!1, t<l.length&&(w=1==(l[t]>>>m&1)), n(p,q-r)&&(w=!w), a[p][q-r]=w, --m, -1==m&&(t+=1,m=7));p+=e;if(0>p||h<=p){p-=e;e=-e;break}}},x=function(b,
d){for(var c=-1;7>=c;c+=1)if(!(-1>=b+c||h<=b+c))for(var e=-1;7>=e;e+=1)-1>=d+e||h<=d+e||(a[b+c][d+e]=0<=c&&6>=c&&(0==e||6==e)||0<=e&&6>=e&&(0==c||6==c)||2<=c&&4>=c&&2<=e&&4>=e?!0:!1);};c.addData=function(a){a=n(a);d.push(a);z=null;};c.isDark=function(c,b){if(0>c||h<=c||0>b||h<=b)throw Error(c+","+b);return a[c][b]};c.getModuleCount=function(){return h};c.make=function(){for(var a=0,h=0,b=0;8>b;b+=1){t(!0,b);var d=B.getLostPoint(c);if(0==b||a>d)a=d, h=b;}t(!1,h);};return c};C.stringToBytes=function(f){for(var g=
[],b=0;b<f.length;b++){var a=f.charCodeAt(b);128>a?g.push(a):2048>a?g.push(192|a>>6,128|a&63):55296>a||57344<=a?g.push(224|a>>12,128|a>>6&63,128|a&63):(b++, a=65536+((a&1023)<<10|f.charCodeAt(b)&1023), g.push(240|a>>18,128|a>>12&63,128|a>>6&63,128|a&63));}return g};var D={L:1,M:0,Q:3,H:2},B=function(){var f=[[],[6,18],[6,22],[6,26],[6,30],[6,34],[6,22,38],[6,24,42],[6,26,46],[6,28,50],[6,30,54],[6,32,58],[6,34,62],[6,26,46,66],[6,26,48,70],[6,26,50,74],[6,30,54,78],[6,30,56,82],[6,30,58,86],[6,34,62,
90],[6,28,50,72,94],[6,26,50,74,98],[6,30,54,78,102],[6,28,54,80,106],[6,32,58,84,110],[6,30,58,86,114],[6,34,62,90,118],[6,26,50,74,98,122],[6,30,54,78,102,126],[6,26,52,78,104,130],[6,30,56,82,108,134],[6,34,60,86,112,138],[6,30,58,86,114,142],[6,34,62,90,118,146],[6,30,54,78,102,126,150],[6,24,50,76,102,128,154],[6,28,54,80,106,132,158],[6,32,58,84,110,136,162],[6,26,54,82,110,138,166],[6,30,58,86,114,142,170]],g={},b=function(a){for(var h=0;0!=a;)h+=1, a>>>=1;return h};g.getBCHTypeInfo=function(a){for(var h=
a<<10;0<=b(h)-b(1335);)h^=1335<<b(h)-b(1335);return(a<<10|h)^21522};g.getBCHTypeNumber=function(a){for(var h=a<<12;0<=b(h)-b(7973);)h^=7973<<b(h)-b(7973);return a<<12|h};g.getPatternPosition=function(a){return f[a-1]};g.getMaskFunction=function(a){switch(a){case 0:return function(a,b){return 0==(a+b)%2};case 1:return function(a,b){return 0==a%2};case 2:return function(a,b){return 0==b%3};case 3:return function(a,b){return 0==(a+b)%3};case 4:return function(a,b){return 0==(Math.floor(a/2)+Math.floor(b/
3))%2};case 5:return function(a,b){return 0==a*b%2+a*b%3};case 6:return function(a,b){return 0==(a*b%2+a*b%3)%2};case 7:return function(a,b){return 0==(a*b%3+(a+b)%2)%2};default:throw Error("bad maskPattern:"+a);}};g.getErrorCorrectPolynomial=function(a){for(var b=A([1],0),f=0;f<a;f+=1)b=b.multiply(A([1,v.gexp(f)],0));return b};g.getLengthInBits=function(a,b){if(4!=a||1>b||40<b)throw Error("mode: "+a+"; type: "+b);return 10>b?8:16};g.getLostPoint=function(a){for(var b=a.getModuleCount(),f=0,d=0;d<
b;d+=1)for(var c=0;c<b;c+=1){for(var g=0,n=a.isDark(d,c),m=-1;1>=m;m+=1)if(!(0>d+m||b<=d+m))for(var k=-1;1>=k;k+=1)0>c+k||b<=c+k||(0!=m||0!=k)&&n==a.isDark(d+m,c+k)&&(g+=1);5<g&&(f+=3+g-5);}for(d=0;d<b-1;d+=1)for(c=0;c<b-1;c+=1)if(g=0, a.isDark(d,c)&&(g+=1), a.isDark(d+1,c)&&(g+=1), a.isDark(d,c+1)&&(g+=1), a.isDark(d+1,c+1)&&(g+=1), 0==g||4==g)f+=3;for(d=0;d<b;d+=1)for(c=0;c<b-6;c+=1)a.isDark(d,c)&&!a.isDark(d,c+1)&&a.isDark(d,c+2)&&a.isDark(d,c+3)&&a.isDark(d,c+4)&&!a.isDark(d,c+5)&&a.isDark(d,c+6)&&
(f+=40);for(c=0;c<b;c+=1)for(d=0;d<b-6;d+=1)a.isDark(d,c)&&!a.isDark(d+1,c)&&a.isDark(d+2,c)&&a.isDark(d+3,c)&&a.isDark(d+4,c)&&!a.isDark(d+5,c)&&a.isDark(d+6,c)&&(f+=40);for(c=g=0;c<b;c+=1)for(d=0;d<b;d+=1)a.isDark(d,c)&&(g+=1);return f+Math.abs(100*g/b/b-50)/5*10};return g}(),v=function(){for(var f=Array(256),g=Array(256),b=0;8>b;b+=1)f[b]=1<<b;for(b=8;256>b;b+=1)f[b]=f[b-4]^f[b-5]^f[b-6]^f[b-8];for(b=0;255>b;b+=1)g[f[b]]=b;return{glog:function(a){if(1>a)throw Error("glog("+a+")");return g[a]},
gexp:function(a){for(;0>a;)a+=255;for(;256<=a;)a-=255;return f[a]}}}(),u=function(){var f=[[1,26,19],[1,26,16],[1,26,13],[1,26,9],[1,44,34],[1,44,28],[1,44,22],[1,44,16],[1,70,55],[1,70,44],[2,35,17],[2,35,13],[1,100,80],[2,50,32],[2,50,24],[4,25,9],[1,134,108],[2,67,43],[2,33,15,2,34,16],[2,33,11,2,34,12],[2,86,68],[4,43,27],[4,43,19],[4,43,15],[2,98,78],[4,49,31],[2,32,14,4,33,15],[4,39,13,1,40,14],[2,121,97],[2,60,38,2,61,39],[4,40,18,2,41,19],[4,40,14,2,41,15],[2,146,116],[3,58,36,2,59,37],[4,
36,16,4,37,17],[4,36,12,4,37,13],[2,86,68,2,87,69],[4,69,43,1,70,44],[6,43,19,2,44,20],[6,43,15,2,44,16],[4,101,81],[1,80,50,4,81,51],[4,50,22,4,51,23],[3,36,12,8,37,13],[2,116,92,2,117,93],[6,58,36,2,59,37],[4,46,20,6,47,21],[7,42,14,4,43,15],[4,133,107],[8,59,37,1,60,38],[8,44,20,4,45,21],[12,33,11,4,34,12],[3,145,115,1,146,116],[4,64,40,5,65,41],[11,36,16,5,37,17],[11,36,12,5,37,13],[5,109,87,1,110,88],[5,65,41,5,66,42],[5,54,24,7,55,25],[11,36,12,7,37,13],[5,122,98,1,123,99],[7,73,45,3,74,46],
[15,43,19,2,44,20],[3,45,15,13,46,16],[1,135,107,5,136,108],[10,74,46,1,75,47],[1,50,22,15,51,23],[2,42,14,17,43,15],[5,150,120,1,151,121],[9,69,43,4,70,44],[17,50,22,1,51,23],[2,42,14,19,43,15],[3,141,113,4,142,114],[3,70,44,11,71,45],[17,47,21,4,48,22],[9,39,13,16,40,14],[3,135,107,5,136,108],[3,67,41,13,68,42],[15,54,24,5,55,25],[15,43,15,10,44,16],[4,144,116,4,145,117],[17,68,42],[17,50,22,6,51,23],[19,46,16,6,47,17],[2,139,111,7,140,112],[17,74,46],[7,54,24,16,55,25],[34,37,13],[4,151,121,5,
152,122],[4,75,47,14,76,48],[11,54,24,14,55,25],[16,45,15,14,46,16],[6,147,117,4,148,118],[6,73,45,14,74,46],[11,54,24,16,55,25],[30,46,16,2,47,17],[8,132,106,4,133,107],[8,75,47,13,76,48],[7,54,24,22,55,25],[22,45,15,13,46,16],[10,142,114,2,143,115],[19,74,46,4,75,47],[28,50,22,6,51,23],[33,46,16,4,47,17],[8,152,122,4,153,123],[22,73,45,3,74,46],[8,53,23,26,54,24],[12,45,15,28,46,16],[3,147,117,10,148,118],[3,73,45,23,74,46],[4,54,24,31,55,25],[11,45,15,31,46,16],[7,146,116,7,147,117],[21,73,45,
7,74,46],[1,53,23,37,54,24],[19,45,15,26,46,16],[5,145,115,10,146,116],[19,75,47,10,76,48],[15,54,24,25,55,25],[23,45,15,25,46,16],[13,145,115,3,146,116],[2,74,46,29,75,47],[42,54,24,1,55,25],[23,45,15,28,46,16],[17,145,115],[10,74,46,23,75,47],[10,54,24,35,55,25],[19,45,15,35,46,16],[17,145,115,1,146,116],[14,74,46,21,75,47],[29,54,24,19,55,25],[11,45,15,46,46,16],[13,145,115,6,146,116],[14,74,46,23,75,47],[44,54,24,7,55,25],[59,46,16,1,47,17],[12,151,121,7,152,122],[12,75,47,26,76,48],[39,54,24,
14,55,25],[22,45,15,41,46,16],[6,151,121,14,152,122],[6,75,47,34,76,48],[46,54,24,10,55,25],[2,45,15,64,46,16],[17,152,122,4,153,123],[29,74,46,14,75,47],[49,54,24,10,55,25],[24,45,15,46,46,16],[4,152,122,18,153,123],[13,74,46,32,75,47],[48,54,24,14,55,25],[42,45,15,32,46,16],[20,147,117,4,148,118],[40,75,47,7,76,48],[43,54,24,22,55,25],[10,45,15,67,46,16],[19,148,118,6,149,119],[18,75,47,31,76,48],[34,54,24,34,55,25],[20,45,15,61,46,16]],g=function(a,b){var d={};d.totalCount=a;d.dataCount=b;return d},
b={},a=function(a,b){switch(b){case D.L:return f[4*(a-1)];case D.M:return f[4*(a-1)+1];case D.Q:return f[4*(a-1)+2];case D.H:return f[4*(a-1)+3]}};b.getRSBlocks=function(b,f){var d=a(b,f);if("undefined"==typeof d)throw Error("bad rs block @ typeNumber:"+b+"/errorCorrectLevel:"+f);for(var c=d.length/3,h=[],k=0;k<c;k+=1)for(var m=d[3*k],n=d[3*k+1],l=d[3*k+2],e=0;e<m;e+=1)h.push(g(n,l));return h};return b}(),k=function(){var f=[],g=0,b={getBuffer:function(){return f},getAt:function(a){return 1==(f[Math.floor(a/
8)]>>>7-a%8&1)},put:function(a,f){for(var g=0;g<f;g+=1)b.putBit(1==(a>>>f-g-1&1));},getLengthInBits:function(){return g},putBit:function(a){var b=Math.floor(g/8);f.length<=b&&f.push(0);a&&(f[b]|=128>>>g%8);g+=1;}};return b},n=function(f){var g=C.stringToBytes(f);return{getMode:function(){return 4},getLength:function(b){return g.length},write:function(b){for(var a=0;a<g.length;a+=1)b.put(g[a],8);}}};return C}()}());

class WalletBackup {

    static get PHI() { return 1.618 }
    static get WIDTH() { return 300 * this.PHI }
    static get HEIGHT() { return this.WIDTH * this.PHI }
    static get IDENTICON_SIZE() { return this.WIDTH / this.PHI }
    static get QR_SIZE() { return this.WIDTH * (1 - 1 / this.PHI) }
    static get PADDING() { return 8 }

    constructor(address, encodedPrivKey) {
        this._width = WalletBackup.WIDTH;
        this._height = WalletBackup.HEIGHT;
        const $canvas = document.createElement('canvas');
        $canvas.width = this._width;
        $canvas.height = this._height;
        this.$canvas = $canvas;
        this._address = address;
        this._ctx = $canvas.getContext('2d');
        this._drawPromise = this._draw(address, encodedPrivKey);
    }

    static calculateQrPosition(walletBackupWidth = WalletBackup.WIDTH, walletBackupHeight = WalletBackup.HEIGHT) {
        const size = WalletBackup.QR_SIZE;
        const padding = WalletBackup.PADDING * 1.5;

        let x = (walletBackupWidth - size) / 2;
        let y = (walletBackupHeight + walletBackupHeight / WalletBackup.PHI) / 2 - size / 2;
        x += padding / 2; /* add half padding to cut away the rounded corners */
        y += padding / 2;

        const width = size - padding;
        const height = size - padding;
        return { x, y, size, padding, width, height };
    }

    filename() {
        return this._address.replace(/ /g, '-') + '.png';
    }

    async toDataUrl() {
        await this._drawPromise;
        return this.$canvas.toDataURL().replace(/#/g, '%23');
    }

    async toObjectUrl() {
        await this._drawPromise;
        return this._toObjectUrl();
    }

    _toObjectUrl() {
        return new Promise(resolve => {
            this.$canvas.toBlob(blob => {
                const url = URL.createObjectURL(blob);
                resolve(url);
            });
        })
    }

    _draw(address, encodedPrivKey) {
        this._drawBackgroundGradient();
        this._drawEncodedPrivKey(encodedPrivKey);

        this._setFont();
        this._drawAddress(address);
        this._drawHeader();

        return this._drawIdenticon(address);
    }

    async _drawIdenticon(address) {
        const $img = await Iqons.image(address);
        const size = WalletBackup.IDENTICON_SIZE;
        const pad = (this._width - size) / 2;
        const x = pad;
        const y = this._height - this._width - size / 2;
        this._ctx.drawImage($img, x, y, size, size);
    }

    _setFont() {
        const ctx = this._ctx;
        ctx.fontFamily = 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "Roboto", "Oxygen", "Ubuntu", "Cantarell", "Fira Sans", "Droid Sans", "Helvetica Neue", Helvetica, Arial, sans-serif';
        ctx.textAlign = 'center';
    }

    _drawHeader() {
        const ctx = this._ctx;
        const x = this._width / 2;
        const y = WalletBackup.PADDING * 6;
        ctx.font = '500 20px ' + ctx.fontFamily;
        ctx.fillStyle = 'rgba(255,255,255,0.7)';
        ctx.fillText('ACCOUNT ACCESS FILE', x, y);

        ctx.font = '500 16px ' + ctx.fontFamily;
        ctx.fillText('DO NOT share this File or QR Code!', x, WalletBackup.PADDING * 12.5);
    }

    _drawAddress(address) {
        const ctx = this._ctx;
        const x = this._width / 2;
        const y = this._width;
        ctx.font = '500 16px ' + ctx.fontFamily;
        ctx.fillStyle = 'white';
        ctx.fillText(address, x, y);
    }

    _drawEncodedPrivKey(encodedPrivKey) {
        const $el = document.createElement('div');
        QrEncoder.render({
            text: encodedPrivKey,
            radius: 0.8,
            ecLevel: 'Q',
            fill: '#2e0038',
            background: 'transparent',
            size: Math.min(240, (window.innerWidth - 64))
        }, $el);

        const $canvas = $el.querySelector('canvas');
        const qrPosition = WalletBackup.calculateQrPosition(this._width, this._height);

        this._ctx.fillStyle = 'white';
        this._ctx.strokeStyle = 'white';
        this._roundRect(qrPosition.x, qrPosition.y, qrPosition.size, qrPosition.size, 16, true);

        const padding = qrPosition.padding;
        this._ctx.drawImage($canvas, qrPosition.x + padding, qrPosition.y + padding, qrPosition.size - 2 * padding,
            qrPosition.size - 2 * padding);
    }

    _drawBackgroundGradient() {
        this._ctx.fillStyle = 'white';
        this._ctx.fillRect(0, 0, this._width, this._height);
        const gradient = this._ctx.createLinearGradient(0, 0, 0, this._height);
        gradient.addColorStop(0, '#536DFE');
        gradient.addColorStop(1, '#a553fe');
        this._ctx.fillStyle = gradient;
        this._ctx.strokeStyle = 'transparent';
        this._roundRect(0, 0, this._width, this._height, 16, true);
    }

    _roundRect(x, y, width, height, radius, fill, stroke) {
        const ctx = this._ctx;
        if (typeof stroke === 'undefined') {
            stroke = true;
        }
        if (typeof radius === 'undefined') {
            radius = 5;
        }
        if (typeof radius === 'number') {
            radius = { tl: radius, tr: radius, br: radius, bl: radius };
        } else {
            var defaultRadius = { tl: 0, tr: 0, br: 0, bl: 0 };
            for (var side in defaultRadius) {
                radius[side] = radius[side] || defaultRadius[side];
            }
        }
        ctx.beginPath();
        ctx.moveTo(x + radius.tl, y);
        ctx.lineTo(x + width - radius.tr, y);
        ctx.quadraticCurveTo(x + width, y, x + width, y + radius.tr);
        ctx.lineTo(x + width, y + height - radius.br);
        ctx.quadraticCurveTo(x + width, y + height, x + width - radius.br, y + height);
        ctx.lineTo(x + radius.bl, y + height);
        ctx.quadraticCurveTo(x, y + height, x, y + height - radius.bl);
        ctx.lineTo(x, y + radius.tl);
        ctx.quadraticCurveTo(x, y, x + radius.tl, y);
        ctx.closePath();
        if (fill) {
            ctx.fill();
        }
        if (stroke) {
            ctx.stroke();
        }
    }
}

class XAccountBackupImport extends XElement {
    html() {
        return `
            <x-account-backup-import-icon></x-account-backup-import-icon>
            <button>Select file</button>
            <input type="file" accept="image/*">`
    }

    onCreate() {
        this.$fileInput = this.$('input');
        this.$importIcon = this.$('x-account-backup-import-icon');
        this.$button = this.$('button');
    }

    onEntry() {
        if (this._boundListeners.size === 0) {
            this.__bindListeners();
        }
    }

    onExit() {
        this.__removeListeners();
    }

    listeners() {
        return {
            'drop': this._onFileDrop.bind(this),
            'dragover': this._onDragOver.bind(this),
            'dragexit': this._onDragEnd.bind(this),
            'dragend': this._onDragEnd.bind(this),
            'click': this._openFileInput.bind(this),
            'change input': this._onFileSelected.bind(this)
        }
    }

    async _onFileDrop(_, event) {
        this._stopPropagation(event);
        this._onDragEnd();

        const files = event.dataTransfer.files;
        this._readFile(files[0]);
    }

    _onDragOver(_, event) {
        this._stopPropagation(event);
        event.dataTransfer.dropEffect = 'copy';
        this.$el.setAttribute('active', 1);
    }

    _onDragEnd() {
        this.$el.removeAttribute('active');
    }

    _openFileInput() {
        this.$fileInput.click();
    }

    _onFileSelected(_, event) {
        const files = event.target.files;
        this._readFile(files[0]);
        this.$fileInput.value = null;
    }

    _onQrError() {
        this.animate('shake', this.$importIcon);
        XToast.error('Couldn\'t read Backup File');
    }

    _stopPropagation(event) {
        event.stopPropagation();
        event.preventDefault();
    }

    async _readFile(file) {
        let qrPosition = WalletBackup.calculateQrPosition();

        try {
            const decoded = await QrScanner.scanImage(file, qrPosition, null, null, false, true);
            this.fire('x-read-file', decoded);
        } catch (e) {
            this._onQrError();
        }
    }
}

class XImportFile extends MixinRedux(XElement) {

    html() {
        return `
            <section x-route="">
                <h1>Import Access File</h1>
                <x-grow></x-grow>
                <x-account-backup-import></x-account-backup-import>
                <x-grow></x-grow>
            </section>
            <x-decrypt-safe x-route="decrypt-safe"></x-decrypt-safe>
            <x-decrypt-wallet x-route="decrypt-wallet"></x-decrypt-wallet>
            <x-set-label x-route="set-label"></x-set-label>
        `
    }

    children() {
        return [ XSetLabel, XDecryptSafe, XDecryptWallet, XAccountBackupImport ];
    }

    async onCreate() {
        super.onCreate();
        this._router = await XRouter$1.instance;
    }

    static mapStateToProps(state) {
        return {
            keyType: state.request.data.type
        }
    }

    static get actions() {
        return { setData, importFromFileWallet: importFromFile$1, importFromFileSafe: importFromFile, decryptWallet: decrypt$1, decryptSafe: decrypt };
    }

    listeners() {
        return {
            'x-read-file': this._onReadFile.bind(this),
            'x-decrypt': this._onDecrypt.bind(this),
            'x-set-label': this._onSetLabel.bind(this)
        }
    }

    _onReadFile(encryptedKeyPair64) {
        if (encryptedKeyPair64.substr(0, 2) === '#2') {
            // wallet account
            this.actions.setData(RequestTypes.IMPORT_FROM_FILE, {
                type: KeyType.LOW,
                encryptedKeyPair64: encryptedKeyPair64.substr(2)
            });
            this._router.goTo('import-from-file/decrypt-wallet');
        } else {
            // safe account (deprecated)
            this.actions.setData(RequestTypes.IMPORT_FROM_FILE, {
                type: KeyType.HIGH,
                encryptedKeyPair64
            });
            this._router.goTo('import-from-file/decrypt-safe');
        }
    }

    async _onDecrypt() {
        if (this.properties.keyType === KeyType.HIGH) {
            this.actions.decryptSafe();
        } else {
            this.actions.decryptWallet();
        }
    }

    _onSetLabel(label) {
        this.actions.setData(RequestTypes.IMPORT_FROM_FILE, { label });
        this.actions.importFromFileSafe();
    }
}

function signSafeTransaction(passphrase) {
    return async (dispatch, getState) => {
        dispatch( setExecuting(RequestTypes.SIGN_SAFE_TRANSACTION) );

        const { transaction: { recipient, value, fee, validityStartHeight, extraData }, address } = getState().request.data;

        try {
            const key = await keyStore.get(address, passphrase);
            const tx = await key.createTransaction(recipient, value, fee, validityStartHeight, extraData, extraData && extraData.length > 0 ? 'extended' : 'basic');

            const signatureProof = Nimiq.SignatureProof.unserialize(new Nimiq.SerialBuffer(tx.proof));

            dispatch(
                setResult(RequestTypes.SIGN_SAFE_TRANSACTION, {
                    sender: tx.sender.toUserFriendlyAddress(),
                    senderPubKey: signatureProof.publicKey.serialize(),
                    recipient: tx.recipient.toUserFriendlyAddress(),
                    value: tx.value / SATOSHIS,
                    fee: tx.fee / SATOSHIS,
                    validityStartHeight: tx.validityStartHeight,
                    signature: signatureProof.signature.serialize(),
                    extraData: Utf8Tools.utf8ByteArrayToString(tx.data),
                    hash: tx.hash().toBase64()
                })
            );
        } catch (e) {
            // assume the password was wrong
            console.error(e);
            dispatch(
                setData(RequestTypes.SIGN_SAFE_TRANSACTION, { isWrongPassphrase: true })
            );
        }
    }
}

class XSignSafe extends MixinRedux(XElement) {

    html() { return `
        <h1>Authorize Transaction</h1>
        <h2>Enter your passphrase below to authorize this transaction:</h2>

        <div class="transaction">
            <div class="center">
                <x-identicon sender></x-identicon>
                <i class="arrow material-icons">arrow_forward</i>
                <x-identicon recipient></x-identicon>
            </div>

            <div class="center">
                <div class="x-value"><span class="value"></span> NIM</div>
            </div>

            <div class="row">
                <label>From</label>
                <div class="row-data">
                    <div class="label" sender></div>
                    <x-address-no-copy sender></x-address-no-copy>
                </div>
            </div>

            <div class="row">
                <label>To</label>
                <div class="row-data">
                    <x-address-no-copy recipient></x-address-no-copy>
                </div>
            </div>

            <div class="extra-data-section display-none row">
                <label>Message</label>
                <div class="row-data">
                    <div class="extra-data"></div>
                </div>
            </div>

            <div class="fee-section display-none row">
                <label>Fee</label>
                <div class="row-data">
                    <div class="fee"></div>
                </div>
            </div>
        </div>

        <x-authenticate button-label="Confirm"></x-authenticate>
        `;
    }

    children() {
        return [ XIdenticon, XAddressNoCopy, XAuthenticate ];
    }

    onCreate() {
        this.$senderIdenticon = this.$identicon[0];
        this.$recipientIdenticon = this.$identicon[1];
        this.$senderLabel = this.$('.label[sender]');
        this.$senderAddress = this.$addressNoCopy[0];
        this.$recipientAddress = this.$addressNoCopy[1];

        super.onCreate();
    }

    static mapStateToProps(state) {
        return {
            requestType: state.request.requestType,
            transaction: state.request.data.transaction,
            myLabel: state.request.data.label
        };
    }

    static get actions() {
        return { signSafeTransaction, setData };
    }

    onAfterEntry() {
        setTimeout(() => this.$authenticate.focus(), 100);
    }

    _onPropertiesChanged(changes) {
        const { requestType } = this.properties;

        if (requestType !== RequestTypes.SIGN_SAFE_TRANSACTION) return;

        const { transaction, myLabel } = changes;

        if (transaction) {
            const { sender, recipient, value, fee, extraData } = transaction;

            this.$senderAddress.address = sender;
            this.$senderIdenticon.address = sender;

            this.$recipientAddress.address = recipient;
            this.$recipientIdenticon.address = recipient;

            this.$('.value').textContent = (value/1e5).toString();

            if (extraData && extraData.length > 0) {
                this.$('.extra-data-section').classList.remove('display-none');
                this.$('.extra-data').textContent = extraData;
            }

            if (fee !== 0) {
                this.$('.fee-section').classList.remove('display-none');
                this.$('.fee').textContent = (fee/1e5).toString() + ' NIM';
            }
        }

        if (myLabel) {
            this.$senderLabel.textContent = this.properties.myLabel;
        }
    }

    listeners() {
        return {
            'x-authenticate-submitted': passphrase => this.actions.signSafeTransaction(passphrase)
        }
    }
}

class XViewTransaction extends MixinRedux(XElement) {

    html() { return `
        <div class="transaction">
            <h1>Authorize Transaction</h1>
            <h2>Please confirm the following transaction:</h2>
            
            <div class="center">
                <x-identicon sender></x-identicon>
                <i class="arrow material-icons">arrow_forward</i>
                <x-identicon recipient></x-identicon>
            </div>
        
            <div class="center">
                <div class="x-value"><span class="value"></span> NIM</div>
            </div>
        
            <div class="row">
                <label>From</label>
                <div class="row-data">
                    <div class="label" sender></div>
                    <x-address-no-copy sender></x-address-no-copy>
                </div>
            </div>
        
            <div class="row">
                <label>To</label>
                <div class="row-data">
                    <x-address-no-copy recipient></x-address-no-copy>
                </div>
            </div>
            
             <div class="extra-data-section display-none row">
                <label>Message</label>
                <div class="row-data">
                    <div class="extra-data"></div>
                </div>
            </div>
        
            <div class="fee-section display-none row">
                <label>Fee</label>
                <div class="row-data">
                    <div class="fee"></div>
                </div>
            </div>
        </div>
        
        <x-grow></x-grow>
        
        <button>Enter PIN</button>
        `;
    }

    onCreate() {
        this.$senderIdenticon = this.$identicon[0];
        this.$recipientIdenticon = this.$identicon[1];
        this.$senderLabel = this.$('.label[sender]');
        this.$senderAddress = this.$addressNoCopy[0];
        this.$recipientAddress = this.$addressNoCopy[1];

        super.onCreate();
    }

    children() {
        return [ XIdenticon, XAddressNoCopy ];
    }

    static mapStateToProps(state) {
        return {
            requestType: state.request.requestType,
            transaction: state.request.data.transaction,
            myLabel: state.request.data.label
        };
    }

    _onPropertiesChanged(changes) {
        const { requestType } = this.properties;

        if (requestType !== RequestTypes.SIGN_WALLET_TRANSACTION) return;

        const { transaction, myLabel } = changes;

        if (transaction) {
            const { sender, recipient, value, fee, extraData } = transaction;

            this.$senderAddress.address = sender;
            this.$senderIdenticon.address = sender;

            this.$recipientAddress.address = recipient;
            this.$recipientIdenticon.address = recipient;

            this.$('.value').textContent = (value/1e5).toString();

            if (extraData && extraData.length > 0) {
                this.$('.extra-data-section').classList.remove('display-none');
                this.$('.extra-data').textContent = extraData;
            }

            if (fee !== 0) {
                this.$('.fee-section').classList.remove('display-none');
                this.$('.fee').textContent = (fee/1e5).toString() + ' NIM';
            }
        }

        if (myLabel) {
            this.$senderLabel.textContent = this.properties.myLabel;
        }
    }

    listeners() {
        return {
            'click button': () => this.fire('x-view-transaction-confirm')
        }
    }
}

class XEnterPin extends MixinRedux(XElement) {

    html() { return `
        <h1>Enter your PIN</h1>
        <h2>Please enter your PIN to authorize the transaction</h2>
        <x-authenticate-pin x-route="" class="center"></x-authenticate-pin>
        `;
    }

    children() {
        return [ XAuthenticatePin ];
    }

    onEntry() {
        this.$authenticatePin.$pinpad.open();
    }

    onBeforeExit() {
        this.$authenticatePin.$pinpad.close();
    }
}

function signWalletTransaction(pin ) {
    return async (dispatch, getState) => {
        dispatch( setExecuting(RequestTypes.SIGN_WALLET_TRANSACTION) );

        const { transaction: { recipient, value, fee, validityStartHeight, extraData }, address } = getState().request.data;

        try {
            const key = await keyStore.get(address, pin);
            const tx = await key.createTransaction(recipient, value, fee, validityStartHeight, extraData, extraData && extraData.length > 0 ? 'extended' : 'basic');

            const signatureProof = Nimiq.SignatureProof.unserialize(new Nimiq.SerialBuffer(tx.proof));

            dispatch(
                setResult(RequestTypes.SIGN_WALLET_TRANSACTION, {
                    sender: tx.sender.toUserFriendlyAddress(),
                    senderPubKey: signatureProof.publicKey.serialize(),
                    recipient: tx.recipient.toUserFriendlyAddress(),
                    value: tx.value / SATOSHIS,
                    fee: tx.fee / SATOSHIS,
                    validityStartHeight: tx.validityStartHeight,
                    signature: signatureProof.signature.serialize(),
                    extraData: Utf8Tools.utf8ByteArrayToString(tx.data),
                    hash: tx.hash().toBase64()
                })
            );
        } catch (e) {
            // assume the password was wrong
            console.error(e);
            dispatch(
                setData(RequestTypes.SIGN_WALLET_TRANSACTION, { isWrongPin: true })
            );
        }
    }
}

class XSignWallet extends MixinRedux(XElement) {

    html() { return `
        <x-view-transaction x-route=""></x-view-transaction>
        <x-enter-pin x-route="enter-pin"></x-enter-pin>
        `;
    }

    children() {
        return [ XEnterPin, XViewTransaction ];
    }

    static get actions() {
        return { signWalletTransaction };
    }

    listeners() {
        return {
            'x-view-transaction-confirm': async () => (await XRouter$1.instance).goTo('sign-wallet-transaction/enter-pin'),
            'x-authenticate-pin-submitted': pin => this.actions.signWalletTransaction(pin)
        }
    }
}

class XDownloadableImage extends XElement {
    static get LONG_TOUCH_DURATION() {
        return 800;
    }

    static get DOWNLOAD_DURATION() {
        return 1500;
    }

    html() {
        return `
            <a>
                <img draggable="false">
                <p>&nbsp;</p>
                <button>Save</button>
            </a>
            <svg long-touch-indicator xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
                <defs>
                    <clipPath id="hexClip">
                        <path clip-rule="evenodd" d="M16 4.29h32l16 27.71l-16 27.71h-32l-16 -27.71zM20.62 12.29h22.76l11.38 19.71l-11.38 19.71h-22.76l-11.38 -19.71z"/>
                    </clipPath>
                </defs>
                <path fill-rule="evenodd" d="M16 4.29h32l16 27.71l-16 27.71h-32l-16 -27.71zM20.62 12.29h22.76l11.38 19.71l-11.38 19.71h-22.76l-11.38 -19.71z" fill="#FFFFFF" opacity="0.2"/>
                <g clip-path="url(#hexClip)">
                    <circle id="circle" cx="32" cy="32" r="16" fill="none" stroke-width="32" stroke-dasharray="100.53 100.53" transform="rotate(-120 32 32)"/>
                </g>
            </svg>
            <p></p>`;
    }

    onCreate() {
        this._src = null;
        this._filename = 'image';
        this._longTouchStart = 0;
        this._longTouchTimeout = null;
        this._indicatorHideTimeout = null;
        this._blurTimeout = null;
        this.$a = this.$('a');
        this.$img = this.$('img');
        this.$p = this.$('p');
        this.$longTouchIndicator = this.$('[long-touch-indicator]');
        this._onWindowBlur = this._onWindowBlur.bind(this);
        this.addEventListener('mousedown', e => this._onMouseDown(e)); // also gets triggered after touchstart
        this.addEventListener('touchstart', e => this._onTouchStart());
        this.addEventListener('touchend', e => this._onTouchEnd());
    }

    set src(src) {
        this._src = src;
        this.$img.src = src;
        this._setupDownload();
    }

    /** @param {string} filename */
    set filename(filename) {
        this._filename = filename;
        this._setupDownload();
    }

    _setupDownload() {
        if (this._supportsNativeDownload())
            this._setupNativeDownload();
        else
            this._setupFallbackDownload();
    }

    _setupNativeDownload() {
        this.$a.href = this._src;
        this.$a.download = this._filename;
        if (!this.$longTouchIndicator) return;
        this.$el.removeChild(this.$longTouchIndicator);
        this.$longTouchIndicator = null;
    }

    _setupFallbackDownload() {
        // Hack to make image downloadable on iOS via long tap.
        this.$a.href = 'javascript:void(0);';
    }

    _supportsNativeDownload() { // Detect if browser supports native `download` attribute
        return typeof this.$a.download !== 'undefined';
    }

    _onMouseDown(e) {
        if(e.button === 0) { // primary button
            if (!this._supportsNativeDownload()) return;
            this._onDownloadStart();
        }
        else if(e.button === 2) { // secondary button
            window.addEventListener('blur', this._onWindowBlur);
        }
    }

    _onTouchStart() {
        if (this._supportsNativeDownload()) return;
        // if no native download is supported, show a hint to download by long tap
        this._showLongTouchIndicator();
        this._longTouchStart = Date.now();
        clearTimeout(this._longTouchTimeout);
        this._longTouchTimeout = setTimeout(() => this._onLongTouch(), XDownloadableImage.LONG_TOUCH_DURATION);
    }

    _onTouchEnd() {
        if (this._supportsNativeDownload()) return;
        this._hideLongTouchIndicator();
        clearTimeout(this._longTouchTimeout);
        if (Date.now() - this._longTouchStart > XDownloadableImage.LONG_TOUCH_DURATION) return;
        this._onLongTouchCancel();
    }

    _onLongTouch() {
        this._hideLongTouchIndicator();
        setTimeout(e => XToast.show('Click on "Save Image"'), 1200);
        this._onDownloadStart();
    }

    _onLongTouchCancel() {
        XToast.show('Touch and hold to download.');
    }

    _onDownloadStart() {
        // some browsers open a download dialog and blur the window focus, which we use as a hint for a download
        window.addEventListener('blur', this._onWindowBlur);
        // otherwise consider the download as successful after some time
        this._blurTimeout = setTimeout(() => this._onDownloadEnd(), XDownloadableImage.DOWNLOAD_DURATION);
    }

    _onDownloadEnd() {
        this.fire('x-image-download');
        window.removeEventListener('blur', this._onWindowBlur);
        clearTimeout(this._blurTimeout);
    }

    _onWindowBlur() {
        // wait for the window to refocus when the browser download dialog closes
        this.listenOnce('focus', e => this._onDownloadEnd(), window);
        clearTimeout(this._blurTimeout);
    }

    _showLongTouchIndicator() {
        this.$longTouchIndicator.style.display = 'block';
        this.stopAnimate('animate', this.$longTouchIndicator);
        this.animate('animate', this.$longTouchIndicator);
    }

    _hideLongTouchIndicator() {
        this.$longTouchIndicator.style.display = 'none';
    }

}

class XDownloadFile extends MixinRedux(XElement) {

    html() {
        return `
            <h1>Save your Access File</h1>
            <h2 secondary>Do NOT share this Account Access File and keep it safe.</h2>
            <x-grow></x-grow>
            <x-downloadable-image></x-downloadable-image>
            <x-grow></x-grow>
        `
    }

    children() {
        return [ XDownloadableImage ];
    }

    onCreate() {
        this.addEventListener('x-image-download', e => this._onImageDownload(e));
        super.onCreate();
    }

    static mapStateToProps(state) {
        return {
           encryptedKeyPair: state.request.data.encryptedKeyPair,
           address: state.request.data.address
        }
    }

    async _onPropertiesChanged(changes) {
        const { address } = this.properties;

        const { encryptedKeyPair } = changes;

        if (!encryptedKeyPair || !address) return;

        const encodedWalletKey = `#2${ Nimiq.BufferUtils.toBase64(encryptedKeyPair) }`;

        const qrPosition = WalletBackup.calculateQrPosition();

        let backup = null;
        let scanResult = null;

        // QR Scanner is not super reliable. Test if we can read the image we just created, if not, create a new one.
        do {
            backup = new WalletBackup(address, encodedWalletKey);
            try {
                scanResult = await QrScanner.scanImage(backup.$canvas, qrPosition, null, null, false, true);
            } catch(e) { }
        } while (scanResult !== encodedWalletKey);

        const filename = backup.filename();
        this.$downloadableImage.src = await backup.toDataUrl();
        this.$downloadableImage.filename = filename;
    }

    _onImageDownload(e) {
        e.stopPropagation();
        this.fire('x-file-download-complete');
    }
}

class XBackupEnterPin extends XElement {

    html() { return `
        <h1>Backup your Account</h1>
        <h2>Please enter your PIN to backup your account.</h2>
        <x-grow x-grow="0.5"></x-grow>
        <x-my-account></x-my-account>
        <x-grow x-grow="0.5"></x-grow>
        <x-authenticate-pin button-label="Backup"></x-authenticate-pin>
        <x-grow></x-grow>
        `;
    }

    children() {
        return [ XAuthenticatePin, XMyAccount ];
    }

    onEntry() {
        this.$authenticatePin.$pinpad.open();
    }

    onBeforeExit() {
        this.$authenticatePin.$pinpad.close();
    }
}

function backupFile(pin) {
    return async (dispatch, getState) => {
        dispatch( setExecuting(RequestTypes.BACKUP_FILE) );

        const { address } = getState().request.data;

        // try to decrypt to authenticate the user
        try {
            await keyStore.get(address, pin);

            // encryptedkeypair is already in store because of loadAccountData
            // but we need to get rid of executing
            dispatch(
                setData(RequestTypes.BACKUP_FILE, {})
            );

            (await XRouter.instance).goTo('backup-file/download');
        } catch (e) {
            console.error(e);
            // assume the password was wrong
            dispatch(
                setData(RequestTypes.BACKUP_FILE, { isWrongPin: true })
            );
        }
    }
}

class XBackupFile extends MixinRedux(XElement) {

    html() { return `
        <x-backup-enter-pin x-route=""></x-backup-enter-pin>
        <x-download-file x-route="download"></x-download-file>
        `;
    }

    children() {
        return [ XBackupEnterPin, XDownloadFile ];
    }

    static get actions() {
        return { backupFile, setResult };
    }

    listeners() {
        return {
            'x-authenticate-pin-submitted': this._onSubmit.bind(this),
            'x-file-download-complete': this._onFileDownload.bind(this)
        };
    }

    _onSubmit(pin) {
        this.actions.backupFile(pin);
    }

    _onFileDownload() {
        this.actions.setResult(RequestTypes.BACKUP_FILE, true);
    }
}

class XAuthenticateBackup extends XElement {

    html() { return `
        <h1>Backup your Account</h1>
        <h2>Please enter your Pass Phrase to backup your account.</h2>
        <x-grow x-grow="0.5"></x-grow>
        <x-my-account></x-my-account>
        <x-authenticate button-label="Backup"></x-authenticate>
        `;
    }

    children() {
        return [ XAuthenticate, XMyAccount ];
    }

    onAfterEntry() {
        this.$authenticate.focus();
    }
}

function backupWords(passphrase) {
    return async (dispatch, getState) => {
        dispatch( setExecuting(RequestTypes.BACKUP_WORDS) );

        try {
            const key = await keyStore.get(getState().request.data.address, passphrase);

            dispatch(
                setData(RequestTypes.BACKUP_WORDS, { privateKey: key.keyPair.privateKey.toHex() })
            );

            (await XRouter$1.instance).goTo('backup-words/words');
        } catch (e) {
            console.error(e);
            // assume the password was wrong
            dispatch(
                setData(RequestTypes.BACKUP_WORDS, { isWrongPassphrase: true })
            );
        }
    }
}

class XBackupWords extends MixinRedux(XElement) {

    html() { return `
        <section x-route="">
            <h1>Backup your Account</h1>
            <x-grow></x-grow>
            <x-privacy-agent></x-privacy-agent>
        </section>
        <x-authenticate-backup x-route="authenticate"></x-authenticate-backup>
        <x-show-words x-route="words"></x-show-words>
        `;
    }

    children() {
        return [ XAuthenticateBackup, XPrivacyAgent, XShowWords ];
    }

    static get actions() {
        return { setData, setResult, backupWords };
    }

    listeners() {
        return {
            'x-authenticate-submitted': passphrase => this.actions.backupWords(passphrase),
            'x-surrounding-checked': async () => (await XRouter$1.instance).goTo(this, 'authenticate'),
            'x-show-words': () => this.actions.setResult(RequestTypes.BACKUP_WORDS, true)
        };
    }
}

function rename(passphrase, label) {
    return async (dispatch, getState) => {
        dispatch( setExecuting(RequestTypes.RENAME) );

        const { address } = getState().request.data;

        try {
            const key = await keyStore.get(address, passphrase);

            key.label = label;

            await keyStore.put(key, passphrase);

            dispatch(
                setResult(RequestTypes.RENAME, label)
            );
        } catch (e) {
            console.error(e);
            // assume the password was wrong
            dispatch(
                setData(RequestTypes.RENAME, { isWrongPassphrase: true })
            );
        }
    }
}

class XRename extends MixinRedux(XElement) {

    html() { return `
        <h1>Rename your Account</h1>
        <x-grow></x-grow>
        <x-my-account></x-my-account>
        <x-grow></x-grow>
        <input id="label" type="text" placeholder="Account name">
        <x-grow></x-grow>
        <x-authenticate button-label="Save"></x-authenticate>
        `;
    }

    children() {
        return [ XMyAccount, XAuthenticate ];
    }

    onCreate() {
        this.$input = this.$('input#label');
        super.onCreate();
    }

    onAfterEntry() {
        this.$input.focus();
    }

    static get actions() {
        return { rename, setData };
    }

    static mapStateToProps(state) {
        return {
            label: state.request.data.label
        }
    }

    _onPropertiesChanged(changes) {
        if (changes.label) {
            this.$input.value = changes.label;
            this._oldInput = changes.label;
        }
    }

    listeners() {
        return {
            'x-authenticate-submitted': passphrase => this.actions.rename(passphrase, this.$input.value),
            'input input': this._cleanInput.bind(this)
        }
    }

    _cleanInput() {
        if (!BrowserDetection.isSafari() && !BrowserDetection.isIOS()) return;

        const currentValue = this.$input.value;
        const encoded = encodeURIComponent(currentValue);

        if (encoded.length > 24) {
            this.$input.value = this._oldInput;
        } else {
            this._oldInput = currentValue;
        }
    }
}

class XUpgradeEnterPin extends XElement {

    html() { return `
        <h1>Upgrade your Account</h1>
        <h2>Please enter your PIN to upgrade your account.</h2>
        <x-grow x-grow="0.5"></x-grow>
        <x-my-account></x-my-account>
        <x-grow x-grow="0.5"></x-grow>
        <x-authenticate-pin button-label="Continue"></x-authenticate-pin>
        <x-grow></x-grow>
        `;
    }

    children() {
        return [ XAuthenticatePin, XMyAccount ];
    }

    onEntry() {
        this.$authenticatePin.$pinpad.open();
    }

    onExit() {
        this.$authenticatePin.$pinpad.close();
    }

    onBeforeExit() {
        this.$authenticatePin.$pinpad.close();
    }
}

class XUpgradeWelcome extends XElement {

    html() { return `
        <h1>Upgrade your Account</h1>
        <x-grow></x-grow>
        <div>
            <p class="-left">
                After completion of the following process, your Miner Account will be converted to a Safe Account</a>.
            </p>
            &nbsp;
            <p class="-left">
                For this you will:
                <ul>
                    <li>Authenticate with your PIN</li>
                    <li>Get a backup in form of 24 Recovery Words, which represent your private key</li>
                    <li>Choose a Pass Phrase to encrypt your private key</li>
                </ul>
            </p>
        </div>
        <x-grow></x-grow>
        <button>Let's go</button>
        `;
    }

    listeners() {
        return {
            'click button': _ => this.fire('x-upgrade-welcome-completed')
        }
    }
}

function decrypt$2(pin, onSuccess) {
    return async (dispatch, getState) => {
        dispatch( setExecuting(RequestTypes.UPGRADE) );

        const { address } = getState().request.data;

        // try to decrypt to authenticate the user
        try {
            const key = await keyStore.get(address, pin);

            dispatch(
                setData(RequestTypes.UPGRADE, { key, privateKey: key.keyPair.privateKey.toHex() })
            );

            onSuccess();
        } catch (e) {
            console.error(e);
            // assume the password was wrong
            dispatch(
                setData(RequestTypes.UPGRADE, { isWrongPin: true })
            );
        }
    }
}

function encryptAndPersist() {
    return async (dispatch, getState) => {
        dispatch( setExecuting(RequestTypes.UPGRADE) );

        const { key, passphrase } = getState().request.data;

        key.type = KeyType.HIGH;

        if (await keyStore.put(key, passphrase)) {
            dispatch(
                setResult(RequestTypes.UPGRADE, true)
            );
        } else {
            dispatch(
                setError(RequestTypes.UPGRADE, 'Key could not be persisted')
            );
        }
    }
}

class XUpgrade extends MixinRedux(XElement) {

    html() { return `
        <x-upgrade-welcome x-route=""></x-upgrade-welcome>
        <x-upgrade-enter-pin x-route="enter-pin"></x-upgrade-enter-pin>
         <section x-route="warning">
            <h1>Upgrade your Account</h1>
            <x-grow></x-grow>
            <x-privacy-agent></x-privacy-agent>
        </section>
        <x-show-words x-route="words"></x-show-words>
        <x-validate-words-connected x-route="validate-words"></x-validate-words-connected>
        <x-set-passphrase x-route="set-passphrase"></x-set-passphrase>
        `;
    }

    children() {
        return [ XUpgradeWelcome, XUpgradeEnterPin, XPrivacyAgent, XShowWords, XValidateWordsConnected, XSetPassphrase ];
    }

    static get actions() {
        return { decrypt: decrypt$2, encryptAndPersist, setData };
    }

    async onCreate() {
        this._router = (await XRouter$1.instance);
        super.onCreate();
    }

    listeners() {
        return {
            'x-upgrade-welcome-completed': this._onWelcomeCompleted.bind(this),
            'x-authenticate-pin-submitted': this._onSubmitPin.bind(this),
            'x-surrounding-checked': this._onSurroundingChecked.bind(this),
            'x-show-words': this._onWordsSeen.bind(this),
            'x-validate-words-back': _ => this._router.goTo(this, 'words'),
            'x-validate-words': this._onWordsValidated.bind(this),
            'x-set-passphrase': this._onSetPassphrase.bind(this)
        };
    }

    async _onWelcomeCompleted() {
        this._router.goTo(this, 'enter-pin');
    }

    _onSubmitPin(pin) {
        this.actions.decrypt(pin, () => this._router.goTo(this, 'warning'));
    }

    _onSurroundingChecked() {
        this._router.goTo(this, 'words');
    }

    _onWordsSeen() {
        this._router.goTo(this, 'validate-words');
    }

    async _onWordsValidated() {
        this._router.goTo(this, 'set-passphrase');
    }

    _onSetPassphrase(passphrase) {
        this.actions.setData(RequestTypes.UPGRADE, { passphrase });
        this.actions.encryptAndPersist();
    }
}

class XClose extends  XElement {
    onEntry() {
        self.close();
    }
}

function getRequestElement(requestType) {
    switch (requestType) {
        case RequestTypes.IMPORT_FROM_WORDS:
            return XImportWords;

        case RequestTypes.IMPORT_FROM_FILE:
            return XImportFile;

        case RequestTypes.CREATE_SAFE:
            return XCreateSafe;

        case RequestTypes.CREATE_WALLET:
            return XCreateWallet;

        case RequestTypes.SIGN_SAFE_TRANSACTION:
            return XSignSafe;

        case RequestTypes.SIGN_WALLET_TRANSACTION:
            return XSignWallet;

        case RequestTypes.BACKUP_WORDS:
            return XBackupWords;

        case RequestTypes.BACKUP_FILE:
            return XBackupFile;

        case RequestTypes.RENAME:
            return XRename;

        case RequestTypes.UPGRADE:
            return XUpgrade;

        default:
            throw new Error('unknown request');
    }
}

var XKeyguard = (requestType) => {
    const RequestElement = getRequestElement(requestType);

    const tagName = XElement.__toTagName(RequestElement.name);

    return class XKeyguard extends MixinRedux(XElement) {

        html() {
            return `
        <x-loader></x-loader>
        <div class="x-route-container">
            <${ tagName } x-route="${requestType}"></${ tagName }>
            <x-close x-route="close"></x-close>
            <div><x-close x-route="/"></x-close></div>
        </div>
        <a secondary x-href="close">
            <i class="material-icons">&#xE5C9;</i>
            Cancel
        </a>
        `;
        }

        children() {
            return [ XLoader, XClose, RequestElement ];
        }

        static mapStateToProps(state) {
            return {
                executing: state.request.executing
            };
        }

        _onPropertiesChanged(changes) {
            if (changes.executing !== undefined) {
                this.$loader.loading = changes.executing;
            }
        }
    }
};

// TODO what to do when the user reloads the page and the state is not initialized again?? > persist the state on unload
// that means we would have to put rpc requests in store and open new promises for unresponsed requests

class XNoRequest extends XElement {

    html() {
        return `
            <x-grow></x-grow>
            <h1>408: Request Timeout</h1>
            <h2>Please start at <a href="https://nimiq.com/">nimiq.com</a></h2>
            <x-grow></x-grow>
        `;
    }
}

class Keyguard {
    constructor() {

        // show UI if we are not embedded
        if (self === top) {
            const $appContainer = document.querySelector('#app');
            MixinRedux.store = store;

            // if there is no request, tell the user to go to dashboard?
            const noRequestTimer = setTimeout(() => {
                new XNoRequest($appContainer);
            }, 10000);

            // wait until request is started
            const unsubscribe = store.subscribe(() => {
                const state = store.getState();
                const requestType = state.request.requestType;
                if (requestType) {
                    window.app = new (XKeyguard(requestType))($appContainer);
                    unsubscribe();
                    clearTimeout(noRequestTimer);
                }
            });
        }

        // configure access control
        const defaultPolicies = [
            {
                origin: Config.origin('safe'),
                policy: new SafePolicy()
            },
            /*{
                origin: Config.origin('wallet'),
                policy: new WalletPolicy(1000)
            },*/
            {
                origin: Config.origin('miner'),
                policy: new MinerPolicy()
            }
        ];

        // cancel request when window is closed
        self.onunload = () => {
            const { reject, result }  = store.getState().request;
            if (reject && !result){
                reject(new Error('Keyguard window was closed.'));
            }
        };

        // cancel request and close window when there is an error
        if (!Config.devMode) {
            self.onerror = (error) => {
                const { reject } = store.getState().request;
                if (reject) {
                    reject(error);
                    self.close();
                }
            };

            // cancel request and close window when there is an unhandled promise rejection
            self.onunhandledrejection = (event) => {
                const { reject } = store.getState().request;
                if (reject) {
                    reject(new Error(event.reason));
                    self.close();
                }
            };
        }


        // start postMessage RPC server
        this._api = RPC.Server(ACL.addAccessControl(
            KeyguardApi, () => store.getState(), defaultPolicies
        ), true, KeyguardApi.RPC_WHITELIST.concat(ACL.RPC_WHITELIST));

        // tell calling window that we are ready
        const client = self === top ? self.opener :  self.parent;
        client.postMessage('ready', '*');
    }
}

(async function() {
    if (window.Nimiq) {
        await Nimiq.loadOffline();
        Nimiq.GenesisConfig[Config.network]();
    }
    window.keyguard = new Keyguard();
})();

}());
