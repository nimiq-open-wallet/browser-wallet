export default class KeyNotFoundError extends Error {

    static get code() {
        return 'K1';
    }

    constructor() {
        super(`Key not found`);
    }
}