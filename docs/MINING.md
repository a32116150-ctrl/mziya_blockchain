# Mziya Mining Engine & Tokenomics

> **Note:** the current consensus rules for mining claims, fees, staking and DeCompute payouts are in [ECONOMY.md](ECONOMY.md). Where this page disagrees, ECONOMY.md is correct.

> Files: `core/mining.js` · `web/js/mining.js`

---

## Tokenomics Constants (`TOKENOMICS`)

```js
TOTAL_SUPPLY:        21_000_000_000   // 21 billion MZY hard cap
INITIAL_HOURLY_RATE: 1.618            // Golden ratio base rate (MZY/h)
HALVING_PERIOD_MS:   63_113_472_000   // ~2 years (2 * 365.25 days)
FLOOR_RATE:          0.202            // Minimum rate after all halvings
SESSION_DURATION_MS: 86_400_000       // 24 hours per session
VALIDATOR_BONUS:     0.25             // +25% for running a validator node
REFERRAL_BONUS:      0.05             // +5% per active referred miner (max 10 = +50%)
BLOCK_TIME_MS:       60_000           // Target: 1 block per minute
GENESIS_TIMESTAMP:   1748736000000    // 2026-06-01 00:00:00 UTC
```

### Halving Schedule

```
getCurrentMiningRate(timestamp, referrals, isValidator)
  halvings = floor((timestamp - GENESIS) / HALVING_PERIOD_MS)
  rate = 1.618 / 2^halvings
  rate = max(rate, 0.202)
```

| Year | Rate (MZY/h) |
|------|-------------|
| 0–2  | 1.618 |
| 2–4  | 0.809 |
| 4–6  | 0.404 |
| 6+   | 0.202 (floor) |

### Bonuses

- **Validator**: rate × 1.25
- **Referrals**: rate × (1 + min(referrals, 10) × 0.05) — up to 1.5×
- **PoI (Proof-of-Intelligence)**: additive bonus of `earned × accuracy × 0.10` on top of base reward

---

## Mining Session (`core/mining.js`)

### Lifecycle

```
startSession(address)
  ├─ Compute rate via getCurrentMiningRate()
  ├─ Create MiningSession { address, rate, startTime, endTime, active: true }
  └─ Persist to storage

User taps START button to start session:
  ├─ Compute rate via getCurrentMiningRate()
  ├─ Create MiningSession { address, rate, startTime, endTime, active: true }
  ├─ Persist to storage
  └─ Disable Tap Orb (Mine Button) in UI to prevent double-tapping and exploits

Session runs in background for 24h:
  └─ UI tick loop updates accrued MZY automatically every second

Session expires (24h) → onSessionExpired()
  └─ claimReward(address, blockchain, broadcastTx?, broadcastBlock?)
       ├─ Scans mempool + latest block for AI_SUBMISSION from this address
       ├─ Computes PoI bonus (additive, never subtractive)
       ├─ Creates MINING reward Transaction
       ├─ blockchain.mempool.add(tx)
       ├─ broadcastTx(tx)                                    — P2P broadcast before forging
       ├─ blockchain.forgeBlock(address) → Block
       ├─ broadcastBlock(block)                              — P2P broadcast before local add
       ├─ blockchain.addBlock(block)                         — validated against AccountState and strict time-based reward limits
       ├─ Persist chain
       ├─ Re-enable Tap Orb (Mine Button) in UI for next cycle
       └─ Delete session from storage
```

### MiningSession Class

```js
class MiningSession {
  address: String
  rate: Number               // MZY/h at session start
  referrals: Number
  isValidator: Boolean
  startTime: Number          // Unix ms
  endTime: Number            // startTime + 24h
  active: Boolean
  earned: Number             // Total accrued MZY
  lastUpdate: Number
  sessionId: String          // `${address}-${startTime}`
}
```

| Property/Method | Description |
|----------------|-------------|
| `tick()` | Update `earned` based on `(now - lastUpdate) × rate`. Sets `active=false` if past `endTime`. |
| `expire()` | Tick then mark inactive. |
| `remainingMs` | `max(0, endTime - now)` |
| `remainingHuman` | `HH:MM:SS` format |
| `progressPercent` | `((now - startTime) / SESSION_DURATION_MS) × 100` capped at 100% |

### MiningManager Class

```js
class MiningManager {
  storage: IDBStorage         // IndexedDB persistence
  activeSessions: Map<address, MiningSession>
}
```

Persistence is via the `IDBStorage` wrapper (IndexedDB in browser, LevelDB planned for Node.js). Sessions are stored under keys `session:${address}`.

---

## PoI Bonus (Proof-of-Intelligence)

The bonus is **purely additive** — users who never train AI get 0 bonus and the full base reward. The formula:

```
poiBonus = earned × bestAccuracy × 0.10
total     = earned + poiBonus
```

Where `bestAccuracy` is the highest accuracy found across all `AI_SUBMISSION` transactions in:
1. The current mempool (`blockchain.mempool.getAll()`)
2. The latest block's transactions (`blockchain.latestBlock.transactions`)

The bonus rate is displayed in the UI as `+X.XX% AI bonus` and updated:
- On every claim
- 30 seconds after a successful AI submission

### AI Training Flow (Frontend)

```
User clicks "Train Local AI Model" (optional — BONUS labelled)
  ├─ Prompt for wallet password
  ├─ Decrypt private key in memory
  ├─ Dispatch to background WebWorker (`ai-worker.js`)
  ├─ WebWorker builds TF.js sequential model: Dense(16) → Dense(8) → Dense(1)
  ├─ WebWorker deterministically seeds dataset using `latestBlock.hash`
  ├─ WebWorker trains on 100 seeded samples for 10 epochs
  ├─ WebWorker extracts first layer weights (4 values)
  ├─ WebWorker computes accuracy = clamp(1 - finalLoss, 0.5, 0.99)
  ├─ Returns weights and accuracy to main thread
  ├─ Create AI_SUBMISSION Transaction { from, to: 'AI_NETWORK_POOL', amount: 0, data: { modelId, weights, accuracy } }
  ├─ Sign with Ed25519
  ├─ Add to mempool → broadcast via P2P
  └─ Toast: "AI weights submitted! Your next mining claim will include a bonus up to +10%."
```

## Mathematical Mining Limits

The consensus engine now enforces strict physical bounds on mining rewards inside `core/blockchain.js`. 
Rather than trusting the client's `elapsedMs`, the blockchain evaluates the physical time elapsed between blocks:

```js
const elapsedMs = block.timestamp - previous.timestamp;
// Max theoretical rate: 1.618 base * 1.25 val * 1.50 ref * 1.10 PoI ≈ 3.33 MZY/hr
const maxTheoreticalReward = (elapsedMs / 3_600_000) * 3.5;
```

Any block containing a total mining reward exceeding this physical cap is instantly rejected. This prevents hyper-inflation attacks and time-travel exploits.

---

## UI Mining Page (`web/js/mining.js`)

The mining page has:
- **Balance hero** — current total balance + USD estimate
- **Mining session panel** — rate display, start button / tap orb (which is disabled, flat, and non-glowing during the active 24h cycle to signify that it has been clicked), session stats (earned, rate, timer), progress bar
- **Network strip** — connected peers, current block height, total supply
- **PoI bonus display** — `+0% AI bonus — tap Train to increase` or `+X.XX% AI bonus` in green
- **AI DePIN panel** (optional bonus) — labeled with `BONUS` badge and `Optional` tag. Contains: description text, "Train Local AI Model" button with hover tooltip, terminal-style logs, global aggregated weights display
