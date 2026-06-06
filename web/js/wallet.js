import { createWallet, walletFromMnemonic, walletFromPrivateKey, encryptPrivateKey, encryptData, decryptData } from '../../core/wallet.js';
import { saveWallet, clearWallet, toast, formatMZY, truncate, closeModals, ensureUnlocked, promptModal } from './app.js';

let app;

export async function initWalletPage(appRef) {
  app = appRef;

  document.getElementById('btn-create-wallet')?.addEventListener('click', openCreateModal);
  document.getElementById('btn-import-wallet')?.addEventListener('click', openImportModal);
  document.getElementById('btn-cancel-create')?.addEventListener('click', () => {
    pendingWallet = null; // SEC-01: Clear key material on modal close
    closeModals();
  });
  document.getElementById('btn-cancel-import')?.addEventListener('click', closeModals);
  document.getElementById('btn-confirm-create')?.addEventListener('click', confirmCreate);
  document.getElementById('btn-confirm-import')?.addEventListener('click', confirmImport);

  document.getElementById('btn-import-privkey-wallet')?.addEventListener('click', openPrivKeyImportModal);
  document.getElementById('btn-cancel-import-privkey')?.addEventListener('click', closeModals);
  document.getElementById('btn-confirm-import-privkey')?.addEventListener('click', confirmPrivKeyImport);

  document.getElementById('btn-watch-address-wallet')?.addEventListener('click', openWatchAddressModal);
  document.getElementById('btn-cancel-watch-address')?.addEventListener('click', closeModals);
  document.getElementById('btn-confirm-watch-address')?.addEventListener('click', confirmWatchAddress);

  document.getElementById('btn-passkey-wallet')?.addEventListener('click', createPasskeyWallet);

  document.getElementById('btn-copy-address')?.addEventListener('click', copyAddress);
  document.getElementById('btn-show-qr')?.addEventListener('click', showQR);
  document.getElementById('btn-show-mnemonic')?.addEventListener('click', showMnemonicWarning);
  document.getElementById('btn-delete-wallet')?.addEventListener('click', deleteWallet);
  document.getElementById('btn-close-qr')?.addEventListener('click', closeModals);
  document.getElementById('btn-copy-qr-addr')?.addEventListener('click', copyAddress);
  
  document.getElementById('btn-close-mnemonic')?.addEventListener('click', closeModals);
  
  const mRevealOverlay = document.getElementById('mnemonic-reveal-overlay');
  mRevealOverlay?.addEventListener('click', () => {
    mRevealOverlay.style.display = 'none';
    const wordsDiv = document.getElementById('mnemonic-reveal-words');
    if (wordsDiv) wordsDiv.style.display = 'grid';
    const copyBtn = document.getElementById('btn-copy-mnemonic');
    if (copyBtn) copyBtn.disabled = false;
  });

  document.getElementById('btn-copy-mnemonic')?.addEventListener('click', async () => {
    const wordsDiv = document.getElementById('mnemonic-reveal-words');
    const wordSpans = wordsDiv?.querySelectorAll('div');
    if (!wordSpans || wordSpans.length === 0) return;
    const phrase = Array.from(wordSpans)
      .map(el => {
        const valSpan = el.querySelectorAll('span')[1];
        return valSpan ? valSpan.textContent : '';
      })
      .join(' ');
    try {
      await navigator.clipboard.writeText(phrase);
      toast('Recovery phrase copied!', 'success');
    } catch {
      toast('Copy failed', 'error');
    }
  });

  document.getElementById('mnemonic-confirm')?.addEventListener('change', function() {
    const btn = document.getElementById('btn-confirm-create');
    if (btn) btn.disabled = !this.checked;
  });
}

// ── Create Wallet ──

let pendingWallet = null;

