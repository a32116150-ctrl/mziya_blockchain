/**
 * Mziya Blockchain — Block & Merkle Tree
 * Each block is cryptographically linked to the previous one.
 * Merkle tree ensures tamper-proof transaction inclusion.
 */

import { sha3_256 } from '@noble/hashes/sha3';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { ed25519 } from '@noble/curves/ed25519';
import { sign as signPayload, verify as verifyPayload, deriveAddress } from './wallet.js';

// ── Canonical JSON ─────────────────────────────────────────────────────────

/**
 * Deterministic JSON serialization with sorted keys.
 * Prevents chain splits from engine-dependent key ordering.
 */
export function canonicalStringify(obj) {
  if (obj === null || obj === undefined) return JSON.stringify(obj);
  if (typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) {
    return '[' + obj.map(v => (v === undefined ? 'null' : canonicalStringify(v))).join(',') + ']';
  }
  if (typeof obj.toJSON === 'function') return canonicalStringify(obj.toJSON());
  // Skip undefined values exactly like JSON.stringify, so a value hashes the
  // same before and after a network round trip.
  const keys = Object.keys(obj).filter(k => obj[k] !== undefined).sort();
  const parts = keys.map(k => JSON.stringify(k) + ':' + canonicalStringify(obj[k]));
  return '{' + parts.join(',') + '}';
}

// ── Merkle Tree ────────────────────────────────────────────────────────────

export function hashData(data) {
  const bytes = typeof data === 'string'
    ? new TextEncoder().encode(data)
    : data;
  return bytesToHex(sha3_256(bytes));
}

export function buildMerkleTree(transactions) {
  if (!transactions || transactions.length === 0) {
    return hashData('empty');
  }

  let level = transactions.map(tx =>
    hashData(typeof tx === 'string' ? tx : canonicalStringify(tx))
  );

  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = level[i + 1] || left; // duplicate last if odd
      next.push(hashData(left + right));
    }
    level = next;
  }

  return level[0];
}

// ── Block ──────────────────────────────────────────────────────────────────

export class Block {
  constructor({ index, previousHash, transactions, timestamp, miner, nonce = 0, signature = null, minerPublicKey = null, modelStates = null }) {
    this.index = index;
    this.previousHash = previousHash;
    this.transactions = transactions || [];
    this.timestamp = timestamp || Date.now();
    this.miner = miner;          // address of block producer
    this.nonce = nonce;
    this.signature = signature;  // Ed25519 signature of `hash` by the block producer
    this.minerPublicKey = minerPublicKey; // producer's public key (must derive to `miner`)
    this.modelStates = modelStates || {}; // globally averaged AI models: { modelId: [weights] }
    this.merkleRoot = buildMerkleTree(this.transactions);
    this.hash = this.computeHash();
  }

  computeHash() {
    const content = canonicalStringify({
      index: this.index,
      previousHash: this.previousHash,
      merkleRoot: this.merkleRoot,
      timestamp: this.timestamp,
      miner: this.miner,
      nonce: this.nonce,
      modelStates: this.modelStates,
    });
    return hashData(content);
  }

  /** Sign the block as its producer. `miner` must be the address of this key. */
  sign(privateKey) {
    this.minerPublicKey = bytesToHex(ed25519.getPublicKey(hexToBytes(privateKey)));
    this.signature = signPayload(this.hash, privateKey);
    return this;
  }

  /** True when the block was signed by the key behind its `miner` address. */
  hasValidSignature() {
    if (!this.signature || !this.minerPublicKey) return false;
    try {
      if (deriveAddress(this.minerPublicKey) !== this.miner) return false;
    } catch {
      return false;
    }
    return verifyPayload(this.hash, this.signature, this.minerPublicKey);
  }

  toJSON() {
    return {
      index: this.index,
      hash: this.hash,
      previousHash: this.previousHash,
      merkleRoot: this.merkleRoot,
      timestamp: this.timestamp,
      miner: this.miner,
      nonce: this.nonce,
      signature: this.signature,
      minerPublicKey: this.minerPublicKey,
      modelStates: this.modelStates,
      transactions: this.transactions,
    };
  }

  static fromJSON(obj) {
    const block = new Block({
      index: obj.index,
      previousHash: obj.previousHash,
      transactions: obj.transactions,
      timestamp: obj.timestamp,
      miner: obj.miner,
      nonce: obj.nonce,
      signature: obj.signature,
      minerPublicKey: obj.minerPublicKey || null,
      modelStates: obj.modelStates,
    });
    // SEC-03: Re-compute hash instead of blindly trusting input
    const computed = block.computeHash();
    if (obj.hash && obj.hash !== computed) {
      console.warn(`[Block] fromJSON hash mismatch at index ${obj.index}: stored=${obj.hash?.slice(0,12)}, computed=${computed.slice(0,12)}`);
    }
    block.hash = computed;
    return block;
  }

  isValid(previousBlock) {
    // Hash integrity
    if (this.hash !== this.computeHash()) return false;
    // Chain linkage
    if (previousBlock && this.previousHash !== previousBlock.hash) return false;
    // Merkle root integrity
    if (this.merkleRoot !== buildMerkleTree(this.transactions)) return false;
    // Index sequence
    if (previousBlock && this.index !== previousBlock.index + 1) return false;
    return true;
  }
}

// ── Genesis Block ──────────────────────────────────────────────────────────

export function createGenesisBlock() {
  return new Block({
    index: 0,
    previousHash: '0'.repeat(64),
    transactions: [{
      type: 'GENESIS',
      message: 'Mziya blockchain initialized — June 2026',
      supply: 21_000_000_000,
      ticker: 'MZY',
    }],
    timestamp: 1748736000000, // 2026-06-01 00:00:00 UTC
    miner: 'GENESIS',
    nonce: 0,
  });
}
