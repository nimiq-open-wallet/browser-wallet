import XElement from '/libraries/x-element/x-element.js';
import XMyAccount from '/libraries/keyguard/src/common-elements/x-my-account.js';
import XAccount from '/libraries/keyguard/src/common-elements/x-account.js';
import XAuthenticate from '/libraries/keyguard/src/common-elements/x-authenticate.js';
import MixinRedux from '/secure-elements/mixin-redux/mixin-redux.js';
import { RequestTypes, setData } from '/libraries/keyguard/src/requests/request-redux.js';
import { signTransaction } from './actions.js';

export default class XSign extends MixinRedux(XElement) {

    html() { return `
        <h1>Transaction</h1>
        <x-my-account></x-my-account>
        <i class="material-icons">arrow_downward</i>
        <x-account></x-account>
        <div class="x-value"><span class="value"></span> NIM</div>
        <div class="x-fee"><span class="fee"></span> Fee</div>
        <x-authenticate button-label="Confirm"></x-authenticate>
        `;
    }

    children() {
        return [ XAccount, XMyAccount, XAuthenticate ];
    }

    static mapStateToProps(state) {
        return {
            requestType: state.request.requestType,
            transaction: state.request.data.transaction
        };
    }

    static get actions() {
        return { signTransaction, setData };
    }

    onAfterEntry() {
        setTimeout(() => this.$authenticate.focus(), 100);
    }

    _onPropertiesChanged(changes) {
        const { requestType } = this.properties;

        if (requestType !== RequestTypes.SIGN_TRANSACTION) return;

        const { transaction } = changes;

        if (transaction) {
            const { recipient, value, fee, validityStartHeight } = transaction;

            this.$account.address = recipient;

            this.$('.value').textContent = (value/1e5).toString();

            if (fee === 0) {
                this.$el.removeChild(this.$('.x-fee'));
            } else {
                this.$('.fee').textContent = (fee/1e5).toString();
            }
        }
    }

    listeners() {
        return {
            'x-authenticate-submitted': passphrase => this.actions.signTransaction(passphrase)
        }
    }
}
