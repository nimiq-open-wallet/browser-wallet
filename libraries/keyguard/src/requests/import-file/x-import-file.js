import XElement from '/libraries/x-element/x-element.js';
import XRouter from '/secure-elements/x-router/x-router.js';
import XAccountBackupImport from '/secure-elements/x-account-backup-import/x-account-backup-import.js';
import XSetLabel from '/libraries/keyguard/src/common-elements/x-set-label.js';
import XDecrypt from './x-decrypt.js';
import MixinRedux from '/secure-elements/mixin-redux/mixin-redux.js';
import { RequestTypes, setData } from '/libraries/keyguard/src/requests/request-redux.js';
import { importFromFile, decrypt } from './actions.js';

export default class XImportFile extends MixinRedux(XElement) {

    html() {
        return `
            <x-set-label x-route="import-from-file/set-label"></x-set-label>
            <x-decrypt x-route="import-from-file/decrypt"></x-decrypt>
            <section x-route="import-from-file">
                <h1>Import Access File</h1>
                <x-grow></x-grow>
                <x-account-backup-import></x-account-backup-import>
                <x-grow></x-grow>
            </section>
        `
    }

    children() {
        return [ XAccountBackupImport, XSetLabel, XDecrypt ];
    }

    async onCreate() {
        super.onCreate();
        this.router = await XRouter.instance;
    }

    static get actions() {
        return { setData, importFromFile, decrypt };
    }

    listeners() {
        return {
            'x-read-file': this._onReadFile.bind(this),
            'x-decrypt': this._onDecrypt.bind(this),
            'x-set-label': this._onSetLabel.bind(this)
        }
    }

    _onReadFile(encryptedKeyPair64) {
        this.actions.setData(RequestTypes.IMPORT_FROM_FILE, { encryptedKeyPair64 });
        this.router.goTo('import-from-file/decrypt');
    }

    _onDecrypt() {
        this.actions.decrypt();
    }

    _onSetLabel(label) {
        this.actions.setData(RequestTypes.IMPORT_FROM_FILE, { label });
        this.actions.importFromFile();
    }
}
