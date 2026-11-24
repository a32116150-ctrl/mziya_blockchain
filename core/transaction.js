/**
 * Mziya Blockchain — Transactions
 *
 * Every transaction (except the genesis record) is signed with Ed25519 by its
 * sender. This file holds the Transaction class and the *stateless* checks
 * (shape, signature, limits). Checks that depend on chain state — balances,
 * nonces, stakes, mining sessions, model escrow — live in core/state.js.
 */

import { hashData, canonicalStringify } from './block.js';
import { sign, verify, isValidAddress, deriveAddress } from './wallet.js';
import { ed25519 } from '@noble/curves/ed25519';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { TOKENOMICS, hasMax6Decimals } from './tokenomics.js';

export { AccountState } from './state.js';

// ── Transaction Types ──────────────────────────────────────────────────────

export const TX_TYPE = {
  TRANSFER:      'TRANSFER',
  MINING_START:  'MINING_START',   // Miner opens a 24h mining session on-chain
  MINING:        'MINING',         // Miner claims the reward for a completed session
  STAKE:         'STAKE',          // Lock MZY to become a validator
  UNSTAKE:       'UNSTAKE',        // Unlock previously staked MZY
  GENESIS:       'GENESIS',
  AI_SUBMISSION: 'AI_SUBMISSION',  // Proof-of-Intelligence weights (mining bonus)
  // DeCompute — decentralized ML training market
  MODEL_DEPLOY:    'MODEL_DEPLOY',    // Company deploys a model + deposits escrow
  TRAINING_SUBMIT: 'TRAINING_SUBMIT', // Trainer submits trained weights
  TRAINING_VERIFY: 'TRAINING_VERIFY', // Validator/provider checks a submission → payout
  MODEL_WITHDRAW:  'MODEL_WITHDRAW',  // Company reclaims unused escrow
};

const KNOWN_TYPES = new Set(Object.values(TX_TYPE));

/** Types that may be sent with a zero fee, so brand-new users can mine and train. */
export const FEE_EXEMPT_TYPES = new Set([
  TX_TYPE.MINING_START,
  TX_TYPE.MINING,
  TX_TYPE.AI_SUBMISSION,
  TX_TYPE.TRAINING_SUBMIT,
]);

export const MODEL_REGISTRY_ADDRESS = 'MODEL_REGISTRY';

// ── Transaction ────────────────────────────────────────────────────────────

export class Transaction {
  constructor({ from, to, amount = 0, type = TX_TYPE.TRANSFER, fee = 0, nonce = 0, data = null, timestamp, publicKey }) {
    this.from = from;          // sender address
    this.to = to;              // recipient address (or MODEL_REGISTRY / model id)
    this.amount = amount;      // MZY, max 6 decimals
    this.type = type;
    this.fee = fee;            // half burned, half to the block producer
    this.nonce = nonce;        // anti-replay: must be exactly lastNonce + 1
    this.data = data;          // type-specific payload
    this.timestamp = timestamp || Date.now();
    this.publicKey = publicKey || null; // Ed25519 public key hex — embedded for self-verification
    this.signature = null;
    this.txHash = null;
  }

  getPayload() {
    return {
      from: this.from,
      to: this.to,
      amount: this.amount,
      type: this.type,
      fee: this.fee,
      nonce: this.nonce,
      data: this.data,
      timestamp: this.timestamp,
    };
  }

  /** Canonical (sorted-key) serialization so every engine signs identical bytes. */
  signingMessage() {
    return canonicalStringify(this.getPayload());
  }

  computeHash() {
    const p = this.getPayload();
    if (this.signature) p.signature = this.signature;
    if (this.publicKey) p.publicKey = this.publicKey;
    return hashData(canonicalStringify(p));
  }

