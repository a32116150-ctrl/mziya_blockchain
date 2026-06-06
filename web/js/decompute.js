/**
 * Mziya DeCompute — UI for decentralized ML training market.
 * Companies deploy models, users train on-device, earn MZY proportional to compute.
 */

import { toast, formatMZY, saveChain, ensureUnlocked, promptModal } from './app.js';
import { TX_TYPE } from '../../core/transaction.js';
import { computeBenchmark } from '../../core/decompute.js';

let app;

export async function initDecompute(appRef) {
  app = appRef;
  ensureBenchmark();
  renderDecomputePanel();
}

function ensureBenchmark() {
  let bm = localStorage.getItem('mziya:speedFactor');
  if (!bm) {
    bm = String(computeBenchmark());
    localStorage.setItem('mziya:speedFactor', bm);
  }
  app.speedFactor = parseFloat(bm);
}

export function refreshBenchmark() {
  localStorage.removeItem('mziya:speedFactor');
  ensureBenchmark();
  renderDecomputePanel();
}

export function renderDecomputePanel() {
  const container = document.getElementById('decompute-panel');
  if (!container) return;
  if (!app.blockchain || !app.blockchain.models) return;

  const models = app.blockchain.models.getAvailable();
  const sf = app.speedFactor || 1;
  const addr = app.wallet?.address;

  container.textContent = '';

  const header = document.createElement('div');
  header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:12px';

  const title = document.createElement('span');
  title.style.cssText = 'font-size:13px;font-weight:700;color:var(--text-1);display:flex;align-items:center;gap:6px';

  const icon = document.createElement('i');
  icon.dataset.lucide = 'cpu';
  icon.style.cssText = 'width:16px;height:16px';
  title.appendChild(icon);
  title.append(' DeCompute — Train for MZY');

  header.appendChild(title);

  const bmBtn = document.createElement('button');
  bmBtn.textContent = 'Benchmark';
  bmBtn.style.cssText = 'font-size:10px;color:var(--yellow);background:var(--yellow-dim);border:1px solid rgba(240,185,11,0.3);border-radius:4px;padding:2px 8px;cursor:pointer';
  bmBtn.addEventListener('click', refreshBenchmark);
  header.appendChild(bmBtn);

  container.appendChild(header);

  const sfLine = document.createElement('div');
  sfLine.style.cssText = 'font-size:11px;color:var(--text-2);margin-bottom:12px';
  sfLine.textContent = `Your device speedFactor: ${sf.toFixed(2)}`;
  container.appendChild(sfLine);

  if (models.length === 0) {
    const empty = document.createElement('p');
    empty.style.cssText = 'font-size:12px;color:var(--text-3);padding:16px 0;text-align:center';
    empty.textContent = 'No models available for training. Check back later.';
    container.appendChild(empty);
    return;
  }

  for (const model of models) {
    const card = document.createElement('div');
    card.style.cssText = 'background:var(--surface-3);border:1px solid var(--border);border-radius:8px;padding:12px;margin-bottom:10px';

    const nameRow = document.createElement('div');
    nameRow.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:6px';

    const name = document.createElement('span');
    name.style.cssText = 'font-size:13px;font-weight:700;color:var(--gold);font-family:monospace';
    name.textContent = model.modelId;
    nameRow.appendChild(name);

    const escrow = document.createElement('span');
    escrow.style.cssText = 'font-size:11px;color:var(--text-2)';
    escrow.textContent = `${formatMZY(model.remainingEscrow, 0)} MZY remaining`;
    nameRow.appendChild(escrow);
    card.appendChild(nameRow);

    const details = document.createElement('div');
    details.style.cssText = 'font-size:11px;color:var(--text-2);line-height:1.6;margin-bottom:10px';
    const providerLine = document.createElement('div');
    providerLine.textContent = `Provider: ${String(model.provider).slice(0, 10)}...`;
    details.appendChild(providerLine);
    const accLine = document.createElement('div');
    accLine.textContent = `Accuracy target: ${(model.maxExpectedAccuracy * 100).toFixed(0)}%`;
    details.appendChild(accLine);
    const subLine = document.createElement('div');
    subLine.textContent = `Submissions: ${model.submissionCount}`;
    details.appendChild(subLine);
    card.appendChild(details);

    const trainBtn = document.createElement('button');
    const lastTrain = localStorage.getItem('mziya:lastAiTrainTime');
    const remaining = lastTrain ? Math.max(0, 86400000 - (Date.now() - parseInt(lastTrain))) : 0;

    if (remaining > 0) {
      const h = Math.floor(remaining / 3600000);
      const m = Math.floor((remaining % 3600000) / 60000);
      trainBtn.disabled = true;
      trainBtn.textContent = `Available in ${h}h ${m}m`;
      trainBtn.style.cssText = 'width:100%;padding:10px;border-radius:6px;font-size:12px;font-weight:700;background:var(--surface-2);color:var(--text-3);border:1px solid var(--border);cursor:not-allowed';
    } else {
      trainBtn.textContent = 'Train & Earn MZY';
      trainBtn.style.cssText = 'width:100%;padding:10px;border-radius:6px;font-size:12px;font-weight:700;background:var(--gold);color:#000;border:none;cursor:pointer;transition:opacity .2s';
      trainBtn.addEventListener('mouseenter', () => trainBtn.style.opacity = '0.85');
      trainBtn.addEventListener('mouseleave', () => trainBtn.style.opacity = '1');
      trainBtn.addEventListener('click', () => handleDecomputeTrain(model, sf));
    }

    card.appendChild(trainBtn);
    container.appendChild(card);
  }

  if (window.lucide) setTimeout(() => lucide.createIcons(), 50);
}

