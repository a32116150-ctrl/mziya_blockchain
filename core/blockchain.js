import { Block, createGenesisBlock, canonicalStringify } from './block.js';
import { AccountState, Transaction, sortTransactions } from './transaction.js';
import { Mempool } from './mempool.js';
import { ConsensusEngine, ValidatorSet } from './consensus.js';

export function aggregateAIWeights(transactions, prevModelStates = {}) {
  const nextStates = JSON.parse(JSON.stringify(prevModelStates || {}));

  const groups = {};
  for (const tx of transactions) {
    const type = tx.type;
    if (type === 'AI_SUBMISSION') {
      const data = tx.data;
      if (data && Array.isArray(data.weights)) {
        const mId = data.modelId || 'default-model';
        if (!groups[mId]) groups[mId] = [];
        groups[mId].push({
          weights: data.weights,
          accuracy: typeof data.accuracy === 'number' ? data.accuracy : 1
        });
      }
    }
  }

  for (const [modelId, submissions] of Object.entries(groups)) {
    if (submissions.length === 0) continue;

    let totalAcc = submissions.reduce((sum, s) => sum + s.accuracy, 0);
    if (totalAcc === 0) totalAcc = submissions.length;

    const vectorLength = submissions[0].weights.length;
    const averagedWeights = new Array(vectorLength).fill(0);

    for (let i = 0; i < vectorLength; i++) {
      let weightedSum = 0;
      for (const sub of submissions) {
        const wVal = sub.weights[i] !== undefined ? sub.weights[i] : 0;
        weightedSum += wVal * sub.accuracy;
      }
      averagedWeights[i] = Math.round((weightedSum / totalAcc) * 1e6) / 1e6;
    }

    nextStates[modelId] = averagedWeights;
  }

  return nextStates;
}

const MAX_TXS_PER_BLOCK = 500;

/** Genesis state: what every node agrees on before block 1. */
function genesisState(genesisBlock) {
  const state = new AccountState();
  state.applyBlock(genesisBlock);
  return state;
}

/**
 * Validate `block` on top of `prev` given the state after `prev`.
 * Never mutates `state`. Returns { valid, error?, state? } where `state` is
 * the state after the block.
 */
export function validateBlockAgainst(block, prev, state, { now = Date.now() } = {}) {
  const fail = (error) => ({ valid: false, error });

  if (!block.isValid(prev)) return fail('Block integrity check failed');

  if (block.timestamp <= prev.timestamp) {
    return fail('Block timestamp must be strictly greater than previous block');
  }
  if (block.timestamp > now + 60_000) return fail('Block timestamp too far in the future');

  // ── Producer: signed by the miner, and a validator once validators exist ──
  if (!block.hasValidSignature()) return fail('Block is not signed by its miner');
  const validators = state.getValidators();
  if (validators.length > 0 && !state.isValidator(block.miner)) {
    return fail('Only staked validators can produce blocks');
  }

  if (!Array.isArray(block.transactions) || block.transactions.length === 0) {
    return fail('Block has no transactions');
  }
  if (block.transactions.length > MAX_TXS_PER_BLOCK) return fail('Too many transactions in block');

  // SEC-02: canonical JSON for deterministic model state comparison
  const expectedStates = aggregateAIWeights(block.transactions, prev.modelStates || {});
  if (canonicalStringify(block.modelStates || {}) !== canonicalStringify(expectedStates)) {
    return fail('Invalid AI modelStates aggregation');
  }

  const txs = block.transactions.map(tx => (tx instanceof Transaction ? tx : Transaction.fromJSON(tx)));

  const sorted = sortTransactions(txs);
  for (let i = 0; i < txs.length; i++) {
    if (txs[i] !== sorted[i]) return fail('Transactions are not in deterministic sorted order');
  }

  // ── Apply one by one on a copy: catches double-spends inside the block ──
  const next = state.clone();
  const ctx = { blockIndex: block.index, timestamp: block.timestamp, miner: block.miner };
  const seen = new Set();
  for (const tx of txs) {
    if (seen.has(tx.txHash)) return fail(`Duplicate transaction ${tx.txHash}`);
    seen.add(tx.txHash);
    const v = tx.validate(next, ctx);
    if (!v.valid) return fail(`Invalid transaction ${tx.txHash || ''}: ${v.error}`);
    next.applyTransaction(tx, ctx);
  }

  if (next.totalSupply > 21_000_000_000) return fail('Block would exceed the 21 billion MZY supply cap');

  return { valid: true, state: next };
}

