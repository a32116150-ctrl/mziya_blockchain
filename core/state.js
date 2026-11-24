/**
 * Mziya Blockchain — Consensus State
 *
 * AccountState is everything a node must agree on after applying the chain:
 *   balances · nonces · public keys · stakes · open mining sessions ·
 *   total supply / burned · DeCompute models and escrow.
 *
 * validateTransaction() checks a tx against the current state.
 * applyTransaction() changes the state; call it only after validation.
 * A block is validated by cloning the state and applying its txs one by one,
 * so two txs in the same block can never spend the same balance.
 */

import { Transaction, TX_TYPE } from './transaction.js';
import { deriveAddress } from './wallet.js';
import { ModelRegistry } from './decompute.js';
import { TOKENOMICS, round6, floor6, computeSessionReward } from './tokenomics.js';

export class AccountState {
  constructor() {
    this.balances = new Map();        // address → spendable MZY
    this.nonces = new Map();          // address → last used nonce
    this.publicKeys = new Map();      // address → Ed25519 public key
    this.stakes = new Map();          // address → staked MZY
    this.miningSessions = new Map();  // address → { start, bestAccuracy }
    this.models = new ModelRegistry();
    this.totalSupply = 0;             // MZY in existence (balances + stakes + escrow)
    this.totalBurned = 0;             // MZY destroyed by fee burn
    this.totalStakingRewards = 0;     // MZY minted to validators
  }

  // ── Reads ──

  getBalance(address) { return this.balances.get(address) || 0; }
  getNonce(address) { return this.nonces.get(address) || 0; }
  getStake(address) { return this.stakes.get(address) || 0; }
  getMiningSession(address) { return this.miningSessions.get(address) || null; }

  isValidator(address) {
    return this.getStake(address) >= TOKENOMICS.MIN_STAKE;
  }

  /** Active validators, sorted by address for deterministic iteration. */
  getValidators() {
    const out = [];
    for (const [address, stake] of this.stakes) {
      if (stake >= TOKENOMICS.MIN_STAKE) out.push({ address, stake, publicKey: this.publicKeys.get(address) || null });
    }
    return out.sort((a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0));
  }

  totalStaked() {
    let s = 0;
    for (const v of this.stakes.values()) s += v;
    return round6(s);
  }

  remainingSupply() {
    return Math.max(0, round6(TOKENOMICS.TOTAL_SUPPLY - this.totalSupply));
  }

  /**
   * The exact MINING claim amount `address` may make right now, or null if the
   * session is missing / not finished. Matches what validators will accept.
   */
  expectedMiningReward(address, timestamp = Date.now()) {
    const session = this.miningSessions.get(address);
    if (!session) return null;
    const reward = computeSessionReward({
      startTimestamp: session.start,
      isValidator: this.isValidator(address),
      bestAccuracy: session.bestAccuracy,
    });
    const amount = Math.min(reward.total, this.remainingSupply());
    return {
      ...reward,
      amount: round6(amount),
      bestAccuracy: session.bestAccuracy,
      start: session.start,
      endsAt: session.start + TOKENOMICS.SESSION_DURATION_MS,
      ready: timestamp - session.start >= TOKENOMICS.SESSION_DURATION_MS,
    };
  }

  // ── Validation ──

