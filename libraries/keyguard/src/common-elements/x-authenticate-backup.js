import XElement from '/libraries/x-element/x-element.js';
import XAuthenticate from '/libraries/keyguard/src/common-elements/x-authenticate.js';
import XMyAccount from '/libraries/keyguard/src/common-elements/x-my-account.js';

export default class XAuthenticateBackup extends XElement {

    html() { return `
        <h1>Backup your Account</h1>
        <h2>Please enter your passphrase to backup your account.</h2>
        <x-grow x-grow="0.5"></x-grow>
        <x-my-account></x-my-account>
        <x-authenticate button-label="Backup"></x-authenticate>
        `;
    }

    children() {
        return [ XAuthenticate, XMyAccount ];
    }

    onAfterEntry() {
        this.$authenticate.focus();
    }
}
