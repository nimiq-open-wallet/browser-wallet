import XElement from '/libraries/x-element/x-element.js';

export default class XNoRequest extends XElement {

    html() {
        return `
            <x-grow></x-grow>
            <h1>408: Request Timeout</h1>
            <h2>Please start at <a href="https://nimiq.com/">nimiq.com</a></h2>
            <x-grow></x-grow>
        `;
    }
}
