import Key from './key.js';
import { RequestTypes } from '../requests/request-redux.js';

export const TypeKeys = {
    ADD: 'keys/add',
    CLEAR: 'keys/clear'
};

export function reducer(state, action) {
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

export function clearVolatile() {
    return {
        type: TypeKeys.CLEAR,
        requestType: RequestTypes.CREATE
    }
}

export function createVolatile(number) {
    const keys = [];

    for (let i = 0; i < number; i++) {
        const keyPair = Nimiq.KeyPair.generate();
        const key = new Key(keyPair);
        keys.push(key);
    }

    return {
        type: TypeKeys.ADD,
        payload: keys,
        requestType: RequestTypes.CREATE
    }
}
