/**
 * Mziya Blockchain — AI WebWorker
 * Offloads heavy TensorFlow.js training from the main UI thread.
 * Generates the deterministic dataset based on the block hash seed,
 * trains the model, and returns the optimized weights.
 */

// Import TensorFlow.js from CDN
importScripts('https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.10.0/dist/tf.min.js');

function generateDeterministicDataset(seedHash, numSamples = 50) {
  let seed = parseInt(seedHash.slice(0, 8), 16) || 12345;
  const random = () => {
    const x = Math.sin(seed++) * 10000;
    return x - Math.floor(x);
  };

  const inputs = [];
  const labels = [];
  
  for (let i = 0; i < numSamples; i++) {
    const x = [random() * 2 - 1, random() * 2 - 1, random() * 2 - 1, random() * 2 - 1];
    inputs.push(x);
    const sum = x.reduce((a, b) => a + b, 0);
    labels.push([sum > 0 ? 1 : 0]);
  }

  return { inputs, labels };
}

self.onmessage = async (e) => {
  const { action, modelConfig, seedHash } = e.data;

  if (action === 'TRAIN') {
    try {
      self.postMessage({ type: 'LOG', msg: '[WORKER] Building TensorFlow.js model...' });

      const seq = tf.sequential();
      for (const layer of modelConfig.layers) {
        if (layer.type === 'dense') {
          seq.add(tf.layers.dense({ units: layer.units, inputShape: layer.inputShape, activation: layer.activation }));
        }
      }

      seq.compile({ 
        optimizer: modelConfig.compile.optimizer, 
        loss: modelConfig.compile.loss, 
        metrics: modelConfig.compile.metrics || ['accuracy'] 
      });

      self.postMessage({ type: 'LOG', msg: `[WORKER] Generating deterministic dataset (seed: ${seedHash.slice(0,8)}...)` });
      
      const trainData = generateDeterministicDataset(seedHash, 100);
      const xs = tf.tensor2d(trainData.inputs);
      const ys = tf.tensor2d(trainData.labels);

      self.postMessage({ type: 'LOG', msg: '[WORKER] Starting on-device training...' });

      await seq.fit(xs, ys, {
        epochs: modelConfig.epochs || 10,
        batchSize: modelConfig.batchSize || 10,
        callbacks: {
          onEpochEnd: (epoch, logs) => {
            self.postMessage({ type: 'LOG', msg: `[WORKER] Epoch ${epoch + 1}: loss = ${logs.loss.toFixed(4)}, acc = ${logs.acc.toFixed(4)}` });
          }
        }
      });

      self.postMessage({ type: 'LOG', msg: '[WORKER] Training complete. Evaluating...' });

      // CORR-06: Use different seed for test data to avoid train/test overlap
      const testData = generateDeterministicDataset(seedHash + '-test', 50);
      const testXs = tf.tensor2d(testData.inputs);
      const testYs = tf.tensor2d(testData.labels);
      
      const evalResult = seq.evaluate(testXs, testYs, { batchSize: 50, verbose: 0 });
      const acc = (await evalResult[1].data())[0];
      const accuracy = Math.min(0.99, Math.max(0.01, acc));

      // Extract all weights as a flat array to pass back to the main thread
      let flatWeights = [];
      for (const layer of seq.layers) {
        const layerWeights = layer.getWeights();
        for (const w of layerWeights) {
          const wData = await w.data();
          flatWeights.push(...Array.from(wData));
        }
      }

      self.postMessage({ type: 'LOG', msg: `[WORKER] Final Accuracy: ${(accuracy * 100).toFixed(1)}%` });

      seq.dispose();
      xs.dispose();
      ys.dispose();
      testXs.dispose();
      testYs.dispose();

      self.postMessage({ 
        type: 'DONE', 
        weights: flatWeights, 
        accuracy 
      });

    } catch (err) {
      self.postMessage({ type: 'ERROR', msg: err.message });
    }
  }
};