export async function handleDecomputeTrain(model, speedFactor) {
  if (!app.wallet) { toast('Create or unlock a wallet first!', 'error'); return; }
  if (app.wallet.isWatchOnly) { toast('Cannot train from a watch-only account!', 'error'); return; }
  if (!ensureUnlocked()) return;
  if (app.isTrainingAI) return;

  const pw = await promptModal({
    title: 'Sign Submission',
    sub: 'Enter your wallet password to sign the training submission:',
    label: 'Password',
    placeholder: 'Wallet password',
    isPassword: true
  });
  if (!pw) return;

  let privateKey;
  try {
    const { decryptPrivateKey } = await import('../../core/wallet.js');
    privateKey = await decryptPrivateKey(app.wallet.privateKeyEncrypted, pw);
  } catch {
    toast('Invalid wallet password!', 'error');
    return;
  }

  app.isTrainingAI = true;
  const logsEl = document.getElementById('ai-logs');
  const logs = [];
  function log(msg) {
    logs.push(msg);
    if (logsEl) {
      logsEl.textContent = logs.join('\n');
      logsEl.scrollTop = logsEl.scrollHeight;
    }
  }

  try {
    const seedHash = app.blockchain.latestBlock?.hash || 'GENESIS';
    log(`[DECOMPUTE] Spawning WebWorker for training...`);
    log(`[DECOMPUTE] Dataset seed: ${seedHash.slice(0,10)}...`);

    const worker = new Worker('/ai-worker.js');
    
    worker.onmessage = async (e) => {
      const msg = e.data;
      if (msg.type === 'LOG') {
        log(msg.msg);
      } else if (msg.type === 'ERROR') {
        log(`[ERROR] ${msg.msg}`);
        toast('Training failed: ' + msg.msg, 'error');
        app.isTrainingAI = false;
        worker.terminate();
      } else if (msg.type === 'DONE') {
        log(`[DECOMPUTE] Received optimized weights from worker.`);
        
        try {
          const { Transaction } = await import('../../core/transaction.js');
          const tx = new Transaction({
            from: app.wallet.address,
            to: model.modelId,
            amount: 0,
            type: TX_TYPE.TRAINING_SUBMIT,
            nonce: app.blockchain.utxo.getNonce(app.wallet.address) + 1,
            data: {
              modelId: model.modelId,
              weights: msg.weights,
              accuracy: msg.accuracy,
              speedFactor,
            },
          });
          tx.sign(privateKey);

          const result = app.blockchain.addPendingTransaction(tx);
          if (result.success) {
            log(`[SUCCESS] Submitted to mempool. TX: ${tx.txHash}`);
            if (app.p2p?.isRunning) await app.p2p.broadcastTransaction(tx);
            localStorage.setItem('mziya:lastAiTrainTime', String(Date.now()));
            await saveChain();
            toast(`Training verified & submitted! You earned MZY proportional to ${(speedFactor * msg.accuracy).toFixed(2)} compute score.`, 'success');
            renderDecomputePanel();
          } else {
            log(`[ERROR] Network rejected weights: ${result.error}`);
            toast('Submission rejected: ' + result.error, 'error');
          }
        } catch (err) {
          log(`[ERROR] ${err.message}`);
        }
        app.isTrainingAI = false;
        worker.terminate();
      }
    };

    worker.postMessage({
      action: 'TRAIN',
      modelConfig: model.modelConfig,
      seedHash
    });

  } catch (e) {
    log(`[ERROR] ${e.message}`);
    toast('Worker failed: ' + e.message, 'error');
    app.isTrainingAI = false;
  }
}
