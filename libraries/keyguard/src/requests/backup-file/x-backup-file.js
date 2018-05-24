import XElement from '/libraries/x-element/x-element.js';
import MixinRedux from '/secure-elements/mixin-redux/mixin-redux.js';
import XDownloadFile from '/libraries/keyguard/src/common-elements/x-download-file.js';
import XAuthenticateBackup from '/libraries/keyguard/src/common-elements/x-authenticate-backup.js';
import { RequestTypes, setResult } from '../request-redux.js';
import { backupFile } from './actions.js';

export default class XBackupFile extends MixinRedux(XElement) {

    html() { return `
        <x-download-file x-route="backup-file/download"></x-download-file>
        <x-authenticate-backup x-route="backup-file"></x-authenticate-backup>
        `;
    }

    children() {
        return [ XAuthenticateBackup, XDownloadFile ];
    }

    static get actions() {
        return { backupFile, setResult };
    }

    listeners() {
        return {
            'x-authenticate-submitted': this._onSubmit.bind(this),
            'x-file-download-complete': this._onFileDownload.bind(this)
        };
    }

    _onSubmit(passphrase) {
        this.actions.backupFile(passphrase);
    }

    _onFileDownload() {
        this.actions.setResult(RequestTypes.BACKUP_FILE, true);
    }
}
