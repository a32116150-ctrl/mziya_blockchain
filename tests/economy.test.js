import { jest } from '@jest/globals';
import { Blockchain } from '../core/blockchain.js';
import { Block } from '../core/block.js';
import {
  Transaction, TX_TYPE,
  createTransfer, createMiningStart, createMiningClaim, createStake, createUnstake,
  createModelDeploy, createTrainingSubmit, createTrainingVerify, createModelWithdraw,
} from '../core/transaction.js';
import { walletFromPrivateKey } from '../core/wallet.js';
import { MiningManager } from '../core/mining.js';
import { TOKENOMICS, DECOMPUTE, computeSessionReward, round6 } from '../core/tokenomics.js';

const DAY = TOKENOMICS.SESSION_DURATION_MS;
const T0 = TOKENOMICS.GENESIS_TIMESTAMP + 10 * DAY;

const alice = walletFromPrivateKey('a1'.repeat(32));
const bob = walletFromPrivateKey('b2'.repeat(32));
const carol = walletFromPrivateKey('c3'.repeat(32));

let now;
let bc;

function setNow(t) { now = t; }
function advance(ms) { now += ms; }

/** Add txs to the mempool and mine them in one block produced by `miner`. */
function mine(txs, miner = alice) {
  for (const tx of txs) {
    const r = bc.addPendingTransaction(tx);
    if (!r.success) throw new Error(`mempool rejected ${tx.type}: ${r.error}`);
  }
  advance(1000);
  const block = bc.forgeBlock(miner.address, miner.privateKey);
  if (!block) throw new Error('forgeBlock returned null');
  const res = bc.addBlock(block);
  if (!res.success) throw new Error(`addBlock failed: ${res.error}`);
  return block;
}

const nonce = (w) => bc.getNextNonce(w.address);

/** Run a full 24h mining session for `w` and return the claimed amount. */
function mineSession(w, producer = w) {
  mine([createMiningStart({ address: w.address, nonce: nonce(w), privateKey: w.privateKey })], producer);
  advance(DAY);
  const expected = bc.utxo.expectedMiningReward(w.address, now);
  mine([createMiningClaim({ address: w.address, amount: expected.amount, nonce: nonce(w), privateKey: w.privateKey })], producer);
  return expected.amount;
}

beforeEach(() => {
  setNow(T0);
  jest.spyOn(Date, 'now').mockImplementation(() => now);
  bc = new Blockchain().initialize();
});

afterEach(() => {
  bc.consensusEngine?.stop();
  jest.restoreAllMocks();
});

// ── Scarcity ────────────────────────────────────────────────────────────────

