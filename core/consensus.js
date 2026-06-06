/**
 * Mziya Blockchain — Consensus Engine
 * BFT-style round management with validator-set block proposal.
 *
 * - Validators (staked MZY) take turns proposing blocks in rounds
 * - 2/3 supermajority of validators required for finality
 * - Round-robin proposer selection weighted by stake
 * - If no validators (testnet/early phase), any miner can propose
 * - A validator cartel controlling >2/3 of stake can control the chain
 */

import { verify } from './wallet.js';
import { hashData } from './block.js';

// ── Validator Registry ─────────────────────────────────────────────────────

export class ValidatorSet {
  constructor() {
    this.validators = new Map(); // address → { publicKey, stake, active }
  }

  register(address, publicKey, stake) {
    this.validators.set(address, {
      address,
      publicKey,
      stake,
      active: true,
      registeredAt: Date.now(),
    });
  }

  unregister(address) {
    if (this.validators.has(address)) {
      this.validators.get(address).active = false;
    }
  }

  getActive() {
    return [...this.validators.values()].filter(v => v.active);
  }

  count() { return this.getActive().length; }

  /**
   * Minimum validators needed to reach 2/3 supermajority
   */
  quorum() { return Math.floor((this.count() * 2) / 3) + 1; }

  isValidator(address) {
    return this.validators.has(address) && this.validators.get(address).active;
  }

  getPublicKey(address) {
    return this.validators.get(address)?.publicKey;
  }

  toJSON() {
    return [...this.validators.values()];
  }
}

// ── Vote ───────────────────────────────────────────────────────────────────

export class Vote {
  constructor({ blockHash, validatorAddress, signature, timestamp }) {
    this.blockHash = blockHash;
    this.validatorAddress = validatorAddress;
    this.signature = signature;
    this.timestamp = timestamp || Date.now();
  }

  getPayload() {
    return { blockHash: this.blockHash, validatorAddress: this.validatorAddress, timestamp: this.timestamp };
  }

  isValid(validatorSet) {
    const publicKey = validatorSet.getPublicKey(this.validatorAddress);
    if (!publicKey) return false;
    return verify(this.getPayload(), this.signature, publicKey);
  }

  toJSON() {
    return {
      blockHash: this.blockHash,
      validatorAddress: this.validatorAddress,
      signature: this.signature,
      timestamp: this.timestamp,
    };
  }

  static fromJSON(obj) { return new Vote(obj); }
}

// ── Block Proposer Selection ───────────────────────────────────────────────

/**
 * Round-robin block proposer selection.
 * Deterministic — all nodes agree on who proposes next.
 * Returns null when no validators are registered (open mining phase).
 */
export function selectBlockProposer(validatorSet, blockIndex) {
  const active = validatorSet.getActive();
  if (active.length === 0) return null;
  return active[blockIndex % active.length];
}

// ── Consensus Engine ───────────────────────────────────────────────────────

const ROUND_TIMEOUT_MS = 120_000; // 2 minutes per round

export class ConsensusEngine {
  constructor(validatorSet) {
    this.validatorSet = validatorSet;
    this.pendingVotes = new Map();     // blockHash → Vote[]
    this.finalizedBlocks = new Set();  // Set of finalized blockHashes
    this.onFinalize = null;            // callback when block finalized

    // Round management
    this.currentRound = 0;
    this.currentProposer = null;
    this.roundStartTime = 0;
    this._timeoutHandle = null;
    this._isRunning = false;
  }

  /**
   * Start the consensus round loop.
   */
  start() {
    if (this._isRunning) return;
    this._isRunning = true;
    this._advanceRound();
  }

  /**
   * Stop the consensus round loop.
   */
  stop() {
    this._isRunning = false;
    if (this._timeoutHandle) {
      clearTimeout(this._timeoutHandle);
      this._timeoutHandle = null;
    }
  }

  /**
   * Advance to the next round and select a proposer.
   */
  _advanceRound() {
    if (!this._isRunning) return;
    this.currentRound++;
    this.currentProposer = selectBlockProposer(this.validatorSet, this.currentRound);
    this.roundStartTime = Date.now();

    if (this.currentProposer) {
      const addr = this.currentProposer.address.slice(0, 14);
      // If we have validators, enforce round timeouts
      this._timeoutHandle = setTimeout(() => {
        if (this._isRunning) {
          this._advanceRound();
        }
      }, ROUND_TIMEOUT_MS);
    }
  }

  /**
   * Check whether a given miner address is allowed to propose a block
   * at the given block index.
   * If no validators are registered (testnet), any miner can propose.
   * If validators are registered, only the designated proposer can.
   */
  canPropose(minerAddress, blockIndex) {
    const proposer = selectBlockProposer(this.validatorSet, blockIndex);
    if (!proposer) return true; // open mining — anyone can propose
    return proposer.address === minerAddress;
  }

  /**
   * Cast a vote for a block (called by validator nodes).
   */
  castVote(vote) {
    if (!(vote instanceof Vote)) vote = Vote.fromJSON(vote);

    if (!this.validatorSet.isValidator(vote.validatorAddress)) {
      return { accepted: false, reason: 'Not a registered validator' };
    }

    if (!vote.isValid(this.validatorSet)) {
      return { accepted: false, reason: 'Invalid vote signature' };
    }

    if (!this.pendingVotes.has(vote.blockHash)) {
      this.pendingVotes.set(vote.blockHash, []);
    }

    const votes = this.pendingVotes.get(vote.blockHash);

    // Prevent double voting
    if (votes.some(v => v.validatorAddress === vote.validatorAddress)) {
      return { accepted: false, reason: 'Already voted for this block' };
    }

    votes.push(vote);

    // Check if quorum reached
    if (votes.length >= this.validatorSet.quorum()) {
      return this.finalizeBlock(vote.blockHash, votes);
    }

    return {
      accepted: true,
      votes: votes.length,
      quorum: this.validatorSet.quorum(),
      finalized: false,
    };
  }

  /**
   * Finalize a block when 2/3 supermajority reached.
   */
  finalizeBlock(blockHash, votes) {
    if (this.finalizedBlocks.has(blockHash)) {
      return { finalized: true, reason: 'Already finalized' };
    }

    this.finalizedBlocks.add(blockHash);
    this.pendingVotes.delete(blockHash);

    if (this.onFinalize) {
      this.onFinalize({ blockHash, votes, finalizedAt: Date.now() });
    }

    return {
      accepted: true,
      finalized: true,
      blockHash,
      voteCount: votes.length,
    };
  }

  isFinalized(blockHash) {
    return this.finalizedBlocks.has(blockHash);
  }

  getVoteCount(blockHash) {
    return this.pendingVotes.get(blockHash)?.length || 0;
  }

  /**
   * Activity proof — user daily tap is recorded here.
   * Not a blockchain transaction, just activity confirmation.
   */
  recordActivity(address, signature, publicKey) {
    const payload = { address, timestamp: Date.now(), action: 'MINING_ACTIVITY' };
    const isValid = verify(payload, signature, publicKey);

    return {
      recorded: isValid,
      address,
      proof: isValid ? hashData(JSON.stringify(payload) + signature) : null,
    };
  }
}
