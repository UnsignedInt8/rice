/*
 * Created on Sun Apr 16 2017 UnsignedInt8
 * Github: https://github.com/unsignedint8
 */

import logger from '../../../misc/Logger';
import { BaseShare } from "./index";
import { Event } from "../../../nodejs/Event";
import ObservableProperty from "../../../nodejs/ObservableProperty";

type ShareNode = {
    next?: string;
    previous?: string;
    item: BaseShare;
}

export type Gap = {
    descendent: string,
    descendentHeight: number,
    length: number
}

/**
 * Sharechain
 * 
 * 'x' stands for main chain shares
 * '-' stands for orphans or deads
 * 
 * [x]
 * [x][-]
 * [x]
 * [x]
 * xxx a gap here xxx (length: 1)
 * [x][-][-]
 * [x][-]
 * [x]
 */

export default class Sharechain extends Event {

    static readonly Instance = new Sharechain();
    static readonly BASE_CHAIN_LENGTH = 24 * 60 * 60 / 10;
    static readonly MAX_CHAIN_LENGTH = Sharechain.BASE_CHAIN_LENGTH * 2;

    static readonly Events = {
        newestChanged: 'NewestChanged',
        oldestChanged: 'OldestChanged',
        deadArrived: 'DeadArrived',
        candidateArrived: 'CandidateArrived',
        orphansFound: 'OrphansFound',
        gapsFound: 'GapsFound',
        chainCalculatable: 'ChainCalculatable',
    }

    private hashIndexer = new Map<string, number>();
    private absheightIndexer = new Map<number, Array<BaseShare>>();
    newest = ObservableProperty.init<BaseShare>(null);
    oldest: BaseShare;
    calculatable = false;
    verified = false;

    private constructor() {
        super();
        this.newest.onPropertyChanged(this.onNewestPropertyChanged.bind(this));
    }

    private onNewestPropertyChanged(oldValue: BaseShare, newValue: BaseShare) {
        this.trigger(Sharechain.Events.newestChanged, this, newValue);
    }

    onDeadShareArrived(callback: (sender: Sharechain, deadShare: BaseShare) => void) {
        super.register(Sharechain.Events.deadArrived, callback);
    }

    onOrphansFound(callback: (sender: Sharechain, orphans: BaseShare[]) => void) {
        super.register(Sharechain.Events.orphansFound, callback);
    }

    onNewestChanged(callback: (sender: Sharechain, value: BaseShare) => void) {
        super.register(Sharechain.Events.newestChanged, callback);
    }

    onCandidateArrived(callback: (sender: Sharechain, value: BaseShare) => void) {
        super.register(Sharechain.Events.candidateArrived, callback);
    }

    onGapsFound(callback: (sender: Sharechain, gaps: Gap[]) => void) {
        super.register(Sharechain.Events.gapsFound, callback);
    }

    onChainCalculatable(callback: (sender: Sharechain) => void) {
        super.register(Sharechain.Events.chainCalculatable, callback);
    }

    has(hash: string) {
        return this.hashIndexer.has(hash);
    }

    /**
     * Return a share by hash or absheight
     */
    get(id: string | number) {
        let height = id;

        if (typeof id === 'string') {
            if (!this.hashIndexer.has(id)) return null;
            height = this.hashIndexer.get(id);
        }

        let shares = this.absheightIndexer.get(<number>height);
        if (!shares || shares.length === 0) return null;
        return shares[0];
    }

    add(shares: BaseShare[]) {
        for (let share of shares) {
            this.append(share);
        }
    }

    /**
     * if returns ture, means it's a new share, and it can be broadcasted to other peers
     * if returns false, means it's **an old** or invalid share, and it should not be broadcasted to other peers
     */
    append(share: BaseShare) {
        if (!share.validity) {
            logger.warn(`invalid share, ${share.info.absheight}, ${share.hash}`);
            return false;
        }

        let shares = this.absheightIndexer.get(share.info.absheight);
        if (!shares) {
            shares = new Array<BaseShare>();
            this.absheightIndexer.set(share.info.absheight, shares);
        }

        if (shares.some(s => s.hash === share.hash)) {
            return false;
        }

        shares.push(share);
        this.hashIndexer.set(share.hash, share.info.absheight);

        if (this.oldest && share.info.absheight < this.oldest.info.absheight) this.oldest = share;

        if (this.newest.hasValue() && share.info.absheight > this.newest.value.info.absheight) {

            this.newest.set(share);

            this.cleanDeprecations();

            // check the previous share array whether has multiple items or not
            let previousShares = this.absheightIndexer.get(share.info.absheight - 1);
            if (!previousShares) {
                // find a gap
                super.trigger(Sharechain.Events.gapsFound, this, [{ descendent: share.hash, descendentHeight: share.info.absheight, length: 1 }]);
                return true;
            }

            if (previousShares.length < 2) return true;

            // find orphans, maybe a gap in here
            let verified = previousShares.singleOrDefault(s => s.hash === share.info.data.previousShareHash, null);
            if (verified) {
                let orphans = previousShares.except([verified], (i1, i2) => i1.hash === i2.hash).toArray();
                if (orphans.length > 0) this.trigger(Sharechain.Events.orphansFound, this, orphans);

                // always keep the first element on the main chain
                this.absheightIndexer.set(share.info.absheight - 1, [verified].concat(orphans));
            } else {
                super.trigger(Sharechain.Events.gapsFound, this, [{ descendent: share.hash, descendentHeight: share.info.absheight, length: 1 }])
            }

            return true;
        }

        // as expereince, this share is verified by other nodes
        if (this.newest.hasValue() && share.info.absheight === this.newest.value.info.absheight) {
            this.trigger(Sharechain.Events.candidateArrived, this, share);
            return true;
        }

        // an old share or some orphans in here or it is just a dead share
        if (this.newest.hasValue() && share.info.absheight < this.newest.value.info.absheight) {

            // just an old share arrived
            if (shares.length < 2) return true;

            let nextHeight = share.info.absheight + 1;
            let nextShares = this.absheightIndexer.get(nextHeight);
            if (!nextShares || nextShares.length == 0) return;

            // dead share arrived
            if (!nextShares.some(s => s.info.data.previousShareHash == share.hash)) {
                this.trigger(Sharechain.Events.deadArrived, this, share);
                return false;
            }

            // check orphans. if this happened, means someone is attacking p2pool network, or node's sharechain is stale
            let orphans = shares.except([share], (i1, i2) => i1.hash === i2.hash).toArray();
            if (orphans.length > 0) this.trigger(Sharechain.Events.orphansFound, this, orphans);

            // keep the first element is on the main chain
            this.absheightIndexer.set(share.info.absheight, [share].concat(orphans));
            return false;
        }

        if (!this.newest.hasValue()) this.newest.set(share);
        if (!this.oldest) this.oldest = share;

        return true;
    }

