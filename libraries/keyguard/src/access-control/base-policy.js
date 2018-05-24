export default class BasePolicy {
   constructor() {
      this.name = this.constructor.name;
   }

    equals(otherPolicy) {
        return otherPolicy && this.name === otherPolicy.name;
    }

    serialize() {
        const serialized = {};

        for (const prop in this)
            if (!(this[prop] instanceof Function)) serialized[prop] = this[prop];

        return serialized;
    }

    allows(method, args) {
        throw 'Make your own policy by extending Policy and overwrite me'
    }

    needsUi(method, args) {
        throw 'Make your own policy by extending Policy and overwrite me'
    }
}
