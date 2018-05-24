import XElement from '/libraries/x-element/x-element.js';
import XAuthenticate from '/libraries/keyguard/src/common-elements/x-authenticate.js';
import XMyAccount from '/libraries/keyguard/src/common-elements/x-my-account.js';
import XShowWords from '/libraries/keyguard/src/common-elements/x-show-words.js';
import XRouter from '/secure-elements/x-router/x-router.js';
import XPrivacyAgent from '/secure-elements/x-privacy-agent/x-privacy-agent.js';
import XMnemonicPhrase from '/secure-elements/x-mnemonic-phrase/x-mnemonic-phrase.js';
import MixinRedux from '/secure-elements/mixin-redux/mixin-redux.js';
import { RequestTypes, setData, setResult } from '../request-redux.js';
import { backupWords } from './actions.js';

export default class XBackupWords extends MixinRedux(XElement) {

    html() { return `
        <x-show-words x-route="backup-words/words"></x-show-words>
        <x-authenticate-backup x-route="backup-words/authenticate"></x-authenticate-backup>
        <section x-route="backup-words">
            <h1>Backup your Account</h1>
            <x-privacy-agent></x-privacy-agent>
        </section>
        `;
    }

    children() {
        return [ XAuthenticate, XPrivacyAgent, XMnemonicPhrase, XMyAccount, XShowWords ];
    }

    static get actions() {
        return { setData, setResult, backupWords };
    }

    listeners() {
        return {
            'x-authenticate-submitted': passphrase => this.actions.backupWords(passphrase),
            'x-surrounding-checked': async () => (await XRouter.instance).root.goTo('backup-words/authenticate'),
            'x-show-words': () => this.actions.setResult(RequestTypes.BACKUP_WORDS, true)
        };
    }
}