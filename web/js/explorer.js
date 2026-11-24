import { formatMZY, formatTime } from './app.js';

let app;

export async function initExplorerPage(appRef) {
  app = appRef;

  document.getElementById('btn-back-explorer')?.addEventListener('click', () => {
    document.getElementById('block-list-section').style.display = 'block';
    document.getElementById('block-detail').style.display = 'none';
  });

  renderExplorer();

  // Refresh when user navigates to explorer page
  document.addEventListener('mziya:explorer-navigate', renderExplorer);

  // PERF-06: Only re-render when explorer is the active page
  setInterval(() => {
    if (document.getElementById('page-explorer')?.classList.contains('active')) {
      renderExplorer();
    }
  }, 10_000);
}

export function renderExplorer() {
  const stats = app.blockchain.getStats();

  const el = id => document.getElementById(id);
  if (el('ex-height')) el('ex-height').textContent = stats.height;
  if (el('ex-txs')) el('ex-txs').textContent = stats.totalTransactions;
  if (el('ex-supply')) el('ex-supply').textContent = formatMZY(stats.circulatingSupply, 2);
  if (el('net-height')) el('net-height').textContent = stats.height;
  if (el('net-supply')) el('net-supply').textContent = formatMZY(stats.circulatingSupply, 0) + ' MZY';

  const blocksList = el('blocks-list');
  if (!blocksList) return;

  const blocks = [...app.blockchain.chain].reverse().slice(0, 30);

  blocksList.textContent = '';

  if (blocks.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty-sub';
    empty.textContent = 'No blocks yet';
    blocksList.appendChild(empty);
    return;
  }

  for (const block of blocks) {
    const hash = block.hash || '—';
    const item = document.createElement('div');
    item.className = 'block-item';
    item.dataset.hash = hash;
    item.addEventListener('click', () => showBlockDetail(hash));

    const left = document.createElement('div');
    left.className = 'block-left';
    const idx = document.createElement('div');
    idx.className = 'block-index';
    idx.textContent = '#' + block.index;
    left.appendChild(idx);
    const h = document.createElement('div');
    h.className = 'block-hash';
    h.textContent = hash;
    left.appendChild(h);
    item.appendChild(left);

    const meta = document.createElement('div');
    meta.className = 'block-meta';
    const txs = document.createElement('div');
    txs.className = 'block-txs';
    const txCount = block.transactions?.length || 0;
    txs.textContent = txCount + ' tx' + (txCount !== 1 ? 's' : '');
    meta.appendChild(txs);
    const time = document.createElement('div');
    time.className = 'block-time';
    time.textContent = formatTime(block.timestamp);
    meta.appendChild(time);
    item.appendChild(meta);

    blocksList.appendChild(item);
  }
}

function safe(str) {
  return String(str).replace(/[<>"'&]/g, (c) => ({
    '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '&': '&amp;'
  }[c] || c));
}

function showBlockDetail(hash) {
  const block = app.blockchain.getBlockByHash(hash);
  if (!block) return;

  const listSection = document.getElementById('block-list-section');
  const detailEl = document.getElementById('block-detail');
  const contentEl = document.getElementById('block-detail-content');

  if (listSection) listSection.style.display = 'none';
  if (detailEl) detailEl.style.display = 'flex';
  if (!contentEl) return;

  contentEl.textContent = '';

  function addRow(label, value) {
    const row = document.createElement('div');
    row.className = 'detail-kv';
    const key = document.createElement('div');
    key.className = 'detail-k';
    key.textContent = label;
    row.appendChild(key);
    const val = document.createElement('div');
    val.className = 'detail-v';
    val.textContent = value;
    row.appendChild(val);
    contentEl.appendChild(row);
  }

  addRow('Block Index', '#' + block.index);
  addRow('Hash', block.hash);
  addRow('Previous Hash', block.previousHash);
  addRow('Merkle Root', block.merkleRoot);
  addRow('Timestamp', new Date(block.timestamp).toUTCString());
  addRow('Miner', block.miner || 'GENESIS');

  const txRow = document.createElement('div');
  txRow.className = 'detail-kv';
  txRow.style.borderBottom = 'none';
  const txKey = document.createElement('div');
  txKey.className = 'detail-k';
  txKey.textContent = 'Transactions (' + (block.transactions?.length || 0) + ')';
  txRow.appendChild(txKey);
  const txVal = document.createElement('div');
  txVal.style.marginTop = '8px';

  const txs = block.transactions || [];
  if (txs.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty-sub';
    empty.style.fontSize = '12px';
    empty.textContent = 'No transactions';
    txVal.appendChild(empty);
  } else {
    for (const tx of txs) {
      const item = document.createElement('div');
      item.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--border);';

      const left = document.createElement('div');

      const typeBadge = document.createElement('span');
      typeBadge.className = 'badge ' + (tx.type === 'MINING' ? 'badge-yellow'
        : ['AI_SUBMISSION', 'TRAINING_SUBMIT', 'TRAINING_VERIFY'].includes(tx.type) ? 'badge-green' : 'badge-gray');
      typeBadge.style.marginRight = '8px';
      typeBadge.textContent = tx.type || 'UNKNOWN';
      left.appendChild(typeBadge);

      const addr = document.createElement('span');
      addr.className = 'detail-v';
      addr.style.cssText = 'font-size:11px;display:inline;';
      addr.textContent = safe(tx.to || '').slice(0, 14) + '…';
      left.appendChild(addr);
      item.appendChild(left);

      const amt = document.createElement('span');
      amt.className = 'tx-amount ' + (tx.type === 'MINING' ? 'mine' : 'in');
      amt.textContent = formatMZY(tx.amount) + ' MZY';
      item.appendChild(amt);

      txVal.appendChild(item);
    }
  }
  txRow.appendChild(txVal);

  contentEl.appendChild(txRow);
}
