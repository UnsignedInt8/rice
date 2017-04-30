/*
 * Created on Sun Apr 09 2017 UnsignedInt8
 * Github: https://github.com/unsignedint8
 */

import { Socket } from 'net';
import * as assert from 'assert';
import * as utils from '../../misc/Utils';
import { Event } from "../../nodejs/Event";
import { Message, PROTOCOL_HEAD_LENGTH } from "./Message";
import Version, { TypeVersion } from "./Messages/Version";
import Addrs, { TypeAddrs } from "./Messages/Addrs";
import Addrme from "./Messages/AddrMe";
import Getaddrs from "./Messages/GetAddrs";
import { Have_tx, Losingtx, Forgettx } from "./Messages/Have_tx";
import Remember_tx from "./Messages/Remember_tx";
import * as fs from 'fs';
import { Block, Transaction } from "bitcoinjs-lib";
import Shares from "./Messages/Shares";
import { Share, NewShare, BaseShare } from "./Shares";
import { TypeSharereq, default as Sharereq } from "./Messages/Sharereq";
import { TypeSharereply, default as Sharereply } from "./Messages/Sharereply";

export default class Node extends Event {

    protected static readonly Events = {
        badPeer: 'BadPeer',
        timeout: 'Timeout', // Socket timeout
        unknownCommand: 'UnknownCommand',
        end: 'End', // When peer disconnected or errors occured
        version: 'Version', // Receivied the 'version' message
        addrs: 'Addrs', // Received the 'addrs' message
        addrMe: 'AddrMe', // Received the 'addrme' message
        getAddrs: 'GetAddrs', // Received the 'getAddrs' message
        haveTx: 'HaveTx',
        losingTx: 'LosingTx',
        forgetTx: 'ForgetTx',
        rememberTx: 'RememberTx',
        bestBlock: 'BestBlock',
        shares: 'Shares',
        shareReq: 'ShareReq',
    }

    private static readonly Messages = {
        version: 'version',
        ping: 'ping',
        pong: 'pong',
        addrs: 'addrs',
        addrme: 'addrme',
        getaddrs: 'getaddrs',
        have_tx: 'have_tx',
        losing_tx: 'losing_tx',
        forget_tx: 'forget_tx',
        remember_tx: 'remember_tx',
        bestblock: 'bestblock',
        shares: 'shares',
        sharereq: 'sharereq',
    }

    protected msgHandlers = new Map<string, (payload: Buffer) => void>();
    protected socket: Socket;

    remoteTxHashs = new Set<string>();
    isJs2PoolPeer = false;
    peerAddress: string;
    peerPort: number;
    externalAddress?: string; // IP address from peer's view
    externalPort?: number; // the port from peer's view

    constructor(peerAddress: string = null, peerPort: number = 9333) {
        super();
        let me = this;

        this.msgHandlers.set(Node.Messages.version, this.handleVersion.bind(me));
        this.msgHandlers.set(Node.Messages.ping, this.handlePing.bind(me));
        this.msgHandlers.set(Node.Messages.pong, this.handlePong.bind(me));
        this.msgHandlers.set(Node.Messages.addrs, this.handleAddrs.bind(me));
        this.msgHandlers.set(Node.Messages.addrme, this.handleAddrme.bind(me));
        this.msgHandlers.set(Node.Messages.getaddrs, this.handleGetaddrs.bind(me));
        this.msgHandlers.set(Node.Messages.have_tx, this.handleHave_tx.bind(me));
        this.msgHandlers.set(Node.Messages.losing_tx, this.handleLosing_tx.bind(me));
        this.msgHandlers.set(Node.Messages.forget_tx, this.handleForgetTx.bind(me));
        this.msgHandlers.set(Node.Messages.remember_tx, this.handleRemember_tx.bind(me));
        this.msgHandlers.set(Node.Messages.bestblock, this.handleBestBlock.bind(me));
        this.msgHandlers.set(Node.Messages.shares, this.handleShares.bind(me));
        this.msgHandlers.set(Node.Messages.sharereq, this.handleSharereq.bind(me));

        if (!peerAddress || peerAddress.length === 0) return;

        this.peerAddress = peerAddress;
        this.peerPort = peerPort;

        this.initSocket(new Socket());
    }

    /// ---------------------- sockets ----------------------------

    protected initSocket(socket: Socket) {
        this.socket = socket;
        let me = this;

        socket.setTimeout(10 * 1000, () => me.trigger(Node.Events.timeout, me));
        socket.once('end', () => me.close());
        socket.once('error', err => {
            console.info(socket.remoteAddress, err.message);
            socket.destroy();
            me.close();
        });
    }

    async connectAsync() {
        let socket = this.socket;

        if (!socket) throw new Error('You should install the socket first');

        try {
            if (!await socket.connectAsync(this.peerPort, this.peerAddress)) return false;

            this.beginReceivingMessagesAsync();
            return true;
        } catch (error) {
            console.error(error);
            socket.removeAllListeners();
            return false;
        }
    }

