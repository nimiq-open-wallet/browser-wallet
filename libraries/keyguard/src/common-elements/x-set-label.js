import XElement from '/libraries/x-element/x-element.js';
import XMyAccount from '/libraries/keyguard/src/common-elements/x-my-account.js';

export default class XSetLabel extends XElement {

    html() { return `
        <h1>Name your Account</h1>
        <h2>This name is only visible to you</h2>
        <x-grow></x-grow>
        <x-my-account></x-my-account>
        <x-grow></x-grow>
        <input type="text" placeholder="Account name">
        <x-grow x-grow="2"></x-grow>
        <button>Confirm</button>
        `;
    }

    children() {
        return [ XMyAccount ];
    }

    onCreate() {
        this.$input = this.$('input');
    }

    listeners() {
        return {
            'click button': e => this.fire('x-set-label', this.$input.value)
        }
    }

    onEntry() {
        this.$('input').focus();
    }
}