  /**
   * @param {Transaction} tx — must already pass tx.validateBasic()
   * @param {{blockIndex:number, timestamp:number}} ctx
   */
  validateTransaction(tx, ctx) {
    const fail = (error) => ({ valid: false, error });
    const from = tx.from;

    const expectedNonce = this.getNonce(from) + 1;
    if (tx.nonce !== expectedNonce) {
      return fail(`Invalid nonce: expected ${expectedNonce}, got ${tx.nonce}`);
    }

    // Amount that leaves the sender's spendable balance
    const spends = (tx.type === TX_TYPE.TRANSFER || tx.type === TX_TYPE.STAKE || tx.type === TX_TYPE.MODEL_DEPLOY)
      ? round6(tx.amount + tx.fee)
      : tx.fee;
    const balance = this.getBalance(from);
    if (balance < spends) {
      return fail(`Insufficient balance: has ${balance}, needs ${spends}`);
    }

    switch (tx.type) {
      case TX_TYPE.MINING_START:
        if (this.miningSessions.has(from)) return fail('A mining session is already open — claim it first');
        break;

      case TX_TYPE.MINING: {
        const expected = this.expectedMiningReward(from, ctx.timestamp);
        if (!expected) return fail('No open mining session — send MINING_START first');
        if (!expected.ready) return fail('Mining session has not finished yet');
        if (expected.amount <= 0) return fail('Supply cap reached — nothing left to mine');
        if (tx.amount !== expected.amount) {
          return fail(`MINING amount must be exactly ${expected.amount} (got ${tx.amount})`);
        }
        break;
      }

      case TX_TYPE.UNSTAKE:
        if (this.getStake(from) < tx.amount) {
          return fail(`Cannot unstake ${tx.amount}: only ${this.getStake(from)} staked`);
        }
        break;

      case TX_TYPE.MODEL_DEPLOY: {
        const err = this.models.checkDeploy(tx);
        if (err) return fail(err);
        break;
      }

      case TX_TYPE.TRAINING_SUBMIT: {
        const err = this.models.checkSubmission(tx, ctx.blockIndex);
        if (err) return fail(err);
        break;
      }

      case TX_TYPE.TRAINING_VERIFY: {
        const err = this.models.checkVerify(tx, ctx.blockIndex, this.isValidator(from));
        if (err) return fail(err);
        break;
      }

      case TX_TYPE.MODEL_WITHDRAW: {
        const err = this.models.checkWithdraw(tx, ctx.blockIndex);
        if (err) return fail(err);
        break;
      }
    }

    return { valid: true };
  }

  // ── Transitions ──

  _credit(address, amount) {
    if (amount === 0) return;
    this.balances.set(address, round6(this.getBalance(address) + amount));
  }

  _debit(address, amount) {
    if (amount === 0) return;
    this.balances.set(address, round6(this.getBalance(address) - amount));
  }

  _mint(address, amount) {
    this._credit(address, amount);
    this.totalSupply = round6(this.totalSupply + amount);
  }

  _burn(amount) {
    this.totalSupply = round6(this.totalSupply - amount);
    this.totalBurned = round6(this.totalBurned + amount);
  }

  /** Splits a fee: FEE_BURN_RATE (rounded up) is destroyed, the rest goes to the block producer. */
  _chargeFee(tx, miner) {
    if (!tx.fee) return;
    this._debit(tx.from, tx.fee);
    // Work in whole micro-MZY; the burned part rounds up, so a minimum fee is fully burned.
    const feeMicro = Math.round(tx.fee * 1_000_000);
    const burnMicro = miner ? Math.ceil(feeMicro * TOKENOMICS.FEE_BURN_RATE - 1e-9) : feeMicro;
    const burned = burnMicro / 1_000_000;
    const toMiner = (feeMicro - burnMicro) / 1_000_000;
    if (toMiner > 0) this._credit(miner, toMiner);
    this._burn(burned);
  }

  /**
   * Validators share STAKER_REWARD_SHARE of each mining claim, pro-rata by stake.
   * Each share is rounded down, so the total minted never exceeds the pool.
   */
  _payStakingRewards(claimAmount) {
    const validators = this.getValidators();
    if (validators.length === 0) return 0;
    const pool = Math.min(floor6(claimAmount * TOKENOMICS.STAKER_REWARD_SHARE), this.remainingSupply());
    if (pool <= 0) return 0;
    const totalStake = validators.reduce((s, v) => s + v.stake, 0);
    let minted = 0;
    for (const v of validators) {
      const share = floor6(pool * (v.stake / totalStake));
      if (share > 0) {
        this._mint(v.address, share);
        minted = round6(minted + share);
      }
    }
    this.totalStakingRewards = round6(this.totalStakingRewards + minted);
    return minted;
  }

