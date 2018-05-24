import { RPC, EventClient } from '/libraries/boruca-messaging/src/boruca.js';
import Policy from '/libraries/keyguard/src/access-control/policy.js';
import { NoUIError } from '/libraries/keyguard/src/errors/index.js';

export default class KeyguardClient {
	static async create(src, assumedPolicy, getState, needUiCallback, usePopup = true) {
		const client = new KeyguardClient(src, getState, needUiCallback, usePopup);
		this._wrappedApi = await client._wrapApi();
		await client._authorize.bind(client)(assumedPolicy);
		return this._wrappedApi;
	}

    /**
	 * @private
	 *
     * @param {string} src URI of secure origin aka key guard aka key dude.
     * @param {() => StateObject} getState function which returns the state
     * @param {function} needUiCallback
     * @param {boolean} usePopup
     */
	constructor(src, getState, needUiCallback, usePopup = true) {
		this._keyguardSrc = src;
		this._keyguardOrigin = new URL(src).origin;
		this.popup = usePopup;
		this.$iframe = this._createIframe();
	    this.needUiCallback = needUiCallback;
	    this.publicApi = {};
		this.policy = null;
		this.getState = getState;
	}

	async _wrapApi() {
 		this.embeddedApi = await this._getApi(this.$iframe.contentWindow);

        for (const methodName of this.embeddedApi.availableMethods) {
            const normalMethod = this._proxyMethod(methodName);
			const secureMethod = this._proxySecureMethod(methodName);
            this.publicApi[methodName] = this._bindMethods(methodName, normalMethod, secureMethod);
        }

		// intercepting "authorize" and "getPolicy" for keeping an instance of the latest authorized policy
		// to predict if user interaction will be needed when calling API methods.
		const apiAuthorize = this.publicApi.authorize.secure;
		this.publicApi.authorize = async requiredPolicy => {
			const success = await apiAuthorize(requiredPolicy);
			this.policy = success ? requiredPolicy : null;
			return success;
		};

		const apiGetPolicy = this.publicApi.getPolicy;
		this.publicApi.getPolicy = async () => {
			return this.policy = Policy.parse(await apiGetPolicy());
		};

		return this.publicApi;
	}

	/** @param {string} methodName
	 *
	 * @returns {function} Trying to call this method in the iframe and open a window if user interaction is required.
	 * */
	_proxyMethod(methodName) {
		const proxy = async (...args) => {
			if (this.policy && !this.policy.allows(methodName, args, this.getState()))
				throw new Error(`Not allowed to call ${methodName}.`)

			try {
				// if we know that user interaction is needed, we'll do a secure request right away, i.e. a redirect/popup
				if (this.policy && this.policy.needsUi(methodName, args, this.getState()))
					return await proxy.secure(...args);

				return await this.embeddedApi[methodName](...args);
			}
			catch (error) {
				if (error.code === NoUIError.code) {
					if (this.needUiCallback instanceof Function) {
						return await new Promise((resolve, reject) => {
							this.needUiCallback(methodName, confirmed => {
								if (!confirmed) reject(new Error('Denied by user.'));
								resolve(proxy.secure.call(args));
							});
						});
					} else throw new Error(`User interaction is required to call "${ methodName }". You need to call this method from an event handler, e.g. a click event.`);
				}
				else throw error;
			}
		};

		return proxy;
	}

	/** @param {string} methodName
	 *
	 * @returns {function} Call this method in a new window
	 * */
	_proxySecureMethod(methodName) {
		return async (...args) => {
			if (this.popup) { // window.open
				const apiWindow = window.open(this._keyguardSrc);
				if (!apiWindow) throw new Error('Keyguard window could not be opened.');
				const secureApi = await this._getApi(apiWindow);
				const result = await secureApi[methodName](...args);
				apiWindow.close();
				return result;
			} else { // top level navigation
				const returnTo = encodeURIComponent(window.location);
				//window.location = `${ KeyguardClient.KEYGUARD_URL }?returnTo=${ returnTo }`;
				throw new Error('Top level navigation not implemented. Use a popup.');
			}
		}
	}

	_bindMethods(methodName, normalMethod, secureMethod) {
		const method = normalMethod;
		method.secure = secureMethod;
		method.isAllowed = () => (this.policy && this.policy.allows(methodName, arguments, this.getState()));
		return method;
	}

    async _authorize(assumedPolicy) {
        let grantedPolicy = await this.publicApi.getPolicy();
        grantedPolicy = grantedPolicy && Policy.parse(grantedPolicy);
        console.log('Got policy:', grantedPolicy);

        if (!assumedPolicy.equals(grantedPolicy)) {
            if (!await this.publicApi.authorize(assumedPolicy)) {
                throw new Error('Authorization failed.');
            }
        }
    }

	// _defaultUi(methodName) {
	// 	return new Promise((resolve, reject) => { resolve(window.confirm("You will be forwarded to securely confirm this action.")); });
	// }

	async _getApi(targetWindow) {
		return await RPC.Client(targetWindow, 'KeyguardApi', this._keyguardOrigin);
	}

	_createIframe(src) {
		const $iframe = document.createElement('iframe');
		$iframe.src = this._keyguardSrc;
		$iframe.name = 'keyguard';
		document.body.appendChild($iframe);
		return $iframe;
	}
}
