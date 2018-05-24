import { keyStore } from '../keys/index.js';

// Requests which need UI
export const RequestTypes = {
    SIGN_TRANSACTION: 'sign-transaction',
    SIGN_MESSAGE: 'sign-message',
    CREATE: 'create',
    IMPORT_FROM_FILE: 'import-from-file',
    IMPORT_FROM_WORDS: 'import-from-words',
    BACKUP_FILE: 'backup-file',
    BACKUP_WORDS: 'backup-words',
    RENAME: 'rename'
};

// basic action types
export const TypeKeys = {
    START: 'request/start',
    SET_DATA: 'request/setData',
    SET_EXECUTING: 'request/executing',
    SET_RESULT: 'request/result',
    SET_ERROR: 'request/error',
};

export const SATOSHIS = 1e5;

export function reducer(state, action) {
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
    if (action.type !== TypeKeys.START && state.requestType !== action.requestType) {
        return {
            error: new Error('Request type does not match')
        };
    }

    // describe state changes for each possible action
    switch (action.type) {
        case TypeKeys.START:
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

            case TypeKeys.SET_DATA:
                return Object.assign({}, state, {
                    executing: false,
                    data: Object.assign({},
                        state.data,
                        action.data
                    )
                });

            case TypeKeys.SET_EXECUTING:
                return Object.assign({}, state, {
                    executing: true,
                    data: Object.assign({},
                        state.data,
                        { isWrongPassphrase: false }
                    )
                });

            case TypeKeys.SET_RESULT:
                return Object.assign({}, state, {
                    result: action.result
                });

            case TypeKeys.SET_ERROR:
                return Object.assign({}, state, {
                    error: action.error
                });

            default:
                return state
        }
}

export function start(requestType, reject, data) {
    return {
        type: TypeKeys.START,
        requestType,
        reject,
        data
    };
}

export function setData(requestType, data) {
    return {
        type: TypeKeys.SET_DATA,
        requestType,
        data
    };
}

export function deny(requestType) {
    return setError(requestType, new Error('Denied by user'));
}

export function setResult(requestType, result) {
    return {
        type: TypeKeys.SET_RESULT,
        requestType,
        result
    }
}

export function setError(requestType, error) {
    return {
        type: TypeKeys.SET_ERROR,
        requestType,
        error
    }
}

export function setExecuting(requestType) {
    return {
        type: TypeKeys.SET_EXECUTING,
        requestType
    }
}

// load key info to data, so we can show it in UI.
export function loadAccountData(requestType) {
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


