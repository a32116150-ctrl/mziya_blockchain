import { jest } from '@jest/globals';
import { Blockchain } from '../core/blockchain.js';
import { Block, createGenesisBlock } from '../core/block.js';
import { Transaction } from '../core/transaction.js';

describe('Blockchain Core', () => {
  let blockchain;

  beforeEach(() => {
    blockchain = new Blockchain();
    blockchain.initialize();
  });

  test('should initialize with a genesis block', () => {
    expect(blockchain.length).toBe(1);
    expect(blockchain.latestBlock.miner).toBe('GENESIS');
    expect(blockchain.latestBlock.transactions[0].type).toBe('GENESIS');
  });

  test('should validate a correct chain', () => {
    expect(blockchain.validateChain()).toBe(true);
  });

  test('should forge and add a valid block', () => {
    const tx = new Transaction({
      from: 'GENESIS',
      to: 'MZ00000000000000000000000000000000000000',
      amount: 10,
      type: 'MINING'
    });
    blockchain.mempool.add(tx);
    
    const newBlock = blockchain.forgeBlock('MZminer123');
    expect(newBlock).not.toBeNull();
    expect(newBlock.index).toBe(1);
    expect(newBlock.previousHash).toBe(blockchain.latestBlock.hash);
    expect(newBlock.miner).toBe('MZminer123');
    
    const res = blockchain.addBlock(newBlock);
    expect(res.success).toBe(true);
    expect(blockchain.length).toBe(2);
    expect(blockchain.latestBlock.hash).toBe(res.blockHash);
  });

  test('should fail to add invalid block', () => {
    const badBlock = new Block({
      index: 5, // invalid index
      previousHash: 'wronghash',
      transactions: [],
      miner: 'MZminer123'
    });
    
    const res = blockchain.addBlock(badBlock);
    expect(res.success).toBe(false);
    expect(res.error).toBeDefined();
  });

  test('should resolve forks using longest chain rule', () => {
    const peerChain = new Blockchain();
    peerChain.initialize();

    // Add block to peer chain
    const tx = new Transaction({ from: 'GENESIS', to: 'MZ00000000000000000000000000000000000000', amount: 10, type: 'MINING' });
    peerChain.mempool.add(tx);
    const block1 = peerChain.forgeBlock('MZminer123');
    peerChain.addBlock(block1);

    // Replace chain
    const res = blockchain.replaceChain(peerChain.toJSON());
    expect(res.replaced).toBe(true);
    expect(blockchain.length).toBe(2);
    expect(blockchain.getBalance('MZ00000000000000000000000000000000000000')).toBe(10);
  });

  test('should aggregate AI_SUBMISSION weights using Federated Averaging (FedAvg)', () => {
    // Miner A submissions
    const tx1 = new Transaction({
      from: 'MZalice000000000000000000000000000000000',
      to: 'AI_NETWORK_POOL',
      amount: 0,
      type: 'AI_SUBMISSION',
      data: {
        modelId: 'mziya-test-model',
        weights: [1.0, 2.0, -1.0],
        accuracy: 0.90
      }
    });

    // Miner B submissions
    const tx2 = new Transaction({
      from: 'MZbob00000000000000000000000000000000000',
      to: 'AI_NETWORK_POOL',
      amount: 0,
      type: 'AI_SUBMISSION',
      data: {
        modelId: 'mziya-test-model',
        weights: [2.0, 0.0, 1.0],
        accuracy: 0.80
      }
    });

    const spy = jest.spyOn(Transaction.prototype, 'isSignatureValid').mockReturnValue(true);
    // Also bypass validate amount because AI_SUBMISSION doesn't have an amount or valid sender balance
    const spyValidate = jest.spyOn(Transaction.prototype, 'validate').mockReturnValue({ valid: true });

    blockchain.mempool.add(tx1);
    blockchain.mempool.add(tx2);

    const block = blockchain.forgeBlock('MZminer0000000000000000000000000000000000');

    // Expected weight calculation (FedAvg weighted by accuracy):
    // totalAccuracy = 0.90 + 0.80 = 1.70
    // w[0] = (1.0 * 0.90 + 2.0 * 0.80) / 1.70 = 2.5 / 1.7 = 1.470588
    // w[1] = (2.0 * 0.90 + 0.0 * 0.80) / 1.70 = 1.8 / 1.7 = 1.058824
    // w[2] = (-1.0 * 0.90 + 1.0 * 0.80) / 1.70 = -0.1 / 1.7 = -0.058824
    const expectedWeights = [
      Math.round((2.5 / 1.7) * 1e6) / 1e6,
      Math.round((1.8 / 1.7) * 1e6) / 1e6,
      Math.round((-0.1 / 1.7) * 1e6) / 1e6
    ];

    expect(block.modelStates['mziya-test-model']).toEqual(expectedWeights);

    // Verify block addition and chain state validation
    const res = blockchain.addBlock(block);
    expect(res.success).toBe(true);
    expect(blockchain.latestBlock.modelStates['mziya-test-model']).toEqual(expectedWeights);

    spy.mockRestore();
    spyValidate.mockRestore();
  });
});
