/**
 * Mziya PWA — Send Page
 * Sign transaction locally with Ed25519, broadcast to P2P network.
 * Private key decrypted in memory only for signing — then gone.
 */

import { createTransfer } from '../../core/transaction.js';
import { decryptPrivateKey } from '../../core/wallet.js';
import { toast, formatMZY, saveChain } from './app.js';

let app;

export async function initSendPage(appRef) {
  app = appRef;

  const sendToInput = document.getElementById('send-to');
  const sendAmountInput = document.getElementById('send-amount');

  sendToInput?.addEventListener('input', updatePreview);
  sendAmountInput?.addEventListener('input', updatePreview);

  document.getElementById('btn-send')?.addEventListener('click', handleSend);

  renderSendState();
}

function renderSendState() {
  const noWallet = document.getElementById('send-no-wallet');
  const form = document.getElementById('send-form');

  if (!app.wallet) {
    noWallet && (noWallet.style.display = 'flex');
    form && (form.style.display = 'none');
    return;
  }

  noWallet && (noWallet.style.display = 'none');
  form && (form.style.display = 'flex');
  form && (form.style.flexDirection = 'column');
  form && (form.style.gap = '16px');

  // Update available balance
  const avail = app.blockchain.getBalance(app.wallet.address);
  const availEl = document.getElementById('send-available');
  if (availEl) availEl.textContent = formatMZY(avail);
}

function updatePreview() {
  const to = document.getElementById('send-to')?.value?.trim();
  const amount = parseFloat(document.getElementById('send-amount')?.value);
  const preview = document.getElementById('send-preview');
  const previewTo = document.getElementById('preview-to');
  const previewAmt = document.getElementById('preview-amount');

  if (to && amount > 0) {
    preview && (preview.style.display = 'flex');
    preview && (preview.style.flexDirection = 'column');
    preview && (preview.style.gap = '10px');
    if (previewTo) previewTo.textContent = to.slice(0, 16) + '...' + to.slice(-4);
    if (previewAmt) previewAmt.textContent = `${formatMZY(amount)} MZY`;
  } else {
    preview && (preview.style.display = 'none');
  }
}

async function handleSend() {
  const to = document.getElementById('send-to')?.value?.trim();
  const amount = parseFloat(document.getElementById('send-amount')?.value);
  const password = document.getElementById('send-password')?.value;
  const statusEl = document.getElementById('send-status');

  const setStatus = (msg, type) => {
    if (!statusEl) return;
    statusEl.textContent = msg;
    statusEl.className = `send-status${type ? ' ' + type : ''}`;
  };

  // Validation
  if (!to || !to.startsWith('MZ')) return setStatus('Invalid recipient address (must start with MZ)', 'error');
  if (!amount || amount <= 0) return setStatus('Enter a valid amount', 'error');
  if (!password) return setStatus('Enter your wallet password', 'error');

  const balance = app.blockchain.getBalance(app.wallet.address);
  if (amount + 0.000001 > balance) {
    return setStatus(`Insufficient balance: ${formatMZY(balance)} MZY`, 'error');
  }

  setStatus('Signing transaction...', '');

  try {
    // Decrypt private key (only in memory, for signing)
    const privateKey = await decryptPrivateKey(app.wallet.privateKeyEncrypted, password);

    const nonce = app.blockchain.getNextNonce(app.wallet.address);

    // Create and sign transaction locally
    const tx = createTransfer({
      from: app.wallet.address,
      to,
      amount,
      fee: 0.000001,
      nonce,
      privateKey,
    });

    // Validate and add to blockchain mempool (single source of truth)
    const mempoolResult = app.blockchain.addPendingTransaction(tx);
    if (!mempoolResult.success) {
      return setStatus(`Transaction rejected: ${mempoolResult.error}`, 'error');
    }

    // Broadcast to P2P network
    if (app.p2p?.isRunning) {
      await app.p2p.broadcastTransaction(tx);
    }

    // Clear form
    document.getElementById('send-to').value = '';
    document.getElementById('send-amount').value = '';
    document.getElementById('send-password').value = '';
    document.getElementById('send-preview').style.display = 'none';

    setStatus(`Transaction sent! TX: ${tx.txHash.slice(0, 16)}...`, 'success');
    toast(`Sent ${formatMZY(amount)} MZY!`, 'success');

    // In local mode (no peers), forge a block immediately for demo
    if (!app.p2p?.isRunning || app.p2p.peerCount === 0) {
      const block = app.blockchain.forgeBlock(app.wallet.address, privateKey);
      if (block) {
        app.blockchain.addBlock(block);
        saveChain();
      }
    }

  } catch (err) {
    if (err.message?.includes('decrypt')) {
      setStatus('Wrong password', 'error');
    } else {
      setStatus(`Error: ${err.message}`, 'error');
    }
  }
}
