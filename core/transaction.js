/**
 * Mziya Blockchain — Transaction & UTXO Model
 * Prevents double-spending through unspent output tracking.
 * Every transaction is signed with Ed25519 — server never needed.
 */

import { hashData } from './block.js';
import { sign, verify, isValidAddress, deriveAddress } from './wallet.js';
import { ed25519 } from '@noble/curves/ed25519';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { TOKENOMICS } from './mining.js';

// ── Transaction Types ──────────────────────────────────────────────────────

export const TX_TYPE = {
  TRANSFER:   'TRANSFER',
  MINING:     'MINING',
  STAKE:      'STAKE',
  UNSTAKE:    'UNSTAKE',
  GENESIS:    'GENESIS',
  AI_SUBMISSION: 'AI_SUBMISSION',
  // DeCompute — decentralized ML training market
  MODEL_DEPLOY:   'MODEL_DEPLOY',   // Company deploys a model + deposits escrow
  TRAINING_SUBMIT: 'TRAINING_SUBMIT', // Trainer submits trained weights
  TRAINING_VERIFY: 'TRAINING_VERIFY', // Verifier checks a submission
  MODEL_WITHDRAW:  'MODEL_WITHDRAW',  // Company reclaims unused escrow
};

// ── Transaction ────────────────────────────────────────────────────────────

