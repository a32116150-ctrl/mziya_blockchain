/**
 * Mziya Blockchain — Tokenomics & Protocol Parameters
 *
 * Single source of truth for every number that consensus depends on.
 * This module has no imports so it can be used anywhere without cycles.
 */

export const TOKENOMICS = {
  TOTAL_SUPPLY:        21_000_000_000,   // 21 billion MZY hard cap
  INITIAL_HOURLY_RATE: 1.618,            // Golden ratio base rate
  HALVING_PERIOD_MS:   2 * 365.25 * 24 * 60 * 60 * 1000, // 2 years
  FLOOR_RATE:          0.202,            // Minimum rate after all halvings
  SESSION_DURATION_MS: 24 * 60 * 60 * 1000,  // 24 hours per session
  VALIDATOR_BONUS:     0.25,             // +25% mining rate for staked validators
  REFERRAL_BONUS:      0.05,             // +5% per active referred miner (UI only, not on-chain)
  BLOCK_TIME_MS:       60_000,           // 60 seconds per block
  GENESIS_TIMESTAMP:   1748736000000,    // 2026-06-01 00:00:00 UTC
  POI_BONUS_MULTIPLIER: 0.10,            // +10% PoI bonus multiplier
  MAX_MINING_REWARD:    100,             // Sanity cap on a single mining claim
  MAX_THEORETICAL_REWARD_RATE: 3.5,      // Kept for reference; claims are now computed exactly

  // ── Staking ──
  MIN_STAKE:            100,             // MZY staked to become a validator
  STAKER_REWARD_SHARE:  0.10,            // Extra MZY minted per mining claim, shared by validators

  // ── Fees ──
  MIN_FEE:              0.000001,        // Minimum fee for non-exempt transactions
  FEE_BURN_RATE:        0.5,             // Share of every fee that is destroyed

  // ── Limits ──
  MAX_AI_WEIGHTS:       4096,            // Max weights in one AI/training submission
  MAX_TX_DATA_BYTES:    200_000,         // Max serialized size of tx.data
};

export const DECOMPUTE = {
  VERIFICATION_WINDOW_BLOCKS: 1440,      // ~24h at 60s blocks to verify a submission
  VERIFIER_FEE_RATE:    0.05,            // Verifier earns 5% on top of the trainer payout
  ACCURACY_TOLERANCE:   0.02,            // |claimed - measured| allowed for a valid submission
  MIN_ACCURACY_FACTOR:  0.3,             // Submissions below 30% of target are rejected
  DEFAULT_PAYOUT_DIVISOR: 100,           // Default payout per submission = escrow / 100
  PRACTICE_MODEL_ID:    'mziya-sentiment-v1',
};

// ── Fixed-point helpers (6 decimals) ───────────────────────────────────────

export function round6(x) {
  return Math.round(x * 1_000_000) / 1_000_000;
}

/** Round down to 6 decimals — used when splitting so we never pay out more than exists. */
export function floor6(x) {
  return Math.floor(round6(x * 1_000_000) ) / 1_000_000;
}

export function hasMax6Decimals(x) {
  return typeof x === 'number' && Number.isFinite(x) && round6(x) === x;
}

// ── Mining rate ────────────────────────────────────────────────────────────

/**
 * Current hourly mining rate. Halves every 2 years, with a floor.
 */
export function getCurrentMiningRate(timestamp = Date.now(), activeReferrals = 0, isValidator = false) {
  const elapsed = timestamp - TOKENOMICS.GENESIS_TIMESTAMP;
  const halvings = Math.max(0, Math.floor(elapsed / TOKENOMICS.HALVING_PERIOD_MS));

  let rate = TOKENOMICS.INITIAL_HOURLY_RATE / Math.pow(2, halvings);
  rate = Math.max(rate, TOKENOMICS.FLOOR_RATE);

  if (isValidator) rate *= (1 + TOKENOMICS.VALIDATOR_BONUS);
  if (activeReferrals > 0) rate *= (1 + Math.min(activeReferrals, 10) * TOKENOMICS.REFERRAL_BONUS);

  return round6(rate);
}

export function calculateSessionEarnings(durationMs, rate) {
  const hours = durationMs / (60 * 60 * 1000);
  return round6(hours * rate);
}

/**
 * The exact reward a completed 24h mining session pays. Consensus-critical:
 * every node computes this from on-chain state, so a claim must match it exactly.
 */
export function computeSessionReward({ startTimestamp, isValidator = false, bestAccuracy = 0 }) {
  const rate = getCurrentMiningRate(startTimestamp, 0, isValidator);
  const base = calculateSessionEarnings(TOKENOMICS.SESSION_DURATION_MS, rate);
  const acc = Math.min(1, Math.max(0, bestAccuracy || 0));
  const poiBonus = acc > 0 ? round6(base * acc * TOKENOMICS.POI_BONUS_MULTIPLIER) : 0;
  return { rate, base, poiBonus, total: round6(base + poiBonus) };
}
