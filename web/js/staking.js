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

  const card = el('div', 'background:var(--surface-3);border:1px solid var(--border);border-radius:8px;padding:12px');
  const header = el('div', 'display:flex;justify-content:space-between;align-items:center;margin-bottom:8px');
  header.appendChild(el('span', 'font-size:13px;font-weight:700;color:var(--text-1)', 'Staking — Become a Validator'));
  header.appendChild(el('span', `font-size:11px;font-weight:700;color:${isValidator ? 'var(--green)' : 'var(--text-3)'}`,
    isValidator ? 'VALIDATOR' : 'NOT STAKED'));
  card.appendChild(header);

  const info = el('div', 'font-size:11px;color:var(--text-2);line-height:1.6;margin-bottom:10px');
  info.appendChild(el('div', '', `Stake ${TOKENOMICS.MIN_STAKE} MZY or more to: produce blocks, earn ${TOKENOMICS.STAKER_REWARD_SHARE * 100}% extra on every mining claim (split by stake), mine at +${TOKENOMICS.VALIDATOR_BONUS * 100}%, and earn DeCompute verifier fees.`));
  info.appendChild(el('div', '', `Your stake: ${formatMZY(stake, 4)} MZY${isValidator ? ` · ${share.toFixed(2)}% of all stake` : ''}`));
  info.appendChild(el('div', '', `Network: ${stats.validatorCount} validators · ${formatMZY(stats.totalStaked, 2)} MZY staked · ${formatMZY(stats.totalStakingRewards, 4)} MZY paid to validators · ${formatMZY(stats.totalBurned, 6)} MZY burned`));
  card.appendChild(info);

  if (!addr) {
    container.appendChild(card);
    return;
  }

  const amountIn = el('input', 'width:100%;padding:8px;margin-bottom:6px;border-radius:6px;border:1px solid var(--border);background:var(--surface-2);color:var(--text-1);font-size:12px;box-sizing:border-box');
  amountIn.type = 'number';
  amountIn.placeholder = `Amount (MZY) — available ${formatMZY(state.getBalance(addr), 4)}`;
  card.appendChild(amountIn);

  const row = el('div', 'display:flex;gap:8px');
  const btnCss = 'flex:1;padding:9px;border-radius:6px;font-size:12px;font-weight:700;cursor:pointer;border:none';
  const stakeBtn = el('button', btnCss + ';background:var(--gold);color:#000', 'Stake');
  const unstakeBtn = el('button', btnCss + ';background:var(--surface-2);color:var(--text-1);border:1px solid var(--border)', 'Unstake');
  stakeBtn.addEventListener('click', () => submit('stake', amountIn.value));
  unstakeBtn.addEventListener('click', () => submit('unstake', amountIn.value));
  row.appendChild(stakeBtn);
  row.appendChild(unstakeBtn);
  card.appendChild(row);

  container.appendChild(card);
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
