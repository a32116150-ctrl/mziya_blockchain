# Mziya Economy — Supply, Fees, Staking & DeCompute Payouts

> Files: `core/tokenomics.js` · `core/state.js` · `core/transaction.js` · `core/decompute.js` · `core/blockchain.js`
>
> This document describes the consensus rules as implemented. Where older docs
> (MINING.md, TRANSACTIONS.md, DECOMPUTE.md) disagree, this file wins.

MZY has value only if it is **scarce** and people **need it for something**.
The protocol enforces both:

| Goal | How |
|------|-----|
| Scarce | Coins are only created by on-chain mining sessions and validator rewards, each computed exactly by every node. Hard cap 21B. Half of every fee is burned. |
| Needed | Companies must lock MZY to get AI models trained; validators must lock MZY to produce blocks and earn rewards. |

---

## 1. Supply — where MZY comes from

There are exactly two ways new MZY is created:

1. **Mining claims** (`MINING`): pays a miner for a finished 24h session.
2. **Validator rewards**: minted alongside each mining claim, see §3.

Every node tracks `totalSupply` explicitly (`AccountState.totalSupply`), and a block that would push it past 21,000,000,000 is invalid. The last claim before the cap is reduced to whatever is left.

### Mining, step by step

```
MINING_START  (signed, fee-free)   → chain records session.start = block timestamp
   … 24 hours …
MINING        (signed, fee-free)   → amount must equal the chain's computation, exactly
```

The reward is computed by `computeSessionReward()` in `core/tokenomics.js`:

```
rate      = 1.618 / 2^halvings(start)      (floor 0.202 MZY/h)
rate     ×= 1.25 if the miner is a validator at claim time
base      = rate × 24
poiBonus  = base × bestAccuracy × 0.10      (bestAccuracy = best AI_SUBMISSION /
                                             TRAINING_SUBMIT accuracy during the session)
amount    = min(base + poiBonus, remaining supply)
```

A claim is rejected if: there is no open session, fewer than 24h have passed (by block timestamps), the amount differs from the computation by even 0.000001, or it isn't signed by the miner.
Each address can have only one open session, and claiming closes it.

> Referral bonuses are **not** part of consensus (referrals aren't on-chain), so they no longer change the claimable amount.

### What was fixed

| Old behaviour | Now |
|---------------|-----|
| `MINING` txs were unsigned, `from: 'GENESIS'`. Anyone could mint up to 3.5 MZY per hour of block time to any address. | Signed by the miner; amount computed from the on-chain session. |
| `UNSTAKE` added `amount` to your balance without checking you had staked anything. | You can only unstake what you staked. |
| Txs in a block were each checked against the state *before* the block, so two txs could spend the same balance. | Txs are applied one at a time to a copy of the state; any failure rejects the block. |
| Blocks were unsigned; anyone could claim to be the producer. | Blocks are signed (`minerPublicKey` + `signature`) and the key must match `miner`. |
| Applying the genesis block put `NaN` into the balance map, which silently disabled the supply-cap check. | Supply is tracked as its own number. |
| Supplied `txHash` values were trusted. | The hash is recomputed and must match. |
| Network transactions went into the mempool unvalidated. | `addPendingTransaction` validates against the pending state first. |

---

## 2. Fees — burn

Every non-exempt transaction pays at least `MIN_FEE = 0.000001` MZY.

```
burned   = ceil(fee × 50%)      (in micro-MZY)  → destroyed, totalSupply decreases
producer = fee − burned                          → block producer
```

A minimum fee is burned entirely. Fee-exempt (so new users can start with 0 MZY): `MINING_START`, `MINING`, `AI_SUBMISSION`, `TRAINING_SUBMIT`.

---

## 3. Staking — validators

| Rule | Value |
|------|-------|
| Minimum stake to be a validator | 100 MZY (`MIN_STAKE`) |
| Who may produce blocks | Anyone while no validators exist; afterwards **only validators** (any of them, so one offline validator can't stall the chain) |
| Validator reward | Each mining claim mints an extra 10% (`STAKER_REWARD_SHARE`), split among all validators pro-rata by stake (each share rounded down) |
| Mining bonus | +25% on the validator's own mining rate |
| Fees | The producer keeps the unburned half of fees in its block |
| Verifier fees | Validators can verify DeCompute submissions (§4) for 5% |

`STAKE` moves MZY from balance into `stakes`; `UNSTAKE` moves it back (up to the staked amount). The `ValidatorSet` used by the consensus engine is rebuilt from chain state after every block.

---

## 4. DeCompute payouts — the AI market

```
MODEL_DEPLOY      company locks escrow, sets rewardPerSubmission (default: escrow / 100)
TRAINING_SUBMIT   trainer submits weights + claimed accuracy + dataset seedHash
                  → payout reserved from escrow:
                      accuracyFactor = min(1, accuracy / maxExpectedAccuracy)   (must be ≥ 0.3)
                      payout         = rewardPerSubmission × accuracyFactor
                      verifierFee    = payout × 5%
TRAINING_VERIFY   provider or any validator re-evaluates the weights (web worker
                  EVALUATE action) and submits computedAccuracy
                  |computed − claimed| ≤ 0.02 → trainer gets payout, verifier gets fee
                  otherwise → nothing paid, reservation released
MODEL_WITHDRAW    provider closes the model and gets the remaining escrow back
                  (only when no submission is waiting for verification)
```

* Escrow can't be over-committed: a submission is rejected if available (unreserved) escrow can't cover its payout + fee.
* One pending submission per trainer per model; providers can't train their own model; trainers can't verify themselves.
* Unverified submissions expire after 1440 blocks (~24h) and their reservation is released.
* Escrow stays part of `totalSupply`; it is locked, not destroyed.
* `speedFactor` is self-reported, so it's recorded but **doesn't** affect payouts.
* The built-in `mziya-sentiment-v1` is a **practice model** with no escrow: submissions aren't paid but count toward the PoI mining bonus.

---

## 5. Known limits (not solved by this change)

* **Sybil mining.** Anyone can create many wallets and run a session on each. Rewards per session are fixed, so this is a "one wallet = one miner" system with no proof of personhood.
* **Self-reported PoI accuracy.** The PoI bonus (max +10%) uses the miner's claimed accuracy. Only paid DeCompute submissions are verified.
* **Fork choice** still prefers the longer chain (then more transactions). There is no finality-based fork choice, and validators aren't slashed.
* **No unbonding period.** A validator can unstake immediately.
* **Synthetic dataset only.** The worker trains on a seeded synthetic task, so `datasetHash`/`testSetHash` are labels. Real company datasets need the ONNX/container phases in DECOMPUTE.md.
* **Amounts are floating point** rounded to 6 decimals after each step. This is deterministic across JS engines, but integer micro-units would be more robust.
* **Breaking change.** Chains created by older versions fail validation and are reset on load.
