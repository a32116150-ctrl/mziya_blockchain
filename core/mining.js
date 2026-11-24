/**
 * Mziya Blockchain — Mining Engine
 * Proof-of-Activity (PoA):
 *  - Users tap once per 24h to prove they are active
 *  - No GPU, no battery drain, no electricity cost
 *  - Mining rate decreases over time (halving schedule)
 */

// Tokenomics and reward math live in core/tokenomics.js (re-exported here
// for backwards compatibility).
export {
  TOKENOMICS,
  getCurrentMiningRate,
  calculateSessionEarnings,
  computeSessionReward,
} from './tokenomics.js';

import { TOKENOMICS, getCurrentMiningRate, calculateSessionEarnings } from './tokenomics.js';
import { createMiningStart, createMiningClaim } from './transaction.js';

// ── Mining Session ─────────────────────────────────────────────────────────

export class MiningSession {
  constructor({ address, rate, referrals = 0, isValidator = false }) {
    this.address = address;
    this.rate = rate;
    this.referrals = referrals;
    this.isValidator = isValidator;
    this.startTime = Date.now();
    this.endTime = this.startTime + TOKENOMICS.SESSION_DURATION_MS;
    this.active = true;
    this.earned = 0;
    this.lastUpdate = this.startTime;
    this.sessionId = `${address}-${this.startTime}`;
  }

  /**
   * Tick: update earned amount.
   * Call this periodically (e.g. every minute) to update UI.
   */
  tick() {
    const now = Date.now();
    if (now >= this.endTime) {
      this.expire();
      return;
    }
    const durationMs = now - this.lastUpdate;
    this.earned += calculateSessionEarnings(durationMs, this.rate);
    this.earned = Math.round(this.earned * 1_000_000) / 1_000_000;
    this.lastUpdate = now;
  }

  expire() {
    // CORR-04: Guard against re-entry from tick() calling expire() again
    if (!this.active) return;
    this.active = false;
    // Final earnings update without re-entering expire
    const now = Date.now();
    const durationMs = now - this.lastUpdate;
    if (durationMs > 0) {
      this.earned += calculateSessionEarnings(durationMs, this.rate);
      this.earned = Math.round(this.earned * 1_000_000) / 1_000_000;
      this.lastUpdate = now;
    }
  }

  /** Snap the countdown to the on-chain start time. */
  alignTo(startTimestamp) {
    this.startTime = startTimestamp;
    this.endTime = startTimestamp + TOKENOMICS.SESSION_DURATION_MS;
    this.sessionId = `${this.address}-${startTimestamp}`;
    if (this.lastUpdate < startTimestamp) this.lastUpdate = startTimestamp;
    const elapsed = Math.min(Date.now(), this.endTime) - startTimestamp;
    this.earned = calculateSessionEarnings(Math.max(0, elapsed), this.rate);
    this.lastUpdate = Math.min(Date.now(), this.endTime);
  }

  get remainingMs() {
    return Math.max(0, this.endTime - Date.now());
  }

  get remainingHuman() {
    const ms = this.remainingMs;
    const h = Math.floor(ms / 3_600_000);
    const m = Math.floor((ms % 3_600_000) / 60_000);
    const s = Math.floor((ms % 60_000) / 1_000);
    return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  }

  get progressPercent() {
    return Math.min(100, ((Date.now() - this.startTime) / TOKENOMICS.SESSION_DURATION_MS) * 100);
  }

  toJSON() {
    return {
      sessionId: this.sessionId,
      address: this.address,
      rate: this.rate,
      referrals: this.referrals,
      isValidator: this.isValidator,
      startTime: this.startTime,
      endTime: this.endTime,
      active: this.active,
      earned: this.earned,
      lastUpdate: this.lastUpdate,
    };
  }

  static fromJSON(obj) {
    // CORR-03: Use a minimal constructor call, then override with stored values
    const session = Object.create(MiningSession.prototype);
    session.address = obj.address;
    session.rate = obj.rate;
    session.referrals = obj.referrals || 0;
    session.isValidator = obj.isValidator || false;
    session.startTime = obj.startTime;
    session.endTime = obj.endTime;
    session.active = obj.active;
    session.earned = obj.earned || 0;
    session.lastUpdate = obj.lastUpdate;
    session.sessionId = obj.sessionId;
    return session;
  }
}

// ── Session Manager ────────────────────────────────────────────────────────

/**
 * Drives mining for a wallet:
 *   startSession → signs MINING_START (the chain records the start time)
 *   claimReward  → after 24h, signs a MINING claim for the exact amount the
 *                  chain computes (base rate × 24h, +25% for validators,
 *                  + Proof-of-Intelligence bonus).
 * The local MiningSession only drives the UI countdown.
 */
export class MiningManager {
  constructor(storage) {
    this.storage = storage; // IndexedDB or LevelDB wrapper
    this.activeSessions = new Map(); // address → MiningSession
    this.tickInterval = null;
  }

  /**
   * Try to put the mempool into a block right away (local / small networks).
   * Returns { block, error } — block is null when this node may not produce.
   */
  _forgeNow(address, blockchain, privateKey, broadcastBlock) {
    const block = blockchain.forgeBlock(address, privateKey);
    if (!block) return { block: null };
    const result = blockchain.addBlock(block);
    if (!result.success) return { block: null, error: `Block rejected: ${result.error}` };
    broadcastBlock?.(block);
    return { block };
  }

