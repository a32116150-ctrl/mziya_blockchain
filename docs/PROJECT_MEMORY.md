# Mziya Project Memory

> Updated: 2026-06-06 (CLI Miner + Wallet Menu)

## Project Status

Mziya is a decentralized blockchain platform for mobile and desktop mining with Proof-of-Intelligence (PoI) and DeCompute — a decentralized ML training market. The codebase is in active development — all core files are written and the Vite build passes with no errors. The UI supports both mobile bottom-nav and desktop sidebar layouts. A terminal-based CLI miner (`cli-miner.js`) provides headless mining on VPS, RPi, or any device with Node.js. A Fly.io bootstrap node deployment was attempted but destroyed (trial not perpetually free); next step is Oracle Cloud or self-host.

## What's Built

### Core (`core/`)
- ✅ `block.js` — Merkle tree, block validation, genesis, serialization
- ✅ `blockchain.js` — Chain, AccountState, mempool integration, ConsensusEngine, validator set, ModelRegistry integration, DeCompute tx handling
- ✅ `consensus.js` — ValidatorSet, Vote, ConsensusEngine with BFT quorum finalization
- ✅ `mempool.js` — Transaction pool with 500-tx cap, 1h TTL
- ✅ `transaction.js` — 10 transaction types (6 core + AI_SUBMISSION + MODEL_DEPLOY + TRAINING_SUBMIT + TRAINING_VERIFY + MODEL_WITHDRAW), validation rules, factory helpers
- ✅ `mining.js` — Tokenomics (halving, golden ratio, floor), session lifecycle, reward claims
- ✅ `wallet.js` — Ed25519 keygen, BIP39 mnemonics, sign/verify, AES-256-GCM encryption
- ✅ `decompute.js` — ModelRegistry, model escrow, submission tracking, verification, compute-based rewards, device benchmark

### Network (`network/`)
- ✅ `peer.js` — Full libp2p node: Noise + Yamux, mDNS + WebRTC(STUN) + DHT + PEX, 6 GossipSub topics, chain sync, consensus vote forwarding, dual browser/Node.js mode, no bootstrap dependency

### Web (`web/`)
- ✅ `index.html` — PWA shell, all CSS vars defined (`--gold`, `--violet`, `--text-primary` etc.), copilot modal with scrollable chat history, PoI bonus badge, MAX send button, responsive desktop layout (sidebar ≥820px)
- ✅ `js/app.js` — SPA orchestrator, lock screen, passkey, DeCompute training (TF.js, 1/day cooldown), P2P orchestration, persistence, AI copilot
- ✅ `js/wallet.js` — Create/import/backup wallet, passkey/private-key/watch-only import, QR display
- ✅ `js/mining.js` — Session tick loop, claim via forgeBlock(), PoI bonus display (reads from `App.blockchain.mempool`)
- ✅ `js/send.js` — Send page with MAX button, local Ed25519 signing, P2P broadcast, demo forge fallback
- ✅ `js/explorer.js` — Block explorer (DOM-built, no innerHTML), custom event navigation refresh
- ✅ `js/decompute.js` — DeCompute UI: device benchmark, available models list, train & earn button, cooldown display, submission flow
- ✅ `js/buffer-polyfill.js` — Buffer polyfill for bip39 in browser (`window.Buffer`)

### CLI Miner (`cli-miner.js`)
- ✅ `cli-miner.js` — Desktop terminal miner with wallet menu (create/import/switch wallets), live status bar, P2P sync, auto-claim, and disk persistence
- ✅ Interactive wallet setup supporting new wallet creation, BIP39 mnemonic import, and private key import

### Bootstrap Node (`bootstrap-node/`)
- ✅ `index.js` — WebSocket listener, DHT server, circuit relay, PeerId/multiaddr output, GossipSub relay
- ✅ `Dockerfile` — `node:22-alpine` Docker image for deployment
- ✅ `fly.toml` — Fly.io config (since destroyed — trial not perpetually free)