    installSocket(socket: Socket) {
        this.close();
        this.initSocket(socket);
    }

    close() {
        if (!this.socket) return;
        this.socket.end();
        this.socket.removeAllListeners();
        this.trigger(Node.Events.end, this);
    }

    private static async readFlowingBytesAsync(stream: Socket, amount: number, preRead: Buffer) {
        return new Promise<{ data: Buffer, lopped: Buffer }>(resolve => {
            let buff = preRead ? preRead : Buffer.from([]);

            let readData = (data: Buffer) => {
                buff = Buffer.concat([buff, data]);
                if (buff.length >= amount) {
                    let returnData = buff.slice(0, amount);
                    let lopped = buff.length > amount ? buff.slice(amount) : null;
                    resolve({ data: returnData, lopped });
                }
                else
                    stream.once('data', readData);
            };

            readData(Buffer.alloc(0));
        });
    };

    protected async beginReceivingMessagesAsync(preBuffer: Buffer = null) {
        let { data, lopped } = await Node.readFlowingBytesAsync(this.socket, PROTOCOL_HEAD_LENGTH, preBuffer);

        let magic = data.slice(0, 8);
        if (!magic.equals(Message.magic)) {
            this.trigger(Node.Events.badPeer, this, 'Bad magic number');
            this.close();
            assert.ok(false);
            return;
        }

        let command = data.slice(8, 20).toString().replace(/\0+$/, '');
        let length = data.readUInt32LE(20);
        let checksum = data.readUInt32LE(24);

        let { data: payload, lopped: remain } = await Node.readFlowingBytesAsync(this.socket, length, lopped);
        if (utils.sha256d(payload).readUInt32LE(0) !== checksum) {
            this.trigger(Node.Events.badPeer, this, 'Bad checksum');
            this.close();
            assert.ok(false);
            return;
        }

        if (this.msgHandlers.has(command)) {
            console.info(command);
            this.msgHandlers.get(command)(payload);
        } else {
            console.info(`unknown command: ${command}`);
            this.trigger(Node.Events.unknownCommand, this, command);
        }

        let me = this;
        process.nextTick(async () => await me.beginReceivingMessagesAsync(remain));
    }

    /// --------------------- handleXXX ---------------------------

    private handleVersion(payload: Buffer) {
        let version = Version.fromBuffer(payload);
        this.isJs2PoolPeer = version.subVersion.startsWith('js2pool');
        this.externalAddress = version.addressTo.ip;
        this.externalPort = version.addressTo.port;

        this.trigger(Node.Events.version, this, version);
    }

    private handlePing(payload: Buffer) {
        if (!this.isJs2PoolPeer) {
            this.sendPingAsync();
            return;
        }

        this.sendPongAsync();
    }

    // Nothing to do here
    private handlePong(payload: Buffer) {
        console.info(this.socket.remoteAddress, 'is alive');
    }

    private handleAddrs(payload: Buffer) {
        let addrs = Addrs.fromBuffer(payload);
        this.trigger(Node.Events.addrs, this, addrs);
    }

    private handleAddrme(payload: Buffer) {
        let addrme = Addrme.fromBuffer(payload);

        if (addrme.port !== this.peerPort) {
            this.trigger(Node.Events.badPeer, this, 'ports are not equal');
            return;
        }

        this.trigger(Node.Events.addrMe, this, this.peerAddress, addrme.port);
    }

    private handleGetaddrs(payload: Buffer) {
        let getaddrs = Getaddrs.fromBuffer(payload);
        this.trigger(Node.Events.getAddrs, this, getaddrs.count);
    }

    private handleHave_tx(payload: Buffer) {
        let me = this;
        let tx = Have_tx.fromBuffer(payload);
        this.trigger(Node.Events.haveTx, this, tx.txHashes);

        while (me.remoteTxHashs.size > 10) {
            let { value } = me.remoteTxHashs.keys().next();
            me.remoteTxHashs.delete(value);
        }

        tx.txHashes.forEach(h => me.remoteTxHashs.add(h));
    }

    private handleLosing_tx(payload: Buffer) {
        let me = this;
        let losingTx = Losingtx.fromBuffer(payload);
        this.trigger(Node.Events.losingTx, this, losingTx.txHashes);

        losingTx.txHashes.forEach(h => me.remoteTxHashs.delete(h));
    }

    private handleForgetTx(payload: Buffer) {
        this.trigger(Node.Events.forgetTx, this, Forgettx.fromBuffer(payload).txHashes);
    }

    private handleRemember_tx(payload: Buffer) {
        let rtx = Remember_tx.fromBuffer(payload);
        this.trigger(Node.Events.rememberTx, this, rtx.txHashes, rtx.txs);
    }

