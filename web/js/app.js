import { Blockchain } from '../../core/blockchain.js';
import { MiningManager, getCurrentMiningRate } from '../../core/mining.js';
import { isValidAddress } from '../../core/wallet.js';
import { initWalletPage } from './wallet.js';
import { initMinePage } from './mining.js';
import { initSendPage } from './send.js';
import { initExplorerPage } from './explorer.js';
import { initDecompute, handleDecomputeTrain, refreshDecomputePanel } from './decompute.js';

// Estimated market price (informational only — not a live oracle)
// Update this based on real exchange data or set via env var
const USD_PER_MZY = parseFloat(localStorage.getItem('mziya:usdPerMzy') || '0.00');

window.MziyaApp = {
  blockchain: null,
  miningManager: null,
  p2p: null,
  wallet: null,
  currentPage: 'mine',
  locked: false,
  ticker: null,
  isTrainingAI: false,
  lastAISubmission: null,
  _poiRefreshTimer: null,
  usdPerMzy: USD_PER_MZY,
  // NOTE: App.mempool removed — always use App.blockchain.mempool directly
};

const App = window.MziyaApp;

async function init() {
  App.blockchain = new Blockchain().initialize();
  App.miningManager = new MiningManager(new IDBStorage('mziya-mining'));

  await loadChainFromStorage();
  await loadWallet();

  await initMinePage(App);
  await initWalletPage(App);
  await initSendPage(App);
  await initExplorerPage(App);
  await initDecompute(App);

  setupNavigation();
  startBackgroundCanvas();
  connectP2P();

  bindLockEvents();
  bindCopilotEvents();
  bindTrainAIEvent();
  bindSettingsEvents();
  bindSendMaxEvent();

  setInterval(refreshUI, 5000);

  if ('serviceWorker' in navigator) {
    // SEC-09: Use correct path relative to server root
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      console.warn('[SW] Registration failed:', err.message);
    });
  }
  if (window.lucide) lucide.createIcons();

  updateAppWalletMode();
  updateGlobalWeightsDisplay();

  console.log('[Mziya] App initialized');
}

async function loadWallet() {
  const stored = localStorage.getItem('mziya:wallet');
  if (stored) {
    try {
      App.wallet = JSON.parse(stored);
      if (localStorage.getItem('mziya:locked') === 'true') {
        App.locked = true;
        showLockScreen(true);
      }
    } catch (err) {
      console.warn('[Mziya] Wallet parse failed:', err.message);
    }
  }
}

export function saveWallet(walletData) {
  App.wallet = walletData;
  localStorage.setItem('mziya:wallet', JSON.stringify(walletData));
  updateAppWalletMode();
}

export function clearWallet() {
  App.wallet = null;
  App.locked = false;
  localStorage.removeItem('mziya:wallet');
  localStorage.removeItem('mziya:locked');
  updateAppWalletMode();
}

function updateAppWalletMode() {
  const appEl = document.getElementById('app');
  const lockBtn = document.getElementById('btn-lock');
  if (!App.wallet) {
    appEl?.classList.add('no-wallet-mode');
    if (lockBtn) lockBtn.style.display = 'none';
    navigateTo('wallet');
  } else {
    appEl?.classList.remove('no-wallet-mode');
    if (lockBtn && !App.locked) lockBtn.style.display = 'block';
  }
  renderWalletPage();
  renderSettings();
}

let _chainStorage = null;
function getChainStorage() {
  if (!_chainStorage) _chainStorage = new IDBStorage('mziya-chain');
  return _chainStorage;
}

async function loadChainFromStorage() {
  try {
    const stored = await getChainStorage().get('chain');
    if (stored) {
      const chainData = JSON.parse(stored);
      if (chainData && chainData.length > 1) {
        App.blockchain.consensusEngine?.stop();
        App.blockchain = Blockchain.fromJSON(chainData).initialize();
      }
    }
  } catch (err) {
    console.warn('[Mziya] Chain load failed:', err.message);
    if (/Stored chain is invalid/.test(err.message)) {
      // Saved by an older, incompatible protocol version — start fresh.
      try { await getChainStorage().delete('chain'); } catch { /* ignore */ }
      setTimeout(() => toast('Network upgraded — your local chain copy was reset.', 'info'), 1500);
    }
  }
}

export async function saveChain() {
  // PERF-03: Save only the latest block incrementally + metadata
  try {
    const storage = getChainStorage();
    const latest = App.blockchain.latestBlock;
    if (latest) {
      await storage.set(`block:${latest.index}`, JSON.stringify(latest.toJSON ? latest.toJSON() : latest));
      await storage.set('chain:meta', JSON.stringify({
        height: App.blockchain.length,
        latestHash: latest.hash,
      }));
    }
    // Also save full chain periodically (every 10 blocks) for recovery
    if (App.blockchain.length % 10 === 0) {
      await storage.set('chain', JSON.stringify(App.blockchain.toJSON()));
    }
  } catch (err) {
    console.warn('[Mziya] Chain save failed:', err.message);
  }
}

// ── P2P Connection ──

async function connectP2P() {
  const peerEl = document.getElementById('peer-count');
  if (peerEl) peerEl.textContent = 'Discovering...';

  let discoveryAttempts = 0;
  const maxDiscoveryAttempts = 3;

  function showDiscoveryStatus() {
    if (!App.p2p || App.p2p.peerCount === 0) {
      if (peerEl) peerEl.textContent = 'No peers on LAN — set BOOTSTRAP_PEERS for WAN';
    }
  }

  const discoveryTimeout = setTimeout(showDiscoveryStatus, 20_000);

  try {
    const { MziyaP2P } = await import('../../network/peer.js');
    App.p2p = new MziyaP2P(App.blockchain, App.blockchain.mempool);

    App.p2p.onPeerConnect = (peerId) => {
      clearTimeout(discoveryTimeout);
      discoveryAttempts = 0;
      updatePeerCount();
      toast(`Connected to peer ${peerId.slice(0, 12)}...`, 'info');
    };
    App.p2p.onPeerDisconnect = () => updatePeerCount();
    App.p2p.onBlock = () => {
      updateExplorerStats();
      saveChain();
      updateGlobalWeightsDisplay();
    };
    App.p2p.onTransaction = (tx) => {
      toast(`New transaction: ${tx.amount} MZY`, 'success');
    };

    const info = await App.p2p.start();
    console.log('[P2P] Started:', info.peerId.slice(0, 16));
    updatePeerCount();
    await App.p2p.requestChainSync();
  } catch (err) {
    clearTimeout(discoveryTimeout);
    console.warn('[P2P] Not available, running in local mode:', err.message);
    if (peerEl) peerEl.textContent = 'Local mode';
    updatePeerCount(0);
  }
}

function updatePeerCount(count = null) {
  const peers = count ?? App.p2p?.peerCount ?? 0;
  const el = (id) => document.getElementById(id);
  if (el('peer-count')) {
    el('peer-count').textContent = peers > 0 ? `${peers} peer${peers !== 1 ? 's' : ''}` : 'Local mode';
  }
  if (el('net-dot')) el('net-dot').className = 'dot' + (peers > 0 ? ' on' : '');
  if (el('net-peers')) el('net-peers').textContent = peers;
}

function updateExplorerStats() {
  const stats = App.blockchain.getStats();
  const el = (id) => document.getElementById(id);
  if (el('net-height')) el('net-height').textContent = stats.height;
  if (el('net-supply')) el('net-supply').textContent = formatMZY(stats.circulatingSupply, 0);
  if (el('ex-height')) el('ex-height').textContent = stats.height;
  if (el('ex-txs')) el('ex-txs').textContent = stats.totalTransactions;
  if (el('ex-supply')) el('ex-supply').textContent = formatMZY(stats.circulatingSupply, 2);
}

