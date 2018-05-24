import MixinModal from '/elements/mixin-modal/mixin-modal.js';
import XElement from '/libraries/x-element/x-element.js';
import XAddress from '/elements/x-address/x-address.js';
import XAccountsDropdown from '../x-accounts/x-accounts-dropdown.js';
import { spaceToDash } from '/libraries/nimiq-utils/parameter-encoding/parameter-encoding.js';
import share from '/libraries/web-share-shim/web-share-shim.nimiq.min.js';

export default class XCreateRequestLinkModal extends MixinModal(XElement) {
    html() {
        return `
            <div class="modal-header">
                <i x-modal-close class="material-icons">close</i>
                <h2>Create Transaction Request</h2>
            </div>
            <div class="modal-body">
                <div class="center">
                    <x-accounts-dropdown name="recipient"></x-accounts-dropdown>
                    <ul>
                        <li>
                            <div>Copy your address:</div>
                            <x-address></x-address>
                        </li>
                        <li>
                            <div>OR use the following link to request a transaction:</div>
                            <div class="x-request-link"></div>
                        </li>
                    </ul>
                </div>
            </div>
        `;
    }

    children() {
        return [ XAddress, XAccountsDropdown ];
    }

    onCreate() {
        navigator.share = share;
        super.onCreate();
    }

    listeners() {
        return {
            'x-account-selected': this._onAccountSelected.bind(this),
            'click .x-request-link': () => navigator.share({
                title: 'Nimiq Transaction Request',
                text: 'Please send me Nimiq using this link:',
                url: this._link
            })
        }
    }

    _onAccountSelected(address) {
        this._setAccount(address);
    }

    _setAccount(address) {
        this.$address.address = address;

        const $requestLink = this.$('.x-request-link');

        this._link = `${ this.attributes.dataXRoot }/#_request/${spaceToDash(address)}_`;

        $requestLink.textContent = this._link;
    }
}
