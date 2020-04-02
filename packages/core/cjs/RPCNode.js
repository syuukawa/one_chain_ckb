"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
class RPCNode {
    constructor(rpcnode) {
        this.chainId = rpcnode.chainId;
        this.chainType = rpcnode.chainType;
        if (rpcnode.baseUrl) {
            this.baseUrl = rpcnode.baseUrl;
        }
        else {
            this.protocol = rpcnode.protocol;
            this.host = rpcnode.host;
            this.port = rpcnode.port;
        }
    }
    toString() {
        if (this.baseUrl) {
            return this.baseUrl;
        }
        else {
            return `${this.protocol}://${this.host}:${this.port}`;
        }
    }
}
exports.RPCNode = RPCNode;
exports.default = RPCNode;
