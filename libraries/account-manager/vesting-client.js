import networkClient from '/apps/safe/src/network-client.js';

export default class VestingClient {
    static async create() {
        const network = (await networkClient).rpcClient;
        return new VestingClient(network);
    }

    constructor(network) {
        this.network = network;
        this._contracts = new Map();
    }

    async find(addresses) {
        if (!this._contracts.size) await this._getContracts();

        const foundContracts = [];

        for (const contract of this._contracts) {
            // TODO Remove for proper genesis block!
            foundContracts.push(contract); break;

            if (!addresses.includes(contract.owner)) continue;
        }

        return foundContracts;
    }

    async _getContracts() {
        this._contracts = await network.getGenesisVestingContracts();
    }

}