export class Transaction {
  constructor({ from, to, amount, type = TX_TYPE.TRANSFER, fee = 0, nonce = 0, data = null, timestamp, publicKey }) {
    this.from = from;          // sender address (null for mining rewards)
    this.to = to;              // recipient address
    this.amount = amount;      // in MZY (floating point, 6 decimal places)
    this.type = type;
    this.fee = fee;            // transaction fee (goes to block producer)
    this.nonce = nonce;        // anti-replay: increments per sender
    this.data = data;          // optional metadata
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

  computeHash() {
    const p = this.getPayload();
    if (this.signature) p.signature = this.signature;
    if (this.publicKey) p.publicKey = this.publicKey;
    return hashData(JSON.stringify(p));
  }

  /**
   * Sign transaction with sender's private key.
   * Derives and embeds the public key so recipients can verify without a registry.
   */
  sign(privateKey) {
    if (this.type === TX_TYPE.MINING || this.type === TX_TYPE.GENESIS) {
      this.txHash = this.computeHash();
      return this;
    }
    const privBytes = hexToBytes(privateKey);
    this.publicKey = bytesToHex(ed25519.getPublicKey(privBytes));
    this.signature = sign(this.getPayload(), privateKey);
    this.txHash = this.computeHash();
    return this;
  }

  /**
   * Verify the transaction signature is valid.
   */
  isSignatureValid(publicKey) {
    if (this.type === TX_TYPE.MINING || this.type === TX_TYPE.GENESIS) return true;
    if (!this.signature || !publicKey) return false;
    return verify(this.getPayload(), this.signature, publicKey);
  }

  /**
   * Full validation rules.
   */
  validate(utxoSet, publicKeyMap) {
    // ── Basic field checks ──
    const specialToTypes = [TX_TYPE.MODEL_DEPLOY, TX_TYPE.MODEL_WITHDRAW, TX_TYPE.TRAINING_SUBMIT, TX_TYPE.TRAINING_VERIFY, TX_TYPE.AI_SUBMISSION];
    if (specialToTypes.includes(this.type)) {
      if (!this.to) {
        return { valid: false, error: 'Missing recipient address' };
      }
    } else {
      if (!this.to || !isValidAddress(this.to)) {
        return { valid: false, error: 'Invalid recipient address' };
      }
    }
    
    // ── AI Submission checks ──
    if (this.type === TX_TYPE.AI_SUBMISSION) {
      if (this.amount !== 0) {
        return { valid: false, error: 'AI submissions must have zero amount' };
      }
      if (!this.data || !Array.isArray(this.data.weights) || typeof this.data.accuracy !== 'number') {
        return { valid: false, error: 'AI submission missing weights or accuracy' };
      }
      if (this.data.accuracy < 0 || this.data.accuracy > 1) {
        return { valid: false, error: 'AI accuracy must be between 0 and 1' };
      }
    }

    // ── MODEL_DEPLOY checks ──
    if (this.type === TX_TYPE.MODEL_DEPLOY) {
      if (this.to !== 'MODEL_REGISTRY') {
        return { valid: false, error: 'MODEL_DEPLOY must send to MODEL_REGISTRY' };
      }
      if (this.amount <= 0) {
        return { valid: false, error: 'MODEL_DEPLOY requires positive escrow deposit' };
      }
      if (!this.data || !this.data.modelId || !this.data.modelConfig) {
        return { valid: false, error: 'MODEL_DEPLOY missing modelId or modelConfig' };
      }
      if (!this.data.datasetHash || !this.data.testSetHash) {
        return { valid: false, error: 'MODEL_DEPLOY missing datasetHash or testSetHash' };
      }
      if (!this.data.maxExpectedAccuracy || this.data.maxExpectedAccuracy <= 0) {
        return { valid: false, error: 'MODEL_DEPLOY missing maxExpectedAccuracy' };
      }
    }

    // ── TRAINING_SUBMIT checks ──
    if (this.type === TX_TYPE.TRAINING_SUBMIT) {
      if (this.amount !== 0) {
        return { valid: false, error: 'TRAINING_SUBMIT must have zero amount' };
      }
      if (!this.data || !this.data.modelId || !Array.isArray(this.data.weights) || typeof this.data.accuracy !== 'number') {
        return { valid: false, error: 'TRAINING_SUBMIT missing modelId, weights, or accuracy' };
      }
      if (!this.data.speedFactor || this.data.speedFactor <= 0) {
        return { valid: false, error: 'TRAINING_SUBMIT requires positive speedFactor' };
      }
      if (this.data.accuracy < 0 || this.data.accuracy > 1) {
        return { valid: false, error: 'accuracy must be between 0 and 1' };
      }
    }

    // ── TRAINING_VERIFY checks ──
    if (this.type === TX_TYPE.TRAINING_VERIFY) {
      if (this.amount !== 0) {
        return { valid: false, error: 'TRAINING_VERIFY must have zero amount' };
      }
      if (!this.data || !this.data.submissionTx) {
        return { valid: false, error: 'TRAINING_VERIFY missing submissionTx' };
      }
    }

    // ── MODEL_WITHDRAW checks ──
    if (this.type === TX_TYPE.MODEL_WITHDRAW) {
      if (this.to !== 'MODEL_REGISTRY') {
        return { valid: false, error: 'MODEL_WITHDRAW must send to MODEL_REGISTRY' };
      }
      if (this.amount !== 0) {
        return { valid: false, error: 'MODEL_WITHDRAW must have zero amount' };
      }
      if (!this.data || !this.data.modelId) {
        return { valid: false, error: 'MODEL_WITHDRAW missing modelId' };
      }
    }

    // DeCompute types that carry zero amount and skip balance checks (but NOT nonce)
    // MODEL_DEPLOY is excluded — it transfers real escrow and needs full validation
    const zeroAmountTypes = [TX_TYPE.AI_SUBMISSION, TX_TYPE.TRAINING_SUBMIT, TX_TYPE.TRAINING_VERIFY, TX_TYPE.MODEL_WITHDRAW];

    // ── Amount validation (skip for zero-amount DeCompute types, MINING, GENESIS) ──
    if (this.type !== TX_TYPE.MINING && this.type !== TX_TYPE.GENESIS && !zeroAmountTypes.includes(this.type)) {
      if (typeof this.amount !== 'number' || this.amount <= 0) {
        return { valid: false, error: 'Invalid amount' };
      }
      if (this.amount < 0.000001) {
        return { valid: false, error: 'Amount below minimum (0.000001 MZY)' };
      }
    }

    // ── Sender address validation (non-coinbase only) ──
    if (this.type !== TX_TYPE.MINING && this.type !== TX_TYPE.GENESIS) {
      if (!this.from || !isValidAddress(this.from)) {
        return { valid: false, error: 'Invalid sender address' };
      }
    }

    // Coinbase transactions skip the rest
    if (this.type === TX_TYPE.GENESIS) {
      return { valid: true };
    }
    if (this.type === TX_TYPE.MINING) {
      if (this.from !== 'GENESIS') return { valid: false, error: 'MINING tx must be from GENESIS' };
      if (typeof this.amount !== 'number' || this.amount <= 0) return { valid: false, error: 'MINING tx requires positive amount' };
      if (this.amount > TOKENOMICS.MAX_MINING_REWARD) return { valid: false, error: 'MINING reward exceeds maximum hard cap constraint' };
      return { valid: true };
    }

    // ── Public key verification ──
    if (!this.publicKey) {
      return { valid: false, error: 'Missing public key — cannot verify signature' };
    }
    const derivedAddr = deriveAddress(this.publicKey);
    if (derivedAddr !== this.from) {
      return { valid: false, error: 'Public key does not match sender address' };
    }

    // ── Signature check ──
    if (!this.isSignatureValid(this.publicKey)) {
      return { valid: false, error: 'Invalid signature' };
    }

    // ── Register public key for future lookups ──
    if (utxoSet && !utxoSet.publicKeys.has(this.from)) {
      utxoSet.publicKeys.set(this.from, this.publicKey);
    }

    // ── Zero-amount DeCompute txs: verified signature, still need nonce check ──
    if (zeroAmountTypes.includes(this.type)) {
      // Nonce replay protection (prevents replaying TRAINING_SUBMIT etc.)
      if (utxoSet) {
        const expectedNonce = utxoSet.getNonce(this.from) + 1;
        if (this.nonce !== expectedNonce) {
          return { valid: false, error: `Invalid nonce: expected ${expectedNonce}, got ${this.nonce}` };
        }
      }
      return { valid: true };
    }

    // ── Nonce replay protection ──
    if (utxoSet) {
      const expectedNonce = utxoSet.getNonce(this.from) + 1;
      if (this.nonce !== expectedNonce) {
        return { valid: false, error: `Invalid nonce: expected ${expectedNonce}, got ${this.nonce}` };
      }
    }

    // ── Balance check ──
    const balance = utxoSet?.getBalance(this.from) || 0;
    if (balance < this.amount + this.fee) {
      return { valid: false, error: `Insufficient balance: has ${balance}, needs ${this.amount + this.fee}` };
    }

    return { valid: true };
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
    tx.signature = obj.signature;
    tx.txHash = obj.txHash;
    tx.publicKey = obj.publicKey || null;
    return tx;
  }
}

// ── UTXO Set ───────────────────────────────────────────────────────────────

/**
 * Tracks all unspent balances. Simpler than Bitcoin's UTXO —
 * we use an account model (like Ethereum) for mobile UX simplicity,
 * while keeping nonce-based replay protection.
 */
export class AccountState {
  constructor() {
    this.balances = new Map();    // address → balance
    this.nonces = new Map();      // address → last nonce
    this.publicKeys = new Map();  // address → publicKey (registered on first tx)
  }

