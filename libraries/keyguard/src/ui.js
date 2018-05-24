/** - For third-party apps requesting access to keystore
 *  - For wallet app to set spending limit
 *  - Intended use: when receiving a sign(tx) request check if policy requests ui and here is a method with this name,
 *  then we call this method here fist. To be discussed
 */

export default class UI {
    static async requestAuthorize(policy, origin) {
        return new Promise(resolve => {
            resolve(confirm(`An app from origin ${origin} is requesting access. Do you want to grant it?`));
        })
    }
}