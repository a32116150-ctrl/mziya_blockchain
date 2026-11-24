import { getCurrentMiningRate } from '../../core/mining.js';
import { formatMZY, showToast, ensureUnlocked, saveChain, requestPrivateKey } from './app.js';

let app;
let tickTimer = null;

export async function initMinePage(appRef) {
  app = appRef;

  const mineBtn = document.getElementById('mine-btn');
  if (!mineBtn) return;

  mineBtn.addEventListener('click', handleMineClick);

  await resumeSession();
  updatePoIBonusDisplay();
}


/** Drive the reactor visuals: progress ring (0–100), hint line and state pill. */
function setReactor(pct, hint, state) {
  const stage = document.querySelector('.orb-stage');
  if (stage) stage.style.setProperty('--p', String(Math.max(0, Math.min(100, pct))));
  const hintEl = document.getElementById('reactor-hint');
  if (hintEl && hint) hintEl.textContent = hint;
  const stateEl = document.getElementById('reactor-state');
  if (stateEl && state) stateEl.lastChild.textContent = state;
}

async function handleMineClick() {
  if (!app.wallet) {
    showToast('Create a wallet first to start mining!', '◈', 'error');
    document.querySelector('.nav-item[data-page="wallet"]')?.click();
    return;
  }

  if (!ensureUnlocked()) return;

  const mineBtn = document.getElementById('mine-btn');
  if (mineBtn) mineBtn.disabled = true;

  try {
    const session = app.miningManager.getSession(app.wallet.address);

    if (session && !session.active) {
      await claimReward();          // finished session → claim it
      if (mineBtn) mineBtn.disabled = false;
    } else if (!session) {
      await startMining();
    } else {
      await confirmActivity();
    }
  } catch (err) {
    console.warn('[Mining] Click action failed:', err);
    if (mineBtn) mineBtn.disabled = false;
  }
}

function p2pCallbacks() {
  return {
    broadcastTx: app.p2p?.isRunning ? (tx) => app.p2p.broadcastTransaction(tx) : undefined,
    broadcastBlock: app.p2p?.isRunning ? (block) => app.p2p.broadcastBlock(block) : undefined,
  };
}

async function startMining() {
  const privateKey = await requestPrivateKey('Start Mining', 'Enter your wallet password to sign the mining-session start:');
  if (!privateKey) {
    const mineBtn = document.getElementById('mine-btn');
    if (mineBtn) mineBtn.disabled = false;
    return;
  }

  const result = await app.miningManager.startSession(app.wallet.address, {
    privateKey,
    blockchain: app.blockchain,
    referrals: 0,
    ...p2pCallbacks(),
  });
  await saveChain();

  if (result.error) {
    showToast(result.error, '✕', 'error');
    const mineBtn = document.getElementById('mine-btn');
    if (mineBtn) mineBtn.disabled = false;
    return;
  }

  showMiningActive(result.session);
  startSessionTick(result.session);
  showToast(result.pending
    ? 'Session start sent — it begins once a block includes it.'
    : 'Mining session started on-chain! MZY is flowing.', '⬡', 'success');

  if (app.p2p?.isRunning) {
    await app.p2p.broadcastMiningActivity({
      address: app.wallet.address,
      sessionId: result.session.sessionId,
      timestamp: Date.now(),
      rate: result.session.rate,
    });
  }
}

async function confirmActivity() {
  const result = await app.miningManager.confirmActivity(app.wallet.address);
  if (result.error) {
    showToast(result.error, '✕', 'error');
    const mineBtn = document.getElementById('mine-btn');
    if (mineBtn) mineBtn.disabled = false;
    return;
  }
  showToast(`Activity confirmed! +${formatMZY(result.session.earned)} MZY`, '✓', 'success');
  updateSessionUI(result.session);
}

async function resumeSession() {
  if (!app.wallet) return;

  const session = await app.miningManager.loadSession(app.wallet.address, app.blockchain);
  const orb = document.getElementById('mine-btn');
  if (session && session.active) {
    showMiningActive(session);
    startSessionTick(session);
  } else if (session) {
    showReadyToClaim();
  } else {
    if (orb) orb.disabled = false;
    const orbLabel = document.getElementById('mine-btn-label');
    if (orbLabel) orbLabel.textContent = 'START';
  }
}

function showMiningActive(session) {
  const orb = document.getElementById('mine-btn');
  const orbLabel = document.getElementById('mine-btn-label');
  const sessionStats = document.getElementById('session-stats');
  const progressSection = document.getElementById('progress-section');

  orb?.classList.add('mining');
  if (orb) orb.disabled = true;
  if (orbLabel) orbLabel.textContent = 'MINING';
  if (sessionStats) sessionStats.style.display = 'grid';
  if (progressSection) progressSection.style.display = 'block';

  const rateEl = document.getElementById('stat-rate');
  if (rateEl) rateEl.textContent = session.rate.toFixed(4);

  const mpRate = document.getElementById('mp-rate');
  if (mpRate) mpRate.textContent = session.rate.toFixed(4);

  updateSessionUI(session);
}