  getBalance(address) {
    return this.balances.get(address) || 0;
  }

  getNonce(address) {
    return this.nonces.get(address) || 0;
  }

  applyTransaction(tx, blockMiner = null) {
    if (tx.type === TX_TYPE.MINING || tx.type === TX_TYPE.GENESIS) {
      this.balances.set(tx.to, this.getBalance(tx.to) + tx.amount);
      return;
    }

    // MODEL_DEPLOY: deduct escrow from company
    if (tx.type === TX_TYPE.MODEL_DEPLOY) {
      const senderBal = this.getBalance(tx.from);
      this.balances.set(tx.from, senderBal - tx.amount);
      if (tx.nonce) this.nonces.set(tx.from, tx.nonce);
      return;
    }

    // STAKE: lock the staked amount from sender's balance
    if (tx.type === TX_TYPE.STAKE) {
      const senderBal = this.getBalance(tx.from);
      this.balances.set(tx.from, senderBal - tx.amount);
      if (tx.nonce) this.nonces.set(tx.from, tx.nonce);
      return;
    }

    // UNSTAKE: return staked amount to sender
    if (tx.type === TX_TYPE.UNSTAKE) {
      this.balances.set(tx.from, this.getBalance(tx.from) + tx.amount);
      if (tx.nonce) this.nonces.set(tx.from, tx.nonce);
      return;
    }

    // TRAINING_SUBMIT, TRAINING_VERIFY, MODEL_WITHDRAW, AI_SUBMISSION: no balance change, but record nonce
    const zeroBalTypes = [TX_TYPE.TRAINING_SUBMIT, TX_TYPE.TRAINING_VERIFY, TX_TYPE.MODEL_WITHDRAW, TX_TYPE.AI_SUBMISSION];
    if (zeroBalTypes.includes(tx.type)) {
      if (tx.nonce) this.nonces.set(tx.from, tx.nonce);
      return;
    }

    // Register public key from transaction if not already known
    if (tx.publicKey && !this.publicKeys.has(tx.from)) {
      const derivedAddr = deriveAddress(tx.publicKey);
      if (derivedAddr === tx.from) {
        this.publicKeys.set(tx.from, tx.publicKey);
      }
    }

    const senderBal = this.getBalance(tx.from);
    this.balances.set(tx.from, senderBal - tx.amount - tx.fee);

    this.balances.set(tx.to, this.getBalance(tx.to) + tx.amount);

    // Fee is credited to the block miner if provided, otherwise burned
    if (tx.fee > 0 && blockMiner) {
      this.balances.set(blockMiner, this.getBalance(blockMiner) + tx.fee);
    }

    this.nonces.set(tx.from, tx.nonce);
  }

