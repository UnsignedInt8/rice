
import { Server, Socket } from "net";
import * as net from 'net';
import * as kinq from 'kinq';
import Node from "./Node";
import { Transaction } from "bitcoinjs-lib";
import { BaseShare } from "./shares";
import { DaemonWatcher, DaemonOptions, GetBlockTemplate, TransactionTemplate } from "../../core/DaemonWatcher";
import ObservableProperty from "../../nodejs/ObservableProperty";
import { Version } from "./messages/Version";
import { TypeShares, Shares } from "./messages/Shares";
import Sharechain, { Gap } from "../chain/Sharechain";
import logger from '../../misc/Logger';
import { TypeSharereq } from "./messages/Sharereq";
import { TypeSharereply } from "./messages/Sharereply";
import * as Bignum from 'bignum';
import { SharechainHelper } from "../chain/SharechainHelper";
import * as Utils from '../../misc/Utils';
import * as MathEx from '../../misc/MathEx';
import * as crypto from 'crypto';

export type PeerOptions = {
    maxConn?: number,
    port: number,
}

export class Peer {

    private port: number;
    private server: Server;
    private readonly knownTxs = ObservableProperty.init(new Map<string, TransactionTemplate>());
    private readonly knownTxsCaches = new Array<Map<string, TransactionTemplate>>();
    private readonly miningTxs = ObservableProperty.init(new Map<string, TransactionTemplate>());
    private readonly sharechain = Sharechain.Instance;
    private readonly pendingShareRequests = new Set<string>();
    readonly peers = new Map<string, Node>(); // ip:port -> Node

    constructor(opts: PeerOptions) {
        this.knownTxs.onPropertyChanged(this.handleKnownTxsChanged.bind(this));
        this.miningTxs.onPropertyChanged(this.handleMiningTxsChanged.bind(this));

        this.sharechain.onGapsFound(this.handleGapsFound.bind(this));
        this.sharechain.onOrphansFound(this.handleOrphansFound.bind(this));
        this.sharechain.onNewestChanged(this.handleNewestShareChanged.bind(this));
        this.sharechain.onCandidateArrived(this.handleCandidateArrived.bind(this));
        this.sharechain.onDeadShareArrived(this.handleDeadShareArrived.bind(this));

        if (!this.sharechain.calculatable) {
            logger.info('waiting for sharechain downloading');
            this.sharechain.onChainCalculatable(this.handleChainCalculatable.bind(this));
            this.port = opts.port;
            return;
        }

        this.server = net.createServer(this.handleNodeConnected.bind(this)).listen(opts.port);
        this.server.on('error', error => { logger.error(error.message); throw error; });
    }

    private handleNodeConnected(s: Socket) {
        let node = new Node();
        node.initSocket(s);
        node.sendVersionAsync(this.sharechain.newest.hasValue() ? this.sharechain.newest.value.hash : null);

        this.registerNode(node);
    }

    private handleChainCalculatable(sender: Sharechain) {
        if (this.server) return;
        this.server = net.createServer(this.handleNodeConnected.bind(this)).listen(this.port);
        this.server.on('error', error => { logger.error(error.message); });
        logger.info('Sharechain downloading completed');
    }

    private handleGapsFound(sender: Sharechain, gaps: Gap[]) {
        if (!this.peers.size) return;
        if (!gaps.length) return;

        logger.warn(`Sharechain gaps found, count: ${gaps.length}, length: ${gaps.sum(g => g.length)}`);

        let peers = kinq.toLinqable(this.peers.values()).orderByDescending(p => p.isJs2PoolPeer).toArray();
        let randomGaps = gaps.length > 1 ? MathEx.shuffle(gaps) : gaps;

        for (let gap of randomGaps) {
            let requestId = Utils.sha256(`${gap.descendent}-${gap.length}`).toString('hex');
            if (this.pendingShareRequests.has(requestId)) continue;

            console.log('gap descendent', gap.descendent, gap.descendentHeight, 'except', gap.descendentHeight - gap.length);
            for (let node of peers.take(8)) {
                node.sendSharereqAsync({
                    id: new Bignum(requestId, 16),
                    hashes: [gap.descendent],
                    parents: Math.min(gap.length, node.isJs2PoolPeer ? 250 : 79),
                });
            }

            this.pendingShareRequests.add(requestId);
        }
    }

    private handleCandidateArrived(sender: Sharechain, share: BaseShare) {
        logger.info(`candidate arrived, ${share.hash}`);
    }

    private handleDeadShareArrived(sender: Sharechain, share: BaseShare) {
        logger.warn(`dead share arrived, ${share.info.absheight}, ${share.hash}`)
    }

