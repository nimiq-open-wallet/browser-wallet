import XElement from '/libraries/x-element/x-element.js';
import XSetLabel from '/libraries/keyguard/src/common-elements/x-set-label.js';
import XSetPassphrase from '/libraries/keyguard/src/common-elements/x-set-passphrase.js';
import XEnterWords from './x-enter-words.js';
import MixinRedux from '/secure-elements/mixin-redux/mixin-redux.js';
import { RequestTypes, setData } from '../request-redux.js';
import { createKey, importFromWords } from './actions.js';
import XRouter from '/secure-elements/x-router/x-router.js';

export default class XImportWords extends MixinRedux(XElement) {

    // todo fix router, so we can fix order. Last should be first
    html() { return `
          <x-set-label x-route="import-from-words/set-label"></x-set-label>
          <x-set-passphrase x-route="import-from-words/set-passphrase"></x-set-passphrase>
          <x-enter-words x-route="import-from-words"></x-enter-words>
        `;
    }

    children() {
        return [ XSetLabel, XEnterWords, XSetPassphrase ];
    }

    static get actions() {
        return { setData, createKey, importFromWords };
    }

    listeners() {
        return {
            'x-enter-words': this._onEnterWords.bind(this),
            'x-set-passphrase': this._onSetPassphrase.bind(this),
            'x-set-label': this._onSetLabel.bind(this)
        }
    }

    _onEnterWords() {
        this.actions.createKey();
    }

    async _onSetPassphrase(passphrase) {
        this.actions.setData(RequestTypes.IMPORT_FROM_WORDS, { passphrase });
        (await XRouter.instance).goTo('import-from-words/set-label');
    }

    _onSetLabel(label) {
        this.actions.setData(RequestTypes.IMPORT_FROM_WORDS, { label });
        this.actions.importFromWords();
    }
}
