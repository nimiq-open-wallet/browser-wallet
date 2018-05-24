import XElement from '/libraries/x-element/x-element.js';
import XMyAccount from '/libraries/keyguard/src/common-elements/x-my-account.js';
import XAuthenticate from '/libraries/keyguard/src/common-elements/x-authenticate.js';
import MixinRedux from '/secure-elements/mixin-redux/mixin-redux.js';
import { setData } from '/libraries/keyguard/src/requests/request-redux.js';
import { rename } from './actions.js';

export default class XRename extends MixinRedux(XElement) {

    html() { return `
        <h1>Rename your Account</h1>
        <x-grow></x-grow>
        <x-my-account></x-my-account>
        <x-grow></x-grow>
        <input id="label" type="text" placeholder="Account name">
        <x-grow></x-grow>
        <x-authenticate button-label="Save"></x-authenticate>
        `;
    }

    children() {
        return [ XMyAccount, XAuthenticate ];
    }

    onCreate() {
        this.$input = this.$('input#label');
        super.onCreate();
    }

    static get actions() {
        return { rename, setData };
    }

    static mapStateToProps(state) {
        return {
            label: state.request.data.label
        }
    }

    _onPropertiesChanged(changes) {
        if (changes.label) {
            this.$input.value = changes.label;
        }
    }

    listeners() {
        return {
            'x-authenticate-submitted': passphrase => this.actions.rename(passphrase, this.$input.value)
        }
    }

    onAfterEntry() {
        this.$input.focus();
    }
}