    private handleOrphansFound(sender: Sharechain, orphans: BaseShare[]) {
        logger.warn(`orphans found, ${orphans.length}, ${orphans[0].info.absheight}, ${orphans[0].hash}`);

    }

    private handleNewestShareChanged(sender: Sharechain, share: BaseShare) {
        logger.info(`sharechain height: ${share.info.absheight}`);

    }

    // ----------------- Node message events -------------------

    private async handleNodeVersion(sender: Node, version: Version) {
        await sender.sendHave_txAsync(Array.from(this.knownTxs.value.keys()));
        await sender.sendRemember_txAsync({ hashes: [], txs: Array.from(this.miningTxs.value.values()) });

        if (<any>version.bestShareHash == 0) return;
        if (this.sharechain.has(version.bestShareHash)) return;

        sender.sendSharereqAsync({ id: new Bignum(Math.random() * 1000000 | 0), hashes: [version.bestShareHash], parents: 1 });
    }

    private handleRemember_tx(sender: Node, txHashes: string[], txs: Transaction[]) {
        for (let hash of txHashes) {
            if (sender.rememberedTxs.has(hash)) {
                sender.close(false, 'Peer referenced transaction hash twice');
                return;
            }

            let knownTx = this.knownTxs.value.get(hash) || this.knownTxsCaches.where(cache => cache.has(hash)).select(cache => cache.get(hash)).firstOrDefault();
            if (!knownTx) {
                logger.info(`Peer referenced unknown transaction ${hash}, disconnecting`);
                sender.close(false);
                return;
            }

            sender.rememberedTxs.set(hash, knownTx);
        }

        let knownTxs = new Map(this.knownTxs.value);
        for (let tx of txs) {
            let txHash = tx.getHash();
            if (sender.rememberedTxs.has(txHash)) {
                sender.close(false, 'Peer referenced transaction twice, disconnecting');
                return;
            }

            let txTemplate = { txid: txHash, hash: txHash, data: tx.toHex() }
            sender.rememberedTxs.set(txHash, txTemplate);
            knownTxs.set(txHash, txTemplate);
        }

        this.knownTxs.set(knownTxs);
    }

    private handleShares(sender: Node, wrappers: TypeShares[]) {
        if (!wrappers || wrappers.length === 0) return;
        if (wrappers.all(item => Sharechain.Instance.has(item.contents.hash))) return;

        let newTxs = new Map(this.knownTxs.value);
        for (let share of wrappers.where(s => s.contents && s.contents.validity).select(s => s.contents)) {
            logger.info(share.hash);

            for (let txHash of share.info.newTransactionHashes) {
                if (this.knownTxs.value.has(txHash)) {
                    let tx = this.knownTxs.value.get(txHash);
                    newTxs.set(txHash, tx);
                    continue;
                }

                if (sender.rememberedTxs.has(txHash)) {
                    let tx = sender.rememberedTxs.get(txHash);
                    newTxs.set(txHash, tx);
                    continue;
                }

                if (this.miningTxs.value.has(txHash)) {
                    continue;
                }

                if (sender.remoteTxHashs.has(txHash)) {
                    continue;
                }

                let cache = this.knownTxsCaches.firstOrDefault(c => c.has(txHash), null);
                if (!cache) {
                    logger.warn('Peer referenced unknown transaction');
                    break;
                }

                let tx = cache.get(txHash);
                newTxs.set(txHash, tx);
            }
        }

        this.sharechain.add(wrappers.map(s => s.contents));
        this.knownTxs.set(newTxs);

        Array.from(this.peers.values()).except([sender], (i1, i2) => i1.tag === i2.tag).each(peer => peer.sendSharesAsync(wrappers));
        this.sharechain.verify();
    }

    private handleSharereq(sender: Node, request: TypeSharereq) {
        let parents = Math.min(Math.min(request.parents, 500 / request.hashes.length | 0), sender.isJs2PoolPeer ? 500 : 100);
        let stops = new Set(request.stops);
        let shares = new Array<BaseShare>();

        for (let hash of request.hashes) {
            for (let share of this.sharechain.subchain(hash, parents, 'backward')) {
                if (stops.has(share.hash)) break;
                shares.push(share);
            }
        }

        if (shares.length === 0) {
            sender.sendSharereplyAsync({ id: request.id, result: 2, wrapper: Shares.fromObject([]) })
            return;
        }

        let wrapper = Shares.fromObject(shares.map(s => { return { version: s.VERSION, contents: s }; }));
        sender.sendSharereplyAsync({ id: request.id, result: 0, wrapper });
        logger.info(`sending ${shares.length} shares to ${sender.tag}`);
    }