    cleanDeprecations() {
        if (!this.newest.hasValue() || !this.oldest) return;
        if (this.newest.value.info.absheight - this.oldest.info.absheight < Sharechain.MAX_CHAIN_LENGTH) return;
        let deprecatedShares = this.absheightIndexer.get(this.oldest.info.absheight);
        if (!deprecatedShares || deprecatedShares.length === 0) return;

        this.absheightIndexer.delete(this.oldest.info.absheight);
        for (let ds of deprecatedShares) this.hashIndexer.delete(ds.hash);
    }

    *subchain(startHash: string, length: number = Number.MAX_SAFE_INTEGER, direction: 'backward' | 'forward' = 'forward') {
        let absheight = this.hashIndexer.get(startHash);
        if (!absheight) return;

        let step = direction === 'backward' ? -1 : 1;

        while (length--) {
            let shares = this.absheightIndexer.get(absheight);
            if (!shares || shares.length === 0) return;

            let share = shares[0];
            absheight = share.info.absheight + step;
            yield share;
        }
    }

    get length() {
        if (!this.newest.hasValue()) return 0;

        let count = 0;
        let height = this.newest.value.info.absheight;
        while (this.absheightIndexer.has(height)) {
            count++;
            height--;
        }

        return count;
    }

    get size() {
        return this.absheightIndexer.size;
    }

    // check all first elements are on the main chain
    verify() {
        if (!this.newest.hasValue()) return false;

        let verified = 0;
        let hash = this.newest.value.hash;
        let absheight = this.newest.value.info.absheight;

        while (true) {
            let shares = this.absheightIndexer.get(absheight);
            if (!shares || shares.length === 0) break;

            let share = shares[0];
            if (hash != share.hash) break;

            verified++;
            absheight = share.info.absheight - 1;
            hash = share.info.data.previousShareHash;
        }

        if (!this.calculatable) {
            this.calculatable = verified == this.length && verified >= Sharechain.BASE_CHAIN_LENGTH;
            if (this.calculatable) super.trigger(Sharechain.Events.chainCalculatable, this, verified);
        }

        logger.info(`sharechain verified: ${verified}, length: ${this.length}, size: ${this.size}`);
        this.verified = verified === this.length;
        return this.verified;
    }

    checkGaps() {
        if (!this.newest.hasValue()) return;

        let gaps = new Array<Gap>();
        let descendentHeight = this.newest.value.info.absheight;
        let ancestorHash = this.newest.value.info.data.previousShareHash;

        for (let [ancestorHeight, shares] of Array.from(this.absheightIndexer).sort((a, b) => b[0] - a[0]).skip(1)) {

            if (!(ancestorHeight + 1 === descendentHeight && shares[0].hash === ancestorHash)) {
                let length = descendentHeight - ancestorHeight;
                gaps.push({ descendent: this.absheightIndexer.get(descendentHeight)[0].hash, length, descendentHeight });
            }

            descendentHeight = ancestorHeight;
            ancestorHash = shares[0].info.data.previousShareHash;
        }

        if (this.oldest && this.newest.hasValue() && this.newest.value.info.absheight - this.oldest.info.absheight < Sharechain.BASE_CHAIN_LENGTH) {
            gaps.push({
                descendent: this.oldest.hash,
                descendentHeight: this.oldest.info.absheight,
                length: Sharechain.BASE_CHAIN_LENGTH - (this.newest.value.info.absheight - this.oldest.info.absheight),
            });
        }

        if (gaps.length > 0) super.trigger(Sharechain.Events.gapsFound, this, gaps);
        return gaps;
    }
}