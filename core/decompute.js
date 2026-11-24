/**
 * Mziya DeCompute — Decentralized ML Training Market
 *
 * 1. A company sends MODEL_DEPLOY with an MZY escrow and a payout per submission.
 * 2. Trainers train on-device and send TRAINING_SUBMIT (weights + claimed accuracy).
 *    The payout is reserved from escrow straight away.
 * 3. The model's provider or any staked validator re-evaluates the weights and
 *    sends TRAINING_VERIFY with the accuracy they measured. If it is within
 *    tolerance of the claim, the trainer is paid and the verifier earns a fee.
 *    Otherwise the reservation is released.
 * 4. Unverified submissions expire after VERIFICATION_WINDOW_BLOCKS.
 * 5. The provider can withdraw leftover escrow once nothing is pending.
 *
 * All state here is consensus state: it is only changed by core/state.js
 * while applying a validated block, and uses block index/timestamp, never
 * the local clock.
 */

import { DECOMPUTE, floor6, round6 } from './tokenomics.js';

export class ModelRegistry {
  constructor() {
    this.models = new Map();       // modelId → model
    this.submissions = new Map();  // modelId → submission[]
    this.subIndex = new Map();     // submission txHash → modelId
    this.benchmarks = new Map();   // kept for API compatibility (unused by consensus)
  }

  // ── Read helpers ──

  getModel(modelId) {
    return this.models.get(modelId) || null;
  }

  getAvailable() {
    const available = [];
    for (const model of this.models.values()) {
      if (model.status === 'active' && (model.practice || model.remainingEscrow > 0)) {
        available.push(model);
      }
    }
    return available;
  }

  findSubmission(txHash) {
    const modelId = this.subIndex.get(txHash);
    if (!modelId) return null;
    return (this.submissions.get(modelId) || []).find(s => s.txHash === txHash) || null;
  }

  isExpired(sub, blockIndex) {
    return blockIndex > sub.blockIndex + DECOMPUTE.VERIFICATION_WINDOW_BLOCKS;
  }

  isPending(sub, blockIndex) {
    return sub.verified === null && sub.payout > 0 && !this.isExpired(sub, blockIndex);
  }

  /** Submissions still waiting for a verifier at the given height. */
  getPendingSubmissions(modelId, blockIndex) {
    const ids = modelId ? [modelId] : [...this.models.keys()];
    const out = [];
    for (const id of ids) {
      for (const sub of this.submissions.get(id) || []) {
        if (this.isPending(sub, blockIndex)) out.push(sub);
      }
    }
    return out;
  }

  /** Escrow not yet promised to a pending submission. */
  availableEscrow(modelId, blockIndex) {
    const model = this.models.get(modelId);
    if (!model) return 0;
    const reserved = this.getPendingSubmissions(modelId, blockIndex)
      .reduce((s, sub) => s + sub.payout + sub.verifierFee, 0);
    return round6(model.remainingEscrow - reserved);
  }

  /** What a submission with this accuracy would earn (trainer payout + verifier fee). */
  quotePayout(modelId, accuracy) {
    const model = this.models.get(modelId);
    if (!model) return { accuracyFactor: 0, payout: 0, verifierFee: 0 };
    const accuracyFactor = Math.min(1, accuracy / model.maxExpectedAccuracy);
    if (model.practice) return { accuracyFactor, payout: 0, verifierFee: 0 };
    const payout = floor6(model.rewardPerSubmission * accuracyFactor);
    const verifierFee = floor6(payout * DECOMPUTE.VERIFIER_FEE_RATE);
    return { accuracyFactor, payout, verifierFee };
  }

  // ── Stateful checks (used by AccountState.validateTransaction) ──

  checkDeploy(tx) {
    if (this.models.has(tx.data.modelId)) return 'Model already exists';
    return null;
  }

  checkSubmission(tx, blockIndex) {
    const model = this.models.get(tx.data.modelId);
    if (!model) return 'Unknown model';
    if (model.status !== 'active') return 'Model no longer active';
    if (model.provider === tx.from) return 'Providers cannot train their own model';

    const { accuracyFactor, payout, verifierFee } = this.quotePayout(tx.data.modelId, tx.data.accuracy);
    if (accuracyFactor < DECOMPUTE.MIN_ACCURACY_FACTOR) return 'Accuracy too low — below 30% of expected';
    if (model.practice) return null;

    const hasPending = (this.submissions.get(model.modelId) || [])
      .some(s => s.trainer === tx.from && this.isPending(s, blockIndex));
    if (hasPending) return 'You already have a submission waiting for verification on this model';

    if (payout <= 0) return 'Payout rounds to zero';
    if (this.availableEscrow(model.modelId, blockIndex) < round6(payout + verifierFee)) {
      return 'Model escrow exhausted';
    }
    return null;
  }