function updateSessionUI(session) {
  const earnedEl = document.getElementById('stat-earned');
  const timerEl = document.getElementById('stat-timer');
  const fillEl = document.getElementById('progress-fill');
  const pctEl = document.getElementById('progress-pct');

  if (earnedEl) earnedEl.textContent = formatMZY(session.earned);
  if (timerEl) timerEl.textContent = session.remainingHuman;

  const pct = session.progressPercent;
  if (fillEl) fillEl.style.width = `${pct}%`;
  if (session.active) setReactor(pct, `Mining… ${session.remainingHuman} left. Rewards are claimable when the ring is full.`, 'Mining');
  if (pctEl) pctEl.textContent = `${Math.round(pct)}%`;

  const balance = app.blockchain.getBalance(app.wallet?.address || '');
  const balEl = document.getElementById('balance-display');
  if (balEl) balEl.textContent = formatMZY(balance + (session.active ? session.earned : 0));

  const usdEl = document.getElementById('balance-usd');
  if (usdEl) {
    if (app.usdPerMzy > 0) {
      usdEl.textContent = `≈ ${((balance + (session.active ? session.earned : 0)) * app.usdPerMzy).toFixed(2)} USD`;
    } else {
      usdEl.textContent = 'Price TBD';
    }
  }
}

function startSessionTick(session) {
  if (tickTimer) clearInterval(tickTimer);

  tickTimer = setInterval(() => {
    const s = app.miningManager.getSession(app.wallet?.address);
    if (!s || !s.active) {
      clearInterval(tickTimer);
      onSessionExpired(s);
      return;
    }
    s.tick();
    updateSessionUI(s);
  }, 1000);
}

function showReadyToClaim() {
  setReactor(100, 'Session complete — tap the reactor to claim your MZY.', 'Ready to claim');
  const orb = document.getElementById('mine-btn');
  const orbLabel = document.getElementById('mine-btn-label');
  orb?.classList.remove('mining');
  if (orb) orb.disabled = false;
  if (orbLabel) orbLabel.textContent = 'CLAIM';
}

function showStartState() {
  setReactor(0, 'Tap the reactor to start a 24-hour session. Come back to claim.', '24h sessions');
  const orb = document.getElementById('mine-btn');
  const orbLabel = document.getElementById('mine-btn-label');
  orb?.classList.remove('mining');
  if (orb) orb.disabled = false;
  if (orbLabel) orbLabel.textContent = 'START';
}

async function onSessionExpired(session) {
  if (!session) { showStartState(); return; }
  showReadyToClaim();
  showToast('Session complete! Tap CLAIM to collect your MZY.', '⬡', 'success');
}

async function claimReward() {
  const privateKey = await requestPrivateKey('Claim Mining Reward', 'Enter your wallet password to sign the reward claim:');
  if (!privateKey) return;

  try {
    const { broadcastTx, broadcastBlock } = p2pCallbacks();
    const result = await app.miningManager.claimReward(
      app.wallet.address,
      app.blockchain,
      broadcastTx,
      broadcastBlock,
      privateKey
    );

    if (result.error) {
      showToast(result.error, '✕', 'error');
      return;
    }
    showStartState();

    saveChain();

    const latestBlock = app.blockchain.latestBlock;
    const pois = latestBlock?.modelStates?.['mziya-sentiment-v1'];
    if (pois) {
      const display = document.getElementById('global-weights-display');
      if (display) {
        display.textContent = `[${pois.map(w => w.toFixed(4)).join(', ')}]`;
      }
    }

    const bonusStr = result.poiBonus > 0 ? ` (+${formatMZY(result.poiBonus)} AI bonus)` : '';
    const waitStr = result.included ? '' : ' — waiting for a validator to include it';
    showToast(`Reward claimed! ${formatMZY(result.amount)} MZY${bonusStr}${waitStr}`, '✓', 'success');
  } catch (e) {
    console.warn('[Mining] Claim error:', e);
    showToast('Claim failed: ' + e.message, '✕', 'error');
  }

  const balEl = document.getElementById('balance-display');
  const balance = app.blockchain.getBalance(app.wallet?.address || '');
  if (balEl) balEl.textContent = formatMZY(balance);

  updatePoIBonusDisplay();
}

function updatePoIBonusDisplay() {
  if (!app.wallet) return;
  // The bonus uses the best accuracy recorded on-chain during the open session
  const session = app.blockchain.getPendingState().getMiningSession(app.wallet.address);
  const bestAcc = session?.bestAccuracy || 0;

  const bonusPct = Math.round(bestAcc * 10 * 100) / 100;
  const el = document.getElementById('poi-bonus-pct');
  if (el) {
    if (bonusPct > 0) {
      el.textContent = `+${bonusPct.toFixed(2)}% boost active`;
      el.style.color = 'var(--green)';
    } else {
      el.textContent = '+0.00% — tap Train to earn';
      el.style.color = 'var(--text-3)';
    }
  }
}
