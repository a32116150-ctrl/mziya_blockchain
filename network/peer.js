import { createLibp2p } from 'libp2p';
import { webRTC } from '@libp2p/webrtc';
import { webSockets } from '@libp2p/websockets';
import { kadDHT } from '@libp2p/kad-dht';
import { gossipsub } from '@chainsafe/libp2p-gossipsub';
import { identify } from '@libp2p/identify';
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { mdns } from '@libp2p/mdns';
import { bootstrap } from '@libp2p/bootstrap';
import { fromString, toString } from 'uint8arrays';
import { Block, hashData } from '../core/block.js';
import { Transaction } from '../core/transaction.js';
import { Vote } from '../core/consensus.js';

export const TOPICS = {
  TRANSACTION: 'mziya/tx/v1',
  BLOCK:       'mziya/block/v1',
  MINING:      'mziya/mining/v1',
  CONSENSUS:   'mziya/consensus/v1',
  SYNC:        'mziya/sync/v1',
  PEX:         'mziya/pex/v1',
};

export function getBootstrapPeers() {
  const envVal = typeof process !== 'undefined' && process?.env?.BOOTSTRAP_PEERS;
  if (envVal) {
    try { return JSON.parse(envVal); }
    catch { return envVal.split(',').map(s => s.trim()).filter(Boolean); }
  }
  return [];
}

export async function createMziyaNode(options = {}) {
  const isBrowser = typeof window !== 'undefined';

  const transports = [];
  if (isBrowser) {
    transports.push(webRTC({
      rtcConfiguration: {
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' },
        ],
      },
    }));
    transports.push(webSockets());
    transports.push(circuitRelayTransport());
  } else {
    transports.push(webSockets());
    transports.push(circuitRelayTransport());
  }

  const discovery = [];
  discovery.push(mdns({
    serviceName: 'mziya-p2p',
    interval: 5000,
  }));

  const bootstrapPeers = getBootstrapPeers();
  if (bootstrapPeers.length > 0) {
    discovery.push(bootstrap({ list: bootstrapPeers }));
  }

  const services = {
    identify: identify(),
    dht: kadDHT({
      protocol: '/mziya/kad/1.0.0',
      clientMode: isBrowser,
    }),
    pubsub: gossipsub({
      allowPublishToZeroTopicPeers: true,
      heartbeatInterval: 1_000,
      fanoutTTL: 60_000,
      mcacheLength: 10,
      mcacheGossip: 3,
    }),
  };

  const addresses = {};
  if (!isBrowser) {
    addresses.listen = [
      '/ip4/0.0.0.0/tcp/0/ws',
    ];
  }

  const node = await createLibp2p({
    addresses,
    transports,
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    peerDiscovery: discovery,
    services,
  });

  return node;
}

const MAX_PENDING_BLOCKS = 100;
const PENDING_BLOCK_TTL = 300_000;
const MAX_MESSAGE_SIZE = 1_048_576;
const RATE_LIMIT_WINDOW_MS = 1_000;
const RATE_LIMIT_MAX_MSG = 20;
const SEEN_MSG_CACHE_SIZE = 2000; // NET-02: LRU dedup cache size

export class MziyaP2P {
  constructor(blockchain, mempool, signer = null) {
    this.node = null;
    this.blockchain = blockchain;
    this.mempool = mempool;
    this.signer = signer;
    this.handlers = new Map();
    this.peers = new Set();
    this.isRunning = false;
    this.onPeerConnect = null;
    this.onPeerDisconnect = null;
    this.onBlock = null;
    this.onTransaction = null;
    this._pexTimer = null;
    this._discoveryTimeout = null;
    // PERF-08: Use counter+timestamp instead of array for rate limiting
    this._rateBuckets = new Map(); // peerId → { count, windowStart }
    // NET-02: Seen message deduplication cache
    this._seenMessages = new Set();
    this._seenQueue = []; // track insertion order for LRU eviction
  }

  async start(options = {}) {
    this.node = await createMziyaNode(options);

    this.node.addEventListener('peer:connect', (evt) => {
      const peerId = evt.detail.toString();
      this.peers.add(peerId);
      this.onPeerConnect?.(peerId);
    });

    this.node.addEventListener('peer:disconnect', (evt) => {
      const peerId = evt.detail.toString();
      this.peers.delete(peerId);
      this._rateBuckets.delete(peerId); // Clean up rate limiter to prevent memory leak
      this.onPeerDisconnect?.(peerId);
    });

    this.node.services.pubsub.subscribe(TOPICS.TRANSACTION);
    this.node.services.pubsub.subscribe(TOPICS.BLOCK);
    this.node.services.pubsub.subscribe(TOPICS.MINING);
    this.node.services.pubsub.subscribe(TOPICS.CONSENSUS);
    this.node.services.pubsub.subscribe(TOPICS.SYNC);
    this.node.services.pubsub.subscribe(TOPICS.PEX);

    this.node.services.pubsub.addEventListener('message', (evt) => {
      this._handleMessage(evt.detail);
    });

    await this.node.start();
    this.isRunning = true;

    this._startPEX();

    return {
      peerId: this.node.peerId.toString(),
      multiaddrs: this.node.getMultiaddrs().map(ma => ma.toString()),
    };
  }