export class Blockchain {
  constructor() {
    this.chain = [];
    this.utxo = new AccountState();
    this.mempool = new Mempool({ maxSize: 500, maxAgeSec: 3600 });
    this.consensusEngine = null;
    this.pendingBlocks = [];
    this.validatorSet = new ValidatorSet();
    this.globalModelStates = {};
    this.txIndex = new Map(); // address → [{ tx, blockIndex, blockHash }]
  }

  get length() { return this.chain.length; }
  get latestBlock() { return this.chain[this.chain.length - 1]; }
  /** DeCompute registry lives in consensus state. */
  get models() { return this.utxo.models; }

  initialize(validatorSet) {
    if (this.chain.length === 0) {
      const genesis = createGenesisBlock();
      this.chain.push(genesis);
      this.utxo = genesisState(genesis);
    }

    if (validatorSet) this.validatorSet = validatorSet;
    this._syncValidators();

    this.consensusEngine = new ConsensusEngine(this.validatorSet);
    this.consensusEngine.onFinalize = ({ blockHash }) => {
      const block = this.pendingBlocks.find(b => b.hash === blockHash);
      if (block) {
        const res = this.addBlock(block);
        if (res.success) {
          this.pendingBlocks = this.pendingBlocks.filter(b => b.hash !== blockHash);
        }
      }
    };
    this.consensusEngine.start();

    return this;
  }

  _syncValidators() {
    if (this.validatorSet) this.validatorSet.syncFromState(this.utxo.getValidators());
  }

  // ── Mempool ──

  /**
   * State as it will be after the current mempool is mined. Lets a sender
   * queue several txs (nonce n+1, n+2, …) before a block is produced.
   */
  getPendingState(timestamp = Date.now()) {
    const state = this.utxo.clone();
    const ctx = { blockIndex: this.chain.length, timestamp, miner: null };
    for (const tx of sortTransactions(this.mempool.getAll())) {
      if (tx.validate(state, ctx).valid) state.applyTransaction(tx, ctx);
    }
    return state;
  }

  /** Nonce to use for the next transaction from `address`. */
  getNextNonce(address) {
    return this.getPendingState().getNonce(address) + 1;
  }

  addPendingTransaction(tx) {
    const txObj = tx instanceof Transaction ? tx : Transaction.fromJSON(tx);
    const ctx = { blockIndex: this.chain.length, timestamp: Date.now(), miner: null };

    const valid = txObj.validate(this.getPendingState(ctx.timestamp), ctx);
    if (!valid.valid) {
      return { success: false, error: valid.error };
    }

    const result = this.mempool.add(txObj);
    return {
      success: result.added,
      txHash: result.txHash || txObj.txHash,
      error: result.reason,
    };
  }

  getPendingTransactions() {
    return this.mempool.getAll();
  }

  // ── Block production ──

