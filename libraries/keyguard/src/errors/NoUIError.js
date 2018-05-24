export default class NoUIError extends Error {

    static get code() {
        return 'K2';
    }

    constructor(method) {
        super(`Method ${method} needs user interface`);
    }
}