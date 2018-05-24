import Reflection from '/libraries/secure-utils/reflection/reflection.js';
import Policy from './policy.js';
import UI from '../ui.js';
import { NoUIError } from '../errors/index.js';

export default class ACL {
    static get STORAGE_KEY() {
        return 'policies';
    }

    static addAccessControl(clazz, getState, defaultPolicies) {
        const ClassWithAcl = class {
            constructor() {
                this._isEmbedded = self !== top;

                const storedPolicies = self.localStorage.getItem(ACL.STORAGE_KEY);
                /** @type {Map<string,Policy> */
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