  /**
   * Sign with the sender's private key. Embeds the public key so anyone can
   * verify without a key registry.
   */
  sign(privateKey) {
    if (this.type === TX_TYPE.GENESIS) {
      this.txHash = this.computeHash();
      return this;
    }
    const privBytes = hexToBytes(privateKey);
    this.publicKey = bytesToHex(ed25519.getPublicKey(privBytes));
    this.signature = sign(this.signingMessage(), privateKey);
    this.txHash = this.computeHash();
    return this;
  }

  isSignatureValid(publicKey = this.publicKey) {
    if (!this.signature || !publicKey) return false;
    return verify(this.signingMessage(), this.signature, publicKey);
  }

  /**
   * Stateless validation: shape, limits, hash and signature.
   * Returns { valid, error? }.
   */
  validateBasic() {
    const fail = (error) => ({ valid: false, error });

    if (!KNOWN_TYPES.has(this.type)) return fail(`Unknown transaction type: ${this.type}`);
    if (this.type === TX_TYPE.GENESIS) return fail('GENESIS transactions are only allowed in the genesis block');

    // ── Numbers ──
    if (!hasMax6Decimals(this.amount) || this.amount < 0) return fail('Invalid amount');
    if (!hasMax6Decimals(this.fee) || this.fee < 0) return fail('Invalid fee');
    if (!Number.isSafeInteger(this.nonce) || this.nonce < 1) return fail('Invalid nonce');
    if (!Number.isSafeInteger(this.timestamp) || this.timestamp <= 0) return fail('Invalid timestamp');
    if (!FEE_EXEMPT_TYPES.has(this.type) && this.fee < TOKENOMICS.MIN_FEE) {
      return fail(`Fee below minimum (${TOKENOMICS.MIN_FEE} MZY)`);
    }

    // ── Sender & signature ──
    if (!this.from || !isValidAddress(this.from)) return fail('Invalid sender address');
    if (!this.publicKey) return fail('Missing public key — cannot verify signature');
    let derived;
    try { derived = deriveAddress(this.publicKey); } catch { return fail('Malformed public key'); }
    if (derived !== this.from) return fail('Public key does not match sender address');
    if (!this.isSignatureValid(this.publicKey)) return fail('Invalid signature');
    if (this.txHash && this.txHash !== this.computeHash()) return fail('Transaction hash mismatch');

    // ── Payload size ──
    if (this.data !== null && this.data !== undefined) {
      if (typeof this.data !== 'object' || Array.isArray(this.data)) return fail('data must be an object');
      if (canonicalStringify(this.data).length > TOKENOMICS.MAX_TX_DATA_BYTES) return fail('Transaction data too large');
    }

    const d = this.data || {};
    const zero = () => this.amount === 0;
    const positive = () => this.amount >= 0.000001;

    switch (this.type) {
      case TX_TYPE.TRANSFER:
        if (!isValidAddress(this.to)) return fail('Invalid recipient address');
        if (!positive()) return fail('Amount below minimum (0.000001 MZY)');
        break;

      case TX_TYPE.MINING_START:
        if (this.to !== this.from) return fail('MINING_START must be sent to yourself');
        if (!zero()) return fail('MINING_START must have zero amount');
        break;

      case TX_TYPE.MINING:
        if (this.to !== this.from) return fail('MINING reward must be paid to the miner');
        if (!positive()) return fail('MINING tx requires positive amount');
        if (this.amount > TOKENOMICS.MAX_MINING_REWARD) return fail('MINING reward exceeds maximum hard cap constraint');
        break;

      case TX_TYPE.STAKE:
      case TX_TYPE.UNSTAKE:
        if (this.to !== this.from) return fail(`${this.type} must be sent to yourself`);
        if (!positive()) return fail('Amount below minimum (0.000001 MZY)');
        break;

      case TX_TYPE.AI_SUBMISSION: {
        if (!zero()) return fail('AI submissions must have zero amount');
        if (!this.to) return fail('Missing recipient address');
        const w = checkWeights(d.weights);
        if (w) return fail(`AI submission ${w}`);
        if (!isAccuracy(d.accuracy)) return fail('AI accuracy must be between 0 and 1');
        break;
      }

      case TX_TYPE.MODEL_DEPLOY:
        if (this.to !== MODEL_REGISTRY_ADDRESS) return fail('MODEL_DEPLOY must send to MODEL_REGISTRY');
        if (!positive()) return fail('MODEL_DEPLOY requires positive escrow deposit');
        if (!isModelId(d.modelId) || !d.modelConfig || typeof d.modelConfig !== 'object') {
          return fail('MODEL_DEPLOY missing modelId or modelConfig');
        }
        if (typeof d.datasetHash !== 'string' || !d.datasetHash || typeof d.testSetHash !== 'string' || !d.testSetHash) {
          return fail('MODEL_DEPLOY missing datasetHash or testSetHash');
        }
        if (typeof d.maxExpectedAccuracy !== 'number' || !(d.maxExpectedAccuracy > 0 && d.maxExpectedAccuracy <= 1)) {
          return fail('MODEL_DEPLOY missing maxExpectedAccuracy');
        }
        if (d.rewardPerSubmission !== undefined) {
          if (!hasMax6Decimals(d.rewardPerSubmission) || d.rewardPerSubmission < 0.000001 || d.rewardPerSubmission > this.amount) {
            return fail('rewardPerSubmission must be positive and no more than the escrow');
          }
        }
        break;

      case TX_TYPE.TRAINING_SUBMIT: {
        if (!zero()) return fail('TRAINING_SUBMIT must have zero amount');
        if (!isModelId(d.modelId)) return fail('TRAINING_SUBMIT missing modelId, weights, or accuracy');
        const w = checkWeights(d.weights);
        if (w || typeof d.accuracy !== 'number') return fail('TRAINING_SUBMIT missing modelId, weights, or accuracy');
        if (typeof d.speedFactor !== 'number' || !Number.isFinite(d.speedFactor) || d.speedFactor <= 0) {
          return fail('TRAINING_SUBMIT requires positive speedFactor');
        }
        if (!isAccuracy(d.accuracy)) return fail('accuracy must be between 0 and 1');
        if (d.seedHash !== undefined && (typeof d.seedHash !== 'string' || d.seedHash.length > 128)) {
          return fail('Invalid seedHash');
        }
        break;
      }

      case TX_TYPE.TRAINING_VERIFY:
        if (!zero()) return fail('TRAINING_VERIFY must have zero amount');
        if (typeof d.submissionTx !== 'string' || !d.submissionTx) return fail('TRAINING_VERIFY missing submissionTx');
        if (!isAccuracy(d.computedAccuracy)) return fail('TRAINING_VERIFY requires computedAccuracy between 0 and 1');
        break;

      case TX_TYPE.MODEL_WITHDRAW:
        if (this.to !== MODEL_REGISTRY_ADDRESS) return fail('MODEL_WITHDRAW must send to MODEL_REGISTRY');
        if (!zero()) return fail('MODEL_WITHDRAW must have zero amount');
        if (!isModelId(d.modelId)) return fail('MODEL_WITHDRAW missing modelId');
        break;
    }

    return { valid: true };
  }