  applyBlock(block) {
    for (const txData of block.transactions) {
      const tx = txData instanceof Transaction ? txData : Transaction.fromJSON(txData);
      this.applyTransaction(tx, block.miner);
    }
  }

  snapshot() {
    return {
      balances: Object.fromEntries(this.balances),
      nonces: Object.fromEntries(this.nonces),
    };
  }

  static fromSnapshot(snap) {
    const set = new AccountState();
    for (const [addr, bal] of Object.entries(snap.balances || {})) {
      set.balances.set(addr, bal);
    }
    for (const [addr, nonce] of Object.entries(snap.nonces || {})) {
      set.nonces.set(addr, nonce);
    }
    return set;
  }
}

// ── Factory Helpers ────────────────────────────────────────────────────────

export function createMiningReward(toAddress, amount, blockIndex) {
  const tx = new Transaction({
    from: 'GENESIS',
    to: toAddress,
    amount,
    type: TX_TYPE.MINING,
    data: { blockIndex },
  });
  tx.txHash = tx.computeHash();
  return tx;
}

export function createTransfer({ from, to, amount, fee = 0, nonce, privateKey }) {
  const tx = new Transaction({ from, to, amount, fee, nonce, type: TX_TYPE.TRANSFER });
  tx.sign(privateKey);
  return tx;
}

/**
 * Sorts transactions deterministically:
 * - MINING transactions always go first.
 * - Non-coinbase transactions are sorted alphabetically by sender (from) address.
 * - Transactions from the same sender are sorted by nonce ascending.
 */
export function sortTransactions(txs) {
  return [...txs].sort((a, b) => {
    if (a.type === TX_TYPE.MINING && b.type !== TX_TYPE.MINING) return -1;
    if (a.type !== TX_TYPE.MINING && b.type === TX_TYPE.MINING) return 1;

    const aFrom = a.from || '';
    const bFrom = b.from || '';
    if (aFrom < bFrom) return -1;
    if (aFrom > bFrom) return 1;

    return (a.nonce || 0) - (b.nonce || 0);
  });
}