function refreshUI() {
  updatePeerCount();
  updateExplorerStats();
  refreshDecomputePanel();
  if (App.wallet) {
    const balance = App.blockchain.getBalance(App.wallet.address);
    const balEl = document.getElementById('balance-display');
    const wbalEl = document.getElementById('wallet-balance');
    if (balEl) balEl.textContent = formatMZY(balance);
    if (wbalEl) wbalEl.textContent = formatMZY(balance);
    const usdEl = document.getElementById('balance-usd');
    if (usdEl) {
      if (App.usdPerMzy > 0) {
        usdEl.textContent = `≈ ${(balance * App.usdPerMzy).toFixed(2)} USD`;
      } else {
        usdEl.textContent = '≈ TBD';
      }
    }
  }
}

// ── Navigation ──

function setupNavigation() {
  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', () => {
      const page = item.dataset.page;
      navigateTo(page);
    });
  });
  document.getElementById('btn-nav-send')?.addEventListener('click', () => navigateTo('send'));
  document.getElementById('btn-send-nav-wallet')?.addEventListener('click', () => navigateTo('wallet'));
  document.getElementById('btn-close-add-account')?.addEventListener('click', () => navigateTo('mine'));
  document.getElementById('btn-close-no-wallet')?.addEventListener('click', () => toast('Please add an account to continue!', 'warning'));
}

export function navigateTo(page) {
  document.querySelectorAll('.page, .nav-item').forEach(el => el.classList.remove('active'));
  document.getElementById(`page-${page}`)?.classList.add('active');
  document.querySelector(`.nav-item[data-page="${page}"]`)?.classList.add('active');
  App.currentPage = page;

  if (page === 'wallet') renderWalletPage();
  if (page === 'explorer') {
    // trigger re-render on every navigation to explorer
    const exEvent = new CustomEvent('mziya:explorer-navigate');
    document.dispatchEvent(exEvent);
  }
  if (page === 'send') renderSendPage();
  if (page === 'settings') renderSettings();
  if (window.lucide) setTimeout(() => lucide.createIcons(), 50);
}

// ── Wallet Lock / Unlock ──

export function showLockScreen(show) {
  const m = document.getElementById('modal-lock');
  if (!m) return;
  if (show) {
    m.style.display = 'flex';
    const pwInput = document.getElementById('lock-password-input');
    if (pwInput) pwInput.value = '';
    const errEl = document.getElementById('lock-error');
    if (errEl) errEl.style.display = 'none';
    const pkErrEl = document.getElementById('lock-passkey-error');
    if (pkErrEl) pkErrEl.style.display = 'none';

    document.getElementById('lock-password-wrapper').style.display = 'none';
    document.getElementById('lock-passkey-wrapper').style.display = 'none';
    document.getElementById('lock-watch-wrapper').style.display = 'none';

    if (App.wallet?.isWatchOnly) {
      document.getElementById('lock-watch-wrapper').style.display = 'flex';
    } else if (App.wallet?.isPasskey) {
      document.getElementById('lock-passkey-wrapper').style.display = 'flex';
      setTimeout(() => unlockPasskey(), 300);
    } else {
      document.getElementById('lock-password-wrapper').style.display = 'flex';
    }

    document.getElementById('bottom-nav').style.display = 'none';
    const lockBtn = document.getElementById('btn-lock');
    if (lockBtn) lockBtn.style.display = 'none';
    const notifBtn = document.getElementById('btn-notif');
    if (notifBtn) notifBtn.style.display = 'none';
  } else {
    m.style.display = 'none';
    document.getElementById('bottom-nav').style.display = 'flex';
    const lockBtn = document.getElementById('btn-lock');
    if (lockBtn) lockBtn.style.display = App.wallet ? 'block' : 'none';
    const notifBtn = document.getElementById('btn-notif');
    if (notifBtn) notifBtn.style.display = 'block';
  }
  if (window.lucide) lucide.createIcons();
}

export function lockWallet() {
  if (!App.wallet) return;
  App.locked = true;
  localStorage.setItem('mziya:locked', 'true');
  showLockScreen(true);
}

// SEC-06: Rate limit unlock attempts
let _unlockAttempts = 0;
let _unlockLockoutUntil = 0;

export async function unlockWallet() {
  const now = Date.now();
  if (now < _unlockLockoutUntil) {
    const remainSec = Math.ceil((_unlockLockoutUntil - now) / 1000);
    const err = document.getElementById('lock-error');
    if (err) { err.textContent = `Too many attempts. Try again in ${remainSec}s`; err.style.display = 'block'; }
    return;
  }
  const pw = document.getElementById('lock-password-input')?.value;
  const err = document.getElementById('lock-error');
  if (!pw) { if (err) { err.textContent = 'Please enter your password'; err.style.display = 'block'; } return; }
  const btn = document.getElementById('btn-confirm-unlock');
  if (btn) { btn.disabled = true; btn.textContent = 'Decrypting...'; }
  try {
    const { decryptPrivateKey } = await import('../../core/wallet.js');
    await decryptPrivateKey(App.wallet.privateKeyEncrypted, pw);
    App.locked = false;
    _unlockAttempts = 0;
    localStorage.removeItem('mziya:locked');
    showLockScreen(false);
    toast('Wallet unlocked!', 'success');
  } catch (e) {
    _unlockAttempts++;
    if (_unlockAttempts >= 3) {
      // Exponential backoff: 30s, 60s, 120s, ...
      const lockoutMs = 30_000 * Math.pow(2, _unlockAttempts - 3);
      _unlockLockoutUntil = Date.now() + Math.min(lockoutMs, 300_000);
      const secs = Math.ceil(Math.min(lockoutMs, 300_000) / 1000);
      if (err) { err.textContent = `Too many failed attempts. Locked for ${secs}s`; err.style.display = 'block'; }
    } else {
      if (err) { err.textContent = 'Incorrect password — try again'; err.style.display = 'block'; }
    }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Unlock Wallet'; }
  }
}

export async function unlockPasskey() {
  const err = document.getElementById('lock-passkey-error');
  if (err) err.style.display = 'none';
  try {
    const challenge = crypto.getRandomValues(new Uint8Array(16));
    const assertion = await navigator.credentials.get({
      publicKey: { challenge, timeout: 15000, userVerification: 'required' }
    });
    if (!assertion) throw new Error('Biometric verification cancelled.');
    App.locked = false;
    localStorage.removeItem('mziya:locked');
    showLockScreen(false);
    toast('Wallet unlocked!', 'success');
  } catch (e) {
    console.warn('Biometric unlock failed:', e);
    if (err) { err.textContent = e.message || 'Biometric authentication failed.'; err.style.display = 'block'; }
  }
}

export async function unlockWatch() {
  const addr = App.wallet?.address || '';
  const answer = await promptModal({
    title: 'Confirm Control',
    sub: `Confirm you control this address:\n${addr.slice(0, 10)}...${addr.slice(-4)}`,
    label: 'Type "YES" to unlock',
    placeholder: 'YES',
    isPassword: false,
    requiredText: 'YES'
  });
  if (!answer) {
    toast('Watch-only unlock cancelled', 'info');
    return;
  }
  App.locked = false;
  localStorage.removeItem('mziya:locked');
  showLockScreen(false);
  toast('Watch-Only unlocked', 'success');
}

