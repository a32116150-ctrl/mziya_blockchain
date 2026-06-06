import { getCurrentMiningRate } from '../../core/mining.js';
import { formatMZY, showToast, ensureUnlocked, saveChain } from './app.js';

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

    if (!session || !session.active) {
      await startMining();
    } else {
      await confirmActivity();
    }
  } catch (err) {
    console.warn('[Mining] Click action failed:', err);
    if (mineBtn) mineBtn.disabled = false;
  }
}

async function startMining() {
  const result = await app.miningManager.startSession(app.wallet.address, {
    referrals: 0,
    isValidator: false,
  });

  if (result.error) {
    showToast(result.error, '✕', 'error');
    const mineBtn = document.getElementById('mine-btn');
    if (mineBtn) mineBtn.disabled = false;
    return;
  }

  showMiningActive(result.session);
  startSessionTick(result.session);
  showToast('Mining session started! MZY is flowing.', '⬡', 'success');

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

  const session = await app.miningManager.loadSession(app.wallet.address);
  const orb = document.getElementById('mine-btn');
  if (session && session.active) {
    showMiningActive(session);
    startSessionTick(session);
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

async function onSessionExpired(session) {
  const orb = document.getElementById('mine-btn');
  const orbLabel = document.getElementById('mine-btn-label');

  orb?.classList.remove('mining');
  if (orb) orb.disabled = false;
  if (orbLabel) orbLabel.textContent = 'START';

  showToast('Session complete! Processing reward...', '⬡', 'success');

  if (app.wallet && session) {
    await claimReward();
  }
}

async function claimReward() {
  try {
    const broadcastTx = app.p2p?.isRunning ? (tx) => app.p2p.broadcastTransaction(tx) : undefined;
    const broadcastBlock = app.p2p?.isRunning ? (block) => app.p2p.broadcastBlock(block) : undefined;

    const result = await app.miningManager.claimReward(
      app.wallet.address,
      app.blockchain,
      broadcastTx,
      broadcastBlock
    );

    if (result.error) {
      showToast(result.error, '✕', 'error');
      return;
    }

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
    showToast(`Reward claimed! ${formatMZY(result.amount)} MZY${bonusStr}`, '✓', 'success');
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
  const addr = app.wallet.address;
  let bestAcc = 0;

  const session = app.miningManager.getSession(addr);
  const cutoffTime = session ? session.startTime : (Date.now() - 24 * 60 * 60 * 1000);

  if (app.blockchain?.chain) {
    for (const block of app.blockchain.chain) {
      if (block.timestamp >= cutoffTime) {
        for (const tx of block.transactions) {
          if (tx.type === 'AI_SUBMISSION' && tx.from === addr && tx.data?.accuracy) {
            if (tx.data.accuracy > bestAcc) bestAcc = tx.data.accuracy;
          }
        }
      }
    }
  }

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