### Documentation (`docs/`)
- ✅ `ARCHITECTURE.md` — System diagram, layer architecture, data flow, dependencies, design principles
- ✅ `CORE.md` — Block/Blockchain/Consensus/Mempool detailed reference
- ✅ `MINING.md` — Tokenomics, halving schedule, session lifecycle, PoI bonus, AI training flow
- ✅ `CRYPTO.md` — Ed25519 keygen, BIP39, address derivation, AES encryption, WebAuthn passkey
- ✅ `TRANSACTIONS.md` — 10 transaction types, validation rules, AccountState model, factory helpers
- ✅ `NETWORK.md` — libp2p architecture, transport dual-mode, GossipSub topics, PEX, chain sync, bootstrap node
- ✅ `UI.md` — SPA views, mount points, state management, lock screen, component breakdown, CSS architecture
- ✅ `PROJECT_MEMORY.md` — This file
- ✅ `DEPLOYMENT.md` — Build, deploy, desktop install, bootstrap node, production checklist
- ✅ `DECOMPUTE.md` — DeCompute decentralized ML training market: architecture, ModelRegistry, tx types, compute rewards, company integration paths

## Design Decisions

| Decision | Rationale |
|----------|-----------|
| Vanilla JS (no framework) | Lighter bundle, no virtual DOM overhead, easier PWA debugging |
| libp2p v1.9.x | Mature P2P stack with browser support via WebRTC |
| Ed25519 over secp256k1 | Faster verification, smaller signatures, no Ethereum compatibility needed |
| SHA3-256 over SHA-256 | NIST FIPS 202, no length-extension attacks |
| Account model over UTXO | Simpler for mobile wallet UX, matching app design |
| mDNS + WebRTC + DHT + PEX | Redundant discovery for maximum connectivity without servers |
| BFT consensus (PoA-style) | Low energy, fast finality, fits mobile-first design |
| AI bonus strictly additive | Users who don't train get full base reward — no penalty |
| No bootstrap peers by default | Forces organic mDNS/WebRTC/DHT discovery; env var for production |
| Public key embedded in transactions | Eliminates separate key registry; self-verifying txs |
| Mnemonic encrypted at rest | PBKDF2 (1M iterations) + AES-256-GCM, never stored in plaintext |
| Per-peer rate limiting | Sliding window prevents single-peer DoS |
| Responsive CSS inline in `<style>` (no external file) | Avoids Vite HMR loading-order issues with `<link>` |
| Buffer polyfill with `vite.config.js` `define: { global: 'globalThis' }` | Fixes bip39's `Buffer is not defined` in browser |
| `node:22-alpine` for bootstrap Docker image | `Promise.withResolvers` required by libp2p's `it-queue` |
| AI training cooldown (1/day per model) | Prevents abuse; creates genuine compute scarcity for DeCompute market |
| Training rewards proportional to compute | `reward ∝ speedFactor × accuracyFactor` — faster devices earn more |
| DeCompute: special address MODEL_REGISTRY | Allows registry to deploy/withdraw model escrow without user wallet |
| Service Worker registered at root scope (`/sw.js`) | Overwrites older service worker registrations and correctly caches index.html / manifest.json |
| Mine button locked & non-glowing during active cycle | Prevents user double-clicking or spamming button to trigger duplicate session events, flat style clearly signals locked state |

## Security Fixes Applied

| ID | Severity | Fix | File |
|----|----------|-----|------|
| 1a | CRITICAL | Public key embedded in every tx; validated against derived address | `transaction.js` |
| 1b | CRITICAL | Nonce replay check added (`nonce === accountState.getNonce(from) + 1`) | `transaction.js` |
| 2 | CRITICAL | `validateChain()` rebuilds AccountState and validates every tx signature/balance | `blockchain.js` |
| 3a | CRITICAL | Vote signature uses real Ed25519 via `signer` callback (was `'auto-validated'`) | `peer.js` |
| 3b | CRITICAL | Validator set populated via STAKE transactions in `addBlock()` | `blockchain.js` |
| 3c | CRITICAL | `isValidator()` checks MZ address (not libp2p PeerId) | `peer.js` |
| 4 | HIGH | Mnemonic encrypted with PBKDF2+AES-256-GCM (was plaintext in localStorage) | `wallet.js`, `core/wallet.js`, `app.js` |
| 5 | HIGH | Chain sync validates full AccountState before accepting; size-limited messages | `blockchain.js`, `peer.js` |
| 6 | HIGH | Per-peer rate limiting (20 msg/s); 1 MB message size cap; pendingBlocks cap (100) with TTL (5min) | `peer.js` |
| 7 | HIGH | PBKDF2 iterations raised to 1,000,000 (was 600,000) | `core/wallet.js` |
| 8 | HIGH | All `innerHTML` replaced with `textContent` + DOM construction; no more XSS in explorer/copilot/toasts | `explorer.js`, `app.js`, `wallet.js` |
| 9 | HIGH | Mining rewards broadcast before local add; validated by peers via full block validation | `mining.js`, `blockchain.js` |
| 10 | MEDIUM | `pendingBlocks` array now capped at 100 with 5-minute TTL | `peer.js` |
| 11 | MEDIUM | `from` address validated for non-coinbase transactions | `transaction.js` |
| 16 | MEDIUM | `MiningSession.fromJSON()` copies known fields (no `Object.assign`) | `mining.js` |

