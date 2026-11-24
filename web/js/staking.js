/**
 * Mziya Staking — lock MZY to become a validator.
 *
 * Validators (stake >= MIN_STAKE):
 *   • produce blocks and keep the unburned half of their fees
 *   • share an extra 10% minted on every mining claim, pro-rata by stake
 *   • mine at +25%
 *   • can verify DeCompute submissions for a fee
 */

import { toast, formatMZY, saveChain, requestPrivateKey } from './app.js';
import { createStake, createUnstake } from '../../core/transaction.js';
import { TOKENOMICS } from '../../core/tokenomics.js';

let app;

function el(tag, css = '', text = '') {
  const e = document.createElement(tag);
  if (css) e.style.cssText = css;
  if (text) e.textContent = text;
  return e;
}

function icon(name) {
  const i = document.createElement('i');
  i.dataset.lucide = name;
  return i;
}

export function renderStakingPanel(appRef) {
  app = appRef;
  const container = document.getElementById('staking-panel');
  if (!container || !app.blockchain) return;
  container.textContent = '';

  const addr = app.wallet?.address;
  const state = app.blockchain.utxo;
  const stats = app.blockchain.getStats();
  const stake = addr ? state.getStake(addr) : 0;
  const isValidator = addr ? state.isValidator(addr) : false;
  const share = stats.totalStaked > 0 && isValidator ? (stake / stats.totalStaked) * 100 : 0;

  const head = el('div');
  head.className = 'card-head';
  const title = el('div');
  title.className = 'card-title';
  const ico = el('span');
  ico.className = 'ico';
  ico.appendChild(icon('layers'));
  title.appendChild(ico);
  title.append('Stake & Validate');
  head.appendChild(title);
  const badge = el('span', '', isValidator ? 'Validator' : 'Not staked');
  badge.className = 'badge ' + (isValidator ? 'badge-green' : 'badge-gray');
  head.appendChild(badge);
  container.appendChild(head);

  const desc = el('p', '', `Lock ${TOKENOMICS.MIN_STAKE}+ MZY to help secure the network and earn.`);
  desc.className = 'card-desc';
  container.appendChild(desc);

  const perks = el('div');
  perks.className = 'perk-list';
  for (const text of [
    `${TOKENOMICS.STAKER_REWARD_SHARE * 100}% extra minted on every mining claim, shared by stake`,
    `+${TOKENOMICS.VALIDATOR_BONUS * 100}% on your own mining rate`,
    'Produce blocks and earn verifier fees from the AI market',
  ]) {
    const row = el('div');
    row.className = 'perk';
    row.appendChild(icon('check'));
    row.append(text);
    perks.appendChild(row);
  }
  container.appendChild(perks);

  const kv = el('div');
  kv.className = 'kv-list';
  const addKv = (k, v) => {
    const row = el('div');
    row.className = 'kv';
    const ks = el('span', '', k); ks.className = 'k';
    const vs = el('span', '', v); vs.className = 'v';
    row.appendChild(ks); row.appendChild(vs);
    kv.appendChild(row);
  };
  addKv('Your stake', `${formatMZY(stake, 4)} MZY${isValidator ? ` · ${share.toFixed(1)}%` : ''}`);
  addKv('Validators', String(stats.validatorCount));
  addKv('Total staked', `${formatMZY(stats.totalStaked, 2)} MZY`);
  addKv('Paid to validators', `${formatMZY(stats.totalStakingRewards, 4)} MZY`);
  addKv('Burned by fees', `${formatMZY(stats.totalBurned, 6)} MZY`);
  container.appendChild(kv);

  if (!addr) return;

  const amountIn = document.createElement('input');
  amountIn.className = 'form-input';
  amountIn.type = 'number';
  amountIn.inputMode = 'decimal';
  amountIn.placeholder = `Amount · ${formatMZY(state.getBalance(addr), 4)} MZY available`;
  container.appendChild(amountIn);

  const row = el('div');
  row.className = 'btn-row';
  const stakeBtn = el('button', '', 'Stake');
  stakeBtn.className = 'btn btn-primary';
  const unstakeBtn = el('button', '', 'Unstake');
  unstakeBtn.className = 'btn btn-ghost';
  stakeBtn.addEventListener('click', () => submit('stake', amountIn.value));
  unstakeBtn.addEventListener('click', () => submit('unstake', amountIn.value));
  row.appendChild(stakeBtn);
  row.appendChild(unstakeBtn);
  container.appendChild(row);

  if (window.lucide) window.lucide.createIcons();
}

async function submit(kind, rawAmount) {
  const addr = app.wallet.address;
  const amount = Math.round(parseFloat(rawAmount) * 1e6) / 1e6;
  if (!(amount > 0)) return toast('Enter an amount', 'error');

  const state = app.blockchain.utxo;
  if (kind === 'stake' && state.getBalance(addr) < amount + TOKENOMICS.MIN_FEE) {
    return toast(`Insufficient balance: ${formatMZY(state.getBalance(addr))} MZY`, 'error');
  }
  if (kind === 'unstake' && state.getStake(addr) < amount) {
    return toast(`You only have ${formatMZY(state.getStake(addr))} MZY staked`, 'error');
  }

  const privateKey = await requestPrivateKey(kind === 'stake' ? 'Stake MZY' : 'Unstake MZY',
    `${kind === 'stake' ? 'Lock' : 'Unlock'} ${formatMZY(amount, 4)} MZY?`);
  if (!privateKey) return;

  const make = kind === 'stake' ? createStake : createUnstake;
  const tx = make({ address: addr, amount, nonce: app.blockchain.getNextNonce(addr), privateKey });
  const res = app.blockchain.addPendingTransaction(tx);
  if (!res.success) return toast(`${kind === 'stake' ? 'Stake' : 'Unstake'} rejected: ${res.error}`, 'error');

  if (app.p2p?.isRunning) app.p2p.broadcastTransaction(tx).catch(() => {});
  if (!app.p2p?.isRunning || app.p2p.peerCount === 0) {
    const block = app.blockchain.forgeBlock(addr, privateKey);
    if (block) app.blockchain.addBlock(block);
  }
  await saveChain();
  toast(kind === 'stake' ? `Staked ${formatMZY(amount, 4)} MZY` : `Unstaked ${formatMZY(amount, 4)} MZY`, 'success');
  renderStakingPanel(app);
}
