import { ModelRegistry, computeBenchmark } from '../core/decompute.js';
import { Transaction, TX_TYPE } from '../core/transaction.js';

describe('Mziya DeCompute Engine', () => {
  let registry;

  beforeEach(() => {
    registry = new ModelRegistry();
  });

  describe('deployModel', () => {
    it('deploys a model correctly and registers it', () => {
      const deployTx = new Transaction({
        from: 'MZcompany',
        to: 'MODEL_REGISTRY',
        amount: 5000,
        type: TX_TYPE.MODEL_DEPLOY,
        data: {
          modelId: 'sentiment-v2',
          modelConfig: { layers: [] },
          datasetHash: 'dataset-hash',
          testSetHash: 'testset-hash',
          maxExpectedAccuracy: 0.90
        }
      });

      const res = registry.deployModel(deployTx);
      expect(res.success).toBe(true);

      const model = registry.getModel('sentiment-v2');
      expect(model).toBeDefined();
      expect(model.provider).toBe('MZcompany');
      expect(model.totalEscrow).toBe(5000);
      expect(registry.getAvailable().length).toBe(1);
    });

    it('rejects double deployments of the same model', () => {
      const deployTx = new Transaction({
        from: 'MZcompany',
        to: 'MODEL_REGISTRY',
        amount: 1000,
        type: TX_TYPE.MODEL_DEPLOY,
        data: {
          modelId: 'sentiment-v2',
          modelConfig: {},
          datasetHash: 'h1',
          testSetHash: 'h2',
          maxExpectedAccuracy: 0.85
        }
      });

      registry.deployModel(deployTx);
      const res = registry.deployModel(deployTx);
      expect(res.success).toBe(false);
      expect(res.error).toBe('Model already exists');
    });
  });

  describe('recordSubmission', () => {
    beforeEach(() => {
      const deployTx = new Transaction({
        from: 'MZcompany',
        to: 'MODEL_REGISTRY',
        amount: 1000,
        type: TX_TYPE.MODEL_DEPLOY,
        data: {
          modelId: 'sentiment-v2',
          modelConfig: {},
          datasetHash: 'h1',
          testSetHash: 'h2',
          maxExpectedAccuracy: 0.90
        }
      });
      registry.deployModel(deployTx);
    });

    it('records a valid training submission', () => {
      const submitTx = new Transaction({
        from: 'MZtrainer',
        to: 'sentiment-v2',
        amount: 0,
        type: TX_TYPE.TRAINING_SUBMIT,
        data: {
          modelId: 'sentiment-v2',
          weights: [0.1, 0.2],
          accuracy: 0.81,
          speedFactor: 1.2
        }
      });
      submitTx.txHash = 'submit-tx-hash';

      const res = registry.recordSubmission(submitTx);
      expect(res.success).toBe(true);

      const sub = registry.findSubmission('submit-tx-hash');
      expect(sub).toBeDefined();
      expect(sub.trainer).toBe('MZtrainer');
      expect(sub.accuracyFactor).toBe(0.81 / 0.90);
    });

    it('rejects submissions with very low accuracy', () => {
      const submitTx = new Transaction({
        from: 'MZtrainer',
        to: 'sentiment-v2',
        amount: 0,
        type: TX_TYPE.TRAINING_SUBMIT,
        data: {
          modelId: 'sentiment-v2',
          weights: [0.1, 0.2],
          accuracy: 0.20, // 0.20 / 0.90 = 22% (below the 30% floor)
          speedFactor: 1.0
        }
      });

      const res = registry.recordSubmission(submitTx);
      expect(res.success).toBe(false);
      expect(res.error).toMatch(/Accuracy too low/);
    });
  });

  describe('verifySubmission', () => {
    beforeEach(() => {
      const deployTx = new Transaction({
        from: 'MZcompany',
        to: 'MODEL_REGISTRY',
        amount: 1000,
        type: TX_TYPE.MODEL_DEPLOY,
        data: {
          modelId: 'sentiment-v2',
          modelConfig: {},
          datasetHash: 'h1',
          testSetHash: 'h2',
          maxExpectedAccuracy: 0.90
        }
      });
      registry.deployModel(deployTx);

      const submitTx = new Transaction({
        from: 'MZtrainer',
        to: 'sentiment-v2',
        amount: 0,
        type: TX_TYPE.TRAINING_SUBMIT,
        data: {
          modelId: 'sentiment-v2',
          weights: [0.1, 0.2],
          accuracy: 0.81,
          speedFactor: 1.0
        }
      });
      submitTx.txHash = 'submit-tx-hash';
      registry.recordSubmission(submitTx);
    });

    it('verifies submission correctly', () => {
      const verifyTx = new Transaction({
        from: 'MZverifier',
        to: 'sentiment-v2',
        amount: 0,
        type: TX_TYPE.TRAINING_VERIFY,
        data: {
          submissionTx: 'submit-tx-hash',
          computedAccuracy: 0.81,
          invalid: false
        }
      });

      const res = registry.verifySubmission(verifyTx);
      expect(res.success).toBe(true);

      const sub = registry.findSubmission('submit-tx-hash');
      expect(sub.verified).toBeDefined();
      expect(sub.verified.invalid).toBe(false);
      expect(sub.verified.verifier).toBe('MZverifier');
    });
  });

  describe('computeBenchmark', () => {
    it('returns a positive number representing device speed', () => {
      const benchmark = computeBenchmark();
      expect(typeof benchmark).toBe('number');
      expect(benchmark).toBeGreaterThan(0);
    });
  });
});