  async stop() {
    if (this._pexTimer) clearInterval(this._pexTimer);
    if (this._discoveryTimeout) clearTimeout(this._discoveryTimeout);
    if (this.node) {
      await this.node.stop();
      this.isRunning = false;
    }
  }

  get peerCount() { return this.peers.size; }

  getPeerId() { return this.node?.peerId?.toString(); }

  getMultiaddrs() {
    return this.node?.getMultiaddrs()?.map(ma => ma.toString()) || [];
  }

  on(event, handler) { this.handlers.set(event, handler); }

  // ── PEX: Peer Exchange ──

  _startPEX() {
    this._pexTimer = setInterval(() => {
      this._announceAddresses();
    }, 300_000); // NET-04: Announce every 5 minutes instead of 30s to reduce chatter
    setTimeout(() => this._announceAddresses(), 2_000);
  }

  async _announceAddresses() {
    if (!this.isRunning || this.peers.size === 0) return;
    try {
      const addrs = this.getMultiaddrs();
      if (addrs.length === 0) return;
      const peerId = this.getPeerId();
      const announce = { peerId, addrs, timestamp: Date.now() };
      await this.node.services.pubsub.publish(
        TOPICS.PEX,
        fromString(JSON.stringify(announce))
      );
    } catch (err) {
      console.warn('[P2P] PEX announce failed:', err.message);
    }
  }

  _handlePEXMessage(data) {
    if (!data.peerId || data.peerId === this.getPeerId()) return;
    this.handlers.get('pex')?.(data);
  }

  // ── Broadcasting ──

  async broadcastTransaction(tx) {
    if (!this.isRunning) return;
    const data = fromString(JSON.stringify(tx.toJSON ? tx.toJSON() : tx));
    await this.node.services.pubsub.publish(TOPICS.TRANSACTION, data);
  }

  async broadcastBlock(block) {
    if (!this.isRunning) return;
    const data = fromString(JSON.stringify(block.toJSON ? block.toJSON() : block));
    await this.node.services.pubsub.publish(TOPICS.BLOCK, data);
  }

  async broadcastMiningActivity(proof) {
    if (!this.isRunning) return;
    const data = fromString(JSON.stringify(proof));
    await this.node.services.pubsub.publish(TOPICS.MINING, data);
  }

  async broadcastVote(vote) {
    if (!this.isRunning) return;
    const data = fromString(JSON.stringify(vote.toJSON ? vote.toJSON() : vote));
    await this.node.services.pubsub.publish(TOPICS.CONSENSUS, data);
  }

  async requestChainSync(fromHeight = 0, count = 100) {
    if (!this.isRunning) return;
    const request = {
      type: 'SYNC_REQUEST',
      ourHeight: this.blockchain.length,
      ourLatestHash: this.blockchain.latestBlock?.hash,
      fromHeight, count,
      timestamp: Date.now(),
    };
    const data = fromString(JSON.stringify(request));
    await this.node.services.pubsub.publish(TOPICS.SYNC, data);
  }

  // ── Message Handling ──

  _handleMessage(message) {
    try {
      const raw = message.data;
      if (raw.length > MAX_MESSAGE_SIZE) {
        console.warn('[P2P] Message too large, dropping');
        return;
      }

      // NET-02: Deduplicate messages by hash
      const msgHash = hashData(raw);
      if (this._seenMessages.has(msgHash)) return;
      this._seenMessages.add(msgHash);
      this._seenQueue.push(msgHash);
      if (this._seenQueue.length > SEEN_MSG_CACHE_SIZE) {
        const evicted = this._seenQueue.shift();
        this._seenMessages.delete(evicted);
      }

      const peerId = message.from ? message.from.toString() : null;
      if (peerId && !this._checkRateLimit(peerId)) {
        return;
      }

      const content = JSON.parse(toString(raw));

      switch (message.topic) {
        case TOPICS.TRANSACTION: this._handleIncomingTransaction(content); break;
        case TOPICS.BLOCK:       this._handleIncomingBlock(content); break;
        case TOPICS.SYNC:        this._handleSyncMessage(content); break;
        case TOPICS.CONSENSUS:   this._handleVote(content); break;
        case TOPICS.MINING:      this._handleMiningActivity(content); break;
        case TOPICS.PEX:         this._handlePEXMessage(content); break;
      }
    } catch (err) {
      console.warn('[P2P] Failed to parse message:', err.message);
    }
  }

