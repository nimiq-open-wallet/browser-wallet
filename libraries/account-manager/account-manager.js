import KeyguardClient from './keyguard-client.js';
import VestingClient from './vesting-client.js';
import SafePolicy from '/libraries/keyguard/src/access-control/safe-policy.js';
import SafeConfig from '/apps/safe/src/config.js';
import { bindActionCreators } from '/libraries/redux/src/index.js';
import { addAccount, setAllKeys, updateLabel } from '/elements/x-accounts/accounts-redux.js';
import MixinRedux from '/secure-elements/mixin-redux/mixin-redux.js';
import XToast from '/secure-elements/x-toast/x-toast.js';

class AccountManager {
    static getInstance() {
        this._instance = this._instance || new Promise(async resolve => {

            const [keyguardClient, ledgerClient, vestingClient, accountStore] = await Promise.all([
                /* KeyguardClient */ KeyguardClient.create(SafeConfig.keyguardSrc, new SafePolicy(), () => {}),
                /* LedgerClient */ null,
                /* VestingClient */ VestingClient.create(),
                /* AccountStore */ { get: (address) => MixinRedux.store.getState().accounts.entries.get(address) }
            ]);

            this._instance = new AccountManager(keyguardClient, ledgerClient, vestingClient, accountStore);
            window.accountManager = this._instance;
            resolve(this._instance);
        });

        return this._instance;
    }

    constructor(keyguardClient, ledgerClient, vestingClient, accountStore) {
        this.keyguard = keyguardClient;
        this.ledger = ledgerClient;
        this.vesting = vestingClient;
        this.accounts = accountStore;

        this._bindStore();

        // Kick off writing accounts to the store
        this._populateAccounts();
    }

    _bindStore() {
        this.store = MixinRedux.store;

        this.actions = bindActionCreators({
            addAccount,
            setAllKeys,
            updateLabel
        }, this.store.dispatch);
    }

    async _populateAccounts() {
        const keyguardKeys = (await this.keyguard.list())
            .map(key => Object.assign({}, key, {
                type: key.type === 'high' ? AccountManager.TYPE.KEYGUARD_HIGH : AccountManager.TYPE.KEYGUARD_LOW
            }));

        let vestingKeys;
        if (keyguardKeys.length) {
            vestingKeys = (await this.vesting.find(keyguardKeys.map(key => key.address)))
                .map((key, i) => Object.assign({}, key, {
                    type: AccountManager.TYPE.VESTING,
                    label: `Vesting Contract`
                }));
        }
        else vestingKeys = [];
        // console.log("Found contracts:", vestingKeys);

        const keys = keyguardKeys.concat(vestingKeys);

        this.actions.setAllKeys(keys);
    }

    /// PUBLIC API ///

    async create() {
        // TODO Show UI for choice between Keyguard and Ledger account creation
        const newKey = await this._invoke('create', {type: AccountManager.TYPE.KEYGUARD_HIGH});
        newKey.type = newKey.type === 'high' ? AccountManager.TYPE.KEYGUARD_HIGH : AccountManager.TYPE.KEYGUARD_LOW;
        this.actions.addAccount(newKey);
        XToast.show('Account created successfully');
    }

    async sign(tx) {
        const account = this.accounts.get(tx.sender);
        return this._invoke('sign', account, tx);
        // Status message is handled by calling code
    }

    async rename(address) {
        const account = this.accounts.get(address);
        const label = await this._invoke('rename', account, address);
        this.actions.updateLabel(account.address, label);
        XToast.show('Account renamed successfully');
    }

    async backupFile(address) {
        const account = this.accounts.get(address);
        this._invoke('backupFile', account, address);
    }

    async backupWords(address) {
        const account = this.accounts.get(address);
        this._invoke('backupWords', account, address);
    }

    async importFile() {
        try {
            const newKey = await this.keyguard.importFromFile();
            newKey.type = newKey.type === 'high' ? AccountManager.TYPE.KEYGUARD_HIGH : AccountManager.TYPE.KEYGUARD_LOW;
            this.actions.addAccount(newKey);
            XToast.show('Account imported successfully');
        } catch (e) {
            // todo how to show error to user?
            console.error(e);
            XToast.show(e.message || e);
        }
    }

    async importWords() {
        try {
            const newKey = await this.keyguard.importFromWords();
            newKey.type = newKey.type === 'high' ? AccountManager.TYPE.KEYGUARD_HIGH : AccountManager.TYPE.KEYGUARD_LOW;
            this.actions.addAccount(newKey);
            XToast.show('Account imported successfully');
        } catch (e) {
            // todo how to show error to user?
            console.error(e);
            XToast.show(e.message || e);
        }
    }

    // signMessage(msg, address) {
    //     throw new Error('Not implemented!'); return;

    //     const account = this.accounts.get(address);
    //     this._invoke('signMessage', account);
    // }

    _invoke(method, account, ...args) {
        // method = methodDict[method][account.type];
        // if (!method) throw new Error(`Method >${method}< not defined for accounts of type ${account.type}!`);

        switch (account.type) {
            case AccountManager.TYPE.KEYGUARD_HIGH:
                return this.keyguard[method](...args);
            case AccountManager.TYPE.LEDGER:
                return this.ledgerClient[method](...args);
            case AccountManager.TYPE.VESTING:
                return this.vestingClient[method](...args);
            default:
                throw new Error(`Account type ${account.type} not in use!`);
        }
    }
}

AccountManager.TYPE = {
    KEYGUARD_HIGH: 1,
    KEYGUARD_LOW: 2,
    LEDGER: 3,
    VESTING: 4
};

export default AccountManager.getInstance();

// export default methodDict = {
//     'sign': {
//         1: 'sign',
//         2: null,
//         3: null
//     },
//     'rename': {
//         1: 'rename',
//         2: null,
//         3: null
//     },
//     'export': {
//         1: 'export',
//         2: null,
//         3: null
//     },
//     'signMessage': {
//         1: 'signMessage',
//         2: null,
//         3: null
//     }
// }