async function openCreateModal() {
  pendingWallet = await createWallet();

  const grid = document.getElementById('mnemonic-grid');
  if (grid) {
    grid.textContent = '';
    pendingWallet.mnemonic.split(' ').forEach((word, i) => {
      const div = document.createElement('div');
      div.className = 'm-word';
      const num = document.createElement('span');
      num.className = 'm-num';
      num.textContent = i + 1;
      div.appendChild(num);
      const txt = document.createElement('span');
      txt.className = 'm-text';
      txt.textContent = word;
      div.appendChild(txt);
      grid.appendChild(div);
    });
  }

  const checkbox = document.getElementById('mnemonic-confirm');
  const btn = document.getElementById('btn-confirm-create');
  if (checkbox) checkbox.checked = false;
  if (btn) btn.disabled = true;
  const err = document.getElementById('create-error');
  if (err) err.style.display = 'none';
  const pwEl = document.getElementById('create-password');
  if (pwEl) pwEl.value = '';

  document.getElementById('modal-create').style.display = 'flex';
}

async function confirmCreate() {
  if (!pendingWallet) return;

  const password = document.getElementById('create-password')?.value;
  const err = document.getElementById('create-error');
  if (!password || password.length < 6) {
    if (err) { err.textContent = 'Password must be at least 6 characters'; err.style.display = 'block'; }
    return;
  }

  const btn = document.getElementById('btn-confirm-create');
  if (btn) { btn.disabled = true; btn.textContent = 'Creating...'; }
  if (err) err.style.display = 'none';

  try {
    const encrypted = await encryptPrivateKey(pendingWallet.privateKey, password);
    const mnemonicEncrypted = await encryptData(pendingWallet.mnemonic, password);
    const walletData = {
      address: pendingWallet.address,
      publicKey: pendingWallet.publicKey,
      privateKeyEncrypted: encrypted,
      mnemonicEncrypted,
      createdAt: Date.now(),
    };
    saveWallet(walletData);
    closeModals();
    toast(`Wallet created! Address: ${walletData.address.slice(0, 14)}...`, 'success');
  } catch (e) {
    if (err) { err.textContent = 'Error: ' + e.message; err.style.display = 'block'; }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Create Wallet'; }
  }
  pendingWallet = null;
}

// ── Import Wallet (Mnemonic) ──

function openImportModal() {
  const modal = document.getElementById('modal-import');
  if (modal) modal.style.display = 'flex';
  document.getElementById('import-mnemonic-input')?.focus();
  const err = document.getElementById('import-error');
  if (err) err.style.display = 'none';
  document.getElementById('import-password').value = '';
}

async function confirmImport() {
  const input = document.getElementById('import-mnemonic-input');
  const errEl = document.getElementById('import-error');
  const password = document.getElementById('import-password')?.value;
  if (!input) return;

  const mnemonic = input.value.trim().toLowerCase();
  const words = mnemonic.split(/\s+/);
  if (words.length !== 12) {
    if (errEl) { errEl.textContent = 'Please enter exactly 12 words'; errEl.style.display = 'block'; }
    return;
  }
  if (!password || password.length < 6) {
    if (errEl) { errEl.textContent = 'Password must be at least 6 characters'; errEl.style.display = 'block'; }
    return;
  }

  const btn = document.getElementById('btn-confirm-import');
  if (btn) { btn.disabled = true; btn.textContent = 'Importing...'; }
  if (errEl) errEl.style.display = 'none';

  try {
    const wallet = await walletFromMnemonic(mnemonic);
    const encrypted = await encryptPrivateKey(wallet.privateKey, password);
    const mnemonicEncrypted = await encryptData(mnemonic, password);
    const walletData = {
      address: wallet.address,
      publicKey: wallet.publicKey,
      privateKeyEncrypted: encrypted,
      mnemonicEncrypted,
      createdAt: Date.now(),
    };
    saveWallet(walletData);
    closeModals();
    toast(`Wallet imported! Address: ${walletData.address.slice(0, 14)}...`, 'success');
  } catch (e) {
    if (errEl) { errEl.textContent = 'Invalid mnemonic: ' + e.message; errEl.style.display = 'block'; }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Import Wallet'; }
  }
}

// ── Private Key Import ──

function openPrivKeyImportModal() {
  document.getElementById('import-privkey-input').value = '';
  document.getElementById('import-privkey-password').value = '';
  const err = document.getElementById('import-privkey-error');
  if (err) err.style.display = 'none';
  document.getElementById('modal-import-privkey').style.display = 'flex';
}

