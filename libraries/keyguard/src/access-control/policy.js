import WalletPolicy from './wallet-policy.js';
import SafePolicy from './safe-policy.js';

export default class Policy {

    static parse(serialized) {
        if (!serialized) return null;
        const policy = Policy.get(serialized.name)
        for (const prop in serialized) policy[prop] = serialized[prop];
        return policy;
    }

    static get(name, ...args) {
        if (!Policy.predefined.hasOwnProperty(name)) throw `Policy "${name} does not exist."`
        return new Policy.predefined[name](...args);
    }
}

Policy.predefined = {};
for (const policy of [WalletPolicy, SafePolicy]) {
    Policy.predefined[policy.name] = policy;
}