  /**
   * @param {string} address
   * @param {{ privateKey:string, blockchain:Blockchain, referrals?:number,
   *           broadcastTx?:Function, broadcastBlock?:Function }} options
   */
  async startSession(address, options = {}) {
    const { privateKey, blockchain, broadcastTx, broadcastBlock } = options;
    if (!privateKey || !blockchain) {
      return { error: 'startSession needs the wallet private key and the blockchain' };
    }

    const existing = this.activeSessions.get(address);
    if (existing?.active) return { error: 'Session already active', session: existing };

    const pendingState = blockchain.getPendingState();
    if (pendingState.getMiningSession(address)) {
      return { error: 'A mining session is already open on-chain — claim it first' };
    }

    const tx = createMiningStart({ address, nonce: pendingState.getNonce(address) + 1, privateKey });
    const added = blockchain.addPendingTransaction(tx);
    if (!added.success) return { error: `Could not start session: ${added.error}` };
    broadcastTx?.(tx);
    const forged = this._forgeNow(address, blockchain, privateKey, broadcastBlock);

    const isValidator = blockchain.utxo.isValidator(address);
    const rate = getCurrentMiningRate(Date.now(), 0, isValidator);
    const session = new MiningSession({ address, rate, referrals: options.referrals || 0, isValidator });
    // Use the on-chain start time once the start tx is in a block
    const onChain = blockchain.utxo.getMiningSession(address);
    if (onChain) session.alignTo(onChain.start);

    this.activeSessions.set(address, session);
    await this.storage?.set(`session:${address}`, JSON.stringify(session.toJSON()));

    return { session, tx, block: forged.block, pending: !onChain };
  }

  async confirmActivity(address) {
    const session = this.activeSessions.get(address);
    if (!session) return { error: 'No active session' };
    if (!session.active) return { error: 'Session expired — start a new one' };

    session.tick();
    await this.storage?.set(`session:${address}`, JSON.stringify(session.toJSON()));
    return { session, earned: session.earned };
  }

  getSession(address) {
    return this.activeSessions.get(address) || null;
  }

  /**
   * Restore the local session. If a blockchain is given, the on-chain session
   * wins (e.g. after reinstalling, or if the start tx was mined later).
   */
  async loadSession(address, blockchain = null) {
    const onChain = blockchain?.utxo?.getMiningSession(address) || null;
    const data = await this.storage?.get(`session:${address}`);
    let session = data ? MiningSession.fromJSON(JSON.parse(data)) : null;

    if (onChain) {
      if (!session) {
        const isValidator = blockchain.utxo.isValidator(address);
        session = new MiningSession({ address, rate: getCurrentMiningRate(onChain.start, 0, isValidator), isValidator });
      }
      session.alignTo(onChain.start);
    }
    if (!session) return null;

    if (Date.now() < session.endTime) {
      session.active = true;
      session.tick(); // catch up
    } else {
      session.expire();
    }
    this.activeSessions.set(address, session);
    return session;
  }

  startTicking(intervalMs = 60_000) {
    this.tickInterval = setInterval(() => {
      for (const session of this.activeSessions.values()) {
        if (session.active) session.tick();
      }
    }, intervalMs);
  }

  stopTicking() {
    if (this.tickInterval) clearInterval(this.tickInterval);
  }

  /**
   * Claim the reward for a finished on-chain session.
   * The amount is whatever the chain says the session earned — the local
   * counter is only a preview.
   */
  async claimReward(address, blockchain, broadcastTx, broadcastBlock, privateKey) {
    const local = this.activeSessions.get(address);
    if (local?.active) {
      return { error: 'Session must be completed before claiming' };
    }
    if (!blockchain) return { error: 'No blockchain' };
    if (!privateKey) return { error: 'Wallet private key required to sign the claim' };

    const pendingState = blockchain.getPendingState();
    const expected = pendingState.expectedMiningReward(address);
    if (!expected) {
      return { error: 'No mining session found on-chain. Start a session first.' };
    }
    if (!expected.ready) {
      const mins = Math.ceil((expected.endsAt - Date.now()) / 60_000);
      return { error: `Session ends in ${mins} min — claim after it finishes` };
    }
    if (expected.amount <= 0) {
      return { error: 'Supply cap reached. No MZY left to mine.' };
    }

    const tx = createMiningClaim({
      address,
      amount: expected.amount,
      nonce: pendingState.getNonce(address) + 1,
      privateKey,
      data: { poiAccuracy: expected.bestAccuracy },
    });

    const added = blockchain.addPendingTransaction(tx);
    if (!added.success) return { error: `Claim rejected: ${added.error}` };
    broadcastTx?.(tx);

    const forged = this._forgeNow(address, blockchain, privateKey, broadcastBlock);
    if (forged.error) return { error: forged.error, tx, amount: expected.amount };

    this.activeSessions.delete(address);
    await this.storage?.delete(`session:${address}`);

    return {
      tx,
      amount: expected.amount,
      baseReward: expected.base,
      poiBonus: expected.poiBonus,
      bestAccuracy: tx.data.poiAccuracy,
      included: !!forged.block,
    };
  }
}
