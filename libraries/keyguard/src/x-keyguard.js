import XElement from '/libraries/x-element/x-element.js';
import XRouter from '/secure-elements/x-router/x-router.js';
import XLoader from '/elements/x-loader/x-loader.js';
import XCreate from './requests/create/x-create.js';
import XImportWords from './requests/import-words/x-import-words.js';
import XImportFile from './requests/import-file/x-import-file.js';
import XSign from './requests/sign/x-sign.js';
import XBackupFile from './requests/backup-file/x-backup-file.js';
import XBackupWords from './requests/backup-words/x-backup-words.js';
import XRename from './requests/rename/x-rename.js';
import XClose from '/secure-elements/x-close/x-close.js';
import MixinRedux from '/secure-elements/mixin-redux/mixin-redux.js';

export default class XKeyguard extends MixinRedux(XElement) {

    html() {
        return `
        <x-loader></x-loader>
        <x-create></x-create>
        <x-backup-words></x-backup-words>
        <x-backup-file></x-backup-file>
        <x-import-file></x-import-file>
        <x-import-words></x-import-words>
        <div><x-sign x-route="sign-transaction"></x-sign></div>
        <div><x-rename x-route="rename"></x-rename></div>
        <x-close x-route="close"></x-close>
        <div><x-close x-route="/"></x-close></div>
        <a secondary x-href="close">
            <i class="material-icons">&#xE5C9;</i>
            Cancel
        </a>
        `;
    }

    children() {
        return [ XLoader, XRouter, XClose, XCreate, XImportWords, XRename,  XImportFile, XSign, XBackupWords, XBackupFile ];
    }

    static mapStateToProps(state) {
        return {
            executing: state.request.executing
        };
    }

    _onPropertiesChanged(changes) {
        if (changes.executing !== undefined) {
            this.$loader.loading = changes.executing;
        }
    }
}

// TODO what to do when the user reloads the page and the state is not initialized again?? > persist the state on unload
// that means we would have to put rpc requests in store and open new promises for unresponsed requests