describe('Stop free coin creation', () => {
  test('a full session pays exactly the chain-computed reward', () => {
    const amount = mineSession(alice);
    const expected = computeSessionReward({ startTimestamp: T0 + 1000 }).total;
    expect(amount).toBe(expected);
    expect(bc.getBalance(alice.address)).toBe(expected);
    expect(bc.utxo.totalSupply).toBe(expected);
    expect(bc.validateChain()).toBe(true);
  });

  test('unsigned "GENESIS" mining rewards are rejected', () => {
    const fake = new Transaction({ from: 'GENESIS', to: bob.address, amount: 50, type: TX_TYPE.MINING });
    expect(bc.addPendingTransaction(fake).success).toBe(false);
  });

  test('claiming without a session, early, or for the wrong amount is rejected', () => {
    const noSession = createMiningClaim({ address: bob.address, amount: 1, nonce: 1, privateKey: bob.privateKey });
    expect(bc.addPendingTransaction(noSession).error).toMatch(/No open mining session/);

    mine([createMiningStart({ address: bob.address, nonce: 1, privateKey: bob.privateKey })], bob);
    advance(DAY / 2);
    const early = createMiningClaim({ address: bob.address, amount: 1, nonce: 2, privateKey: bob.privateKey });
    expect(bc.addPendingTransaction(early).error).toMatch(/not finished/);

    advance(DAY);
    const expected = bc.utxo.expectedMiningReward(bob.address, now).amount;
    const greedy = createMiningClaim({ address: bob.address, amount: round6(expected + 1), nonce: 2, privateKey: bob.privateKey });
    expect(bc.addPendingTransaction(greedy).error).toMatch(/must be exactly/);
  });

  test('a session can only be claimed once', () => {
    mineSession(bob);
    const again = createMiningClaim({ address: bob.address, amount: 1, nonce: nonce(bob), privateKey: bob.privateKey });
    expect(bc.addPendingTransaction(again).success).toBe(false);
  });

  test('UNSTAKE cannot create money', () => {
    mineSession(alice);
    const bal = bc.getBalance(alice.address);
    const unstake = createUnstake({ address: alice.address, amount: 10, nonce: nonce(alice), privateKey: alice.privateKey });
    expect(bc.addPendingTransaction(unstake).error).toMatch(/only 0 staked/);
    expect(bc.getBalance(alice.address)).toBe(bal);
  });

  test('two transfers that together overspend cannot share a block', () => {
    mineSession(alice);
    const bal = bc.getBalance(alice.address);
    const spendAll = round6(bal - TOKENOMICS.MIN_FEE);
    const t1 = createTransfer({ from: alice.address, to: bob.address, amount: spendAll, nonce: nonce(alice), privateKey: alice.privateKey });
    const t2 = createTransfer({ from: alice.address, to: carol.address, amount: spendAll, nonce: nonce(alice) + 1, privateKey: alice.privateKey });

    // Hand-build a block containing both (bypassing the mempool and forger)
    const prev = bc.latestBlock;
    const block = new Block({
      index: bc.length, previousHash: prev.hash, timestamp: now + 1000,
      transactions: [t1.toJSON(), t2.toJSON()], miner: alice.address, modelStates: prev.modelStates,
    }).sign(alice.privateKey);

    const res = bc.addBlock(block);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/Insufficient balance/);
  });

  test('blocks must be signed by their miner', () => {
    bc.addPendingTransaction(createMiningStart({ address: bob.address, nonce: 1, privateKey: bob.privateKey }));
    advance(1000);
    const unsigned = bc.forgeBlock(bob.address); // no key
    expect(bc.addBlock(unsigned).error).toMatch(/not signed/);

    const wrongKey = bc.forgeBlock(bob.address).sign(carol.privateKey);
    expect(bc.addBlock(wrongKey).error).toMatch(/not signed/);
  });

  test('tampered transaction hashes are rejected', () => {
    const tx = createMiningStart({ address: bob.address, nonce: 1, privateKey: bob.privateKey }).toJSON();
    tx.txHash = 'f'.repeat(64);
    expect(bc.addPendingTransaction(tx).error).toMatch(/hash mismatch/);
  });

  test('supply cap limits the final claim to what is left', () => {
    mine([createMiningStart({ address: alice.address, nonce: 1, privateKey: alice.privateKey })]);
    advance(DAY);
    bc.utxo.totalSupply = TOKENOMICS.TOTAL_SUPPLY - 5;
    const expected = bc.utxo.expectedMiningReward(alice.address, now);
    expect(expected.amount).toBe(5);
  });
});

// ── Fee burn ────────────────────────────────────────────────────────────────

describe('Fee burn', () => {
  test('half of each fee is burned, half goes to the block producer', () => {
    mineSession(alice);
    const supplyBefore = bc.utxo.totalSupply;
    const fee = 0.1;
    const tx = createTransfer({ from: alice.address, to: bob.address, amount: 1, fee, nonce: nonce(alice), privateKey: alice.privateKey });
    mine([tx], carol); // carol produces the block

    expect(bc.getBalance(bob.address)).toBe(1);
    expect(bc.getBalance(carol.address)).toBe(0.05);
    expect(bc.utxo.totalBurned).toBe(0.05);
    expect(bc.utxo.totalSupply).toBe(round6(supplyBefore - 0.05));
  });

  test('non-exempt transactions need at least the minimum fee', () => {
    mineSession(alice);
    const tx = createTransfer({ from: alice.address, to: bob.address, amount: 1, fee: 0, nonce: nonce(alice), privateKey: alice.privateKey });
    expect(bc.addPendingTransaction(tx).error).toMatch(/Fee below minimum/);
  });
});

// ── Staking ─────────────────────────────────────────────────────────────────