  /**
   * Build and sign the next block from the mempool. Only includes txs that
   * are valid in sequence. Returns null when there is nothing to include or
   * this address may not produce blocks.
   */
  forgeBlock(minerAddress, privateKey) {
    const pending = this.mempool.getAll();
    if (pending.length === 0) return null;

    if (this.consensusEngine && !this.consensusEngine.canPropose(minerAddress, this.chain.length)) {
      return null; // validators exist and we are not one of them
    }

    const prev = this.latestBlock;
    const timestamp = Math.max(Date.now(), prev.timestamp + 1);
    const ctx = { blockIndex: this.chain.length, timestamp, miner: minerAddress };

    const state = this.utxo.clone();
    const included = [];
    for (const tx of sortTransactions(pending)) {
      if (included.length >= MAX_TXS_PER_BLOCK) break;
      if (tx.validate(state, ctx).valid) {
        state.applyTransaction(tx, ctx);
        included.push(tx);
      }
    }
    if (included.length === 0) return null;

    const nextStates = aggregateAIWeights(included, prev.modelStates || {});

    const block = new Block({
      index: this.chain.length,
      previousHash: prev.hash,
      transactions: included.map(tx => tx.toJSON()),
      timestamp,
      miner: minerAddress,
      modelStates: nextStates,
    });
    if (privateKey) block.sign(privateKey);
    return block;
  }

  addBlock(block) {
    const validation = this.validateBlock(block);
    if (!validation.valid) {
      return { success: false, error: validation.error };
    }

    this.chain.push(block);
    this.utxo = validation.state;
    this._syncValidators();
    this.globalModelStates = block.modelStates || {};
    this._indexBlock(block);
    this._pruneMempool(block);

    return { success: true, blockHash: block.hash };
  }

  validateBlock(block) {
    if (this.chain.length === 0) return { valid: false, error: 'Chain not initialized' };
    return validateBlockAgainst(block, this.latestBlock, this.utxo);
  }

  _indexBlock(block) {
    for (const tx of block.transactions) {
      const entry = { ...(tx.toJSON ? tx.toJSON() : tx), blockIndex: block.index, blockHash: block.hash };
      if (tx.from) {
        if (!this.txIndex.has(tx.from)) this.txIndex.set(tx.from, []);
        this.txIndex.get(tx.from).push(entry);
      }
      if (tx.to && tx.to !== tx.from) {
        if (!this.txIndex.has(tx.to)) this.txIndex.set(tx.to, []);
        this.txIndex.get(tx.to).push(entry);
      }
    }
  }

  /** Drop mined txs and any that can no longer be valid (stale nonces). */
  _pruneMempool(block) {
    this.mempool.removeMany(block.transactions.map(tx => tx.txHash));
    for (const tx of this.mempool.getAll()) {
      if (tx.nonce <= this.utxo.getNonce(tx.from)) this.mempool.remove(tx.txHash);
    }
  }

  // ── Whole-chain validation & sync ──

  /**
   * Replay a chain from genesis, validating every block.
   * Returns { valid, state?, error?, height? }.
   */
  replayChain(chain) {
    if (!chain || chain.length === 0) return { valid: false, error: 'Empty chain' };
    const blocks = chain.map(b => (b instanceof Block ? b : Block.fromJSON(b)));

    const genesis = createGenesisBlock();
    if (blocks[0].hash !== genesis.hash) return { valid: false, error: 'Genesis block mismatch' };

    let state = genesisState(genesis);
    for (let i = 1; i < blocks.length; i++) {
      const res = validateBlockAgainst(blocks[i], blocks[i - 1], state);
      if (!res.valid) return { valid: false, error: `Block ${i}: ${res.error}`, height: i };
      state = res.state;
    }
    return { valid: true, state, blocks };
  }

  validateChain(chain = this.chain) {
    return this.replayChain(chain).valid;
  }

  _adoptChain(blocks, state) {
    this.chain = blocks;
    this.utxo = state;
    this._syncValidators();
    this.globalModelStates = blocks[blocks.length - 1].modelStates || {};
    this.txIndex = new Map();
    for (const b of blocks) this._indexBlock(b);
    for (const tx of this.mempool.getAll()) {
      if (tx.nonce <= this.utxo.getNonce(tx.from)) this.mempool.remove(tx.txHash);
    }
  }

