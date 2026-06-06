import { Blockchain } from '../core/blockchain.js';
import { Transaction, TX_TYPE } from '../core/transaction.js';
import { Block } from '../core/block.js';

describe('Consensus Engine Hardening', () => {
  let blockchain;

  beforeEach(() => {
    blockchain = new Blockchain();
    blockchain.initialize();
  });

  describe('Cryptographic Mining Validation', () => {
    it('rejects blocks with monotonic timestamp violations', () => {
      const dummyAddress = 'MZ00000000000000000000000000000000000000';
      blockchain.mempool.add(new Transaction({ from: 'GENESIS', to: dummyAddress, amount: 10, type: TX_TYPE.MINING }));
      const block1 = blockchain.forgeBlock('MZminer000000000000000000000000000000000000');
      block1.timestamp = Date.now();
      block1.hash = block1.computeHash();
      blockchain.addBlock(block1);

      // Attempt to forge a block with an OLDER timestamp (Time-Travel Attack)
      const block2 = new Block({
        index: 2,
        previousHash: block1.hash,
        transactions: [],
        miner: dummyAddress
      });
      block2.timestamp = block1.timestamp - 1000;
      block2.hash = block2.computeHash();
      // Bypass basic validation (like previousHash checks) so it hits the timestamp rule
      block2.isValid = () => true;

      const result = blockchain.addBlock(block2);
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/must be strictly greater/);
    });

    it('rejects blocks that exceed mathematical mining caps', () => {
      const dummyAddress = 'MZ00000000000000000000000000000000000000';
      blockchain.mempool.add(new Transaction({ from: 'GENESIS', to: dummyAddress, amount: 10, type: TX_TYPE.MINING }));
      const block1 = blockchain.forgeBlock(dummyAddress);
      block1.timestamp = Date.now();
      block1.hash = block1.computeHash();
      blockchain.addBlock(block1);

      // Wait 1 second elapsed time
      const nextTimestamp = block1.timestamp + 1000;
      
      // Try to forge a block claiming 50 MZY for just 1 second of work
      const fakeMiningTx = new Transaction({
        from: 'GENESIS',
        to: dummyAddress,
        amount: 50,
        type: TX_TYPE.MINING
      });
      fakeMiningTx.txHash = 'fake_hash';

      const block2 = new Block({
        index: 2,
        previousHash: block1.hash,
        transactions: [fakeMiningTx],
        miner: dummyAddress
      });
      block2.timestamp = nextTimestamp;
      block2.hash = block2.computeHash();
      // Bypass basic validation to hit the mathematical mining caps rule
      block2.isValid = () => true;

      const result = blockchain.addBlock(block2);
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/exceeds theoretical maximum/);
    });
  });

  describe('DeCompute Training Submission Validation', () => {
    it('rejects TRAINING_SUBMIT with invalid speedFactor', () => {
      const aiTx = new Transaction({
        from: 'MZhacker00000000000000000000000000000000',
        to: 'mziya-sentiment-v1',
        amount: 0,
        type: TX_TYPE.TRAINING_SUBMIT,
        nonce: 1,
        data: {
          modelId: 'mziya-sentiment-v1',
          weights: [0.1, 0.2, 0.3],
          accuracy: 0.85,
          speedFactor: -1, // Invalid: must be positive
        }
      });
      
      const result = aiTx.validate(null, null);
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/positive speedFactor/);
    });

    it('rejects TRAINING_SUBMIT with accuracy out of range', () => {
      const aiTx = new Transaction({
        from: 'MZhacker00000000000000000000000000000000',
        to: 'mziya-sentiment-v1',
        amount: 0,
        type: TX_TYPE.TRAINING_SUBMIT,
        nonce: 1,
        data: {
          modelId: 'mziya-sentiment-v1',
          weights: [0.1, 0.2, 0.3],
          accuracy: 1.5, // Invalid: must be 0-1
          speedFactor: 1.0,
        }
      });
      
      const result = aiTx.validate(null, null);
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/between 0 and 1/);
    });
  });
});
