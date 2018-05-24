import RPC from './rpc.js';

export default class EventServer {
    constructor() {
        this._listeners = new Map();
        const that = this;
        RPC.Server(class EventRPCServer {
            on({ callingWindow, callingOrigin }, event) {
                if (!that._listeners.get(event)) {
                    that._listeners.set(event, new Map());
                }
                that._listeners.get(event).set(callingWindow, callingOrigin);
            }

            off({ callingWindow, callingOrigin }, event) {
                const eventEntry = that._listeners.get(event)
                if (eventEntry.get(callingWindow) !== callingOrigin) return;

                eventEntry.delete(callingWindow);
                if (that._listeners.get(event).length === 0) {
                    that._listeners.delete(event);
                }
            }

            onConnected() {
                that.onConnected();
            }
        }, true);
    }

    fire(event, value) {
        if (!this._listeners.get(event)) return;

        for (const [callingWindow, callingOrigin] of this._listeners.get(event)) {
            callingWindow.postMessage({event, value}, callingOrigin);
        }
    }

    onConnected() { }
}