export function logoutWallet() {
  if (confirm('Sign out and clear wallet from this device?\n\nMake sure you have backed up your recovery phrase!')) {
    clearWallet();
    showLockScreen(false);
    closeModals();
    toast('Logged out successfully', 'info');
  }
}

function bindLockEvents() {
  document.getElementById('btn-lock')?.addEventListener('click', lockWallet);
  document.getElementById('btn-confirm-unlock')?.addEventListener('click', unlockWallet);
  document.getElementById('lock-password-input')?.addEventListener('keypress', (e) => { if (e.key === 'Enter') unlockWallet(); });
  document.getElementById('btn-passkey-unlock')?.addEventListener('click', unlockPasskey);
  document.getElementById('btn-watch-unlock')?.addEventListener('click', unlockWatch);
  document.getElementById('btn-lock-logout')?.addEventListener('click', logoutWallet);
}

/**
 * Ask for the wallet password and return the decrypted private key, or null.
 * The key only lives in memory for the signing call that needs it.
 */
export async function requestPrivateKey(title = 'Sign Transaction', sub = 'Enter your wallet password to sign:') {
  if (!App.wallet) { toast('Create or unlock a wallet first!', 'error'); return null; }
  if (App.wallet.isWatchOnly) { toast('Watch-only accounts cannot sign transactions', 'error'); return null; }
  if (!ensureUnlocked()) return null;
  const pw = await promptModal({ title, sub, label: 'Password', placeholder: 'Wallet password', isPassword: true });
  if (!pw) return null;
  try {
    const { decryptPrivateKey } = await import('../../core/wallet.js');
    return await decryptPrivateKey(App.wallet.privateKeyEncrypted, pw);
  } catch {
    toast('Wrong password', 'error');
    return null;
  }
}

export function ensureUnlocked() {
  if (App.locked) {
    showLockScreen(true);
    return false;
  }
  return true;
}

// ── Wallet Page Rendering ──

function renderWalletPage() {
  const nw = document.getElementById('no-wallet');
  const wv = document.getElementById('wallet-view');
  if (!App.wallet) {
    if (nw) nw.style.display = 'flex';
    if (wv) wv.style.display = 'none';
    return;
  }
  if (nw) nw.style.display = 'none';
  if (wv) wv.style.display = 'block';

  const addrEl = document.getElementById('wallet-address');
  if (addrEl) {
    addrEl.textContent = '';
    const span = document.createElement('span');
    span.textContent = truncate(App.wallet.address, 10, 8);
    addrEl.appendChild(span);
    if (App.wallet.isWatchOnly) {
      const badge = document.createElement('span');
      badge.className = 'badge badge-yellow';
      badge.style.cssText = 'font-size:10px;vertical-align:middle;margin-left:6px;padding:2px 6px';
      badge.textContent = 'Watch-Only';
      addrEl.appendChild(badge);
    } else if (App.wallet.isPasskey) {
      const badge = document.createElement('span');
      badge.className = 'badge badge-green';
      badge.style.cssText = 'font-size:10px;vertical-align:middle;margin-left:6px;padding:2px 6px;display:inline-flex;align-items:center;gap:3px';
      const iEl = document.createElement('i');
      iEl.dataset.lucide = 'fingerprint';
      iEl.style.cssText = 'width:10px;height:10px;stroke-width:2.5px';
      badge.appendChild(iEl);
      const txt = document.createElement('span');
      txt.textContent = 'Passkey';
      badge.appendChild(txt);
      addrEl.appendChild(badge);
    }
  }

  const backupBtn = document.getElementById('btn-show-mnemonic');
  if (backupBtn) {
    if (App.wallet.isWatchOnly || App.wallet.isPasskey || !App.wallet.mnemonicEncrypted) backupBtn.style.display = 'none';
    else backupBtn.style.display = 'flex';
  }

  const balance = App.blockchain.getBalance(App.wallet.address);
  const balEl = document.getElementById('wallet-balance');
  if (balEl) balEl.textContent = formatMZY(balance);

  renderTxHistory();
  if (window.lucide) setTimeout(() => lucide.createIcons(), 50);
}

function renderTxHistory() {
  const c = document.getElementById('tx-history');
  if (!c || !App.wallet) return;
  const addr = App.wallet.address;
  const hist = [];
  for (const b of [...App.blockchain.chain].reverse()) {
    for (const tx of (b.transactions || [])) {
      if (tx.from === addr || tx.to === addr) hist.push({ ...tx, blockIndex: b.index });
    }
  }
  c.textContent = '';
  if (!hist.length) {
    const empty = document.createElement('div');
    empty.style.cssText = 'padding:32px 16px';
    empty.className = 'empty-state';
    const p = document.createElement('p');
    p.className = 'empty-sub';
    p.textContent = 'No transactions yet. Start mining to earn MZY!';
    empty.appendChild(p);
    c.appendChild(empty);
    return;
  }
  const wrap = document.createElement('div');
  wrap.style.cssText = 'background:var(--surface);border-top:1px solid var(--border);border-bottom:1px solid var(--border)';
  const shown = hist.slice(0, 20);
  for (let i = 0; i < shown.length; i++) {
    const tx = shown[i];
    const mine = tx.type === 'MINING';
    const special = {
      MINING_START: ['Mining Started', 'Network'],
      STAKE: ['Staked', 'Staking'],
      UNSTAKE: ['Unstaked', 'Staking'],
      MODEL_DEPLOY: ['Model Escrow', 'DeCompute'],
      MODEL_WITHDRAW: ['Escrow Refund', 'DeCompute'],
      TRAINING_SUBMIT: ['Training Submitted', 'DeCompute'],
      TRAINING_VERIFY: ['Verified Training', 'DeCompute'],
      AI_SUBMISSION: ['AI Submission', 'Network'],
    }[tx.type];
    const isIn = (tx.to === addr && tx.from !== addr && !mine) || tx.type === 'UNSTAKE';
    const cls = mine ? 'mine' : isIn ? 'in' : 'out';
    const label = mine ? 'Mining Reward' : special ? special[0] : isIn ? 'Received' : 'Sent';
    const sign = (mine || isIn) ? '+' : (tx.amount ? '-' : '');
    const other = mine ? 'Network' : special ? special[1] : isIn ? (tx.from || 'Network') : tx.to;

    const item = document.createElement('div');
    item.className = 'tx-item';

    const icon = document.createElement('div');
    icon.className = 'tx-icon ' + cls;
    const iEl = document.createElement('i');
    iEl.dataset.lucide = mine ? 'zap' : isIn ? 'arrow-down-left' : 'arrow-up-right';
    icon.appendChild(iEl);
    item.appendChild(icon);

    const info = document.createElement('div');
    info.className = 'tx-info';
    const typeDiv = document.createElement('div');
    typeDiv.className = 'tx-type';
    typeDiv.textContent = label;
    info.appendChild(typeDiv);
    const addrDiv = document.createElement('div');
    addrDiv.className = 'tx-addr';
    addrDiv.textContent = truncate(other, 10, 6);
    info.appendChild(addrDiv);
    item.appendChild(info);

    const right = document.createElement('div');
    right.className = 'tx-right';
    const amtDiv = document.createElement('div');
    amtDiv.className = 'tx-amount ' + cls;
    amtDiv.textContent = sign + formatMZY(tx.amount);
    right.appendChild(amtDiv);
    const timeDiv = document.createElement('div');
    timeDiv.className = 'tx-time';
    timeDiv.textContent = tx.timestamp ? formatTime(tx.timestamp) : 'MZY';
    right.appendChild(timeDiv);
    item.appendChild(right);

    wrap.appendChild(item);

    if (i < shown.length - 1) {
      const div = document.createElement('div');
      div.className = 'divider-full';
      wrap.appendChild(div);
    }
  }
  c.appendChild(wrap);
  if (window.lucide) setTimeout(() => lucide.createIcons(), 100);
}

