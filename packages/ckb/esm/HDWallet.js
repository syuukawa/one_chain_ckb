import { fromSeed } from 'bip32';
import { NetworkError, OneChainError, RPCError } from '@onechain/core';
import { logger } from './log';
import * as helper from './helper';
/**
 * HDWallet
 *
 * @export
 * @class HDWallet
 */
export class HDWallet {
    constructor() {
        this.logger = logger;
        this.helper = helper;
        // batch request size, default is 100 addresses per request
        this._batchSize = 100;
        // gap limit in bip44
        this._gapLimit = 20;
        // change addresses
        this._change = [];
        // receiving addresses
        this._receiving = [];
    }
    get mnemonic() {
        return this._mnemonic;
    }
    get path() {
        return this._path;
    }
    get receiving() {
        return this._receiving;
    }
    get change() {
        return this._change;
    }
    async init({ mnemonic, path, rpcnode, apiProvider }) {
        this.logger.info('HDWallet.init');
        this._mnemonic = mnemonic;
        this._rpcnode = rpcnode;
        this._apiProvider = apiProvider;
        this._network = this.helper.getNetworkByChainId(this._rpcnode.chainId);
        !PROD && this.logger.debug('HDWallet.init:', mnemonic);
        const seedStr = this.helper.mnemonicToSeedSync(mnemonic);
        !PROD && this.logger.trace('HDWallet.init bip39 seed:', seedStr);
        const seed = Buffer.from(seedStr, 'hex');
        this._root = fromSeed(seed);
        !PROD && this.logger.trace('HDWallet.init root key:', this._root.toBase58());
        if (this.helper.isArray(path)) {
            if (path.length > 1) {
                this._path = await this._findUsedPath({ path });
            }
            else {
                this._path = path[0];
            }
        }
        else {
            this._path = path;
        }
        return this;
    }
    /**
     * Create HD wallet from JSON
     *
     * @static
     * @param {any} data
     * @param {RPCNode} rpcnode
     * @param {IUTXOApiProvider} apiProvider
     * @return {Promise<HDWallet>}
     */
    static async fromJSON({ data, rpcnode, apiProvider }) {
        const wallet = new this();
        await wallet.init({ mnemonic: data.mnemonic, path: data.path, rpcnode, apiProvider });
        wallet.recover({ receiving: data.receiving, change: data.change });
        return wallet;
    }
    /**
     * Create HD wallet from mnemonic
     *
     * @static
     * @param {string} mnemonic
     * @param {string|string[]} path
     * @param {RPCNode} rpcnode
     * @param {IUTXOApiProvider} apiProvider
     * @param {boolean} [needSync=true]
     * @param {boolean} [syncFromStart=false]
     * @return {Promise<HDWallet>}
     */
    static async fromMnemonic({ mnemonic, path, rpcnode, apiProvider, needSync = true, syncfromStart = false }) {
        const wallet = new this();
        await wallet.init({ mnemonic, path, rpcnode, apiProvider });
        await wallet.derive({ needSync, syncfromStart });
        return wallet;
    }
    /**
     * Get all keypairs in HD wallet
     *
     * @param {string} [type=HDWallet.ADDRESS_ALL]
     * @return {IKeypair[]}
     */
    getKeypairs({ type = HDWallet.ADDRESS_ALL } = {}) {
        let ret = [];
        const getKeypair = (address) => {
            return {
                address: address.address,
                privateKey: this._getWIFFromAddress(address),
            };
        };
        if (type === HDWallet.ADDRESS_RECEIVING) {
            ret = this._receiving.map(getKeypair);
        }
        else if (type === HDWallet.ADDRESS_CHANGE) {
            ret = this._change.map(getKeypair);
        }
        else {
            ret = ret.concat(this._receiving.map(getKeypair));
            ret = ret.concat(this._change.map(getKeypair));
        }
        return ret;
    }
    /**
     * Initialize HDWallet
     *
     * @param {string|string[]} path
     * @param {boolean} needSync
     * @param {boolean} syncfromStart
     * @return Promise<void>
     */
    async derive({ needSync = true, syncfromStart = false }) {
        if (needSync) {
            this.logger.info('HDWallet.derive with sync');
            const [receiving, change] = await Promise.all([
                this._discover(this._path, '0', syncfromStart),
                this._discover(this._path, '1', syncfromStart),
            ]);
            this._receiving = this._receiving.concat(receiving);
            this._change = this._change.concat(change);
        }
        else {
            this.logger.info('HDWallet.derive without sync');
            this._receiving = this._derive(this._path, '0');
            this._change = this._derive(this._path, '1');
        }
    }
    /**
     * Recover status HD wallet from data
     *
     * @param {IAddressJSON[]} receiving
     * @param {IAddressJSON[]} change
     * @return void
     */
    recover({ receiving, change }) {
        this.logger.info('HDWallet.recover');
        const _deserialize = (val) => {
            var _a;
            const ecpair = this._getEcpairFromWIF(val.wif);
            return {
                index: val.index,
                address: val.address,
                txCount: val.txCount,
                balance: (_a = val.balance) !== null && _a !== void 0 ? _a : '0',
                ecpair,
            };
        };
        receiving.map(_deserialize).forEach((item) => {
            this._receiving[item.index] = item;
        });
        change.map(_deserialize).forEach((item) => {
            this._change[item.index] = item;
        });
    }
    toJSON() {
        const _serialize = (address) => {
            return {
                index: address.index,
                address: address.address,
                wif: this._getWIFFromAddress(address),
                publicKey: this._getPublicKeyFromAddress(address),
                privateKey: this._getPrivateKeyFromAddress(address),
                txCount: address.txCount,
                balance: address.balance,
            };
        };
        return {
            mnemonic: this._mnemonic,
            path: this._path,
            receiving: this._receiving.map(_serialize),
            change: this._change.map(_serialize),
        };
    }
    /**
     * Batch fetch addresses' information
     *
     * @protected
     * @param {BIP32} parent
     * @param {number} index
     * @param {number} gap
     * @param {IAddress[]} [fetchedAddress=[]]
     * @return {Promise<IAddress[]>}
     */
    async _batchFetchAddresses(parent, index, gap, fetchedAddress = []) {
        const addressesMap = {};
        for (let i = 0; i < this._batchSize; i++) {
            const node = parent.derive(index);
            const ecpair = this._getEcpairFromPrivateKey(node.privateKey);
            const address = this._getAddressFromEcpair(ecpair);
            addressesMap[address] = {
                index: index,
                address,
                txCount: 0,
                balance: '0',
                ecpair,
            };
            index++;
        }
        const startTimestamp = Date.now();
        let stopDerive = false;
        try {
            const addresses = this.helper.values(addressesMap).map((v) => v.address);
            const results = await this._apiProvider.getAddresses(addresses);
            for (const v of results) {
                addressesMap[v.address].txCount = v.txCount;
                // about gap: https://github.com/bitcoin/bips/blob/master/bip-0044.mediawiki#account-discovery
                if (v.txCount > 0) {
                    gap = 0;
                    this.logger.trace(`HDWallet._batchFetchAddresses[${parent.index}] gap count reset at: [${v.address} ${v.txCount}]:`, gap);
                }
                else {
                    gap += 1;
                    this.logger.trace(`HDWallet._batchFetchAddresses[${parent.index}] gap count increase at [${v.address} ${v.txCount}]:`, gap);
                }
                fetchedAddress.push(addressesMap[v.address]);
                if (gap >= this._gapLimit) {
                    stopDerive = true;
                    break;
                }
            }
        }
        catch (err) {
            this.logger.error(err);
            if (err instanceof RPCError || err instanceof NetworkError) {
                throw err;
            }
            else {
                throw OneChainError.fromCode(107);
            }
        }
        if (stopDerive) {
            return fetchedAddress;
        }
        else {
            const usedTime = Date.now() - startTimestamp;
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    this._batchFetchAddresses(parent, index, gap, fetchedAddress).then(resolve, reject);
                    clearTimeout(timer);
                }, usedTime > 500 ? 0 : 500);
            });
        }
    }
    /**
     * Calculate where the fetch start
     *
     * @protected
     * @param {string} path
     * @param {string} isChange
     * @param {IAddress[]} addresses
     * @param {boolean} [syncfromStart=false]
     * @return {node: BIP32Interface, gap: number, startAt: number}
     */
    _calcFetchStart(path, isChange, addresses, syncfromStart = false) {
        let startAt = 0;
        let gap = 0;
        if (!syncfromStart && addresses.length > 0) {
            let lastAddress;
            for (const address of addresses) {
                // about gap: https://github.com/bitcoin/bips/blob/master/bip-0044.mediawiki#account-discovery
                gap = address.txCount > 0 ? 0 : gap + 1;
                lastAddress = address;
            }
            startAt = lastAddress.index + 1;
        }
        const node = this._root.derivePath(`${path}/${isChange}`);
        this.logger.debug(`HDWallet fetch start at: ${path}/${isChange}/${startAt} gap: ${gap}`);
        return { node, startAt, gap };
    }
    /**
     * Derive 20 addresses
     *
     * @protected
     * @param {string} path
     * @param {string} isChange
     * @return {any[]}
     */
    _derive(path, isChange) {
        const parent = this._root.derivePath(`${path}/${isChange}`);
        const addresses = [];
        for (let i = 0; i < 20; i++) {
            const node = parent.derive(i);
            const ecpair = this._getEcpairFromPrivateKey(node.privateKey);
            addresses.push({
                index: i,
                address: this._getAddressFromEcpair(ecpair),
                txCount: 0,
                balance: '0',
                ecpair,
            });
        }
        return addresses;
    }
    /**
     * Discover addresses through rpc
     *
     * @protected
     * @param {string|string[]} path
     * @param {string} isChange
     * @param {boolean} [syncfromStart=false]
     * @return {Promise<IAddress[]>}
     */
    async _discover(path, isChange, syncfromStart = false) {
        let start;
        if (isChange === '0') {
            start = this._calcFetchStart(path, '0', this._receiving, syncfromStart);
        }
        else {
            start = this._calcFetchStart(path, '1', this._change, syncfromStart);
        }
        return this._batchFetchAddresses(start.node, start.startAt, start.gap, []);
    }
    /**
     * Find used path
     *
     * @param path
     * @returns {Promise<string>}
     * @protected
     */
    async _findUsedPath({ path }) {
        this.logger.info('HDWallet._findUsedPath from:', path);
        const addressesMap = {};
        for (let i = 0; i < path.length; i++) {
            const addresses = this._derive(path[i], '0');
            addresses.forEach((address) => {
                addressesMap[address.address] = i;
            });
        }
        let selectedIndex = Number.MAX_SAFE_INTEGER;
        const results = await this._apiProvider.getAddresses(Object.keys(addressesMap));
        for (const v of results) {
            if (v.txCount > 0) {
                const index = addressesMap[v.address];
                if (selectedIndex > index) {
                    selectedIndex = index;
                }
            }
        }
        if (selectedIndex === Number.MAX_SAFE_INTEGER) {
            selectedIndex = 0;
        }
        return path[selectedIndex];
    }
    _getEcpairFromWIF(wif) {
        return this.helper.privateKeyToAddressByNetwork(wif, this._network);
    }
    _getEcpairFromPrivateKey(privateKey) {
        return this.helper.privateKeyToAddressByNetwork(privateKey.toString('hex'), this._network);
    }
    _getPublicKeyFromAddress(address) {
        return address.ecpair.publicKey;
    }
    _getPrivateKeyFromAddress(address) {
        return address.ecpair.privateKey;
    }
    _getWIFFromAddress(address) {
        return address.ecpair.wif;
    }
    _getAddressFromEcpair(keypair) {
        return keypair.address;
    }
}
HDWallet.ADDRESS_ALL = 'all';
HDWallet.ADDRESS_CHANGE = 'change';
HDWallet.ADDRESS_RECEIVING = 'receiving';
export default HDWallet;
