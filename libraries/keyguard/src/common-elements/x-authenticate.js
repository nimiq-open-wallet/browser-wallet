import XPassphraseGetter from '/secure-elements/x-passphrase-getter/x-passphrase-getter.js';
import MixinRedux from '/secure-elements/mixin-redux/mixin-redux.js';

export default class XAuthenticate extends MixinRedux(XPassphraseGetter) {

    styles() {
        return [ 'x-passphrase-input' ];
    }

    static mapStateToProps(state) {
        return {
            isWrongPassphrase: state.request.data.isWrongPassphrase
        };
    }

    _onPropertiesChanged(changes) {
        if (changes.isWrongPassphrase) {
            this.wrongPassphrase();
        }
    }
}