## Reliability Fixes (Pass 2 — June 2026)

| # | Fix | Issue | Files |
|---|-----|-------|-------|
| 1 | Chain storage → IndexedDB | localStorage caps at 5-10MB, would crash at ~5k blocks | `app.js` |
| 2 | 21B supply cap enforced | Mining rewards minted from nothing with zero cap check | `mining.js` |
| 3 | `mergeBlocks` continuity check | Any longer peer chain could overwrite chain — no fork verification | `blockchain.js` |
| 4 | Transaction fees credited to miner | Fees deducted from sender but vanished — never paid to block producer | `blockchain.js` |
| 5 | `forgeBlock` proposer check | Blocks could be forged outside proposer's turn when validators exist | `blockchain.js`, `consensus.js` |
| 6 | Consensus engine round management | `selectBlockProposer` defined but never called; no round timeouts | `consensus.js` |
| 7 | AI training on real synthetic data | TF.js trained on random-noise-to-random-noise; accuracy was fake `1 - loss` | `app.js` |
| 8 | Bootstrap node relays GossipSub | Node ran DHT+relay but didn't subscribe to any Mziya topics | `bootstrap-node/index.js` |
| 9 | Watch-only unlock auth | `unlockWatch()` set `locked=false` with zero authentication | `app.js` |
| 10 | Hardcoded USD price removed | `balance * 0.15` replaced with configurable `usdPerMzy` (0=hidden) | `app.js`, `mining.js` |
| 11 | Misleading claims removed | "No 51% attack" replaced with honest validator cartel warning; "AI Copilot" → "Copilot" (rule-based) | `consensus.js`, `index.html` |
| 12 | Dead script removed | `node:start` pointed at nonexistent `node.js` | `package.json` |
| 13 | P2P bootstrap service wired | `@libp2p/bootstrap` imported and used when `BOOTSTRAP_PEERS` set | `peer.js` |

## Reliability Fixes (Pass 3 — June 2026)

| # | Fix | Issue | Files |
|---|-----|-------|-------|
| 14 | Buffer polyfill for bip39 | `ReferenceError: Buffer is not defined` on "Create Wallet" in browser | `web/js/buffer-polyfill.js`, `vite.config.js`, `web/index.html` |
| 15 | Desktop responsive layout | No computer-friendly layout on wide screens | `web/index.html` (inline CSS) |
| 16 | Block explorer card styling | Text edge-to-edge, no padding on `.block-item` | `web/index.html` (CSS) |
| 17 | Bootstrap node Dockerfile → Node 22 | `Promise.withResolvers` not available in Node 20 | `Dockerfile` |
| 18 | Fly.io deploy attempted | No perpetually free option; Oracle Cloud or self-host needed | `fly.toml` (app destroyed) |

## Bug Bounty Fixes (Pass 4 — June 2026)