  // PERF-08: O(1) rate limiting with counter + window reset
  _checkRateLimit(peerId) {
    const now = Date.now();
    let bucket = this._rateBuckets.get(peerId);
    if (!bucket || now - bucket.windowStart > RATE_LIMIT_WINDOW_MS) {
      bucket = { count: 0, windowStart: now };
      this._rateBuckets.set(peerId, bucket);
    }
    bucket.count++;
    if (bucket.count > RATE_LIMIT_MAX_MSG) {
      console.warn('[P2P] Rate limit exceeded for', peerId.slice(0, 12));
      return false;
    }
    return true;
  }

  _handleIncomingTransaction(txData) {
    const tx = Transaction.fromJSON(txData);
    const result = this.mempool.add(tx);
    if (result.added) this.onTransaction?.(tx);
  }

  _handleIncomingBlock(blockData) {
    const block = Block.fromJSON(blockData);

    if (this.blockchain.consensusEngine) {
      if (this.blockchain.consensusEngine.isFinalized(block.hash)) {
        const result = this.blockchain.addBlock(block);
        if (result.success) this.onBlock?.(block);
      } else {
        if (!Array.isArray(this.blockchain.pendingBlocks)) {
          this.blockchain.pendingBlocks = [];
        }
        if (this.blockchain.pendingBlocks.length >= MAX_PENDING_BLOCKS) {
          this.blockchain.pendingBlocks.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
          this.blockchain.pendingBlocks.shift();
        }
        const now = Date.now();
        this.blockchain.pendingBlocks = this.blockchain.pendingBlocks.filter(
          b => now - (b.timestamp || 0) < PENDING_BLOCK_TTL
        );
        if (!this.blockchain.pendingBlocks.find(b => b.hash === block.hash)) {
          this.blockchain.pendingBlocks.push(block);
        }
        if (this.signer && this.blockchain.consensusEngine.validatorSet.isValidator(this.signer.address)) {
          const votePayload = { blockHash: block.hash, validatorAddress: this.signer.address, timestamp: Date.now() };
          const signature = this.signer.sign(votePayload);
          const vote = new Vote({
            blockHash: block.hash,
            validatorAddress: this.signer.address,
            signature,
            timestamp: votePayload.timestamp,
          });
          this.broadcastVote(vote).catch((err) => {
            console.warn('[P2P] Vote broadcast failed:', err.message);
          });
        }
      }
    } else {
      const result = this.blockchain.addBlock(block);
      if (result.success) this.onBlock?.(block);
    }
  }

  async _handleSyncMessage(message) {
    if (message.type === 'SYNC_REQUEST') {
      if (this.blockchain.length > message.ourHeight) {
        const fromHeight = message.fromHeight || 0;
        const count = message.count || 100;
        const chain = this.blockchain.toJSON();
        const blocks = chain.slice(fromHeight, fromHeight + count);
        const response = { type: 'SYNC_RESPONSE', blocks, height: this.blockchain.length, fromHeight, count };
        const data = fromString(JSON.stringify(response));
        await this.node.services.pubsub.publish(TOPICS.SYNC, data);
      }
    } else if (message.type === 'SYNC_RESPONSE') {
      if (message.height > this.blockchain.length && Array.isArray(message.blocks)) {
        const incomingBlocks = message.blocks.map(b => Block.fromJSON(b));
        const mergeResult = this.blockchain.mergeBlocks(incomingBlocks);
        if (mergeResult) this.onBlock?.(incomingBlocks[incomingBlocks.length - 1]);
      }
    }
  }

  _handleVote(voteData) {
    if (this.blockchain.consensusEngine) {
      const vote = Vote.fromJSON(voteData);
      const result = this.blockchain.receiveVote(vote);
      if (result.finalized) {
        const pending = Array.isArray(this.blockchain.pendingBlocks) ? this.blockchain.pendingBlocks : [];
        const block = pending.find(b => b.hash === voteData.blockHash);
        if (block) {
          const addResult = this.blockchain.addBlock(block);
          if (addResult.success) {
            this.blockchain.pendingBlocks = pending.filter(b => b.hash !== block.hash);
            this.onBlock?.(block);
          }
        }
      }
    }
    this.handlers.get('vote')?.(voteData);
  }

  _handleMiningActivity(activityData) {
    this.handlers.get('activity')?.(activityData);
  }
}