describe('Staking rewards', () => {
  function fundAndStake(w, sessions, stake) {
    for (let i = 0; i < sessions; i++) mineSession(w, bc.utxo.getValidators().length ? alice : w);
    mine([createStake({ address: w.address, amount: stake, nonce: nonce(w), privateKey: w.privateKey })],
      bc.utxo.getValidators().length ? alice : w);
  }

  test('staking MIN_STAKE makes you a validator; only validators then produce blocks', () => {
    fundAndStake(alice, 3, 100);
    expect(bc.utxo.isValidator(alice.address)).toBe(true);
    expect(bc.validatorSet.isValidator(alice.address)).toBe(true);

    bc.addPendingTransaction(createMiningStart({ address: bob.address, nonce: 1, privateKey: bob.privateKey }));
    expect(bc.forgeBlock(bob.address, bob.privateKey)).toBeNull();
    expect(bc.forgeBlock(alice.address, alice.privateKey)).not.toBeNull();
  });

  test('validators share 10% extra on every mining claim, pro-rata by stake', () => {
    fundAndStake(alice, 3, 100);
    const aliceBefore = bc.getBalance(alice.address);
    const claimed = mineSession(bob, alice);

    const share = Math.floor(round6(claimed * TOKENOMICS.STAKER_REWARD_SHARE * 1e6)) / 1e6;
    expect(bc.getBalance(alice.address)).toBe(round6(aliceBefore + share));
    expect(bc.utxo.totalStakingRewards).toBe(share);
  });

  test('validators get the +25% mining bonus', () => {
    fundAndStake(alice, 3, 100);
    const claimed = mineSession(alice);
    const normal = computeSessionReward({ startTimestamp: now }).total;
    expect(claimed).toBeGreaterThan(normal);
  });

  test('unstaking returns exactly what was staked and removes validator status', () => {
    fundAndStake(alice, 3, 100);
    const bal = bc.getBalance(alice.address);
    mine([createUnstake({ address: alice.address, amount: 100, nonce: nonce(alice), privateKey: alice.privateKey })]);
    expect(bc.getBalance(alice.address)).toBe(round6(bal + 100 - TOKENOMICS.MIN_FEE));
    expect(bc.utxo.isValidator(alice.address)).toBe(false);
    expect(bc.getStake(alice.address)).toBe(0);
  });
});

// ── DeCompute payouts ───────────────────────────────────────────────────────

