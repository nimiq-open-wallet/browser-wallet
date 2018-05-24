import BasePolicy from './base-policy.js';
import KeyType from '../keys/key-type.js';

export default class SafePolicy extends BasePolicy {
    allows(method, args, state) {
        switch (method) {
            case 'importFromFile':
            case 'importFromWords':
            case 'backupFile':
            case 'backupWords':
            case 'list':
            case 'createVolatile':
            case 'create':
            case 'rename':
                return true;
            case 'sign':
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
                return false;
            case 'create':
            case 'importFromFile':
            case 'importFromWords':
            case 'backupFile':
            case 'backupWords':
            case 'sign':
            case 'rename':
                return true;
            default:
                throw new Error(`Unhandled method: ${method}`);
        }
    }
}
