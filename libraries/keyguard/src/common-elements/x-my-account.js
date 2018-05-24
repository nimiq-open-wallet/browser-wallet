import MixinRedux from '/secure-elements/mixin-redux/mixin-redux.js';
import XAccount from './x-account.js';

export default class XMyAccount extends MixinRedux(XAccount) {
    static mapStateToProps(state) {
        return Object.assign({},
            state.request.data
        )
    }
}