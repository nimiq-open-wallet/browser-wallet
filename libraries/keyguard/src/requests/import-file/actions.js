import { RequestTypes, setExecuting, setResult, setData, loadAccountData, setError } from '../request-redux.js';
import { Key, KeyType, keyStore } from '../../keys/index.js';
import XRouter from '/secure-elements/x-router/x-router.js';

// called after entering the passphrase
export function decrypt() {
    return async (dispatch, getState) => {
        dispatch( setExecuting(RequestTypes.IMPORT_FROM_FILE) );

        // get encrypted key from request data set with _startRequest in keyguard-api
        const { encryptedKeyPair64, passphrase } = getState().request.data;

        try {
            const encryptedKeyPair = Nimiq.BufferUtils.fromBase64(encryptedKeyPair64);

            // test if we can decrypt
            const key = await Key.loadEncrypted(encryptedKeyPair, passphrase);

            dispatch(
                setData(RequestTypes.IMPORT_FROM_FILE, Object.assign({}, key.getPublicInfo()) )
            );

            (await XRouter.instance).goTo('import-from-file/set-label');

        } catch (e) {
            console.error(e);
            // assume the password was wrong
            dispatch(
                setData(RequestTypes.IMPORT_FROM_FILE, { isWrongPassphrase: true })
            );
        }
    }
}


export function importFromFile() {
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