| # | Bug | Fix | Files |
|---|-----|-----|-------|
| B1 | Balance USD "Price TBD" ugly placeholder | Changed to clean `≈ TBD` text | `app.js` |
| B2 | Copilot balance used hardcoded `0.15` USD | Now uses `App.usdPerMzy` from state | `app.js` |
| B3 | Explorer nav called nonexistent `renderExplorer()` | Custom event `mziya:explorer-navigate` dispatched | `app.js`, `explorer.js` |
| B4 | Copilot chat history had no scrollable container | Added `#copilot-chat-history` div with welcome message | `index.html` |
| B5 | AI console used `Space Mono` font (never loaded) | Changed to `IBM Plex Mono` (already in `<head>`) | `index.html` |
| B6 | 8 undefined CSS vars (`--gold`, `--violet`, `--text-primary` etc.) | Added all missing aliases to `:root` | `index.html` |
| B7 | Copilot button used `var(--nav-height)` (undefined) | Changed to `var(--nav-h)` (correct defined var) | `index.html` |
| B8 | `App.mempool` was detached duplicate — AI txs lost | Removed `App.mempool`; all code uses `App.blockchain.mempool` | `app.js` |
| B9 | `updatePoIBonusDisplay()` read from dead `App.mempool` | Now reads from `App.blockchain.mempool.getAll()` | `app.js` |
| B10 | Same bug in mining.js | Fixed to `app.blockchain.mempool.getAll()` | `mining.js` |
| B11 | `trainLocalAI()` submitted to dead `App.mempool` | Now submits to `App.blockchain.mempool.add()` | `app.js` |
| B15 | `closeModals()` closed `#modal-lock` (security bypass) | Added guard: skips `#modal-lock` element | `app.js` |
| U1 | PoI bonus was tiny grey text | Upgraded to full badge card with icon + mono value | `index.html` |
| U3 | Copilot had no close button | Added X close button in header | `index.html` |
| U6 | Tx history showed "MZY" as timestamp | Changed to `formatTime(tx.timestamp)` | `app.js` |
| U8 | Explorer block detail unstyled (bad CSS classes) | Fixed `detail-row` → `detail-kv`, `detail-key` → `detail-k`, `detail-val` → `detail-v`; tx type colors | `explorer.js` |
| U9 | Send form had no MAX button | Added MAX button; fills `balance - 0.000001` | `index.html`, `app.js` |

**Additional fixes in `send.js`**: Consolidated dead `app.mempool.add(tx)` + redundant `addPendingTransaction()` to single `app.blockchain.addPendingTransaction(tx)`. Fixed status class `status-text success` → `send-status success` (matches stylesheet).

## DeCompute Implementation (Pass 5 — June 2026)

### New Transaction Types
| Type | Code | Purpose |
|------|------|---------|
| MODEL_DEPLOY | `10` | Company deploys a model with escrow deposit |
| TRAINING_SUBMIT | `11` | User submits training results (weights + accuracy) |
| TRAINING_VERIFY | `12` | Verifier confirms training validity |
| MODEL_WITHDRAW | `13` | Company withdraws remaining escrow |

### Core (`core/decompute.js`)
- `ModelRegistry` class with in-memory storage:
  - `deployModel(tx)` — creates model entry with escrow, validates company funds
  - `recordSubmission(tx)` — records weights/accuracy/speedFactor per model
  - `verifySubmission(tx)` — marks submission as verified
  - `getPendingPayouts(modelId)` — computes rewards for unverified submissions
  - `getAvailable()` — returns list of deployable training models
- Default model `mziya-sentiment-v1` seeded in `blockchain.initialize()`
- `computeBenchmark()` — measures device CPU speed (loop-based, returns speedFactor ≈ 1.0 baseline)

### Web UI (`web/js/decompute.js`)
- `initDecompute()` — initializes benchmark, renders panel
- `renderDecomputePanel()` — displays available models with name, provider, escrow, accuracy target, submission count
- `handleDecomputeTrain()` — full training flow: password prompt, TF.js model build, on-device training, accuracy evaluation, TRAINING_SUBMIT tx creation, mempool submission, cooldown set
- Device speedFactor stored in `localStorage key mziya:speedFactor`
- Cooldown (1/day) tracked via `localStorage key mziya:lastAiTrainTime`

### AccountState Integration
- `MODEL_DEPLOY` deducts escrow from company in `AccountState.applyTransaction()`
- `TRAINING_SUBMIT`, `TRAINING_VERIFY`, `AI_SUBMISSION`, `MODEL_WITHDRAW` — no balance change

### Blockchain Integration
- `Blockchain.models` — ModelRegistry instance
- Default model seeded in `blockchain.initialize()`
- `addBlock()` handles all 4 DeCompute tx types via `models.deployModel()`, `models.recordSubmission()`, `models.verifySubmission()`

