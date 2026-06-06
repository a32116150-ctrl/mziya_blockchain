/**
 * Mziya DeCompute — Decentralized ML Training Market
 *
 * Companies deploy models + deposit escrow.
 * Users train on-device and submit weights.
 * Peers verify accuracy claims.
 * Rewards proportional to compute contributed (speedFactor × accuracyFactor).
 */

import { TX_TYPE } from './transaction.js';

const VERIFICATION_WINDOW_BLOCKS = 100;

export class ModelRegistry {
  constructor() {
    this.models = new Map();
    this.escrow = new Map();
    this.submissions = new Map();
    this.benchmarks = new Map();
  }

  deployModel(tx) {
    if (this.models.has(tx.data.modelId)) {
      return { success: false, error: 'Model already exists' };
    }

    const modelDef = {
      modelId: tx.data.modelId,
      provider: tx.from,
      modelConfig: tx.data.modelConfig,
      datasetHash: tx.data.datasetHash,
      testSetHash: tx.data.testSetHash,
      maxExpectedAccuracy: tx.data.maxExpectedAccuracy,
      totalEscrow: tx.amount,
      remainingEscrow: tx.amount,
      submissionCount: 0,
      status: 'active',
      createdAt: Date.now(),
    };

    this.models.set(tx.data.modelId, modelDef);
    this.escrow.set(tx.data.modelId, tx.amount);
    this.submissions.set(tx.data.modelId, []);

    return { success: true };
  }

  recordSubmission(tx) {
    const model = this.models.get(tx.data.modelId);
    if (!model) return { success: false, error: 'Unknown model' };
    if (model.status !== 'active') return { success: false, error: 'Model no longer active' };

    const accuracyFactor = Math.min(1, tx.data.accuracy / model.maxExpectedAccuracy);
    if (accuracyFactor < 0.3) {
      return { success: false, error: 'Accuracy too low — below 30% of expected' };
    }

    const submission = {
      modelId: tx.data.modelId,
      trainer: tx.from,
      weights: tx.data.weights,
      accuracy: tx.data.accuracy,
      speedFactor: tx.data.speedFactor,
      accuracyFactor,
      score: tx.data.speedFactor * accuracyFactor,
      txHash: tx.txHash,
      timestamp: Date.now(),
      verified: null,
    };

    this.submissions.get(tx.data.modelId).push(submission);
    model.submissionCount++;

    return { success: true };
  }

  verifySubmission(tx) {
    const targetSub = this.findSubmission(tx.data.submissionTx);
    if (!targetSub) return { success: false, error: 'Submission not found' };
    if (targetSub.verified !== null) return { success: false, error: 'Already verified' };

    targetSub.verified = {
      verifier: tx.from,
      computedAccuracy: tx.data.computedAccuracy,
      invalid: tx.data.invalid,
      timestamp: Date.now(),
    };

    return { success: true };
  }

  findSubmission(txHash) {
    for (const subs of this.submissions.values()) {
      const found = subs.find(s => s.txHash === txHash);
      if (found) return found;
    }
    return null;
  }

  getPendingPayouts(modelId) {
    const model = this.models.get(modelId);
    if (!model) return [];
    const subs = this.submissions.get(modelId) || [];
    const cutoff = Date.now() - VERIFICATION_WINDOW_BLOCKS * 60_000;

    const pending = [];
    let totalScore = 0;
    const ready = [];

    for (const sub of subs) {
      if (sub.verified && sub.verified.invalid) continue;
      if (sub.verified && !sub.verified.invalid) {
        ready.push(sub);
        totalScore += sub.score;
      } else if (sub.timestamp < cutoff) {
        ready.push(sub);
        totalScore += sub.score;
      }
    }

    for (const sub of ready) {
      const share = sub.score / totalScore;
      pending.push({
        trainer: sub.trainer,
        reward: model.remainingEscrow * share,
        score: sub.score,
      });
    }

    return pending;
  }

  payoutBlockHashes(blockIndex) {
    const payouts = [];
    for (const modelId of this.models.keys()) {
      const pending = this.getPendingPayouts(modelId);
      for (const p of pending) {
        payouts.push({
          modelId,
          trainer: p.trainer,
          amount: p.reward,
          block: blockIndex,
        });
      }
    }
    return payouts;
  }

  getAvailable() {
    const available = [];
    for (const model of this.models.values()) {
      if (model.status === 'active' && model.remainingEscrow > 0) {
        available.push(model);
      }
    }
    return available;
  }

  getModel(modelId) {
    return this.models.get(modelId) || null;
  }

  snapshot() {
    return {
      models: Array.from(this.models.entries()).map(([id, m]) => [id, { ...m }]),
      escrow: Array.from(this.escrow.entries()),
      submissions: Array.from(this.submissions.entries()).map(([id, subs]) => [id, subs.map(s => ({ ...s }))]),
      benchmarks: Array.from(this.benchmarks.entries()),
    };
  }

  static fromSnapshot(snap) {
    const reg = new ModelRegistry();
    if (snap.models) {
      for (const [id, m] of snap.models) reg.models.set(id, m);
    }
    if (snap.escrow) {
      for (const [id, e] of snap.escrow) reg.escrow.set(id, e);
    }
    if (snap.submissions) {
      for (const [id, subs] of snap.submissions) reg.submissions.set(id, subs);
    }
    if (snap.benchmarks) {
      for (const [addr, b] of snap.benchmarks) reg.benchmarks.set(addr, b);
    }
    return reg;
  }
}

export function getDefaultModel() {
  return {
    modelId: 'mziya-sentiment-v1',
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
    totalEscrow: 100000,
    remainingEscrow: 100000,
    provider: 'GENESIS',
    submissionCount: 0,
    status: 'active',
    createdAt: Date.now(),
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
