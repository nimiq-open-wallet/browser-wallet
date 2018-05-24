import XElement from '/libraries/x-element/x-element.js';
import ValidationUtils from '/libraries/secure-utils/validation-utils/validation-utils.js';

export default class XAddressNoCopy extends XElement {
    styles() { return ['x-address'] }

    listeners() {
        return {
            'click': this._onCopy
        }
    }

    set address(address) {
        if (ValidationUtils.isValidAddress(address)) {
            this.$el.textContent = address;
        } else {
            this.$el.textContent = '';
        }
    }
}