    private handleSharereply(sender: Node, reply: TypeSharereply) {
        // not ok
        if (reply.result != 0) {
            this.sharechain.checkGaps();
            logger.warn(`share request reply not ok, error code: ${reply.result}, from ${sender.tag}`);
            return;
        }

        let shares = reply.wrapper.shares.map(s => s.contents).where(share => share.validity && !this.sharechain.has(share.hash)).toArray();
        if (shares.length === 0) this.sharechain.fix();
        this.sharechain.add(shares);
        SharechainHelper.saveShares(shares);
        this.pendingShareRequests.delete(reply.id.toString(16));

        process.nextTick(() => {
            this.sharechain.checkGaps();
            this.sharechain.verify();
        });

        logger.info(`received ${reply.wrapper.shares.length} shares from ${sender.tag}`);
    }

    // ----------------- Peer work ---------------------

    private registerNode(node: Node) {
        node.onVersionVerified(this.handleNodeVersion.bind(this));
        node.onRemember_tx(this.handleRemember_tx.bind(this));
        node.onShares(this.handleShares.bind(this));
        node.onSharereq(this.handleSharereq.bind(this));
        node.onSharereply(this.handleSharereply.bind(this));
        node.onEnd(function (sender: Node) { this.peers.delete(sender.tag); }.bind(this));
        this.peers.set(node.tag, node);
    }

    /**
     * update_remote_view_of_my_known_txs
     */
    private handleKnownTxsChanged(oldValue: Map<string, TransactionTemplate>, newValue: Map<string, TransactionTemplate>) {

        let added = newValue.except(oldValue).select(item => item[0]).toArray();
        let removed = oldValue.except(newValue).select(item => item[0]).toArray();;

        if (added.any()) {
            this.peers.forEach(p => p.sendHave_txAsync(added));
        }

        if (removed.any()) {
            this.peers.forEach(p => p.sendLosing_txAsync(removed));
        }

        this.knownTxsCaches.push(removed.select(hash => { return [hash, oldValue.get(hash)]; }).toMap<string, TransactionTemplate>())
        if (this.knownTxsCaches.length > 10) this.knownTxsCaches.shift();

        logger.info(`known txs changed, added: ${added.length}, removed: ${removed.length}`)
    }

    /**
     * update_remote_view_of_my_mining_txs
     */
    private handleMiningTxsChanged(oldValue: Map<string, TransactionTemplate>, newValue: Map<string, TransactionTemplate>) {

        let added = newValue.except(oldValue).select(item => item[1]).toArray();
        let removed = oldValue.except(newValue).select(item => item[1]).toArray();

        if (added.any()) {
            this.peers.forEach(p => p.sendRemember_txAsync({ hashes: added.where(tx => p.remoteTxHashs.has(tx.txid || tx.hash)).select(tx => tx.txid || tx.hash).toArray(), txs: added.where(tx => !p.remoteTxHashs.has(tx.txid || tx.hash)).toArray() }));
        }

        if (removed.any()) {
            let totalSize = removed.sum(item => item.data.length / 2);
            this.peers.forEach(p => p.sendForget_txAsync(removed.map(tx => tx.txid || tx.hash), totalSize));
        }

        logger.info(`mining txs changed, added: ${added.length}, removed: ${removed.length}`, );
    }

    initPeersAsync(peers: { host: string, port: number }[]) {
        for (let peer of peers) {
            let node = new Node();
            node.connectAsync(peer.host, peer.port).then(result => {
                if (!result) return;
                this.registerNode(node);
                node.sendVersionAsync(this.sharechain.newest.hasValue() ? this.sharechain.newest.value.hash : null);
                logger.info(`${node.tag} connected ${node.connectionTime}ms`);
            });
        }
    }

    updateMiningTemplate(template: GetBlockTemplate) {
        let miningTxs = new Map<string, TransactionTemplate>();
        let knownTxs = new Map(this.knownTxs.value);

        template.transactions.forEach(tx => {
            miningTxs.set(tx.txid || tx.hash, tx);
            knownTxs.set(tx.txid || tx.hash, tx);
        });

        this.miningTxs.set(miningTxs);
        this.knownTxs.set(knownTxs);
    }

    removeDeprecatedTxs(txs: string[]) {
        let knownTxs = new Map(this.knownTxs.value);

        for (let tx of txs) {
            if (this.miningTxs.value.has(tx)) continue;
            knownTxs.delete(tx);
        }

        this.knownTxs.set(knownTxs);
        this.peers.forEach(node => txs.forEach(tx => node.rememberedTxs.delete(tx)));
    }
}