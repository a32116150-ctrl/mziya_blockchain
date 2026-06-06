import { Block, createGenesisBlock, buildMerkleTree, hashData } from '../core/block.js';

describe('Block Core', () => {
  describe('buildMerkleTree', () => {
    it('returns empty hash for no transactions', () => {
      const root = buildMerkleTree([]);
      expect(root).toBe(hashData('empty'));
    });

    it('returns correct hash for a single transaction', () => {
      const tx = { from: 'Alice', to: 'Bob', amount: 10 };
      const root = buildMerkleTree([tx]);
      expect(root).toBe(hashData(JSON.stringify(tx)));
    });

    it('builds a tree for multiple transactions', () => {
      const txs = [
        { id: 1, val: 'a' },
        { id: 2, val: 'b' },
        { id: 3, val: 'c' }
      ];
      const root = buildMerkleTree(txs);
      expect(root).toBeDefined();
      expect(root.length).toBe(64); // hex sha3-256
    });
  });

  describe('Block class', () => {
    it('creates a block with correct parameters and computes hash', () => {
      const block = new Block({
        index: 1,
        previousHash: 'prev-hash-hex-string',
        transactions: [{ type: 'TRANSFER', amount: 100 }],
        miner: 'MZminerAddress',
        timestamp: 1700000000000
      });

      expect(block.index).toBe(1);
      expect(block.previousHash).toBe('prev-hash-hex-string');
      expect(block.miner).toBe('MZminerAddress');
      expect(block.timestamp).toBe(1700000000000);
      expect(block.hash).toBe(block.computeHash());
    });

    it('serializes and deserializes to JSON correctly', () => {
      const block = new Block({
        index: 2,
        previousHash: 'prev-hash',
        transactions: [{ type: 'TRANSFER', amount: 5 }],
        miner: 'MZminer'
      });

      const json = block.toJSON();
      const restored = Block.fromJSON(json);

      expect(restored.index).toBe(block.index);
      expect(restored.hash).toBe(block.hash);
      expect(restored.previousHash).toBe(block.previousHash);
      expect(restored.miner).toBe(block.miner);
      expect(restored.transactions).toEqual(block.transactions);
    });

    it('validates sequence and hashes correctly', () => {
      const genesis = createGenesisBlock();
      const nextBlock = new Block({
        index: 1,
        previousHash: genesis.hash,
        transactions: [],
        miner: 'MZminer'
      });

      expect(nextBlock.isValid(genesis)).toBe(true);

      // Mutate next block to fail validity
      nextBlock.index = 2; // wrong index
      expect(nextBlock.isValid(genesis)).toBe(false);
    });
  });

  describe('Genesis Block', () => {
    it('creates a correct genesis block', () => {
      const genesis = createGenesisBlock();
      expect(genesis.index).toBe(0);
      expect(genesis.miner).toBe('GENESIS');
      expect(genesis.transactions[0].type).toBe('GENESIS');
    });
  });
});
