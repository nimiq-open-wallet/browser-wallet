import XPassphraseInput from '../x-passphrase-input/x-passphrase-input.js';
import XPassphraseIndicator from '../x-passphrase-indicator/x-passphrase-indicator.js';
import XElement from '/libraries/x-element/x-element.js';

export default class XPassphraseGetter extends XElement {
    html() {
        const { buttonLabel } = this.attributes;

        return `
            <x-passphrase-input></x-passphrase-input>
            <x-grow></x-grow>
            <button>${ buttonLabel || 'Confirm' }</button>
        `;
    }

    onCreate() {
        this.$button = this.$('button');
        // TODO is it correct to disable autocompletion and force users to re-enter password?
        this.$('input').setAttribute('autocomplete', 'off');
    }

    children() {
        return [ XPassphraseInput, XPassphraseIndicator];
    }

    listeners() {
        return {
            'click button': e => this._onPassphraseSubmit(),
            'keydown input': (d, e) => { if (e.keyCode == 13) this._onPassphraseSubmit() }
        }
    }

    focus() {
        this.$passphraseInput.focus();
    }

    wrongPassphrase() {
        this.$passphraseInput.setInvalid();
    }


    get value() {
        return this.$passphraseInput.value;
    }

    _onPassphraseSubmit() {
        this.fire(this.__tagName + '-submitted', this.value);
    }
}