  mergeBlocks(incomingBlocks) {
    if (incomingBlocks.length <= this.chain.length) return false;

    // Verify our chain is a strict prefix of the incoming chain
    for (let i = 0; i < this.chain.length; i++) {
      const inc = incomingBlocks[i];
      if (this.chain[i].hash !== (inc.hash || inc.computeHash?.())) return false;
    }

    const res = this.replayChain(incomingBlocks);
    if (!res.valid) return false;
    this._adoptChain(res.blocks, res.state);
    return true;
  }

  replaceChain(incomingChain) {
    const incomingBlocks = incomingChain.map(b => (b instanceof Block ? b : Block.fromJSON(b)));

    const ourWork = this.chain.reduce((sum, b) => sum + (b.transactions?.length || 0), 0);
    const incomingWork = incomingBlocks.reduce((sum, b) => sum + (b.transactions?.length || 0), 0);

    const isLonger = incomingBlocks.length > this.chain.length;
    const isSameLengthWithMoreWork = incomingBlocks.length === this.chain.length && incomingWork > ourWork;
    const isSameLengthAndWorkWithBetterHash = incomingBlocks.length === this.chain.length && incomingWork === ourWork &&
      incomingBlocks[incomingBlocks.length - 1].hash < this.latestBlock.hash;

    if (!isLonger && !isSameLengthWithMoreWork && !isSameLengthAndWorkWithBetterHash) {
      return { replaced: false, reason: 'Incoming chain does not have more work' };
    }

    const res = this.replayChain(incomingBlocks);
    if (!res.valid) {
      return { replaced: false, reason: `Incoming chain is invalid: ${res.error}` };
    }

    this._adoptChain(res.blocks, res.state);
    return { replaced: true };
  }

  receiveVote(voteData) {
    if (!this.consensusEngine) return { accepted: false, reason: 'No consensus engine' };
    return this.consensusEngine.castVote(voteData);
  }

  // ── Queries ──

  getBalance(address) {
    return this.utxo.getBalance(address);
  }

  getStake(address) {
    return this.utxo.getStake(address);
  }

  getTransactionHistory(address) {
    return [...(this.txIndex.get(address) || [])].reverse();
  }

  getBlockByHash(hash) {
    return this.chain.find(b => b.hash === hash) || null;
  }

  getBlockByIndex(index) {
    return this.chain[index] || null;
  }

  getTransactionByHash(txHash) {
    for (const block of this.chain) {
      const tx = block.transactions.find(t => t.txHash === txHash);
      if (tx) return { tx, block };
    }
    return null;
  }

  getStats() {
    const allTxs = this.chain.reduce((sum, b) => sum + b.transactions.length, 0);
    return {
      height: this.chain.length,
      latestBlock: this.latestBlock?.hash,
      latestBlockTime: this.latestBlock?.timestamp,
      totalTransactions: allTxs,
      pendingTransactions: this.mempool.size,
      totalSupply: this.utxo.totalSupply,
      circulatingSupply: this.utxo.totalSupply,
      totalBurned: this.utxo.totalBurned,
      totalStaked: this.utxo.totalStaked(),
      totalStakingRewards: this.utxo.totalStakingRewards,
      escrowLocked: this.utxo.models.totalEscrow(),
      remainingSupply: this.utxo.remainingSupply(),
      validatorCount: this.utxo.getValidators().length,
      modelCount: Object.keys(this.globalModelStates).length,
    };
  }

  toJSON() {
    return this.chain.map(b => (b.toJSON ? b.toJSON() : b));
  }

  /**
   * Load a stored chain. Every block is re-validated; throws if the stored
   * chain is invalid (e.g. created by an older, incompatible version).
   */
  static fromJSON(chainData) {
    const bc = new Blockchain();
    const res = bc.replayChain(chainData);
    if (!res.valid) throw new Error(`Stored chain is invalid: ${res.error}`);
    bc._adoptChain(res.blocks, res.state);
    return bc;
  }
}
