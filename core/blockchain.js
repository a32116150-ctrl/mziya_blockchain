import { Block, createGenesisBlock, hashData, canonicalStringify } from './block.js';
import { AccountState, Transaction, TX_TYPE, sortTransactions } from './transaction.js';
import { Mempool } from './mempool.js';
import { ConsensusEngine, ValidatorSet, selectBlockProposer } from './consensus.js';
import { ModelRegistry, getDefaultModel } from './decompute.js';
import { TOKENOMICS } from './mining.js';

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

export class Blockchain {
  constructor() {
    this.chain = [];
    this.utxo = new AccountState();
    this.mempool = new Mempool({ maxSize: 500, maxAgeSec: 3600 });
    this.consensusEngine = null;
    this.pendingBlocks = [];
    this.publicKeyMap = new Map();
    this.validatorSet = null;
    this.globalModelStates = {};
    this.models = new ModelRegistry();
    this.txIndex = new Map(); // address → [{ tx, blockIndex, blockHash }]
  }

  get length() { return this.chain.length; }
  get latestBlock() { return this.chain[this.chain.length - 1]; }

  initialize(validatorSet) {
    if (this.chain.length === 0) {
      const genesis = createGenesisBlock();
      this.chain.push(genesis);
      this.utxo.applyBlock(genesis);
    }

    if (this.models.getAvailable().length === 0) {
      this.models.models.set('mziya-sentiment-v1', getDefaultModel());
      this.models.submissions.set('mziya-sentiment-v1', []);
    }

    if (validatorSet) {
      this.validatorSet = validatorSet;
    } else {
      this.validatorSet = new ValidatorSet();
    }

    this.consensusEngine = new ConsensusEngine(this.validatorSet);
    this.consensusEngine.onFinalize = ({ blockHash, votes }) => {
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

  addPendingTransaction(tx) {
    const txObj = tx instanceof Transaction ? tx : Transaction.fromJSON(tx);

    const valid = txObj.validate(this.utxo, this.publicKeyMap);
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

  forgeBlock(minerAddress) {
    const pending = this.mempool.getAll();
    if (pending.length === 0) return null;

    // Check that this miner is allowed to propose at this block index
    if (this.consensusEngine && !this.consensusEngine.canPropose(minerAddress, this.chain.length)) {
      const proposer = selectBlockProposer(this.validatorSet, this.chain.length);
      const expected = proposer?.address?.slice(0, 14) || 'none';
      return null; // not our turn to propose
    }

    // Sort transactions deterministically
    const sortedPending = sortTransactions(pending);

    const prevStates = this.latestBlock ? this.latestBlock.modelStates : {};
    const nextStates = aggregateAIWeights(sortedPending, prevStates);
    this.globalModelStates = nextStates;

    const block = new Block({
      index: this.chain.length,
      previousHash: this.latestBlock.hash,
      transactions: sortedPending.map(tx =>
        tx.toJSON ? tx.toJSON() : tx
      ),
      miner: minerAddress,
      modelStates: nextStates,
    });

    return block;
  }

  addBlock(block) {
    const validation = this.validateBlock(block);
    if (!validation.valid) {
      return { success: false, error: validation.error };
    }

    for (const txData of block.transactions) {
      const tx = txData instanceof Transaction ? txData : Transaction.fromJSON(txData);
      if (tx.type === TX_TYPE.STAKE && this.validatorSet) {
        const pubKey = tx.publicKey || this.utxo.publicKeys.get(tx.from);
        if (pubKey) {
          this.validatorSet.register(tx.from, pubKey, tx.amount);
        }
      }
      if (tx.type === TX_TYPE.UNSTAKE && this.validatorSet) {
        this.validatorSet.unregister(tx.from);
      }
      if (tx.type === TX_TYPE.MODEL_DEPLOY) {
        this.models.deployModel(tx);
      }
      if (tx.type === TX_TYPE.TRAINING_SUBMIT) {
        this.models.recordSubmission(tx);
      }
      if (tx.type === TX_TYPE.TRAINING_VERIFY) {
        this.models.verifySubmission(tx);
      }
    }

    this.chain.push(block);
    this.utxo.applyBlock(block);

    this.globalModelStates = block.modelStates || {};

    // PERF-01: Update transaction index
    for (const txData of block.transactions) {
      const tx = txData instanceof Transaction ? txData : txData;
      if (tx.from) {
        if (!this.txIndex.has(tx.from)) this.txIndex.set(tx.from, []);
        this.txIndex.get(tx.from).push({ ...tx, blockIndex: block.index, blockHash: block.hash });
      }
      if (tx.to && tx.to !== tx.from) {
        if (!this.txIndex.has(tx.to)) this.txIndex.set(tx.to, []);
        this.txIndex.get(tx.to).push({ ...tx, blockIndex: block.index, blockHash: block.hash });
      }
    }

    const blockTxHashes = new Set(
      block.transactions.map(tx => tx.txHash || hashData(JSON.stringify(tx)))
    );
    this.mempool.removeMany([...blockTxHashes]);

    return { success: true, blockHash: block.hash };
  }

  validateBlock(block) {
    if (this.chain.length === 0) return { valid: true };

    const previous = this.latestBlock;

    if (!block.isValid(previous)) {
      return { valid: false, error: 'Block integrity check failed' };
    }

    // SEC-02: Use canonical JSON for deterministic model state comparison
    const prevStates = previous.modelStates || {};
    const expectedStates = aggregateAIWeights(block.transactions, prevStates);
    if (canonicalStringify(block.modelStates || {}) !== canonicalStringify(expectedStates)) {
      return { valid: false, error: 'Invalid AI modelStates aggregation' };
    }

    if (block.timestamp <= previous.timestamp) {
      return { valid: false, error: 'Block timestamp must be strictly greater than previous block' };
    }
    if (block.timestamp > Date.now() + 60_000) {
      return { valid: false, error: 'Block timestamp too far in the future' };
    }

    // PERF-05: Deserialize transactions once and reuse
    const deserializedTxs = block.transactions.map(tx =>
      tx instanceof Transaction ? tx : Transaction.fromJSON(tx)
    );

    // Enforce deterministic transaction ordering
    const sortedTxs = sortTransactions([...deserializedTxs]);
    for (let i = 0; i < deserializedTxs.length; i++) {
      if (deserializedTxs[i].txHash !== sortedTxs[i].txHash) {
        return { valid: false, error: 'Transactions are not in deterministic sorted order' };
      }
    }

    const elapsedMs = block.timestamp - previous.timestamp;
     // Max theoretical rate: 1.618 base * 1.25 val * 1.50 ref * 1.10 PoI ≈ 3.33 MZY/hr
     const maxTheoreticalReward = (elapsedMs / 3_600_000) * TOKENOMICS.MAX_THEORETICAL_REWARD_RATE;
    let totalMiningReward = 0;

    for (const tx of deserializedTxs) {
      const valid = tx.validate(this.utxo, this.publicKeyMap);
      if (!valid.valid) {
        return { valid: false, error: `Invalid transaction ${tx.txHash || ''}: ${valid.error}` };
      }
      if (tx.type === 'MINING') {
        totalMiningReward += tx.amount;
      }
    }

    // Allow a small absolute tolerance for very fast blocks or floating point
    if (totalMiningReward > maxTheoreticalReward + 0.001) {
      return { valid: false, error: `Total mining reward (${totalMiningReward}) exceeds theoretical maximum (${maxTheoreticalReward}) for elapsed time` };
    }

    // ── Supply cap enforcement (21 billion MZY hard cap) ──
    if (totalMiningReward > 0) {
      const currentSupply = Array.from(this.utxo.balances.values())
        .reduce((sum, bal) => sum + Math.max(0, bal), 0);
      if (currentSupply + totalMiningReward > 21_000_000_000) {
        const remaining = Math.max(0, 21_000_000_000 - currentSupply);
        return { valid: false, error: `Mining reward (${totalMiningReward}) would exceed supply cap. Only ${remaining.toFixed(6)} MZY remaining.` };
      }
    }

    return { valid: true };
  }

  validateChain(chain = this.chain) {
    if (chain.length === 0) return false;

    const genesis = createGenesisBlock();
    if (chain[0].hash !== genesis.hash) return false;

    const tempUtxo = new AccountState();
    tempUtxo.applyBlock(chain[0]);

    for (let i = 1; i < chain.length; i++) {
      const block = chain[i] instanceof Block ? chain[i] : Block.fromJSON(chain[i]);
      const prev = chain[i - 1] instanceof Block ? chain[i - 1] : Block.fromJSON(chain[i - 1]);
      if (!block.isValid(prev)) return false;
      if (block.timestamp <= prev.timestamp) return false;
      if (block.timestamp > Date.now() + 60_000) return false;

      // Verify transaction ordering
      const sortedTxs = sortTransactions(block.transactions.map(tx => tx instanceof Transaction ? tx : Transaction.fromJSON(tx)));
      for (let j = 0; j < block.transactions.length; j++) {
        const tx = block.transactions[j] instanceof Transaction ? block.transactions[j] : Transaction.fromJSON(block.transactions[j]);
        if (tx.txHash !== sortedTxs[j].txHash) return false;
      }

      const elapsedMs = block.timestamp - prev.timestamp;
       const maxTheoreticalReward = (elapsedMs / 3_600_000) * TOKENOMICS.MAX_THEORETICAL_REWARD_RATE;
      let totalMiningReward = 0;

      for (const txData of block.transactions) {
        const tx = txData instanceof Transaction ? txData : Transaction.fromJSON(txData);
        const valid = tx.validate(tempUtxo, tempUtxo.publicKeys);
        if (!valid.valid) return false;
        
        if (tx.type === 'MINING') {
          totalMiningReward += tx.amount;
        }

        tempUtxo.applyTransaction(tx, block.miner);
      }

      if (totalMiningReward > maxTheoreticalReward + 0.001) return false;
    }

    return true;
  }

  /**
   * CORR-01/02: Rebuild all state (UTXO, validators, models, txIndex) from a chain.
   */
  _rebuildState(chain) {
    this.utxo = new AccountState();
    this.validatorSet = this.validatorSet ? new ValidatorSet() : null;
    this.models = new ModelRegistry();
    this.txIndex = new Map();

    for (const block of chain) {
      this.utxo.applyBlock(block);

      for (const txData of block.transactions) {
        const tx = txData instanceof Transaction ? txData : Transaction.fromJSON(txData);
        if (tx.type === TX_TYPE.STAKE && this.validatorSet) {
          const pubKey = tx.publicKey || this.utxo.publicKeys.get(tx.from);
          if (pubKey) this.validatorSet.register(tx.from, pubKey, tx.amount);
        }
        if (tx.type === TX_TYPE.UNSTAKE && this.validatorSet) {
          this.validatorSet.unregister(tx.from);
        }
        if (tx.type === TX_TYPE.MODEL_DEPLOY) this.models.deployModel(tx);
        if (tx.type === TX_TYPE.TRAINING_SUBMIT) this.models.recordSubmission(tx);
        if (tx.type === TX_TYPE.TRAINING_VERIFY) this.models.verifySubmission(tx);

        // Rebuild txIndex
        if (tx.from) {
          if (!this.txIndex.has(tx.from)) this.txIndex.set(tx.from, []);
          this.txIndex.get(tx.from).push({ ...tx, blockIndex: block.index, blockHash: block.hash });
        }
        if (tx.to && tx.to !== tx.from) {
          if (!this.txIndex.has(tx.to)) this.txIndex.set(tx.to, []);
          this.txIndex.get(tx.to).push({ ...tx, blockIndex: block.index, blockHash: block.hash });
        }
      }
    }

    this.globalModelStates = chain.length > 0
      ? (chain[chain.length - 1].modelStates || {})
      : {};

    // Re-register default model if empty
    if (this.models.getAvailable().length === 0) {
      this.models.models.set('mziya-sentiment-v1', getDefaultModel());
      this.models.submissions.set('mziya-sentiment-v1', []);
    }
  }

  mergeBlocks(incomingBlocks) {
    if (incomingBlocks.length <= this.chain.length) return false;

    // Verify our chain is a strict prefix of the incoming chain
    for (let i = 0; i < this.chain.length; i++) {
      const cur = this.chain[i];
      const inc = incomingBlocks[i];
      if (cur.hash !== (inc.hash || inc.computeHash?.())) {
        return false;
      }
    }

    if (!this.validateChain(incomingBlocks)) return false;

    this.chain = incomingBlocks;
    // CORR-01: Rebuild ALL state, not just UTXO
    this._rebuildState(this.chain);

    return true;
  }

  replaceChain(incomingChain) {
    const incomingBlocks = incomingChain.map(b => b instanceof Block ? b : Block.fromJSON(b));

    const ourWork = this.chain.reduce((sum, b) => sum + (b.transactions?.length || 0), 0);
    const incomingWork = incomingBlocks.reduce((sum, b) => sum + (b.transactions?.length || 0), 0);

    const isLonger = incomingBlocks.length > this.chain.length;
    const isSameLengthWithMoreWork = incomingBlocks.length === this.chain.length && incomingWork > ourWork;
    const isSameLengthAndWorkWithBetterHash = incomingBlocks.length === this.chain.length && incomingWork === ourWork && 
      incomingBlocks[incomingBlocks.length - 1].hash < this.latestBlock.hash;

    if (!isLonger && !isSameLengthWithMoreWork && !isSameLengthAndWorkWithBetterHash) {
      return { replaced: false, reason: 'Incoming chain does not have more work' };
    }

    if (!this.validateChain(incomingBlocks)) {
      return { replaced: false, reason: 'Incoming chain is invalid' };
    }

    this.chain = incomingBlocks;
    // CORR-02: Rebuild ALL state, not just UTXO
    this._rebuildState(this.chain);

    return { replaced: true };
  }

  receiveVote(voteData) {
    if (!this.consensusEngine) return { accepted: false, reason: 'No consensus engine' };
    return this.consensusEngine.castVote(voteData);
  }

  getBalance(address) {
    return this.utxo.getBalance(address);
  }

  getTransactionHistory(address) {
    // PERF-01: Use txIndex for O(1) lookups when available
    if (this.txIndex.has(address)) {
      return [...this.txIndex.get(address)].reverse();
    }
    // Fallback: scan chain (only if index not built)
    const history = [];
    for (const block of this.chain) {
      for (const tx of block.transactions) {
        if (tx.from === address || tx.to === address) {
          history.push({ ...tx, blockIndex: block.index, blockHash: block.hash });
        }
      }
    }
    return history.reverse();
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
      // CORR-07: Clamp negative balances for accurate supply
      circulatingSupply: Array.from(this.utxo.balances.values())
        .reduce((sum, bal) => sum + Math.max(0, bal), 0),
      validatorCount: this.validatorSet?.count() || 0,
      modelCount: Object.keys(this.globalModelStates).length,
    };
  }

  toJSON() {
    return this.chain.map(b => b.toJSON ? b.toJSON() : b);
  }

  static fromJSON(chainData) {
    const bc = new Blockchain();
    bc.chain = chainData.map(b => Block.fromJSON(b));
    // Rebuild all state from the deserialized chain
    bc._rebuildState(bc.chain);
    return bc;
  }
}


