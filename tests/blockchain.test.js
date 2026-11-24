import { jest } from '@jest/globals';
import { Blockchain } from '../core/blockchain.js';
import { Block } from '../core/block.js';
import { Transaction, TX_TYPE, createMiningStart } from '../core/transaction.js';
import { walletFromPrivateKey } from '../core/wallet.js';
import { TOKENOMICS } from '../core/tokenomics.js';

const miner = walletFromPrivateKey('01'.repeat(32));
const alice = walletFromPrivateKey('02'.repeat(32));
const bob = walletFromPrivateKey('03'.repeat(32));

let now;

describe('Blockchain Core', () => {
  let blockchain;

  beforeEach(() => {
    now = TOKENOMICS.GENESIS_TIMESTAMP + 86_400_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    blockchain = new Blockchain();
    blockchain.initialize();
  });

  afterEach(() => {
    blockchain.consensusEngine?.stop();
    jest.restoreAllMocks();
  });

  test('should initialize with a genesis block', () => {
    expect(blockchain.length).toBe(1);
    expect(blockchain.latestBlock.miner).toBe('GENESIS');
    expect(blockchain.latestBlock.transactions[0].type).toBe('GENESIS');
    expect(blockchain.utxo.totalSupply).toBe(0);
  });

  test('should validate a correct chain', () => {
    expect(blockchain.validateChain()).toBe(true);
  });

  test('should forge and add a valid signed block', () => {
    blockchain.addPendingTransaction(createMiningStart({ address: miner.address, nonce: 1, privateKey: miner.privateKey }));
    now += 1000;

    const newBlock = blockchain.forgeBlock(miner.address, miner.privateKey);
    expect(newBlock).not.toBeNull();
    expect(newBlock.index).toBe(1);
    expect(newBlock.previousHash).toBe(blockchain.latestBlock.hash);
    expect(newBlock.miner).toBe(miner.address);
    expect(newBlock.hasValidSignature()).toBe(true);

    const res = blockchain.addBlock(newBlock);
    expect(res.success).toBe(true);
    expect(blockchain.length).toBe(2);
    expect(blockchain.latestBlock.hash).toBe(res.blockHash);
    expect(blockchain.mempool.size).toBe(0);
  });

  test('should fail to add invalid block', () => {
    const badBlock = new Block({
      index: 5, // invalid index
      previousHash: 'wronghash',
      transactions: [],
      miner: miner.address,
    }).sign(miner.privateKey);

    const res = blockchain.addBlock(badBlock);
    expect(res.success).toBe(false);
    expect(res.error).toBeDefined();
  });

  test('should resolve forks using longest chain rule', () => {
    const peerChain = new Blockchain();
    peerChain.initialize();
    peerChain.addPendingTransaction(createMiningStart({ address: alice.address, nonce: 1, privateKey: alice.privateKey }));
    now += 1000;
    const block1 = peerChain.forgeBlock(alice.address, alice.privateKey);
    expect(peerChain.addBlock(block1).success).toBe(true);

    const res = blockchain.replaceChain(peerChain.toJSON());
    expect(res.replaced).toBe(true);
    expect(blockchain.length).toBe(2);
    expect(blockchain.utxo.getMiningSession(alice.address)).not.toBeNull();
    peerChain.consensusEngine.stop();
  });

  test('should reject a chain containing a forged block', () => {
    const peerChain = new Blockchain();
    peerChain.initialize();
    peerChain.addPendingTransaction(createMiningStart({ address: alice.address, nonce: 1, privateKey: alice.privateKey }));
    now += 1000;
    const block1 = peerChain.forgeBlock(alice.address); // unsigned
    peerChain.chain.push(block1); // force it in, skipping validation

    const res = blockchain.replaceChain(peerChain.toJSON());
    expect(res.replaced).toBe(false);
    expect(res.reason).toMatch(/invalid/);
    peerChain.consensusEngine.stop();
  });

  test('should aggregate AI_SUBMISSION weights using Federated Averaging (FedAvg)', () => {
    const tx1 = new Transaction({
      from: alice.address, to: 'AI_NETWORK_POOL', amount: 0, nonce: 1,
      type: TX_TYPE.AI_SUBMISSION,
      data: { modelId: 'mziya-test-model', weights: [1.0, 2.0, -1.0], accuracy: 0.90 },
    }).sign(alice.privateKey);

    const tx2 = new Transaction({
      from: bob.address, to: 'AI_NETWORK_POOL', amount: 0, nonce: 1,
      type: TX_TYPE.AI_SUBMISSION,
      data: { modelId: 'mziya-test-model', weights: [2.0, 0.0, 1.0], accuracy: 0.80 },
    }).sign(bob.privateKey);

    expect(blockchain.addPendingTransaction(tx1).success).toBe(true);
    expect(blockchain.addPendingTransaction(tx2).success).toBe(true);
    now += 1000;

    const block = blockchain.forgeBlock(miner.address, miner.privateKey);

    // FedAvg weighted by accuracy: totalAccuracy = 1.70
    const expectedWeights = [
      Math.round((2.5 / 1.7) * 1e6) / 1e6,
      Math.round((1.8 / 1.7) * 1e6) / 1e6,
      Math.round((-0.1 / 1.7) * 1e6) / 1e6,
    ];

    expect(block.modelStates['mziya-test-model']).toEqual(expectedWeights);

    const res = blockchain.addBlock(block);
    expect(res.success).toBe(true);
    expect(blockchain.latestBlock.modelStates['mziya-test-model']).toEqual(expectedWeights);
  });
});
