import { RequestTypes, setExecuting, setResult, setData } from '../request-redux.js';
import { keyStore } from '../../keys/index.js';
import XRouter from '/secure-elements/x-router/x-router.js';

export function backupWords(passphrase) {
    return async (dispatch, getState) => {
        dispatch( setExecuting(RequestTypes.BACKUP_WORDS) );

        try {
            const key = await keyStore.get(getState().request.data.address, passphrase);

            dispatch(
                setData(RequestTypes.BACKUP_WORDS, { privateKey: key.keyPair.privateKey.toHex() })
            );

            (await XRouter.instance).goTo('backup-words/words');
        } catch (e) {
            console.error(e);
            // assume the password was wrong
            dispatch(
                setData(RequestTypes.BACKUP_WORDS, { isWrongPassphrase: true })
            );
        }
    }
}