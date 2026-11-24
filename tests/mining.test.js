import { jest } from '@jest/globals';
import { getCurrentMiningRate, calculateSessionEarnings, MiningSession, MiningManager, TOKENOMICS } from '../core/mining.js';
import { Blockchain } from '../core/blockchain.js';
import { walletFromPrivateKey } from '../core/wallet.js';

describe('Mining Engine', () => {
  describe('getCurrentMiningRate', () => {
    it('returns the initial rate at genesis', () => {
      const rate = getCurrentMiningRate(TOKENOMICS.GENESIS_TIMESTAMP);
      expect(rate).toBe(TOKENOMICS.INITIAL_HOURLY_RATE);
    });

    it('halves the rate after a halving period', () => {
      const midTimestamp = TOKENOMICS.GENESIS_TIMESTAMP + TOKENOMICS.HALVING_PERIOD_MS + 1000;
      const rate = getCurrentMiningRate(midTimestamp);
      expect(rate).toBe(Math.round((TOKENOMICS.INITIAL_HOURLY_RATE / 2) * 1e6) / 1e6);
    });

    it('respects the floor rate after many halvings', () => {
      const farTimestamp = TOKENOMICS.GENESIS_TIMESTAMP + (TOKENOMICS.HALVING_PERIOD_MS * 10);
      const rate = getCurrentMiningRate(farTimestamp);
      expect(rate).toBe(TOKENOMICS.FLOOR_RATE);
    });

    it('applies validator and referral bonuses correctly', () => {
      const baseRate = getCurrentMiningRate(TOKENOMICS.GENESIS_TIMESTAMP, 0, false);
      const valRate = getCurrentMiningRate(TOKENOMICS.GENESIS_TIMESTAMP, 0, true);
      const refRate = getCurrentMiningRate(TOKENOMICS.GENESIS_TIMESTAMP, 2, false);

      expect(valRate).toBe(Math.round(baseRate * (1 + TOKENOMICS.VALIDATOR_BONUS) * 1e6) / 1e6);
      expect(refRate).toBe(Math.round(baseRate * (1 + 2 * TOKENOMICS.REFERRAL_BONUS) * 1e6) / 1e6);
    });
  });

  describe('calculateSessionEarnings', () => {
    it('calculates earnings proportionally based on hours', () => {
      const rate = 1.0;
      const durationMs = 12 * 60 * 60 * 1000; // 12 hours
      const earned = calculateSessionEarnings(durationMs, rate);
      expect(earned).toBe(12.0);
    });
  });

  describe('MiningSession', () => {
    it('initializes session correctly', () => {
      const session = new MiningSession({
        address: 'MZaddress123',
        rate: 1.5,
        referrals: 2,
        isValidator: true
      });

      expect(session.address).toBe('MZaddress123');
      expect(session.rate).toBe(1.5);
      expect(session.referrals).toBe(2);
      expect(session.isValidator).toBe(true);
      expect(session.active).toBe(true);
      expect(session.earned).toBe(0);
    });
  });

  describe('MiningManager', () => {
    let mockStorage;
    let manager;

    beforeEach(() => {
      const dataMap = new Map();
      mockStorage = {
        get: jest.fn().mockImplementation(async (key) => dataMap.get(key)),
        set: jest.fn().mockImplementation(async (key, value) => { dataMap.set(key, value); }),
        delete: jest.fn().mockImplementation(async (key) => { dataMap.delete(key); })
      };
      manager = new MiningManager(mockStorage);
    });

    it('starts and confirms active sessions', async () => {
      const w = walletFromPrivateKey('0c'.repeat(32));
      const blockchain = new Blockchain();
      blockchain.initialize();

      const startRes = await manager.startSession(w.address, { privateKey: w.privateKey, blockchain });
      expect(startRes.error).toBeUndefined();
      expect(startRes.session.active).toBe(true);
      expect(blockchain.utxo.getMiningSession(w.address)).not.toBeNull();

      const confirmRes = await manager.confirmActivity(w.address);
      expect(confirmRes.session).toBeDefined();
      expect(confirmRes.earned).toBeDefined();
      blockchain.consensusEngine.stop();
    });

    it('refuses to start without a key', async () => {
      const res = await manager.startSession('MZminer', {});
      expect(res.error).toMatch(/private key/);
    });

    it('prevents claiming a reward from active session', async () => {
      const w = walletFromPrivateKey('0d'.repeat(32));
      const blockchain = new Blockchain();
      blockchain.initialize();

      await manager.startSession(w.address, { privateKey: w.privateKey, blockchain });

      const claimRes = await manager.claimReward(w.address, blockchain, null, null, w.privateKey);
      expect(claimRes.error).toBe('Session must be completed before claiming');
      blockchain.consensusEngine.stop();
    });
  });
});
