/**
 * Mziya Blockchain — Mining Engine
 * Proof-of-Activity (PoA):
 *  - Users tap once per 24h to prove they are active
 *  - No GPU, no battery drain, no electricity cost
 *  - Mining rate decreases over time (halving schedule)
 */

// ── Tokenomics Constants ───────────────────────────────────────────────────

export const TOKENOMICS = {
  TOTAL_SUPPLY:        21_000_000_000,   // 21 billion MZY hard cap
  INITIAL_HOURLY_RATE: 1.618,            // Golden ratio base rate
  HALVING_PERIOD_MS:   2 * 365.25 * 24 * 60 * 60 * 1000, // 2 years
  FLOOR_RATE:          0.202,            // Minimum rate after all halvings
  SESSION_DURATION_MS: 24 * 60 * 60 * 1000,  // 24 hours per session
  VALIDATOR_BONUS:     0.25,             // +25% for running a node
  REFERRAL_BONUS:      0.05,             // +5% per active referred miner
  BLOCK_TIME_MS:       60_000,           // 60 seconds per block
  GENESIS_TIMESTAMP:   1748736000000,    // 2026-06-01 00:00:00 UTC
  POI_BONUS_MULTIPLIER: 0.10,            // +10% PoI bonus multiplier
  MAX_MINING_REWARD:    100,             // Max mining reward per claim
  MAX_THEORETICAL_REWARD_RATE: 3.5,      // Max theoretical hourly reward rate
};

import { Transaction, createMiningReward } from './transaction.js';

// ── Rate Calculator ────────────────────────────────────────────────────────

/**
 * Calculate current mining rate based on elapsed time since genesis.
 * Rate halves every 2 years, with a floor.
 */
export function getCurrentMiningRate(timestamp = Date.now(), activeReferrals = 0, isValidator = false) {
  const elapsed = timestamp - TOKENOMICS.GENESIS_TIMESTAMP;
  const halvings = Math.floor(elapsed / TOKENOMICS.HALVING_PERIOD_MS);

  let rate = TOKENOMICS.INITIAL_HOURLY_RATE / Math.pow(2, halvings);
  rate = Math.max(rate, TOKENOMICS.FLOOR_RATE);

  // Bonuses
  if (isValidator) rate *= (1 + TOKENOMICS.VALIDATOR_BONUS);
  if (activeReferrals > 0) rate *= (1 + Math.min(activeReferrals, 10) * TOKENOMICS.REFERRAL_BONUS);

  return Math.round(rate * 1_000_000) / 1_000_000; // 6 decimal places
}

/**
 * Calculate MZY earned during a mining session.
 */
export function calculateSessionEarnings(durationMs, rate) {
  const hours = durationMs / (60 * 60 * 1000);
  return Math.round(hours * rate * 1_000_000) / 1_000_000;
}

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

export class MiningManager {
  constructor(storage) {
    this.storage = storage; // IndexedDB or LevelDB wrapper
    this.activeSessions = new Map(); // address → MiningSession
    this.tickInterval = null;
  }

  async startSession(address, options = {}) {
    if (this.activeSessions.has(address)) {
      const existing = this.activeSessions.get(address);
      if (existing.active) return { error: 'Session already active', session: existing };
    }

    const rate = getCurrentMiningRate(Date.now(), options.referrals, options.isValidator);
    const session = new MiningSession({
      address,
      rate,
      referrals: options.referrals || 0,
      isValidator: options.isValidator || false,
    });

    this.activeSessions.set(address, session);
    await this.storage?.set(`session:${address}`, JSON.stringify(session.toJSON()));

    return { session };
  }

  async confirmActivity(address) {
    // The daily "tap" — confirms the user is human and active
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

  async loadSession(address) {
    const data = await this.storage?.get(`session:${address}`);
    if (!data) return null;
    const session = MiningSession.fromJSON(JSON.parse(data));
    // Resume if still within 24h
    if (session.active && Date.now() < session.endTime) {
      session.tick(); // catch up
      this.activeSessions.set(address, session);
      return session;
    }
    return null;
  }

  startTicking(intervalMs = 60_000) {
    this.tickInterval = setInterval(() => {
      for (const session of this.activeSessions.values()) {
        if (session.active) session.tick();
        else this.activeSessions.delete(session.address);
      }
    }, intervalMs);
  }

  stopTicking() {
    if (this.tickInterval) clearInterval(this.tickInterval);
  }

  /**
   * Generate the mining reward transaction for a completed session.
   * Checks total supply cap before minting.
   * Broadcasts tx + block through optional callbacks for P2P propagation.
   */
  async claimReward(address, blockchain, broadcastTx, broadcastBlock) {
    const session = this.activeSessions.get(address);
    if (!session || session.active) {
      return { error: 'Session must be completed before claiming' };
    }

    // ── Supply cap check ──
    const currentSupply = [...(blockchain?.utxo?.balances?.values() || [])].reduce((s, v) => s + Math.max(0, v), 0);
    if (currentSupply + session.earned > TOKENOMICS.TOTAL_SUPPLY) {
      const remaining = Math.max(0, TOKENOMICS.TOTAL_SUPPLY - currentSupply);
      return { error: `Supply cap reached. Only ${remaining.toFixed(6)} MZY remaining to be mined.` };
    }

    let bestAcc = 0;

    if (blockchain && blockchain.chain) {
      for (const block of blockchain.chain) {
        if (block.timestamp >= session.startTime) {
          for (const txData of block.transactions) {
            if (txData.type === 'AI_SUBMISSION' && txData.from === address && txData.data && typeof txData.data.accuracy === 'number') {
              if (txData.data.accuracy > bestAcc) bestAcc = txData.data.accuracy;
            }
          }
        }
      }
    }

    let poiBonus = 0;
    if (bestAcc > 0) {
      poiBonus = Math.round(session.earned * (bestAcc * TOKENOMICS.POI_BONUS_MULTIPLIER) * 1000000) / 1000000;
      session.earned = Math.round((session.earned + poiBonus) * 1000000) / 1000000;
    }

    const tx = createMiningReward(address, session.earned, blockchain.length);
    tx.data = { ...tx.data, poiAccuracy: bestAcc, poiBonus };

    blockchain.mempool.add(tx);
    broadcastTx?.(tx);

    const block = blockchain.mempool.size > 0 ? blockchain.forgeBlock(address) : null;
    if (block) {
      broadcastBlock?.(block);
      const result = blockchain.addBlock(block);
      if (!result.success) {
        return { error: `Block rejected: ${result.error}`, tx, amount: session.earned };
      }
    }

    this.activeSessions.delete(address);
    await this.storage?.delete(`session:${address}`);

    return { tx, amount: session.earned, poiBonus, bestAccuracy: bestAcc };
  }
}