### Files Changed
| File | What |
|------|------|
| `core/transaction.js` | 4 new tx types (MODEL_DEPLOY, TRAINING_SUBMIT, TRAINING_VERIFY, MODEL_WITHDRAW), AccountState apply rules |
| `core/decompute.js` | NEW — ModelRegistry + benchmark |
| `core/blockchain.js` | ModelRegistry import, default model seeding, DeCompute tx handling in addBlock |
| `web/js/decompute.js` | NEW — DeCompute UI panel |
| `web/js/app.js` | Removed old trainLocalAI + updateTrainButtonState; wired Train AI button to DeCompute; imports initDecompute |
| `web/index.html` | Added `#decompute-panel` div below AI section |

## Billion Dollar Upgrade (Pass 6 — June 2026)

### Mathematical Consensus Hardening
- Implemented strict block reward caps (`maxTheoreticalReward`) based on the physics of elapsed time (`elapsedMs / 3_600_000 * 3.5`).
- Enforced strict monotonic timestamps; blocks cannot go backwards in time or drift >60s into the future.
- Restricted `MINING` transactions to strictly originate from the `'GENESIS'` address.

### Simulated zkML (Deterministic AI Validation)
- Built `core/ai-verifier.js` to mathematically execute the TensorFlow.js dense layer forward pass deterministically.
- Seeded the training and validation synthetic datasets perfectly using the `previousBlockHash` to prevent any possibility of faking accuracy.

### Asynchronous UI (WebWorkers)
- Migrated TF.js training out of `decompute.js` main thread.
- Created `web/js/ai-worker.js` background thread to perform the compute asynchronously, keeping UI strictly at 60fps.

## Known Gaps

1. **No Docker Compose** for multi-node local testing
2. **TURN server** not configured — some restrictive NATs may fail WebRTC (ice-restart-turned on the roadmap)
3. **No block explorer** — the wallet view serves as minimal explorer
4. **No @chainsafe/libp2p-noise in package.json** — currently a transitive dependency only
5. **No benchmarks** — mining rate, chain sync time, P2P latency not profiled
6. **No CI/CD** pipeline configured
8. **Globally, peers without BOOTSTRAP_PEERS cannot discover each other across the internet** — only LAN (mDNS) works out of the box
9. **No perpetually free bootstrap host found yet** — Fly.io trial (7 days) is not free; Oracle Cloud or self-host needed

## Upcoming Roadmap

### Short Term
- [x] DeCompute core (`core/decompute.js`) — ModelRegistry, tx types, compute rewards
- [x] DeCompute UI (`web/js/decompute.js`) — model list, benchmark, train & earn
- [x] Wire existing Train button to DeCompute system
- [ ] Deploy bootstrap node on Oracle Cloud Always Free (2 AMD micro VMs, 1GB RAM) or self-host on RPi
- [ ] `npm run dev` on two browser tabs (same WiFi) — verify mDNS and WebRTC connection, test DeCompute submission
- [ ] `npm run bootstrap` on a headless Linux RPi — verify WebSocket listener + relay + GossipSub relay
- [ ] TURN server config for restrictive NAT environments
- [ ] docker-compose.yml for 3-node local testnet with bootstrap node
- [x] Automated test suite (Jest) for `core/` modules (Transaction, Blockchain, Consensus, ModelRegistry)
- [x] WebWorker multithreading for TF.js to prevent UI freezing
- [x] Mathematical consensus bounds (PoA timestamps and reward max limits)

### Medium Term
- [ ] Fork resolution (`replaceChain` handles same-length forks, total-work comparison)
- [ ] Block explorer page (standalone HTML, served via Vite)
- [ ] Token faucet for testnet onboarding
- [ ] DeCompute: model creator dashboard (deploy/withdraw escrow/view submissions)

### Long Term
- [ ] iOS App Store / Google Play Store deployment via PWA wrapper (e.g. PWA Builder)
- [ ] WebRTC TURN server for global connectivity
- [ ] Subnet/sidechain support for specialized AI model markets
- [ ] DeCompute: ONNX Runtime integration (Phase 2), Docker Container integration (Phase 3)
