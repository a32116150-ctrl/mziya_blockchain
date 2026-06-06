/**
 * Mziya Blockchain — Mempool (Transaction Pool)
 * Holds pending transactions before they are included in a block.
 * Runs on every peer — no central mempool server.
 */

import { Transaction } from './transaction.js';

export class Mempool {
  constructor({ maxSize = 500, maxAgeSec = 3600 } = {}) {
    this.pool = new Map();    // txHash → Transaction
    this.maxSize = maxSize;
    this.maxAgeSec = maxAgeSec;
  }

  add(tx) {
    const txObj = tx instanceof Transaction ? tx : Transaction.fromJSON(tx);
    const hash = txObj.txHash || txObj.computeHash();

    if (this.pool.has(hash)) return { added: false, reason: 'Duplicate' };
    if (this.pool.size >= this.maxSize) {
      this.evictOldest();
    }

    this.pool.set(hash, { tx: txObj, receivedAt: Date.now() });
    return { added: true, txHash: hash };
  }

  has(txHash) { return this.pool.has(txHash); }

  getAll() {
    return [...this.pool.values()].map(e => e.tx);
  }

  remove(txHash) { this.pool.delete(txHash); }

  removeMany(txHashes) {
    for (const h of txHashes) this.pool.delete(h);
  }

  evictOldest() {
    const now = Date.now();
    for (const [hash, entry] of this.pool) {
      if ((now - entry.receivedAt) / 1000 > this.maxAgeSec) {
        this.pool.delete(hash);
      }
    }
    // PERF-07: If still full, find oldest with O(n) linear scan instead of O(n log n) sort
    if (this.pool.size >= this.maxSize) {
      let oldestHash = null;
      let oldestTime = Infinity;
      for (const [hash, entry] of this.pool) {
        if (entry.receivedAt < oldestTime) {
          oldestTime = entry.receivedAt;
          oldestHash = hash;
        }
      }
      if (oldestHash) this.pool.delete(oldestHash);
    }
  }

  get size() { return this.pool.size; }

  clear() { this.pool.clear(); }
}
