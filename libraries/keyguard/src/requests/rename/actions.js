import { RequestTypes, setExecuting, setResult, setData } from '../request-redux.js';
import { keyStore } from '../../keys/index.js';

export function rename(passphrase, label) {
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