  checkVerify(tx, blockIndex, isValidator) {
    const sub = this.findSubmission(tx.data.submissionTx);
    if (!sub) return 'Submission not found';
    if (sub.verified !== null) return 'Already verified';
    if (sub.payout <= 0) return 'Practice submissions are not verified';
    if (this.isExpired(sub, blockIndex)) return 'Verification window expired';
    if (sub.trainer === tx.from) return 'Trainers cannot verify their own submission';
    const model = this.models.get(sub.modelId);
    if (model.provider !== tx.from && !isValidator) return 'Only the model provider or a staked validator can verify';
    return null;
  }

  checkWithdraw(tx, blockIndex) {
    const model = this.models.get(tx.data.modelId);
    if (!model) return 'Unknown model';
    if (model.provider !== tx.from) return 'Only the model provider can withdraw escrow';
    if (model.status !== 'active') return 'Model already closed';
    if (this.getPendingSubmissions(model.modelId, blockIndex).length > 0) {
      return 'Cannot withdraw while submissions are waiting for verification';
    }
    return null;
  }

  // ── State transitions (only called on validated txs) ──

  registerPracticeModel(timestamp) {
    const model = getDefaultModel(timestamp);
    this.models.set(model.modelId, model);
    this.submissions.set(model.modelId, []);
  }

  deployModel(tx, ctx = {}) {
    if (this.models.has(tx.data.modelId)) {
      return { success: false, error: 'Model already exists' };
    }
    const rewardPerSubmission = tx.data.rewardPerSubmission
      ?? Math.max(0.000001, floor6(tx.amount / DECOMPUTE.DEFAULT_PAYOUT_DIVISOR));

    const modelDef = {
      modelId: tx.data.modelId,
      provider: tx.from,
      modelConfig: tx.data.modelConfig,
      datasetHash: tx.data.datasetHash,
      testSetHash: tx.data.testSetHash,
      maxExpectedAccuracy: tx.data.maxExpectedAccuracy,
      rewardPerSubmission,
      totalEscrow: tx.amount,
      remainingEscrow: tx.amount,
      paidOut: 0,
      submissionCount: 0,
      status: 'active',
      practice: false,
      createdAtBlock: ctx.blockIndex ?? null,
      createdAt: ctx.timestamp ?? tx.timestamp,
    };

    this.models.set(modelDef.modelId, modelDef);
    this.submissions.set(modelDef.modelId, []);
    return { success: true };
  }

  recordSubmission(tx, ctx = {}) {
    const model = this.models.get(tx.data.modelId);
    if (!model) return { success: false, error: 'Unknown model' };
    if (model.status !== 'active') return { success: false, error: 'Model no longer active' };

    const { accuracyFactor, payout, verifierFee } = this.quotePayout(model.modelId, tx.data.accuracy);
    if (accuracyFactor < DECOMPUTE.MIN_ACCURACY_FACTOR) {
      return { success: false, error: 'Accuracy too low — below 30% of expected' };
    }

    const submission = {
      modelId: model.modelId,
      trainer: tx.from,
      weights: tx.data.weights,
      accuracy: tx.data.accuracy,
      speedFactor: tx.data.speedFactor,
      seedHash: tx.data.seedHash ?? null,
      accuracyFactor,
      score: tx.data.speedFactor * accuracyFactor,
      payout,
      verifierFee,
      txHash: tx.txHash,
      blockIndex: ctx.blockIndex ?? 0,
      timestamp: ctx.timestamp ?? tx.timestamp,
      verified: null,
    };

    this.submissions.get(model.modelId).push(submission);
    this.subIndex.set(tx.txHash, model.modelId);
    model.submissionCount++;
    return { success: true, submission };
  }