describe('AI market payouts', () => {
  const modelId = 'acme-classifier-v1';

  function deploy(escrow = 100, rewardPerSubmission = 10) {
    mineSession(carol);
    mineSession(carol);
    mineSession(carol);
    mine([createModelDeploy({
      from: carol.address, amount: escrow, nonce: nonce(carol), privateKey: carol.privateKey,
      data: { modelId, modelConfig: { layers: [] }, datasetHash: 'd', testSetHash: 't', maxExpectedAccuracy: 0.9, rewardPerSubmission },
    })], carol);
  }

  function submit(w, accuracy = 0.9) {
    const tx = createTrainingSubmit({
      from: w.address, nonce: nonce(w), privateKey: w.privateKey,
      data: { modelId, weights: [0.1, 0.2], accuracy, speedFactor: 1, seedHash: 'abc' },
    });
    mine([tx], carol);
    return tx;
  }

  test('deploy moves MZY into escrow without changing total supply', () => {
    mineSession(carol); mineSession(carol); mineSession(carol);
    const supply = bc.utxo.totalSupply;
    const bal = bc.getBalance(carol.address);
    mine([createModelDeploy({
      from: carol.address, amount: 100, nonce: nonce(carol), privateKey: carol.privateKey,
      data: { modelId, modelConfig: {}, datasetHash: 'd', testSetHash: 't', maxExpectedAccuracy: 0.9 },
    })], carol);
    expect(bc.models.getModel(modelId).remainingEscrow).toBe(100);
    expect(bc.models.getModel(modelId).rewardPerSubmission).toBe(1); // default escrow / 100
    expect(bc.getBalance(carol.address)).toBe(round6(bal - 100 - TOKENOMICS.MIN_FEE));
    expect(bc.utxo.totalSupply).toBe(round6(supply - TOKENOMICS.MIN_FEE)); // a minimum fee is burned entirely
  });

  test('verified submission pays the trainer and the verifier from escrow', () => {
    deploy(100, 10);
    const sub = submit(bob, 0.9);
    mine([createTrainingVerify({ from: carol.address, nonce: nonce(carol), privateKey: carol.privateKey, submissionTx: sub.txHash, computedAccuracy: 0.89 })], carol);

    expect(bc.getBalance(bob.address)).toBe(10);
    const model = bc.models.getModel(modelId);
    expect(model.remainingEscrow).toBe(round6(100 - 10 - 0.5));
    expect(bc.models.findSubmission(sub.txHash).verified.valid).toBe(true);
    expect(bc.validateChain()).toBe(true);
  });

  test('a false accuracy claim is paid nothing and frees the reservation', () => {
    deploy(100, 10);
    const sub = submit(bob, 0.9);
    expect(bc.models.availableEscrow(modelId, bc.length)).toBe(round6(100 - 10.5));
    mine([createTrainingVerify({ from: carol.address, nonce: nonce(carol), privateKey: carol.privateKey, submissionTx: sub.txHash, computedAccuracy: 0.5 })], carol);
    expect(bc.getBalance(bob.address)).toBe(0);
    expect(bc.models.findSubmission(sub.txHash).verified.valid).toBe(false);
    expect(bc.models.availableEscrow(modelId, bc.length)).toBe(100);
  });

  test('only the provider or a validator may verify, and never the trainer', () => {
    deploy(100, 10);
    const sub = submit(bob, 0.9);
    mineSession(alice, carol);
    const byStranger = createTrainingVerify({ from: alice.address, nonce: nonce(alice), privateKey: alice.privateKey, submissionTx: sub.txHash, computedAccuracy: 0.9 });
    expect(bc.addPendingTransaction(byStranger).error).toMatch(/provider or a staked validator/);
  });

  test('escrow cannot be over-committed', () => {
    deploy(20, 10);
    submit(bob, 0.9);
    const second = createTrainingSubmit({
      from: alice.address, nonce: nonce(alice), privateKey: alice.privateKey,
      data: { modelId, weights: [1], accuracy: 0.9, speedFactor: 1 },
    });
    expect(bc.addPendingTransaction(second).error).toMatch(/escrow exhausted/);
  });

  test('provider withdraws leftover escrow once nothing is pending', () => {
    deploy(100, 10);
    const sub = submit(bob, 0.9);
    const early = createModelWithdraw({ from: carol.address, modelId, nonce: nonce(carol), privateKey: carol.privateKey });
    expect(bc.addPendingTransaction(early).error).toMatch(/waiting for verification/);

    mine([createTrainingVerify({ from: carol.address, nonce: nonce(carol), privateKey: carol.privateKey, submissionTx: sub.txHash, computedAccuracy: 0.9 })], carol);
    const bal = bc.getBalance(carol.address);
    mine([createModelWithdraw({ from: carol.address, modelId, nonce: nonce(carol), privateKey: carol.privateKey })], carol);
    // refund 89.5 minus the (fully burned) minimum fee
    expect(bc.getBalance(carol.address)).toBe(round6(bal + 89.5 - TOKENOMICS.MIN_FEE));
    expect(bc.models.getModel(modelId).status).toBe('closed');
  });

  test('unverified submissions expire after the verification window', () => {
    deploy(100, 10);
    const sub = submit(bob, 0.9);
    const sNow = bc.models.findSubmission(sub.txHash);
    expect(bc.models.isPending(sNow, bc.length)).toBe(true);
    expect(bc.models.isPending(sNow, sNow.blockIndex + DECOMPUTE.VERIFICATION_WINDOW_BLOCKS + 1)).toBe(false);
  });

  test('training the practice model raises the PoI mining bonus', () => {
    mine([createMiningStart({ address: bob.address, nonce: 1, privateKey: bob.privateKey })], bob);
    mine([createTrainingSubmit({
      from: bob.address, nonce: 2, privateKey: bob.privateKey,
      data: { modelId: DECOMPUTE.PRACTICE_MODEL_ID, weights: [1, 2], accuracy: 0.8, speedFactor: 1 },
    })], bob);
    advance(DAY);
    const expected = bc.utxo.expectedMiningReward(bob.address, now);
    expect(expected.bestAccuracy).toBe(0.8);
    expect(expected.poiBonus).toBeGreaterThan(0);
  });
});

// ── MiningManager end-to-end ────────────────────────────────────────────────

describe('MiningManager', () => {
  test('start → wait 24h → claim credits the wallet', async () => {
    const mm = new MiningManager(null);
    const start = await mm.startSession(alice.address, { privateKey: alice.privateKey, blockchain: bc });
    expect(start.error).toBeUndefined();
    expect(bc.utxo.getMiningSession(alice.address)).not.toBeNull();

    advance(DAY + 1000);
    mm.getSession(alice.address).tick();
    const res = await mm.claimReward(alice.address, bc, null, null, alice.privateKey);
    expect(res.error).toBeUndefined();
    expect(res.included).toBe(true);
    expect(bc.getBalance(alice.address)).toBe(res.amount);
  });

  test('replaying the chain from JSON reproduces the same state', async () => {
    mineSession(alice);
    mine([createTransfer({ from: alice.address, to: bob.address, amount: 3, nonce: nonce(alice), privateKey: alice.privateKey })]);
    const copy = Blockchain.fromJSON(JSON.parse(JSON.stringify(bc.toJSON())));
    expect(copy.getBalance(bob.address)).toBe(3);
    expect(copy.utxo.totalSupply).toBe(bc.utxo.totalSupply);
    expect(copy.utxo.totalBurned).toBe(bc.utxo.totalBurned);
  });
});