function renderSendPage() {
  const sn = document.getElementById('send-no-wallet');
  const sf = document.getElementById('send-form');
  if (!App.wallet) {
    if (sn) sn.style.display = 'flex';
    if (sf) sf.style.display = 'none';
    return;
  }
  if (sn) sn.style.display = 'none';
  if (sf) sf.style.display = 'flex';
  const avail = App.blockchain.getBalance(App.wallet.address);
  const availEl = document.getElementById('send-available');
  if (availEl) availEl.textContent = formatMZY(avail);
}

function renderSettings() {
  const addr = App.wallet?.address;
  const nameEl = document.getElementById('profile-name');
  const addrEl = document.getElementById('profile-addr');
  if (nameEl) {
    if (addr) {
      if (App.wallet?.isWatchOnly) nameEl.textContent = 'Watch-Only Account';
      else if (App.wallet?.isPasskey) nameEl.textContent = 'Passkey Secured';
      else nameEl.textContent = 'Mziya Miner';
    } else {
      nameEl.textContent = 'No Wallet';
    }
  }
  if (addrEl) addrEl.textContent = addr ? truncate(addr, 12, 8) : 'Create a wallet to get started';
  // CORR-05: Use Array.from on Map values (Object.values doesn't work on Maps)
  const supply = Array.from(App.blockchain.utxo.balances.values()).reduce((s, v) => s + Math.max(0, v), 0);
  const peers = App.p2p?.peerCount ?? 0;
  const netSub = document.getElementById('si-net-sub');
  if (netSub) netSub.textContent = peers > 0 ? `Connected to ${peers} peers` : 'Running in local mode';
  const peersBadge = document.getElementById('si-peers-badge');
  if (peersBadge) peersBadge.textContent = `${peers} peers`;
  const chainSub = document.getElementById('si-chain-sub');
  if (chainSub) chainSub.textContent = `Block #${App.blockchain.length} · ${formatMZY(supply, 0)} MZY mined`;
  const rateEl = document.getElementById('si-rate');
  if (rateEl) rateEl.textContent = getCurrentMiningRate().toFixed(4) + ' MZY/h';
  const lockSection = document.getElementById('settings-lock-section');
  if (lockSection) lockSection.style.display = addr ? 'block' : 'none';
}

// ── PoI Bonus Display ──

