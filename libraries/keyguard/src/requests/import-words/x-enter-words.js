import XElement from '/libraries/x-element/x-element.js';
import XMnemonicInput from '/secure-elements/x-mnemonic-input/x-mnemonic-input.js';
import MixinRedux from '/secure-elements/mixin-redux/mixin-redux.js';
import { RequestTypes, deny, setData } from '/libraries/keyguard/src/requests/request-redux.js';

// TODO remove for production
import MnemonicPhrase from '/libraries/mnemonic-phrase/mnemonic-phrase.min.js';
window.test = async () => {
    const randomKey = window.crypto.getRandomValues(new Uint8Array(32));
    const hexKey = MnemonicPhrase._arrayToHex(randomKey);
    const testPassphrase = MnemonicPhrase.keyToMnemonic(hexKey).split(' ');
    function putWord(field, word, index) {
        setTimeout(() => {
            field.$input.value = word;
            field._value = word;
            field.__onValueChanged({type: 'blur'});
        }, index * 50);
    }
    const $mnemonicInput = document.body.querySelector('x-mnemonic-input').xDebug
    $mnemonicInput.$fields.forEach((field, index) => {
        putWord(field, testPassphrase[index], index);
    });
};

export default class XEnterWords extends MixinRedux(XElement) {

    html() { return `
        <h1>Account Recovery</h1>
        <h2>Please enter your 24 Account Recovery Words.</h2>
        <x-grow></x-grow>
        <x-mnemonic-input class="x-recovery-phrase"></x-mnemonic-input>
        <p class="pad-bottom">
            Press <code>Space</code> or <code>Tab</code> at the end of a word to jump to the next field.
        </p>
        <x-grow x-grow="2"></x-grow>
        `;
    }

    children() {
        return [ XMnemonicInput ];
    }

    static get actions() {
        return { deny, setData };
    }

    listeners() {
        return {
            'x-mnemonic-input': this._onSuccess.bind(this)
        }
    }

    _onSuccess(hexKey) {
        this.actions.setData(RequestTypes.IMPORT_FROM_WORDS, { hexKey });
        this.fire('x-enter-words');
    }
}
