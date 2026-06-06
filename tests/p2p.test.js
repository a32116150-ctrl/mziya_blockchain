import { jest } from '@jest/globals';
import { MziyaP2P, TOPICS } from '../network/peer.js';
import { Blockchain } from '../core/blockchain.js';
import { Mempool } from '../core/mempool.js';
import { Transaction } from '../core/transaction.js';
import { Block } from '../core/block.js';

describe('Mziya P2P Network Layer', () => {
  let blockchain;
  let mempool;
  let p2p;

  beforeEach(() => {
    blockchain = new Blockchain();
    blockchain.initialize();
    mempool = new Mempool();
    p2p = new MziyaP2P(blockchain, mempool);
  });

  test('should initialize with correct parameters', () => {
    expect(p2p.blockchain).toBe(blockchain);
    expect(p2p.mempool).toBe(mempool);
    expect(p2p.isRunning).toBe(false);
    expect(p2p.peerCount).toBe(0);
  });

  test('should handle incoming transactions via pubsub', () => {
    let callbackTriggered = false;
    p2p.onTransaction = (tx) => {
      callbackTriggered = true;
      expect(tx.amount).toBe(100);
      expect(tx.to).toBe('MZrecipient123');
    };

    const mockTx = new Transaction({
      from: null,
      to: 'MZrecipient123',
      amount: 100,
      type: 'MINING'
    });
    mockTx.txHash = mockTx.computeHash();

    const mockPubsubMessage = {
      topic: TOPICS.TRANSACTION,
      data: new TextEncoder().encode(JSON.stringify(mockTx.toJSON()))
    };

    p2p._handleMessage(mockPubsubMessage);

    expect(mempool.size).toBe(1);
    expect(mempool.has(mockTx.txHash)).toBe(true);
    expect(callbackTriggered).toBe(true);
  });

  test('should handle incoming blocks via pubsub', () => {
    let callbackTriggered = false;
    p2p.onBlock = (block) => {
      callbackTriggered = true;
      expect(block.index).toBe(1);
    };

    const mockBlock = new Block({
      index: 1,
      previousHash: blockchain.latestBlock.hash,
      transactions: [],
      miner: 'MZminer123',
      timestamp: Date.now()
    });

    const mockPubsubMessage = {
      topic: TOPICS.BLOCK,
      data: new TextEncoder().encode(JSON.stringify(mockBlock.toJSON()))
    };

    // Mock addBlock and consensusEngine to isolate P2P test
    blockchain.addBlock = jest.fn().mockReturnValue({ success: true, blockHash: mockBlock.hash });
    blockchain.consensusEngine.isFinalized = jest.fn().mockReturnValue(true);

    // Manually increment length to simulate successful addition
    const originalLength = blockchain.length;
    Object.defineProperty(blockchain, 'length', { get: () => originalLength + 1 });
    Object.defineProperty(blockchain, 'latestBlock', { get: () => mockBlock });

    p2p._handleMessage(mockPubsubMessage);

    // Verify blockchain was updated
    expect(blockchain.addBlock).toHaveBeenCalled();
    expect(blockchain.length).toBe(2);
    expect(blockchain.latestBlock.hash).toBe(mockBlock.hash);
    expect(callbackTriggered).toBe(true);
  });

  test('should handle chain sync request-response messages', () => {
    const mockSyncRequest = {
      type: 'SYNC_REQUEST',
      ourHeight: 1,
      ourLatestHash: blockchain.latestBlock.hash,
      timestamp: Date.now()
    };

    // Prepare pubsub mock to trace broadcasted messages
    const published = [];
    p2p.node = {
      services: {
        pubsub: {
          publish: (topic, data) => {
            published.push({ topic, data: new TextDecoder().decode(data) });
          }
        }
      }
    };
    p2p.isRunning = true;

    // Handle incoming SYNC_REQUEST from a peer who is shorter than us
    // Let's add a block first so we have height = 2
    const mockBlock = new Block({
      index: 1,
      previousHash: blockchain.latestBlock.hash,
      transactions: [],
      miner: 'MZminer123'
    });
    blockchain.addBlock(mockBlock);

    const mockRequestMsg = {
      topic: TOPICS.SYNC,
      data: new TextEncoder().encode(JSON.stringify(mockSyncRequest))
    };

    p2p._handleMessage(mockRequestMsg);

    // It should respond with our longer chain
    expect(published.length).toBe(1);
    const publishedPayload = JSON.parse(published[0].data);
    expect(publishedPayload.type).toBe('SYNC_RESPONSE');
    expect(publishedPayload.height).toBe(2);
    expect(publishedPayload.blocks).toBeDefined();
  });
});
