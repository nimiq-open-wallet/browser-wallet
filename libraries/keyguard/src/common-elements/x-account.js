import XElement from '/libraries/x-element/x-element.js';
import XIdenticon from '/secure-elements/x-identicon/x-identicon.js';
import XAddressNoCopy from '/secure-elements/x-address-no-copy/x-address-no-copy.js';

export default class XAccount extends XElement {
    html() {
        return `
            <x-identicon></x-identicon>
            <div class="x-account-info">
                <div class="x-account-label"></div>
                <x-address-no-copy></x-address-no-copy>
            </div>
        `
    }

    children() { return [XIdenticon, XAddressNoCopy ] }

    onCreate() {
        this.$label = this.$('.x-account-label');
        super.onCreate();
    }

    listeners() {
        return {
            'click': this._onAccountSelected
        }
    }

    _onPropertiesChanged(changes) {
        for (const prop in changes) {
            if (changes[prop] !== undefined) {
                // Update display
                this[prop] = changes[prop];
            }
        }
    }

    set label(label) {
        this.$label.textContent = label;
    }

    set address(address) {
        this.$identicon.address = address;
        this.$addressNoCopy.address = address;
        this._address = address;
    }

    set account(account) {
        this.setProperties(account, true);
    }
}
