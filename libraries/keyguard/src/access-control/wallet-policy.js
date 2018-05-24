import BasePolicy from './base-policy.js';
import KeyType from '../keys/key-type.js';

export default class WalletPolicy extends BasePolicy {
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
            case 'createVolatile':
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
                const { account, recipient, value, fee } = args;
                if (value + fee > this._limit) return true;
                return false;
            default:
                throw new Error(`Unhandled method: ${method}`);
        }
    }
}

// todo update