function updatePoIBonusDisplay() {
  if (!App.wallet) return;
  // PoI bonus comes from the best accuracy recorded on-chain during the open session
  const session = App.blockchain.getPendingState?.().getMiningSession(App.wallet.address);
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

// ── AI DePIN: Global Weights Display ──

function updateGlobalWeightsDisplay() {
  const lastBlock = App.blockchain.latestBlock;
  const weights = lastBlock?.modelStates?.['mziya-sentiment-v1'] || [0.0000, 0.0000, 0.0000, 0.0000];
  const display = document.getElementById('global-weights-display');
  if (display) {
    display.textContent = `[${weights.map(w => w.toFixed(4)).join(', ')}]`;
  }
  updatePoIBonusDisplay();
}

// ── AI Training (TensorFlow.js) ──
// Strictly optional. Base mining works without any AI code.
// Limited to once per day per device.

const AI_TRAIN_COOLDOWN_MS = 24 * 60 * 60 * 1000;

function getLastAiTrainTime() {
  const val = localStorage.getItem('mziya:lastAiTrainTime');
  return val ? parseInt(val, 10) : 0;
}

function setLastAiTrainTime(ts) {
  localStorage.setItem('mziya:lastAiTrainTime', String(ts));
}

function getTimeUntilNextAiTrain() {
  const last = getLastAiTrainTime();
  if (!last) return 0;
  const elapsed = Date.now() - last;
  return Math.max(0, AI_TRAIN_COOLDOWN_MS - elapsed);
}

// ── AI Copilot ──

function openCopilot() {
  closeModals();
  const modal = document.getElementById('modal-copilot');
  if (modal) {
    modal.style.display = 'flex';
    document.getElementById('copilot-input')?.focus();
  }
}

function appendChatBubble(text, sender) {
  const history = document.getElementById('copilot-chat-history');
  if (!history) return;

  const bubble = document.createElement('div');
  bubble.style.display = 'flex';
  bubble.style.gap = '8px';
  bubble.style.alignItems = 'flex-start';
  bubble.style.width = '100%';

  const isBot = sender === 'bot';

  function makeIcon(color) {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'width:24px;height:24px;border-radius:50%;background:var(--surface-3);border:1px solid var(--border);display:flex;align-items:center;justify-content:center;font-size:10px;color:' + color + ';flex-shrink:0';
    const i = document.createElement('i');
    i.dataset.lucide = isBot ? 'bot' : 'user';
    i.style.cssText = 'width:12px;height:12px';
    wrap.appendChild(i);
    return wrap;
  }

  const content = document.createElement('div');
  content.style.cssText = 'padding:10px 14px;font-size:13px;line-height:1.5;color:var(--text-primary);text-align:left;max-width:85%';
  content.style.background = isBot ? 'var(--surface-3)' : 'rgba(124,92,252,0.12)';
  content.style.border = isBot ? '1px solid var(--border)' : '1px solid rgba(124,92,252,0.3)';
  content.style.borderRadius = isBot ? '4px 16px 16px 16px' : '16px 4px 16px 16px';
  if (!isBot) content.style.marginLeft = 'auto';
  content.textContent = text;

  if (isBot) {
    bubble.appendChild(makeIcon('var(--gold)'));
    bubble.appendChild(content);
  } else {
    bubble.appendChild(content);
    bubble.appendChild(makeIcon('var(--violet)'));
  }

  history.appendChild(bubble);
  history.scrollTop = history.scrollHeight;
  if (window.lucide) lucide.createIcons();
}

function sendCopilotMsg(text = null) {
  const inputEl = document.getElementById('copilot-input');
  const userText = text || inputEl?.value?.trim();
  if (!userText) return;

  if (inputEl && !text) inputEl.value = '';

  appendChatBubble(userText, 'user');

  // Show typing indicator
  const history = document.getElementById('copilot-chat-history');
  const typingEl = document.createElement('div');
  typingEl.id = 'copilot-typing';
  typingEl.style.cssText = 'display:flex;gap:8px;align-items:center;padding:4px 0;';

  // SEC-08: Use DOM API instead of innerHTML to prevent XSS patterns
  const iconWrap = document.createElement('div');
  iconWrap.style.cssText = 'width:24px;height:24px;border-radius:50%;background:linear-gradient(135deg,var(--yellow),var(--violet));display:flex;align-items:center;justify-content:center;flex-shrink:0;';
  const iconEl = document.createElement('i');
  iconEl.dataset.lucide = 'bot';
  iconEl.style.cssText = 'width:12px;height:12px;color:#000;';
  iconWrap.appendChild(iconEl);
  typingEl.appendChild(iconWrap);

  const bubbleEl = document.createElement('div');
  bubbleEl.style.cssText = 'background:var(--surface-3);border:1px solid var(--border);border-radius:4px 14px 14px 14px;padding:10px 14px;font-size:13px;color:var(--text-2);';
  const dotsWrap = document.createElement('span');
  dotsWrap.style.cssText = 'display:inline-flex;gap:3px;align-items:center;';
  for (let di = 0; di < 3; di++) {
    const dot = document.createElement('span');
    dot.style.cssText = `width:5px;height:5px;border-radius:50%;background:var(--text-2);animation:blink 1s infinite ${di * 0.2}s;display:inline-block;`;
    dotsWrap.appendChild(dot);
  }
  bubbleEl.appendChild(dotsWrap);
  typingEl.appendChild(bubbleEl);
  if (history) { history.appendChild(typingEl); history.scrollTop = history.scrollHeight; }
  if (window.lucide) lucide.createIcons();

  setTimeout(() => {
    typingEl.remove();
    const response = getCopilotResponse(userText);
    if (response.navigate) {
      closeModals();
      setTimeout(() => navigateTo(response.navigate), 100);
    }
    if (response.action) response.action();
    appendChatBubble(response.text, 'bot');
  }, 700 + Math.random() * 400);
}

function getCopilotResponse(userText) {
  const q = userText.toLowerCase().trim();

  // ── SEND / TRANSFER ──
  const sendRegex = /send\s+(\d+(?:\.\d+)?)\s*mzy(?:\s+to\s+([a-zA-Z0-9]+))?/i;
  const sendMatch = userText.match(sendRegex);
  if (sendMatch) {
    const amount = sendMatch[1];
    const recipient = sendMatch[2] || '';
    return {
      navigate: 'send',
      action: () => {
        const amtEl = document.getElementById('send-amount');
        const toEl = document.getElementById('send-to');
        if (amtEl) amtEl.value = amount;
        if (toEl && recipient) toEl.value = recipient.toUpperCase();
        toast(`Copilot prefilled ${amount} MZY on the send form!`, 'success');
      },
      text: `Done! I've opened the Send page and prefilled ${amount} MZY${recipient ? ' to ' + recipient.slice(0,10) + '...' : ''}. Just enter your password and confirm.`
    };
  }

  // ── BALANCE / ADDRESS ──
  if (/balance|how much (mzy|do i have|have i got)|my funds|my account|who am i|my address|wallet info|show me my/.test(q)) {
    if (!App.wallet) return { text: "You don't have a wallet yet. Go to the Wallet tab and create or import one to get started!" };
    const bal = App.blockchain.getBalance(App.wallet.address);
    const usdStr = App.usdPerMzy > 0 ? `\n• USD Value: ≈ $${(bal * App.usdPerMzy).toFixed(4)}` : '';
    const session = App.miningManager?.getSession(App.wallet.address);
    const miningStr = session?.active ? `\n• Mining: ✓ Active (+${formatMZY(session.earned || 0)} pending)` : '\n• Mining: Not started';
    return { text: `Your Mziya wallet:\n\n• Address: ${App.wallet.address}\n• Balance: ${formatMZY(bal)} MZY${usdStr}${miningStr}\n• Block Height: ${App.blockchain.length}` };
  }

  // ── MINING STATUS ──
  if (/mining status|am i mining|is mining|session status|current session/.test(q)) {
    if (!App.wallet) return { text: "You need a wallet to mine. Create one in the Wallet tab first!" };
    const session = App.miningManager?.getSession(App.wallet.address);
    if (!session || !session.active) {
      return { navigate: 'mine', text: "You don't have an active mining session. I've opened the Mine page — tap the ⚡ orb to start!" };
    }
    return { text: `Mining session active!\n\n• Earned this session: ${formatMZY(session.earned || 0)} MZY\n• Rate: ${(session.rate || 0).toFixed(4)} MZY/h\n• Time remaining: ${session.remainingHuman || '...'}\n• Progress: ${Math.round(session.progressPercent || 0)}%` };
  }

  // ── START MINING ──
  if (/start min|begin min|mine now|start earning|how do i mine|tap to mine|activate mining/.test(q)) {
    return {
      navigate: 'mine',
      text: "Opening the Mine page! Tap the glowing ⚡ orb to start your 24-hour mining session. You'll earn MZY automatically while the tab stays open."
    };
  }

  // ── AI / PoI TRAINING ──
  if (/train|ai model|proof.of.intel|poi|depin|federated|weights|accuracy bonus|ai bonus|how.*earn more|boost.*mining/.test(q)) {
    const hasTrained = App.lastAISubmission;
    const bonusInfo = hasTrained
      ? `Your last submission had ${(hasTrained.accuracy * 100).toFixed(1)}% accuracy.`
      : 'You haven\'t trained yet this session.';
    return {
      navigate: 'mine',
      text: `Proof-of-Intelligence (PoI) lets you earn up to +10% bonus MZY by training a tiny AI model on your device.\n\n• No data leaves your device — only model weights go on-chain\n• Each training run takes ~10 seconds with TensorFlow.js\n• Higher accuracy = bigger PoI bonus on your next reward\n• ${bonusInfo}\n\nI've opened the Mine tab — scroll down to the "Proof-of-Intelligence Pool" card and tap Train!`
    };
  }

  // ── WALLET CREATE ──
  if (/create.*(wallet|account)|new wallet|generate wallet|make.*wallet|set up wallet/.test(q)) {
    return {
      navigate: 'wallet',
      text: "Opening the Wallet tab! Click \"Create New Account\" to generate a fresh MZY address. You'll get a 12-word recovery phrase — write it down before anything else!"
    };
  }

  // ── WALLET IMPORT ──
  if (/import.*(wallet|phrase|seed|mnemonic|key)|restore wallet|recover wallet|i have a phrase/.test(q)) {
    return {
      navigate: 'wallet',
      text: "Opening the Wallet tab! Choose \"Import Recovery Phrase\" to restore from 12 words, or \"Import Private Key\" if you have a raw hex key."
    };
  }

  // ── BACKUP / RECOVERY PHRASE ──
  if (/backup|recovery phrase|seed phrase|12 words|mnemonic|save my wallet|export wallet/.test(q)) {
    if (!App.wallet) return { text: "You don't have a wallet to back up yet. Create one first!" };
    if (App.wallet.isWatchOnly) return { text: "Watch-only accounts don't have a recovery phrase — they're view-only." };
    return {
      navigate: 'wallet',
      text: "To view your recovery phrase:\n\n1. Go to Wallet tab\n2. Tap the \"Backup\" button (key icon)\n3. Enter your wallet password\n4. Write down all 12 words in order\n\n⚠️ Never share these words with anyone!"
    };
  }

  // ── DELETE / REMOVE WALLET ──
  if (/delete.*wallet|remove.*wallet|clear.*wallet|wipe.*wallet|logout|sign out/.test(q)) {
    return {
      navigate: 'wallet',
      text: "To remove your wallet from this device:\n\n1. Go to Wallet tab\n2. Tap the \"Remove\" button (trash icon)\n\n⚠️ Make sure you have your 12-word recovery phrase first! Your MZY stays on-chain — only the local key is removed."
    };
  }

  // ── LOCK / SECURITY ──
  if (/lock.*wallet|lock.*screen|secure.*wallet|lock session/.test(q)) {
    return {
      action: () => {
        if (typeof lockWallet === 'function') lockWallet();
        else document.getElementById('btn-lock')?.click();
      },
      text: "Locking your wallet now! You'll need your password (or biometrics) to unlock."
    };
  }

  // ── NETWORK / PEERS ──
  if (/peers|network|connected|p2p|how many peers|node|connection status/.test(q)) {
    const peers = App.p2p?.peerCount ?? 0;
    const status = peers > 0 ? `Connected to ${peers} peer${peers !== 1 ? 's' : ''}` : 'No peers found — running in local mode';
    return { text: `Network Status:\n\n• ${status}\n• Block height: ${App.blockchain.length}\n• Pending transactions: ${App.blockchain.mempool?.size ?? 0}\n• Discovery: mDNS + WebRTC\n\nFor WAN peers, configure BOOTSTRAP_PEERS on your node server.` };
  }

  // ── BLOCKS / CHAIN HEIGHT ──
  if (/blocks?|chain|block height|latest block|blockchain|how many blocks|block #/.test(q)) {
    const stats = App.blockchain.getStats();
    const latest = App.blockchain.latestBlock;
    return {
      navigate: 'explorer',
      text: `Blockchain info:\n\n• Height: ${stats.height} blocks\n• Total transactions: ${stats.totalTransactions}\n• MZY mined: ${formatMZY(stats.circulatingSupply, 2)}\n• Latest block: ${latest?.hash?.slice(0, 16)}...\n• Miner: ${latest?.miner || 'GENESIS'}\n\nOpening the Explorer for you!`
    };
  }

  // ── TRANSACTION HISTORY ──
  if (/transaction|tx history|my transactions|sent|received|history|past tx/.test(q)) {
    if (!App.wallet) return { text: "You need a wallet to view transaction history. Create or import one first!" };
    const hist = [];
    for (const b of App.blockchain.chain) {
      for (const tx of (b.transactions || [])) {
        if (tx.from === App.wallet.address || tx.to === App.wallet.address) hist.push(tx);
      }
    }
    if (hist.length === 0) return { navigate: 'wallet', text: "You have no transactions yet. Start mining to earn your first MZY!" };
    const last = hist[hist.length - 1];
    const isMine = last.type === 'MINING';
    return {
      navigate: 'wallet',
      text: `You have ${hist.length} transaction${hist.length !== 1 ? 's' : ''} on record.\n\nMost recent: ${isMine ? '⚡ Mining reward' : last.to === App.wallet.address ? '↓ Received' : '↑ Sent'} — ${formatMZY(last.amount)} MZY\n\nOpening Wallet for your full history!`
    };
  }

  // ── FEES ──
  if (/fee|gas|network fee|transaction fee|cost to send/.test(q)) {
    return { text: "The minimum network fee is 0.000001 MZY per transfer. Half of every fee is burned (permanently removed from supply) and the other half goes to the validator that produced the block — a minimum fee is burned entirely. Starting/claiming mining and submitting AI training are free." };
  }

  // ── TOKENOMICS / SUPPLY ──
  if (/supply|total supply|how many mzy|tokenomics|circulating|market cap|21 billion/.test(q)) {
    const stats = App.blockchain.getStats();
    return { text: `MZY Tokenomics:\n\n• Max Supply: 21,000,000,000 MZY (21 billion)\n• In existence: ${formatMZY(stats.totalSupply, 2)} MZY\n• Burned by fees: ${formatMZY(stats.totalBurned, 6)} MZY\n• Staked by validators: ${formatMZY(stats.totalStaked, 2)} MZY\n• Locked in AI escrow: ${formatMZY(stats.escrowLocked, 2)} MZY\n\nUses: pay for AI model training (DeCompute), stake to validate and earn, pay fees (half burned).\nMining rate halves every 2 years, with a floor rate of 0.202 MZY/h.` };
  }

  // ── MINING RATE / EARNINGS ──
  if (/rate|mzy.*(hour|hr|day|week)|how much.*earn|earnings|reward|how fast|mining speed/.test(q)) {
    const rate = typeof getCurrentMiningRate === 'function' ? getCurrentMiningRate() : 1.618;
    const daily = rate * 24;
    const weekly = daily * 7;
    return { text: `Current mining rates:\n\n• Base rate: ${rate.toFixed(4)} MZY/h\n• Per day: ~${daily.toFixed(2)} MZY\n• Per week: ~${weekly.toFixed(2)} MZY\n• PoI bonus: up to +10% on top\n\nRate halves every 2 years. Current floor is 0.202 MZY/h.` };
  }

  // ── HALVING ──
  if (/halv|when.*halv|next halving|emission/.test(q)) {
    return { text: "MZY halving happens every 2 years. The mining rate drops by 50% at each halving, similar to Bitcoin. The current rate is 1.618 MZY/h, and the floor is 0.202 MZY/h — the minimum it will ever reach." };
  }

  // ── RECEIVE / QR CODE ──
  if (/receive|my qr|qr code|deposit|give.*address|share.*address/.test(q)) {
    return {
      navigate: 'wallet',
      action: () => setTimeout(() => document.getElementById('btn-show-qr')?.click(), 400),
      text: "Opening your QR code! You can share it or your address to receive MZY from anyone."
    };
  }

  // ── COPY ADDRESS ──
  if (/copy.*address|my address|share.*address|what.*address|address is/.test(q)) {
    if (!App.wallet) return { text: "You need a wallet first! Create or import one from the Wallet tab." };
    navigator.clipboard?.writeText(App.wallet.address).catch(() => {});
    return { text: `Your address: ${App.wallet.address}\n\n(Copied to clipboard!)` };
  }

  // ── PASSKEY / BIOMETRICS ──
  if (/passkey|biometric|face id|touch id|fingerprint|secure.*biom/.test(q)) {
    return {
      navigate: 'wallet',
      text: "Passkey wallets use your device's biometrics (Face ID / Touch ID / fingerprint) to secure your MZY. To set one up:\n\n1. Go to Wallet tab\n2. Tap \"Secure with Passkey\"\n3. Complete biometric registration\n\nNote: Requires HTTPS or localhost."
    };
  }

  // ── WATCH-ONLY ──
  if (/watch.only|watch address|view.only|track.*address|monitor.*wallet/.test(q)) {
    return {
      navigate: 'wallet',
      text: "Watch-only mode lets you track any MZY address without importing the private key. You can see balance and transaction history, but can't send or mine. Tap \"Watch Address\" in the Wallet tab."
    };
  }

  // ── SETTINGS ──
  if (/settings|config|preferences|version|about|testnet|mainnet/.test(q)) {
    return { navigate: 'settings', text: "Opening Settings! You can view tokenomics, network info, manage your wallet, and see the app version there." };
  }

  // ── WHAT IS MZIYA ──
  if (/what is mziya|what.*mziy|tell me about|explain mziya|how does mziya work|about this app/.test(q)) {
    return { text: "Mziya is a fully decentralized, serverless blockchain where you mine MZY coin directly from your phone or browser.\n\n• No central server — pure P2P via WebRTC + mDNS\n• Mining is time-based (not proof-of-work), so no battery drain\n• Unique Proof-of-Intelligence (PoI) lets you earn bonus MZY by training real AI models on-device\n• 21 billion MZY total supply with Bitcoin-style halvings\n• Ed25519 signed transactions — your key never leaves your device" };
  }

  // ── HELP ──
  if (/help|what can you do|commands|what.*ask|capabilities|show.*options|guide/.test(q)) {
    return { text: `I'm Mziya Copilot — here's what I can help with:\n\n💰 Wallet\n• "What's my balance?"\n• "Copy my address" / "Show QR code"\n• "Create a wallet" / "Import a wallet"\n• "Back up my recovery phrase"\n\n⚡ Mining\n• "Start mining" / "Mining status"\n• "How much can I earn per day?"\n• "Train AI for PoI bonus"\n\n📊 Blockchain\n• "Show latest blocks" / "Block height"\n• "My transaction history"\n• "Network peers status"\n\n💸 Send\n• "Send 10 MZY to MZ1234..."\n\n🔒 Security\n• "Lock my wallet"\n• "How do I back up?"\n\n📚 Info\n• "What is Mziya?" / "Tokenomics"\n• "What are fees?" / "When is halving?"` };
  }

  // ── HELLO / GREETINGS ──
  if (/^(hi|hello|hey|sup|yo|hola|greetings|good morning|good afternoon|good evening|what'?s up)/.test(q)) {
    const greetings = [
      "Hey! 👋 What can I help you with today? Ask me about your balance, mining, sending MZY, or anything blockchain-related!",
      "Hello! Ready to help. Ask me anything — balance, mining status, how to send MZY, or just say 'help' for all commands.",
      "Hi there! What's up? I can check your balance, explain PoI, help you send MZY, or navigate around the app."
    ];
    return { text: greetings[Math.floor(Math.random() * greetings.length)] };
  }

  // ── THANKS ──
  if (/thank|thanks|cheers|great|awesome|perfect|nice|cool/.test(q)) {
    return { text: "Happy to help! Anything else you'd like to know? 🚀" };
  }

  // ── NAVIGATE: EXPLORER ──
  if (/explorer|view blocks|block list|open explorer/.test(q)) {
    return { navigate: 'explorer', text: "Opening the Block Explorer! You can browse all blocks and transactions on the chain." };
  }

  // ── NAVIGATE: SEND ──
  if (/send page|go to send|open send|transfer page/.test(q)) {
    return { navigate: 'send', text: "Opening the Send page! Enter a recipient address and amount to transfer MZY." };
  }

  // ── NAVIGATE: MINE ──
  if (/mine page|go to mine|open mine|mining page/.test(q)) {
    return { navigate: 'mine', text: "Opening the Mine page! Tap the ⚡ orb to start your mining session." };
  }

  // ── NAVIGATE: WALLET ──
  if (/wallet page|go to wallet|open wallet|dashboard/.test(q)) {
    return { navigate: 'wallet', text: "Opening the Wallet dashboard!" };
  }

  // ── PENDING TRANSACTIONS ──
  if (/pending|mempool|unconfirmed tx|pending tx/.test(q)) {
    const pending = App.blockchain.mempool?.size ?? 0;
    return { text: `There are currently ${pending} pending transaction${pending !== 1 ? 's' : ''} in the mempool waiting to be included in the next block.` };
  }

  // ── FALLBACK ──
  const fallbacks = [
    "I'm not sure I understood that. Try asking about your balance, mining, sending MZY, or type 'help' to see everything I can do!",
    "Hmm, I didn't quite get that. I'm best at wallet info, mining, sending MZY, and blockchain facts. Type 'help' for a full list!",
    "I don't have an answer for that specific question yet! Try: 'balance', 'mining status', 'send 5 MZY to...', 'block height', or 'help'."
  ];
  return { text: fallbacks[Math.floor(Math.random() * fallbacks.length)] };
}

function bindCopilotEvents() {
  document.getElementById('btn-open-copilot')?.addEventListener('click', openCopilot);
  document.getElementById('btn-floating-copilot')?.addEventListener('click', openCopilot);
  document.getElementById('btn-copilot-send')?.addEventListener('click', () => sendCopilotMsg());
  document.getElementById('copilot-input')?.addEventListener('keypress', (e) => { if (e.key === 'Enter') sendCopilotMsg(); });
  document.getElementById('btn-close-copilot')?.addEventListener('click', closeModals);
  document.querySelectorAll('.copilot-suggestion').forEach(el => {
    el.addEventListener('click', () => {
      const msg = el.dataset.copilotMsg;
      if (msg) sendCopilotMsg(msg);
    });
  });
}

function bindTrainAIEvent() {
  const btn = document.getElementById('btn-train-ai');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    const panel = document.getElementById('decompute-panel');
    if (panel) {
      panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    if (!App.blockchain?.models) return;
    const models = App.blockchain.models.getAvailable();
    if (models.length === 0) {
      toast('No models available for training.', 'info');
      return;
    }
    const sf = App.speedFactor || 1;
    handleDecomputeTrain(models[0], sf);
  });
}

function bindSendMaxEvent() {
  document.getElementById('btn-send-max')?.addEventListener('click', () => {
    if (!App.wallet) { toast('No wallet loaded', 'error'); return; }
    const balance = App.blockchain.getBalance(App.wallet.address);
    const fee = 0.000001;
    const max = Math.max(0, balance - fee);
    const input = document.getElementById('send-amount');
    if (input) {
      input.value = max.toFixed(6);
      input.dispatchEvent(new Event('input'));
    }
    toast(`Max amount set: ${max.toFixed(6)} MZY`, 'info');
  });
}

function bindSettingsEvents() {
  document.getElementById('si-backup')?.addEventListener('click', triggerBackup);
  document.getElementById('si-create-settings')?.addEventListener('click', () => {
    document.getElementById('btn-create-wallet')?.click();
    navigateTo('wallet');
  });
  document.getElementById('si-import-settings')?.addEventListener('click', () => {
    document.getElementById('btn-import-wallet')?.click();
    navigateTo('wallet');
  });
  document.getElementById('si-network-status')?.addEventListener('click', () => {
    const peers = App.p2p?.peerCount ?? 0;
    const msg = peers > 0
      ? `Connected to ${peers} peers via mDNS + WebRTC. Chain height: ${App.blockchain.length}`
      : 'Peer discovery active (mDNS + WebRTC). Ensure you are on the same WiFi as other Mziya users.';
    toast(msg, 'info');
  });
  document.getElementById('si-chain-info')?.addEventListener('click', () => {
    // CORR-05: Use Array.from for Map values
    const supply = Array.from(App.blockchain.utxo.balances.values()).reduce((s, v) => s + Math.max(0, v), 0);
    toast(`Chain: ${App.blockchain.length} blocks · ${formatMZY(supply, 2)} MZY mined · Genesis: June 2026`, 'info');
  });
  document.getElementById('si-network-mode')?.addEventListener('click', () => {
    toast('Testnet mode — no real value. Switch to mainnet when ready.', 'info');
  });
  document.getElementById('si-about')?.addEventListener('click', () => {
    toast('Mziya v1.0.0 · Testnet · Fully P2P blockchain · No central server', 'info');
  });
  document.getElementById('si-whitepaper')?.addEventListener('click', () => {
    toast('Whitepaper coming soon!', 'info');
  });
  document.getElementById('si-lock')?.addEventListener('click', lockWallet);
  document.getElementById('si-clear-data')?.addEventListener('click', clearAllData);
}

async function triggerBackup() {
  if (!App.wallet?.mnemonicEncrypted) { toast('Recovery phrase not stored on this device.', 'error'); return; }
  const pw = await promptModal({
    title: 'Backup Wallet',
    sub: 'Enter your wallet password to reveal the recovery phrase:',
    label: 'Password',
    placeholder: 'Wallet password',
    isPassword: true
  });
  if (!pw) return;
  try {
    const { decryptData } = await import('../../core/wallet.js');
    const mnemonic = await decryptData(App.wallet.mnemonicEncrypted, pw);
    const words = mnemonic.split(' ').map((w, i) => `${i + 1}. ${w}`).join('\n');
    alert('🔐 RECOVERY PHRASE\n\nWrite these down and keep them secret:\n\n' + words + '\n\n⚠ Anyone with these words controls your MZY.');
  } catch {
    toast('Incorrect password.', 'error');
  }
}

function clearAllData() {
  if (!confirm('⚠️ This will delete your wallet and all chain data from this device.\n\nMake sure you have your 12-word recovery phrase!\n\nContinue?')) return;
  localStorage.clear();
  location.reload();
}

// ── Toast Notifications ──

export function showToast(message, icon = '⬡', type = '') {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  const iconSpan = document.createElement('span');
  iconSpan.className = 'toast-icon';
  iconSpan.textContent = icon;
  toast.appendChild(iconSpan);
  const msgSpan = document.createElement('span');
  msgSpan.textContent = message;
  toast.appendChild(msgSpan);
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(-8px)';
    toast.style.transition = 'all 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

export function toast(msg, type = 'info') {
  const icons = { info: '◎', success: '✓', error: '✕', warning: '⚠' };
  showToast(msg, icons[type] || '◎', type === 'success' ? 'success' : type === 'error' ? 'error' : '');
}

export function closeModals() {
  // Never close the lock screen via this function — it's a security gate
  document.querySelectorAll('.modal').forEach(m => {
    if (m.id === 'modal-lock') return;
    m.style.display = 'none';
  });
}

// ── Formatters ──

export function formatMZY(amount, decimals = 6) {
  if (!amount) return (0).toFixed(decimals);
  return Number(amount).toFixed(decimals);
}

export function formatTime(timestamp) {
  const diff = Date.now() - timestamp;
  if (diff < 60_000) return 'Just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return new Date(timestamp).toLocaleDateString();
}

export function truncate(str, start = 6, end = 4) {
  if (!str || str.length <= start + end + 3) return str;
  return `${str.slice(0, start)}...${str.slice(-end)}`;
}

// ── Background Canvas ──

function startBackgroundCanvas() {
  const canvas = document.getElementById('bg-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  let W, H, particles = [];
  const PARTICLE_COUNT = 60;
  const GOLD = [255, 200, 50];
  const VIOLET = [124, 92, 252];

  function resize() {
    W = canvas.width = window.innerWidth;
    H = canvas.height = window.innerHeight;
  }

  function createParticle() {
    const useGold = Math.random() > 0.5;
    const color = useGold ? GOLD : VIOLET;
    return {
      x: Math.random() * W, y: Math.random() * H,
      vx: (Math.random() - 0.5) * 0.3, vy: (Math.random() - 0.5) * 0.3,
      r: Math.random() * 1.5 + 0.5, color, alpha: Math.random() * 0.4 + 0.1,
    };
  }

  function initParticles() {
    particles = Array.from({ length: PARTICLE_COUNT }, createParticle);
  }

  function drawHexagon(ctx, x, y, size, alpha) {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = `rgba(255, 200, 50, ${alpha})`;
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const angle = (Math.PI / 3) * i - Math.PI / 6;
      const px = x + size * Math.cos(angle);
      const py = y + size * Math.sin(angle);
      i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.stroke();
    ctx.restore();
  }

  let frame = 0;
  let isVisible = true;

  // PERF-02: Pause canvas when tab is hidden
  document.addEventListener('visibilitychange', () => {
    isVisible = !document.hidden;
  });

  function draw() {
    if (!isVisible) { requestAnimationFrame(draw); return; }
    ctx.clearRect(0, 0, W, H);
    // PERF-02: Use squared distances to avoid Math.sqrt
    const CONNECTION_DIST_SQ = 120 * 120; // 14400
    for (let i = 0; i < particles.length; i++) {
      for (let j = i + 1; j < particles.length; j++) {
        const dx = particles[i].x - particles[j].x;
        const dy = particles[i].y - particles[j].y;
        const distSq = dx * dx + dy * dy;
        if (distSq < CONNECTION_DIST_SQ) {
          const alpha = (1 - Math.sqrt(distSq) / 120) * 0.12;
          ctx.beginPath();
          ctx.strokeStyle = `rgba(255, 200, 50, ${alpha})`;
          ctx.lineWidth = 0.5;
          ctx.moveTo(particles[i].x, particles[i].y);
          ctx.lineTo(particles[j].x, particles[j].y);
          ctx.stroke();
        }
      }
    }
    for (const p of particles) {
      p.x += p.vx; p.y += p.vy;
      if (p.x < 0) p.x = W; if (p.x > W) p.x = 0;
      if (p.y < 0) p.y = H; if (p.y > H) p.y = 0;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${p.color.join(',')}, ${p.alpha})`;
      ctx.fill();
    }
    if (frame % 180 === 0) {
      const hx = Math.random() * W;
      const hy = Math.random() * H;
      drawHexagon(ctx, hx, hy, 20 + Math.random() * 40, 0.04 + Math.random() * 0.06);
    }
    frame++;
    requestAnimationFrame(draw);
  }

  resize();
  initParticles();
  draw();
  window.addEventListener('resize', () => { resize(); initParticles(); });
}

// ── IndexedDB Storage Wrapper ──

class IDBStorage {
  constructor(dbName) {
    this.dbName = dbName;
    this.db = null;
  }

  async open() {
    if (this.db) return this.db;
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(this.dbName, 1);
      req.onupgradeneeded = (e) => { e.target.result.createObjectStore('data'); };
      req.onsuccess = (e) => { this.db = e.target.result; resolve(this.db); };
      req.onerror = () => reject(req.error);
    });
  }

  async set(key, value) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('data', 'readwrite');
      tx.objectStore('data').put(value, key);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  }

  async get(key) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('data', 'readonly');
      const req = tx.objectStore('data').get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async delete(key) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('data', 'readwrite');
      tx.objectStore('data').delete(key);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  }
}

export function promptModal({ title, sub, label, placeholder, isPassword = true, requiredText = null }) {
  return new Promise((resolve) => {
    const modal = document.getElementById('modal-prompt');
    const titleEl = document.getElementById('prompt-title');
    const subEl = document.getElementById('prompt-sub');
    const labelEl = document.getElementById('prompt-input-label');
    const inputEl = document.getElementById('prompt-input');
    const errEl = document.getElementById('prompt-error');
    const confirmBtn = document.getElementById('btn-confirm-prompt');
    const cancelBtn = document.getElementById('btn-cancel-prompt');

    if (!modal || !inputEl) {
      resolve(prompt(`${title}\n\n${sub}`));
      return;
    }

    titleEl.textContent = title;
    subEl.textContent = sub;
    labelEl.textContent = label;
    inputEl.value = '';
    inputEl.type = isPassword ? 'password' : 'text';
    inputEl.placeholder = placeholder || '';
    errEl.style.display = 'none';
    modal.style.display = 'flex';
    inputEl.focus();

    const cleanup = () => {
      modal.style.display = 'none';
      confirmBtn.removeEventListener('click', onConfirm);
      cancelBtn.removeEventListener('click', onCancel);
      inputEl.removeEventListener('keydown', onKeyDown);
    };

    const onConfirm = () => {
      const val = inputEl.value;
      if (requiredText && val.trim().toUpperCase() !== requiredText.toUpperCase()) {
        errEl.textContent = `Please type "${requiredText}" to confirm.`;
        errEl.style.display = 'block';
        return;
      }
      cleanup();
      resolve(val);
    };

    const onCancel = () => {
      cleanup();
      resolve(null);
    };

    const onKeyDown = (e) => {
      if (e.key === 'Enter') {
        onConfirm();
      } else if (e.key === 'Escape') {
        onCancel();
      }
    };

    confirmBtn.addEventListener('click', onConfirm);
    cancelBtn.addEventListener('click', onCancel);
    inputEl.addEventListener('keydown', onKeyDown);
  });
}

document.addEventListener('DOMContentLoaded', init);