    private handleBestBlock(payload: Buffer) {
        let header = Block.fromBuffer(payload);
        this.trigger(Node.Events.bestBlock, this, header);
    }

    private handleShares(payload: Buffer) {
        console.log('shares: ', payload.length);
        fs.writeFileSync('/tmp/shares_' + Date.now(), payload.toString('hex'));

        let sharesWrapper = Shares.fromBuffer(payload);
        this.trigger(Node.Events.shares, this, sharesWrapper.shares);
    }

    private handleSharereq(payload: Buffer) {
        let request = Sharereq.fromBuffer(payload);
        this.trigger(Node.Events.shareReq, this, request);
    }

    /// -------------------- sendXXXAsync -------------------------

    async sendVersionAsync() {
        let addrTo = {
            services: 0,
            ip: this.socket.remoteAddress,
            port: this.socket.remotePort,
        };

        let addrFrom = {
            services: 0,
            ip: this.socket.localAddress,
            port: this.socket.localPort,
        };

        let msg = Message.fromObject({
            command: 'version',
            payload: {
                addressFrom: addrFrom,
                addressTo: addrTo,
            }
        });

        return await this.socket.writeAsync(msg.toBuffer());
    }

    async sendPingAsync() {
        let msg = Message.fromObject({ command: 'ping', payload: {} });
        return await this.socket.writeAsync(msg.toBuffer());
    }

    private async sendPongAsync() {
        let msg = Message.fromObject({ command: 'pong', payload: {} });
        return await this.socket.writeAsync(msg.toBuffer());
    }

    /**
     * Tell a peer to record my address
     * You should check the externalAddress equals the socket.localAddress
     * @param port 
     */
    async sendAddrmeAsync(port: number) {
        let msg = Message.fromObject({ command: 'addrme', payload: { port: port } });
        return await this.socket.writeAsync(msg.toBuffer());
    }

    async sendGetaddrsAsync(count: number) {
        let msg = Message.fromObject({ command: 'getaddrs', payload: { count: count } });
        return await this.socket.writeAsync(msg.toBuffer());
    }

    async sendAddrsAsync(addrs: TypeAddrs[]) {
        let data = Addrs.fromObjects(addrs);
        return await this.socket.writeAsync(data);
    }

    async sendSharereqAsync(sharereq: TypeSharereq) {
        let data = Sharereq.fromObject(sharereq);
        return await this.socket.writeAsync(data.toBuffer());
    }

    async sendSharereplyAsync(reply: TypeSharereply) {
        let r = Sharereply.fromObject(reply);
        return await this.socket.writeAsync(r.toBuffer());
    }

    isAvailable = () => this.socket.readable && this.socket.writable;

    /// -------------------- onXXXEvents --------------------------

    onBadPeer(callback: (sender: Node, message: string) => void) {
        super.register(Node.Events.badPeer, callback);
        return this;
    }

    onTimeout(callback: (sender: Node) => void) {
        super.register(Node.Events.timeout, callback);
        return this;
    }

    onEnd(callback: (sender: Node) => void) {
        super.register(Node.Events.end, callback);
        return this;
    }

    onUnknownCommand(callback: (sender: Node, cmd: string) => void) {
        super.register(Node.Events.unknownCommand, callback);
        return this;
    }

    onVersionVerified(callback: (sender: Node, version: Version) => void) {
        super.register(Node.Events.version, callback);
        return this;
    }

    onAddrMe(callback: (sender: Node, ip: string, port: number) => void) {
        super.register(Node.Events.addrMe, callback);
        return this;
    }

    onAddrs(callback: (sender: Node, addrs: TypeAddrs[]) => void) {
        super.register(Node.Events.addrs, callback);
        return this;
    }

    onGetAddrs(callback: (sender: Node, count: number) => void) {
        super.register(Node.Events.getAddrs, callback);
        return this;
    }

    onHaveTx(callback: (sender: Node, txHashes: string[]) => void) {
        super.register(Node.Events.haveTx, callback);
        return this;
    }

    onLosingTx(callback: (sender: Node, txHashes: string[]) => void) {
        super.register(Node.Events.losingTx, callback);
        return this;
    }

    onForgetTx(callback: (sender: Node, txHashes: string[]) => void) {
        super.register(Node.Events.forgetTx, callback);
        return this;
    }

    onRememberTx(callback: (sender: Node, txHashes: string[], txs: Transaction[]) => void) {
        super.register(Node.Events.rememberTx, callback);
        return this;
    }

    onBestBlock(callback: (sender: Node, header: Block) => void) {
        super.register(Node.Events.bestBlock, callback);
        return this;
    }

    onShares(callback: (sender: Node, shares: { version: number, contents: BaseShare }[]) => void) {
        super.register(Node.Events.shares, callback);
        return this;
    }

    onShareReq(callback: (sender: Node, TypeSharereq) => void) {
        super.register(Node.Events.shareReq, callback);
        return this;
    }
}