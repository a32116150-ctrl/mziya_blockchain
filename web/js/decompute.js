/**
 * Mziya DeCompute — UI for the decentralized ML training market.
 *
 *  • Trainers: train a model on-device, submit weights, get paid from the
 *    model's escrow once a verifier confirms the accuracy.
 *  • Verifiers (staked validators or the model provider): re-measure pending
 *    submissions and earn a fee for each one they verify.
 *  • Companies: deploy a model with an MZY escrow and withdraw what's left.
 */

import { toast, formatMZY, saveChain, requestPrivateKey } from './app.js';
import {
  createTrainingSubmit, createTrainingVerify, createModelDeploy, createModelWithdraw,
} from '../../core/transaction.js';
import { computeBenchmark, getDefaultModel } from '../../core/decompute.js';
import { DECOMPUTE, TOKENOMICS } from '../../core/tokenomics.js';
import { renderStakingPanel } from './staking.js';

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

// ── Small DOM helpers ──

/** Create an element with a class name and optional text. */
function el(tag, cls = '', text = '') {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

function icon(name) {
  const i = document.createElement('i');
  i.dataset.lucide = name;
  return i;
}

function primaryButton(label, onClick, disabled = false) {
  const b = el('button', disabled ? 'btn btn-ghost btn-sm btn-full' : 'btn btn-primary btn-sm btn-full', label);
  b.disabled = disabled;
  if (!disabled) b.addEventListener('click', onClick);
  return b;
}

function secondaryButton(label, onClick) {
  const b = el('button', 'btn btn-ghost btn-xs', label);
  b.addEventListener('click', onClick);
  return b;
}

function input(placeholder, type = 'text', value = '') {
  const i = el('input', 'form-input');
  i.placeholder = placeholder;
  i.type = type;
  i.value = value;
  return i;
}

function p2pBroadcast(tx) {
  if (app.p2p?.isRunning) app.p2p.broadcastTransaction(tx).catch(() => {});
}

/** Submit a signed tx; in local mode (no peers) also produce the block right away. */
async function submitTx(tx, privateKey) {
  const res = app.blockchain.addPendingTransaction(tx);
  if (!res.success) return res;
  p2pBroadcast(tx);
  if (!app.p2p?.isRunning || app.p2p.peerCount === 0) {
    const block = app.blockchain.forgeBlock(app.wallet.address, privateKey);
    if (block) {
      const added = app.blockchain.addBlock(block);
      if (added.success && app.p2p?.isRunning) app.p2p.broadcastBlock(block).catch(() => {});
    }
  }
  await saveChain();
  return res;
}

// ── Panel ──

let _lastRenderKey = '';

/**
 * Re-render the staking + DeCompute panels when the chain or wallet changed,
 * but never while the user is typing in one of them.
 */
export function refreshDecomputePanel() {
  if (!app?.blockchain) return;
  const active = document.activeElement;
  const typing = active && active.tagName === 'INPUT' &&
    (active.closest('#decompute-panel') || active.closest('#staking-panel'));
  if (typing) return;
  const key = `${app.wallet?.address || ''}|${app.blockchain.length}|${app.blockchain.latestBlock?.hash}`;
  if (key !== _lastRenderKey) renderDecomputePanel();
}

export function renderDecomputePanel() {
  if (app?.blockchain) {
    _lastRenderKey = `${app.wallet?.address || ''}|${app.blockchain.length}|${app.blockchain.latestBlock?.hash}`;
  }
  renderStakingPanel(app);

  const container = document.getElementById('decompute-panel');
  if (!container) return;
  if (!app.blockchain || !app.blockchain.models) return;

  const models = app.blockchain.models.getAvailable();
  const sf = app.speedFactor || 1;
  const addr = app.wallet?.address;
  const height = app.blockchain.length;

  container.textContent = '';

  const header = el('div', 'card-head');
  const title = el('div', 'card-title');
  const ico = el('span', 'ico');
  ico.appendChild(icon('cpu'));
  title.appendChild(ico);
  title.append('AI Compute Market');
  header.appendChild(title);
  const bmBtn = el('button', 'pill violet', `⚡ ${sf.toFixed(2)}× speed`);
  bmBtn.title = 'Re-run device benchmark';
  bmBtn.addEventListener('click', refreshBenchmark);
  header.appendChild(bmBtn);
  container.appendChild(header);

  container.appendChild(el('p', 'card-desc',
    'Companies lock MZY to get models trained. Train on your device, and get paid once a verifier confirms your accuracy.'));

  if (models.length === 0) {
    container.appendChild(el('p', 'empty-sub', 'No models available for training. Check back later.'));
  }

  for (const model of models) container.appendChild(renderModelCard(model, sf, addr, height));

  if (addr) {
    renderVerifyQueue(container, addr, height);
    renderMyModels(container, addr, height);
    renderDeployForm(container);
  }

  if (window.lucide) setTimeout(() => lucide.createIcons(), 50);
}

function renderModelCard(model, sf, addr, height) {
  const reg = app.blockchain.models;
  const card = el('div', 'model-card');

  const nameRow = el('div', 'model-top');
  nameRow.appendChild(el('span', 'model-name', model.modelId));
  nameRow.appendChild(el('span', model.practice ? 'badge badge-gray' : 'badge badge-green', model.practice
    ? 'Practice · PoI'
    : `${formatMZY(reg.availableEscrow(model.modelId, height), 2)} MZY`));
  card.appendChild(nameRow);

  const details = el('div', 'model-meta');
  details.appendChild(el('div', '', `Provider: ${String(model.provider).slice(0, 10)}...`));
  details.appendChild(el('div', '', `Accuracy target: ${(model.maxExpectedAccuracy * 100).toFixed(0)}%`));
  if (!model.practice) {
    details.appendChild(el('div', '', `Pays up to ${formatMZY(model.rewardPerSubmission, 4)} MZY per verified submission`));
  } else {
    details.appendChild(el('div', '', 'Training during a mining session raises your mining reward by up to +10%.'));
  }
  details.appendChild(el('div', '', `Submissions: ${model.submissionCount}`));
  card.appendChild(details);

  const lastTrain = localStorage.getItem(`mziya:lastAiTrainTime:${model.modelId}`);
  const remaining = lastTrain ? Math.max(0, 3_600_000 - (Date.now() - parseInt(lastTrain))) : 0;
  const waiting = addr && !model.practice && (reg.submissions.get(model.modelId) || [])
    .some(s => s.trainer === addr && reg.isPending(s, height));

  if (model.provider === addr) {
    card.appendChild(primaryButton('You provide this model', null, true));
  } else if (waiting) {
    card.appendChild(primaryButton('Waiting for verification…', null, true));
  } else if (remaining > 0) {
    const m = Math.ceil(remaining / 60_000);
    card.appendChild(primaryButton(`Available in ${m}m`, null, true));
  } else {
    card.appendChild(primaryButton(model.practice ? 'Train for PoI Bonus' : 'Train & Earn MZY', () => handleDecomputeTrain(model, sf)));
  }
  return card;
}

// ── Training ──

export async function handleDecomputeTrain(model, speedFactor) {
  if (!app.wallet) { toast('Create or unlock a wallet first!', 'error'); return; }
  if (app.isTrainingAI) return;

  const privateKey = await requestPrivateKey('Sign Submission', 'Enter your wallet password to sign the training submission:');
  if (!privateKey) return;

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
    log(`[DECOMPUTE] Dataset seed: ${seedHash.slice(0, 10)}...`);

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
          const accuracy = Math.round(msg.accuracy * 1e6) / 1e6;
          const tx = createTrainingSubmit({
            from: app.wallet.address,
            nonce: app.blockchain.getNextNonce(app.wallet.address),
            privateKey,
            data: { modelId: model.modelId, weights: msg.weights, accuracy, speedFactor, seedHash },
          });

          const result = await submitTx(tx, privateKey);
          if (result.success) {
            log(`[SUCCESS] Submitted. TX: ${tx.txHash}`);
            localStorage.setItem(`mziya:lastAiTrainTime:${model.modelId}`, String(Date.now()));
            if (model.practice) {
              toast(`Training recorded (${(accuracy * 100).toFixed(1)}% accuracy) — PoI mining bonus updated.`, 'success');
            } else {
              const quote = app.blockchain.models.quotePayout(model.modelId, accuracy);
              toast(`Submitted! You'll receive ${formatMZY(quote.payout, 4)} MZY once a verifier confirms your accuracy.`, 'success');
            }
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

    worker.postMessage({ action: 'TRAIN', modelConfig: model.modelConfig, seedHash });
  } catch (e) {
    log(`[ERROR] ${e.message}`);
    toast('Worker failed: ' + e.message, 'error');
    app.isTrainingAI = false;
  }
}

// ── Verification ──

function evaluateInWorker(modelConfig, weights, seedHash) {
  return new Promise((resolve, reject) => {
    const worker = new Worker('/ai-worker.js');
    worker.onmessage = (e) => {
      if (e.data.type === 'EVALUATED') { worker.terminate(); resolve(e.data.accuracy); }
      if (e.data.type === 'ERROR') { worker.terminate(); reject(new Error(e.data.msg)); }
    };
    worker.postMessage({ action: 'EVALUATE', modelConfig, weights, seedHash });
  });
}

function renderVerifyQueue(container, addr, height) {
  const reg = app.blockchain.models;
  const isValidator = app.blockchain.utxo.isValidator(addr);
  const pending = reg.getPendingSubmissions(null, height).filter(sub => {
    const model = reg.getModel(sub.modelId);
    return sub.trainer !== addr && (isValidator || model.provider === addr);
  });
  if (pending.length === 0) return;

  container.appendChild(el('div', 'sub-head', `Verify & earn · ${pending.length} waiting`));
  for (const sub of pending.slice(0, 10)) {
    const card = el('div', 'model-card');
    const top = el('div', 'model-top');
    top.appendChild(el('span', 'model-name', sub.modelId));
    top.appendChild(el('span', 'badge badge-yellow', `claims ${(sub.accuracy * 100).toFixed(1)}%`));
    card.appendChild(top);
    card.appendChild(el('div', 'model-meta',
      `Pays trainer ${formatMZY(sub.payout, 4)} MZY · you earn ${formatMZY(sub.verifierFee, 4)} MZY · expires in ${sub.blockIndex + DECOMPUTE.VERIFICATION_WINDOW_BLOCKS - height} blocks`));
    card.appendChild(primaryButton('Re-check & Verify', () => handleVerify(sub)));
    container.appendChild(card);
  }
}

async function handleVerify(sub) {
  const model = app.blockchain.models.getModel(sub.modelId);
  if (!sub.seedHash) { toast('This submission has no dataset seed, so it cannot be re-checked.', 'error'); return; }

  const privateKey = await requestPrivateKey('Verify Submission', 'Enter your wallet password to sign the verification:');
  if (!privateKey) return;

  toast('Re-evaluating the submitted weights on the test set…', 'info');
  let measured;
  try {
    measured = await evaluateInWorker(model.modelConfig, sub.weights, sub.seedHash);
  } catch (err) {
    toast('Evaluation failed: ' + err.message, 'error');
    return;
  }
  measured = Math.round(measured * 1e6) / 1e6;

  const tx = createTrainingVerify({
    from: app.wallet.address,
    nonce: app.blockchain.getNextNonce(app.wallet.address),
    privateKey,
    submissionTx: sub.txHash,
    computedAccuracy: measured,
  });
  const res = await submitTx(tx, privateKey);
  if (!res.success) { toast('Verification rejected: ' + res.error, 'error'); return; }

  const ok = Math.abs(measured - sub.accuracy) <= DECOMPUTE.ACCURACY_TOLERANCE;
  toast(ok
    ? `Verified (${(measured * 100).toFixed(1)}%). Trainer paid, you earned ${formatMZY(sub.verifierFee, 4)} MZY.`
    : `Claim was false (measured ${(measured * 100).toFixed(1)}%). No payout.`, ok ? 'success' : 'info');
  renderDecomputePanel();
}

// ── Provider: my models ──

function renderMyModels(container, addr, height) {
  const reg = app.blockchain.models;
  const mine = [...reg.models.values()].filter(m => m.provider === addr);
  if (mine.length === 0) return;

  container.appendChild(el('div', 'sub-head', 'My models'));
  for (const model of mine) {
    const card = el('div', 'model-card');
    const top = el('div', 'model-top');
    top.appendChild(el('span', 'model-name', model.modelId));
    top.appendChild(el('span', model.status === 'active' ? 'badge badge-green' : 'badge badge-gray', model.status));
    card.appendChild(top);
    const pendingCount = reg.getPendingSubmissions(model.modelId, height).length;
    card.appendChild(el('div', 'model-meta',
      `Escrow left ${formatMZY(model.remainingEscrow, 2)} MZY · paid out ${formatMZY(model.paidOut, 2)} MZY · ${pendingCount} pending`));
    if (model.status === 'active') {
      card.appendChild(secondaryButton(pendingCount ? 'Verify pending first' : 'Withdraw escrow', async () => {
        if (pendingCount) { toast('Verify or wait out pending submissions before withdrawing.', 'info'); return; }
        const privateKey = await requestPrivateKey('Withdraw Escrow', `Close ${model.modelId} and refund its remaining escrow?`);
        if (!privateKey) return;
        const tx = createModelWithdraw({ from: addr, modelId: model.modelId, nonce: app.blockchain.getNextNonce(addr), privateKey });
        const res = await submitTx(tx, privateKey);
        toast(res.success ? `Refunded ${formatMZY(model.remainingEscrow, 2)} MZY.` : 'Withdraw rejected: ' + res.error, res.success ? 'success' : 'error');
        renderDecomputePanel();
      }));
    }
    container.appendChild(card);
  }
}

// ── Provider: deploy ──

function renderDeployForm(container) {
  const details = el('details', 'deploy');
  const summary = el('summary', '', 'Deploy a model · for companies');
  details.appendChild(summary);

  const box = el('div', 'deploy-body');
  box.appendChild(el('p', 'card-desc',
    'Lock MZY in escrow. Trainers are paid from it only after their accuracy is verified. Uses the built-in 4-input classifier architecture.'));
  const idIn = input('Model ID (e.g. acme-classifier-v1)');
  const escrowIn = input('Escrow (MZY)', 'number');
  const payoutIn = input('Payout per verified submission (MZY)', 'number');
  const targetIn = input('Target accuracy (0.5 – 1.0)', 'number', '0.9');
  box.lastChild.style.marginBottom = '12px';
  [idIn, escrowIn, payoutIn, targetIn].forEach(i => box.appendChild(i));

  box.appendChild(primaryButton('Deploy & Lock Escrow', async () => {
    const modelId = idIn.value.trim();
    const amount = Math.round(parseFloat(escrowIn.value) * 1e6) / 1e6;
    const rewardPerSubmission = Math.round(parseFloat(payoutIn.value) * 1e6) / 1e6;
    const maxExpectedAccuracy = parseFloat(targetIn.value);
    if (!/^[a-z0-9][a-z0-9._-]{2,63}$/i.test(modelId)) return toast('Model ID: 3–64 letters, numbers, . _ -', 'error');
    if (!(amount > 0)) return toast('Enter an escrow amount', 'error');
    if (!(rewardPerSubmission > 0) || rewardPerSubmission > amount) return toast('Payout must be positive and no more than the escrow', 'error');
    if (!(maxExpectedAccuracy >= 0.5 && maxExpectedAccuracy <= 1)) return toast('Target accuracy must be 0.5 – 1.0', 'error');
    const balance = app.blockchain.getBalance(app.wallet.address);
    if (balance < amount + TOKENOMICS.MIN_FEE) return toast(`Insufficient balance: ${formatMZY(balance)} MZY`, 'error');

    const privateKey = await requestPrivateKey('Deploy Model', `Lock ${formatMZY(amount, 2)} MZY in escrow for ${modelId}?`);
    if (!privateKey) return;
    const tx = createModelDeploy({
      from: app.wallet.address,
      amount,
      nonce: app.blockchain.getNextNonce(app.wallet.address),
      privateKey,
      data: {
        modelId,
        modelConfig: getDefaultModel().modelConfig,
        datasetHash: 'synthetic-sum-v1',
        testSetHash: 'synthetic-sum-test-v1',
        maxExpectedAccuracy,
        rewardPerSubmission,
      },
    });
    const res = await submitTx(tx, privateKey);
    toast(res.success ? `${modelId} deployed with ${formatMZY(amount, 2)} MZY escrow.` : 'Deploy rejected: ' + res.error, res.success ? 'success' : 'error');
    renderDecomputePanel();
  }));
  details.appendChild(box);
  container.appendChild(details);
}