  /**
   * Apply a validated transaction.
   * @param {Transaction} tx
   * @param {{blockIndex:number, timestamp:number, miner?:string}} ctx
   */
  applyTransaction(tx, ctx = {}) {
    if (tx.type === TX_TYPE.GENESIS) return; // genesis record carries no balances

    const from = tx.from;
    if (tx.publicKey && !this.publicKeys.has(from) && deriveAddress(tx.publicKey) === from) {
      this.publicKeys.set(from, tx.publicKey);
    }
    this.nonces.set(from, tx.nonce);
    this._chargeFee(tx, ctx.miner);

    switch (tx.type) {
      case TX_TYPE.TRANSFER:
        this._debit(from, tx.amount);
        this._credit(tx.to, tx.amount);
        break;

      case TX_TYPE.MINING_START:
        this.miningSessions.set(from, { start: ctx.timestamp ?? tx.timestamp, bestAccuracy: 0 });
        break;

      case TX_TYPE.MINING:
        this.miningSessions.delete(from);
        this._mint(from, tx.amount);
        this._payStakingRewards(tx.amount);
        break;

      case TX_TYPE.STAKE:
        this._debit(from, tx.amount);
        this.stakes.set(from, round6(this.getStake(from) + tx.amount));
        break;

      case TX_TYPE.UNSTAKE: {
        const left = round6(this.getStake(from) - tx.amount);
        if (left > 0) this.stakes.set(from, left); else this.stakes.delete(from);
        this._credit(from, tx.amount);
        break;
      }

      case TX_TYPE.AI_SUBMISSION:
        this._recordPoI(from, tx.data?.accuracy);
        break;

      case TX_TYPE.MODEL_DEPLOY:
        this._debit(from, tx.amount); // moves into escrow; still counted in totalSupply
        this.models.deployModel(tx, ctx);
        break;

      case TX_TYPE.TRAINING_SUBMIT:
        this.models.recordSubmission(tx, ctx);
        this._recordPoI(from, tx.data?.accuracy);
        break;

      case TX_TYPE.TRAINING_VERIFY: {
        const res = this.models.verifySubmission(tx, ctx);
        for (const p of res.payouts || []) this._credit(p.address, p.amount);
        break;
      }

      case TX_TYPE.MODEL_WITHDRAW: {
        const res = this.models.withdraw(tx);
        this._credit(from, res.refund);
        break;
      }
    }
  }

  /** Training during an open mining session raises its Proof-of-Intelligence bonus. */
  _recordPoI(address, accuracy) {
    const session = this.miningSessions.get(address);
    if (session && typeof accuracy === 'number' && accuracy > session.bestAccuracy) {
      session.bestAccuracy = Math.min(1, accuracy);
    }
  }

  /** Apply every tx in a block (no validation — use for trusted/replayed blocks). */
  applyBlock(block) {
    const ctx = { blockIndex: block.index, timestamp: block.timestamp, miner: block.miner };
    if (block.index === 0) {
      this.models.registerPracticeModel(block.timestamp);
      return;
    }
    for (const txData of block.transactions) {
      const tx = txData instanceof Transaction ? txData : Transaction.fromJSON(txData);
      this.applyTransaction(tx, ctx);
    }
  }

  // ── Copy & persistence ──

  clone() {
    const s = new AccountState();
    s.balances = new Map(this.balances);
    s.nonces = new Map(this.nonces);
    s.publicKeys = new Map(this.publicKeys);
    s.stakes = new Map(this.stakes);
    s.miningSessions = new Map([...this.miningSessions].map(([a, v]) => [a, { ...v }]));
    s.models = this.models.clone();
    s.totalSupply = this.totalSupply;
    s.totalBurned = this.totalBurned;
    s.totalStakingRewards = this.totalStakingRewards;
    return s;
  }

  snapshot() {
    return {
      balances: Object.fromEntries(this.balances),
      nonces: Object.fromEntries(this.nonces),
      stakes: Object.fromEntries(this.stakes),
      miningSessions: Object.fromEntries(this.miningSessions),
      totalSupply: this.totalSupply,
      totalBurned: this.totalBurned,
      totalStakingRewards: this.totalStakingRewards,
      models: this.models.snapshot(),
    };
  }

  static fromSnapshot(snap) {
    const s = new AccountState();
    for (const [a, v] of Object.entries(snap.balances || {})) s.balances.set(a, v);
    for (const [a, v] of Object.entries(snap.nonces || {})) s.nonces.set(a, v);
    for (const [a, v] of Object.entries(snap.stakes || {})) s.stakes.set(a, v);
    for (const [a, v] of Object.entries(snap.miningSessions || {})) s.miningSessions.set(a, { ...v });
    s.totalSupply = snap.totalSupply || 0;
    s.totalBurned = snap.totalBurned || 0;
    s.totalStakingRewards = snap.totalStakingRewards || 0;
    if (snap.models) s.models = ModelRegistry.fromSnapshot(snap.models);
    return s;
  }
}