  /**
   * Marks a submission as verified. Valid when the verifier's measured accuracy
   * is within tolerance of the trainer's claim. Returns the payouts to credit.
   */
  verifySubmission(tx, ctx = {}) {
    const sub = this.findSubmission(tx.data.submissionTx);
    if (!sub) return { success: false, error: 'Submission not found' };
    if (sub.verified !== null) return { success: false, error: 'Already verified' };

    const computed = tx.data.computedAccuracy;
    const valid = typeof computed === 'number'
      && Math.abs(computed - sub.accuracy) <= DECOMPUTE.ACCURACY_TOLERANCE + 1e-9;

    sub.verified = {
      verifier: tx.from,
      computedAccuracy: computed,
      valid,
      invalid: !valid,
      blockIndex: ctx.blockIndex ?? null,
      timestamp: ctx.timestamp ?? tx.timestamp,
    };

    if (!valid || sub.payout <= 0) {
      return { success: true, valid, payouts: [] };
    }

    const model = this.models.get(sub.modelId);
    const total = round6(sub.payout + sub.verifierFee);
    model.remainingEscrow = round6(model.remainingEscrow - total);
    model.paidOut = round6(model.paidOut + total);

    const payouts = [{ address: sub.trainer, amount: sub.payout }];
    if (sub.verifierFee > 0) payouts.push({ address: tx.from, amount: sub.verifierFee });
    return { success: true, valid, payouts };
  }

  /** Closes the model and returns the escrow to refund to the provider. */
  withdraw(tx) {
    const model = this.models.get(tx.data.modelId);
    if (!model) return { success: false, refund: 0 };
    const refund = model.remainingEscrow;
    model.remainingEscrow = 0;
    model.status = 'closed';
    return { success: true, refund };
  }

  /** Total MZY currently locked in escrow across all models. */
  totalEscrow() {
    let sum = 0;
    for (const m of this.models.values()) sum += m.practice ? 0 : m.remainingEscrow;
    return round6(sum);
  }

  // ── Copy & persistence ──

  clone() {
    const reg = new ModelRegistry();
    for (const [id, m] of this.models) reg.models.set(id, { ...m });
    for (const [id, subs] of this.submissions) {
      // weights arrays are never mutated, so they can be shared
      reg.submissions.set(id, subs.map(s => ({ ...s, verified: s.verified ? { ...s.verified } : null })));
    }
    reg.subIndex = new Map(this.subIndex);
    reg.benchmarks = new Map(this.benchmarks);
    return reg;
  }

  snapshot() {
    return {
      models: Array.from(this.models.entries()).map(([id, m]) => [id, { ...m }]),
      submissions: Array.from(this.submissions.entries()).map(([id, subs]) => [id, subs.map(s => ({ ...s }))]),
      benchmarks: Array.from(this.benchmarks.entries()),
    };
  }

  static fromSnapshot(snap) {
    const reg = new ModelRegistry();
    for (const [id, m] of snap.models || []) reg.models.set(id, m);
    for (const [id, subs] of snap.submissions || []) {
      reg.submissions.set(id, subs);
      for (const s of subs) reg.subIndex.set(s.txHash, id);
    }
    for (const [addr, b] of snap.benchmarks || []) reg.benchmarks.set(addr, b);
    return reg;
  }
}

/**
 * The built-in practice model. It holds no escrow, so it pays nothing directly,
 * but training it counts toward the Proof-of-Intelligence mining bonus.
 */
export function getDefaultModel(timestamp = 0) {
  return {
    modelId: DECOMPUTE.PRACTICE_MODEL_ID,
    modelConfig: {
      layers: [
        { type: 'dense', units: 16, activation: 'relu', inputShape: [4] },
        { type: 'dense', units: 8, activation: 'relu' },
        { type: 'dense', units: 1, activation: 'sigmoid' },
      ],
      compile: { optimizer: 'sgd', loss: 'binaryCrossentropy', metrics: ['accuracy'] },
      epochs: 10,
      batchSize: 10,
    },
    datasetHash: 'default-synthetic-sum-v1',
    testSetHash: 'default-synthetic-sum-test-v1',
    maxExpectedAccuracy: 0.95,
    rewardPerSubmission: 0,
    totalEscrow: 0,
    remainingEscrow: 0,
    paidOut: 0,
    provider: 'GENESIS',
    submissionCount: 0,
    status: 'active',
    practice: true,
    createdAtBlock: 0,
    createdAt: timestamp,
  };
}

export function computeBenchmark() {
  const start = performance.now();
  const n = 50;
  const data = new Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = 0; j < 1000; j++) {
      s += Math.sin(j * i) * Math.cos(j);
    }
    data[i] = s;
  }
  const elapsed = performance.now() - start;
  const baseline = 50;
  return Math.max(0.1, Math.round((baseline / elapsed) * 100) / 100);
}
