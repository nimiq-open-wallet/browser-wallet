import { RequestTypes, setExecuting, setResult, setError, setData } from '../request-redux.js';
import { Key, KeyType, keyStore } from '../../keys/index.js';
import XRouter from '/secure-elements/x-router/x-router.js';

export function createKey() {
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

            (await XRouter.instance).goTo('import-from-words/set-passphrase');

        } catch (e) {
            console.error(e);
            dispatch(
                setError(RequestTypes.IMPORT_FROM_WORDS, e)
            );
        }
    }
}

export function importFromWords() {
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