async function confirmPrivKeyImport() {
  const priv = document.getElementById('import-privkey-input')?.value.trim();
  const pw = document.getElementById('import-privkey-password')?.value;
  const err = document.getElementById('import-privkey-error');

  if (!/^[0-9a-fA-F]{64}$/.test(priv)) {
    if (err) { err.textContent = 'Invalid private key — must be 64 hex characters'; err.style.display = 'block'; }
    return;
  }
  if (!pw || pw.length < 6) {
    if (err) { err.textContent = 'Password must be at least 6 characters'; err.style.display = 'block'; }
    return;
  }

  const btn = document.getElementById('btn-confirm-import-privkey');
  if (btn) { btn.disabled = true; btn.textContent = 'Importing...'; }
  if (err) err.style.display = 'none';

  try {
    const wallet = walletFromPrivateKey(priv.toLowerCase());
    const encrypted = await encryptPrivateKey(wallet.privateKey, pw);
    const walletData = {
      address: wallet.address,
      publicKey: wallet.publicKey,
      privateKeyEncrypted: encrypted,
      mnemonicEncrypted: null,
      createdAt: Date.now(),
    };
    saveWallet(walletData);
    closeModals();
    toast('Private key wallet imported!', 'success');
  } catch (e) {
    if (err) { err.textContent = 'Error: ' + e.message; err.style.display = 'block'; }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Import Wallet'; }
  }
}

// ── Watch Address ──

function openWatchAddressModal() {
  document.getElementById('watch-address-input').value = '';
  const err = document.getElementById('watch-address-error');
  if (err) err.style.display = 'none';
  document.getElementById('modal-watch-address').style.display = 'flex';
}

async function confirmWatchAddress() {
  const addr = document.getElementById('watch-address-input')?.value.trim();
  const err = document.getElementById('watch-address-error');
  const valid = addr && addr.startsWith('MZ') && addr.length === 40 && /^[0-9a-fA-F]+$/.test(addr.slice(2));
  if (!valid) {
    if (err) { err.textContent = 'Invalid address — must start with MZ + 38 hex chars'; err.style.display = 'block'; }
    return;
  }

  const walletData = {
    address: addr,
    publicKey: '',
    privateKeyEncrypted: null,
    mnemonicEncrypted: null,
    isWatchOnly: true,
    createdAt: Date.now(),
  };
  saveWallet(walletData);
  closeModals();
  toast('Watch-only address added!', 'success');
}

// ── Passkey Wallet ──

async function createPasskeyWallet() {
  toast('Initializing device authenticator...', 'info');

  try {
    let cred;
    try {
      const challenge = crypto.getRandomValues(new Uint8Array(16));
      const id = crypto.getRandomValues(new Uint8Array(16));
      cred = await navigator.credentials.create({
        publicKey: {
          challenge,
          rp: { name: 'Mziya Blockchain' },
          user: { id, name: 'mziya-miner-' + Date.now(), displayName: 'Mziya Miner' },
          pubKeyCredParams: [{ alg: -7, type: 'public-key' }],
          timeout: 10000,
          authenticatorSelection: { userVerification: 'required' },
        },
      });
    } catch (err) {
      console.warn('WebAuthn registration error:', err.message);
      if (window.location.protocol !== 'https:' && window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1') {
        throw new Error('Biometric Passkeys require a secure connection (HTTPS or localhost).');
      }
      throw new Error(err.message || 'Authentication cancelled.');
    }

    if (!cred) throw new Error('Authentication cancelled.');

    // SEC-10: Derive private key from attestation object (secret device data) + credential ID
    // The attestation contains device-specific signatures not available to remote attackers
    const attestationBytes = new Uint8Array(cred.response?.attestationObject || []);
    const entropy = 'mziya-passkey-seed:' + cred.id + ':' + Array.from(attestationBytes).map(b => b.toString(16).padStart(2, '0')).join('');
    const hashBytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(entropy)));
    const hash = Array.from(hashBytes).map(b => b.toString(16).padStart(2, '0')).join('');

    const derivedWallet = walletFromPrivateKey(hash);

    // Derive encryption password from credential ID + attestation (not a static string)
    // This ensures each passkey credential produces a unique encryption key
    const encKeyInput = 'mziya-enc:' + cred.id + ':' + Array.from(attestationBytes.slice(0, 32)).map(b => b.toString(16).padStart(2, '0')).join('');
    const encKeyHash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(encKeyInput)));
    const encPassword = Array.from(encKeyHash).map(b => b.toString(16).padStart(2, '0')).join('');

    const enc = await encryptPrivateKey(derivedWallet.privateKey, encPassword);

    saveWallet({
      address: derivedWallet.address,
      publicKey: derivedWallet.publicKey,
      privateKeyEncrypted: enc,
      mnemonicEncrypted: null,
      isPasskey: true,
      passkeyCredentialId: cred.id, // Store credential ID to re-derive encryption key on unlock
      isWatchOnly: false,
      createdAt: Date.now(),
    });

    closeModals();
    toast('Passkey registered successfully!', 'success');
  } catch (e) {
    toast(e.message, 'error');
  }
}