  /**
   * Full validation: stateless checks, then state checks (if state given).
   * @param {AccountState} [state]
   * @param {{blockIndex:number, timestamp:number, miner?:string}} [ctx]
   */
  validate(state, ctx) {
    const basic = this.validateBasic();
    if (!basic.valid || !state) return basic;
    return state.validateTransaction(this, ctx || { blockIndex: Infinity, timestamp: Date.now() });
  }

  toJSON() {
    return {
      txHash: this.txHash || this.computeHash(),
      from: this.from,
      to: this.to,
      amount: this.amount,
      type: this.type,
      fee: this.fee,
      nonce: this.nonce,
      data: this.data,
      timestamp: this.timestamp,
      signature: this.signature,
      publicKey: this.publicKey,
    };
  }

  static fromJSON(obj) {
    const tx = new Transaction(obj);
    tx.signature = obj.signature || null;
    tx.publicKey = obj.publicKey || null;
    // Never trust a supplied hash: validateBasic() rejects a mismatch.
    tx.txHash = obj.txHash || tx.computeHash();
    return tx;
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function isAccuracy(x) {
  return typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= 1;
}

function isModelId(id) {
  return typeof id === 'string' && id.length > 0 && id.length <= 64;
}

function checkWeights(weights) {
  if (!Array.isArray(weights) || weights.length === 0) return 'missing weights';
  if (weights.length > TOKENOMICS.MAX_AI_WEIGHTS) return `has too many weights (max ${TOKENOMICS.MAX_AI_WEIGHTS})`;
  if (!weights.every(w => typeof w === 'number' && Number.isFinite(w))) return 'weights must be finite numbers';
  return null;
}

// ── Factory Helpers ────────────────────────────────────────────────────────

function signed(fields, privateKey) {
  return new Transaction(fields).sign(privateKey);
}

export function createTransfer({ from, to, amount, fee = TOKENOMICS.MIN_FEE, nonce, privateKey }) {
  return signed({ from, to, amount, fee, nonce, type: TX_TYPE.TRANSFER }, privateKey);
}

export function createMiningStart({ address, nonce, privateKey }) {
  return signed({ from: address, to: address, amount: 0, fee: 0, nonce, type: TX_TYPE.MINING_START }, privateKey);
}

export function createMiningClaim({ address, amount, nonce, privateKey, data = null }) {
  return signed({ from: address, to: address, amount, fee: 0, nonce, type: TX_TYPE.MINING, data }, privateKey);
}

export function createStake({ address, amount, nonce, privateKey, fee = TOKENOMICS.MIN_FEE }) {
  return signed({ from: address, to: address, amount, fee, nonce, type: TX_TYPE.STAKE }, privateKey);
}

export function createUnstake({ address, amount, nonce, privateKey, fee = TOKENOMICS.MIN_FEE }) {
  return signed({ from: address, to: address, amount, fee, nonce, type: TX_TYPE.UNSTAKE }, privateKey);
}

export function createModelDeploy({ from, amount, nonce, privateKey, fee = TOKENOMICS.MIN_FEE, data }) {
  return signed({ from, to: MODEL_REGISTRY_ADDRESS, amount, fee, nonce, type: TX_TYPE.MODEL_DEPLOY, data }, privateKey);
}

export function createTrainingSubmit({ from, nonce, privateKey, data, fee = 0 }) {
  return signed({ from, to: data.modelId, amount: 0, fee, nonce, type: TX_TYPE.TRAINING_SUBMIT, data }, privateKey);
}

export function createTrainingVerify({ from, nonce, privateKey, submissionTx, computedAccuracy, fee = TOKENOMICS.MIN_FEE }) {
  return signed({
    from, to: MODEL_REGISTRY_ADDRESS, amount: 0, fee, nonce,
    type: TX_TYPE.TRAINING_VERIFY,
    data: { submissionTx, computedAccuracy },
  }, privateKey);
}

export function createModelWithdraw({ from, modelId, nonce, privateKey, fee = TOKENOMICS.MIN_FEE }) {
  return signed({ from, to: MODEL_REGISTRY_ADDRESS, amount: 0, fee, nonce, type: TX_TYPE.MODEL_WITHDRAW, data: { modelId } }, privateKey);
}

/**
 * Deterministic block ordering: by sender address, then nonce, then hash.
 * (Sender+nonce order is what lets several txs from one sender share a block.)
 */
export function sortTransactions(txs) {
  return [...txs].sort((a, b) => {
    const aFrom = a.from || '';
    const bFrom = b.from || '';
    if (aFrom < bFrom) return -1;
    if (aFrom > bFrom) return 1;
    const n = (a.nonce || 0) - (b.nonce || 0);
    if (n !== 0) return n;
    const ah = a.txHash || '';
    const bh = b.txHash || '';
    return ah < bh ? -1 : ah > bh ? 1 : 0;
  });
}
