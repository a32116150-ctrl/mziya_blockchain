import { jest } from '@jest/globals';
import { Blockchain } from '../core/blockchain.js';
import { Transaction, TX_TYPE, createMiningStart, createTrainingSubmit } from '../core/transaction.js';
import { Block } from '../core/block.js';
import { walletFromPrivateKey } from '../core/wallet.js';
import { TOKENOMICS } from '../core/tokenomics.js';

const miner = walletFromPrivateKey('0a'.repeat(32));
const hacker = walletFromPrivateKey('0b'.repeat(32));

let now;

describe('Consensus Engine Hardening', () => {
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

  function addFirstBlock() {
    blockchain.addPendingTransaction(createMiningStart({ address: miner.address, nonce: 1, privateKey: miner.privateKey }));
    now += 1000;
    const block1 = blockchain.forgeBlock(miner.address, miner.privateKey);
    expect(blockchain.addBlock(block1).success).toBe(true);
    return block1;
  }

  describe('Cryptographic Mining Validation', () => {
    it('rejects blocks with monotonic timestamp violations', () => {
      const block1 = addFirstBlock();

      // Attempt to forge a block with an OLDER timestamp (Time-Travel Attack)
      const block2 = new Block({
        index: 2,
        previousHash: block1.hash,
        transactions: [],
        timestamp: block1.timestamp - 1000,
        miner: miner.address,
      }).sign(miner.privateKey);

      const result = blockchain.addBlock(block2);
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/must be strictly greater/);
    });

    it('rejects coins minted out of thin air', () => {
      const block1 = addFirstBlock();

      // An unsigned "GENESIS" mining reward — the old free-mint exploit
      const fakeMiningTx = new Transaction({ from: 'GENESIS', to: hacker.address, amount: 50, type: TX_TYPE.MINING, nonce: 1 });

      const block2 = new Block({
        index: 2,
        previousHash: block1.hash,
        transactions: [fakeMiningTx.toJSON()],
        timestamp: now + 1000,
        miner: hacker.address,
        modelStates: block1.modelStates,
      }).sign(hacker.privateKey);

      const result = blockchain.addBlock(block2);
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Invalid sender address/);
      expect(blockchain.getBalance(hacker.address)).toBe(0);
    });

    it('rejects a signed MINING claim without a finished session', () => {
      const tx = new Transaction({ from: hacker.address, to: hacker.address, amount: 50, type: TX_TYPE.MINING, nonce: 1 })
        .sign(hacker.privateKey);
      const result = blockchain.addPendingTransaction(tx);
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/No open mining session/);
    });
  });

  describe('DeCompute Training Submission Validation', () => {
    it('rejects TRAINING_SUBMIT with invalid speedFactor', () => {
      const aiTx = createTrainingSubmit({
        from: hacker.address, nonce: 1, privateKey: hacker.privateKey,
        data: { modelId: 'mziya-sentiment-v1', weights: [0.1, 0.2, 0.3], accuracy: 0.85, speedFactor: -1 },
      });

      const result = aiTx.validate(null, null);
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/positive speedFactor/);
    });

    it('rejects TRAINING_SUBMIT with accuracy out of range', () => {
      const aiTx = createTrainingSubmit({
        from: hacker.address, nonce: 1, privateKey: hacker.privateKey,
        data: { modelId: 'mziya-sentiment-v1', weights: [0.1, 0.2, 0.3], accuracy: 1.5, speedFactor: 1.0 },
      });

      const result = aiTx.validate(null, null);
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/between 0 and 1/);
    });

    it('rejects oversized weight arrays', () => {
      const aiTx = createTrainingSubmit({
        from: hacker.address, nonce: 1, privateKey: hacker.privateKey,
        data: { modelId: 'mziya-sentiment-v1', weights: new Array(TOKENOMICS.MAX_AI_WEIGHTS + 1).fill(0), accuracy: 0.5, speedFactor: 1 },
      });
      expect(aiTx.validate(null, null).valid).toBe(false);
    });
  });
});