// ── Utilities ──

async function copyAddress() {
  if (!app.wallet) return;
  try {
    await navigator.clipboard.writeText(app.wallet.address);
    toast('Address copied!', 'success');
  } catch {
    toast('Copy failed — select manually', 'error');
  }
}

function showQR() {
  if (!app.wallet) return;
  const qrEl = document.getElementById('wallet-qr');
  if (qrEl) {
    qrEl.innerHTML = '';
    if (window.QRCode) {
      try {
        new QRCode(qrEl, { text: app.wallet.address, width: 160, height: 160, colorDark: '#0B0E11', colorLight: '#ffffff' });
      } catch (e) { }
    }
  }
  const addrEl = document.getElementById('qr-address');
  if (addrEl) addrEl.textContent = app.wallet.address;
  document.getElementById('modal-qr').style.display = 'flex';
}

async function showMnemonicWarning() {
  if (!app.wallet?.mnemonicEncrypted) {
    toast('Recovery phrase not stored on this device.', 'error');
    return;
  }
  const pw = await promptModal({
    title: 'Backup Recovery Phrase',
    sub: 'Enter your wallet password to reveal the recovery phrase:',
    label: 'Password',
    placeholder: 'Wallet password',
    isPassword: true
  });
  if (!pw) return;
  try {
    const mnemonic = await decryptData(app.wallet.mnemonicEncrypted, pw);
    
    const overlay = document.getElementById('mnemonic-reveal-overlay');
    const wordsDiv = document.getElementById('mnemonic-reveal-words');
    const copyBtn = document.getElementById('btn-copy-mnemonic');
    
    if (overlay) overlay.style.display = 'flex';
    if (wordsDiv) {
      wordsDiv.style.display = 'none';
      wordsDiv.innerHTML = '';
      const words = mnemonic.split(' ');
      words.forEach((w, i) => {
        const item = document.createElement('div');
        item.style.cssText = 'background:var(--surface-2);border:1px solid var(--border);padding:8px;border-radius:var(--radius-sm);font-size:12px;font-family:IBM Plex Mono,monospace;color:var(--text-1);text-align:left;display:flex;align-items:center';
        
        const num = document.createElement('span');
        num.style.cssText = 'color:var(--text-3);margin-right:6px;font-weight:700';
        num.textContent = `${i + 1}.`;
        
        const val = document.createElement('span');
        val.textContent = w;
        
        item.appendChild(num);
        item.appendChild(val);
        wordsDiv.appendChild(item);
      });
    }
    if (copyBtn) copyBtn.disabled = true;
    
    const modal = document.getElementById('modal-mnemonic');
    if (modal) modal.style.display = 'flex';
  } catch (e) {
    console.error(e);
    toast('Incorrect password.', 'error');
  }
}

function deleteWallet() {
  if (!confirm('Remove wallet from this device?\n\nMake sure you have your 12-word recovery phrase!')) return;
  clearWallet();
  toast('Wallet removed from device', 'info');
}
