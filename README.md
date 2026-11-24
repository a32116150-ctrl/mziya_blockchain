# ⬡ Mziya Blockchain

> Serverless mobile & desktop blockchain with Proof-of-Intelligence (PoI) mining.
> Mine MZY from your phone or terminal — no server, no GPU, no battery drain.

---

## What is Mziya?

Mziya is a mobile-first and desktop blockchain with **zero central infrastructure**. Every device running the app is a full peer — holding a copy of the chain, signing transactions locally, and connecting directly to other nodes via WebRTC.

### Key Features

- **MZY Coin** — 21 billion max supply, halving every 2 years
- **Mine for free** — tap once per day to earn MZY via Proof-of-Activity
- **PoI bonus** — train a tiny AI model on-device for up to +10% mining bonus (optional)
- **Earn by training AI** — companies lock MZY in escrow; trainers are paid once a verifier confirms their accuracy
- **Staking** — lock 100+ MZY to become a validator: produce blocks, share 10% extra on every mining claim, +25% mining
- **Fee burn** — half of every fee is destroyed, so supply shrinks with usage
- **Ed25519 cryptography** — BIP39 12-word mnemonics, all keys encrypted at rest (PBKDF2 1M + AES-256-GCM)
- **Fully P2P** — libp2p with mDNS + WebRTC + Kademlia DHT + GossipSub + Peer Exchange
- **Self-verifying transactions** — every tx carries its own Ed25519 public key, nonce replay protection
- **PWA** — install on your phone's home screen, works offline
- **Responsive UI** — bottom nav on mobile, sidebar nav on desktop (≥820px)
- **Desktop CLI miner** — headless mining on VPS, Raspberry Pi, or any terminal (`node cli-miner.js`)

---

## Quick Start

### Web App (Mobile / Desktop Browser)

```bash
cd mziya
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in a browser. Open a second tab to see P2P discovery in action.

### Desktop CLI Miner (Headless / VPS / RPi)

```bash
cd mziya
npm install
node cli-miner.js
```

The CLI wallet menu lets you create a new wallet or import an existing one, then starts a 24h mining cycle with a live progress bar.

### Build for production

```bash
npm run build
# Output in web/dist/
```

### Run a bootstrap node (Linux/RPi)

```bash
npm run bootstrap
```

---

## Command-Line Miner (CLI)

For headless systems (Linux servers, VPS, or Raspberry Pi) or developers who prefer working in the terminal, Mziya provides a fully functional terminal miner client. 

This client runs natively on **Windows, macOS, and Linux**.

### ASCII Terminal Interface
When launched, you are greeted with a premium, real-time colored ASCII interface:

```text
  ███╗   ███╗███████╗██╗██╗   ██╗ █████╗ 
  ████╗ ████║╚══███╔╝██║╚██╗ ██╔╝██╔══██╗
  ██╔████╔██║  ███╔╝ ██║ ╚████╔╝ ███████║
  ██║╚██╔╝██║ ███╔╝  ██║  ╚██╔╝  ██╔══██║
  ██║ ╚═╝ ██║███████╗██║   ██║   ██║  ██║
  ╚═╝     ╚═╝╚══════╝╚═╝   ╚═╝   ╚═╝  ╚═╝

  ⚡ Mziya Terminal Mining Node 
  Proof-of-Activity (PoA)
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

🔑 Loaded Wallet: MZ12D3...
📦 Loaded Chain Height: 12
🌐 Connecting to P2P network...
🌐 P2P Node Running. ID: QmPeerId...

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🚀 Mining Cycle Status:
[Mining] [████████░░░░] 64% | Rate: 1.6180 MZY/h | Earned: 0.123456 MZY | Peers: 2 | Height: 12 | Ends: 21:32:11
```

### Setup & Run Instructions

#### 1. Download & Install Prerequisites
Ensure you have **Node.js (version >= 20.0.0)** installed on your machine:
* **Linux/macOS**: Install via nvm (`nvm install 22`) or your package manager (`brew install node`).
* **Windows**: Download the installer from the official [Node.js Website](https://nodejs.org/).

#### 2. Get the Source Code & Dependencies
```bash
git clone https://github.com/your-username/mziya.git
cd mziya
npm install
```

#### 3. Run the CLI Miner
Run the following command in your terminal:
```bash
node cli-miner.js
```

### CLI Wallet Menu:

On first run (or when choosing to switch wallets), you are prompted with:

```text
── Wallet Setup ──
  [1] Create new wallet
  [2] Import from 12-word seed phrase
  [3] Import from private key
```

- **Create new wallet** — generates a fresh Ed25519 keypair with a BIP39 12-word mnemonic and saves it to `wallet.json`.
- **Import from seed phrase** — restores a wallet from a 12-word mnemonic phrase.
- **Import from private key** — restores a wallet from a raw Ed25519 private key hex.

On subsequent runs, the CLI detects the existing `wallet.json` and offers to reuse it or switch to a different wallet.

### CLI Features:
- **Interactive Wallet Setup**: Create, import, or switch wallets at startup.
- **Disk-Based Persistence**: Ledger blocks are saved to `blockchain-state.json` and session states to `mining-sessions.json` so your progress is preserved across restarts.
- **P2P Synced**: Resolves peers automatically using local mDNS and public GossipSub relays, executing direct blockchain syncing in the background.
- **Autonomous Claim & Restart**: Automatically loops through the 24-hour cycle, ticking the progress bar every second, auto-claims the mining rewards, and restarts the next cycle without any human intervention.
- **Live Status Bar**: Real-time display of mining rate, MZY earned, wallet balance, connected peers, chain height, and session countdown.

---

## Security

| Threat | Defense |
|--------|---------|
| Signature forgery | Public key embedded in every tx; verified against derived MZ address |
| Replay attacks | Strict nonce check: `tx.nonce === accountState.getNonce(from) + 1` |
| Chain hijacking | `validateChain()` rebuilds full AccountState and validates every tx before accepting |
| Block timestamp manipulation | Mathematical monotonic validation + Max 60s future drift enforced |
| XSS via transactions | All `innerHTML` eliminated — DOM built with `textContent` |
| Key theft from localStorage | Private key + mnemonic encrypted with PBKDF2 (1M) + AES-256-GCM |
| DoS via message flood | Per-peer rate limiting (20 msg/s), 1 MB msg cap, 100-block pending cap with 5min TTL |
| Unauthenticated votes | Optional `signer` callback — votes signed with Ed25519 |
| Double-spend | Block txs applied one by one to a state copy; nonce + balance checked for each |
| Mining reward forgery | Claims are signed by the miner and must equal the reward computed from the on-chain `MINING_START` session |
| Block forgery | Blocks signed by their producer; only staked validators may produce once any exist |
| Unlimited supply | `totalSupply` tracked explicitly; 21B hard cap enforced per block |
| Fake AI Submissions | Paid DeCompute submissions are re-evaluated by the provider or a validator before payout |

All **CRITICAL** and **HIGH** severity vulnerabilities identified in the 2026-06-02 security audit have been fixed.

---

## Architecture

```
mziya/
├── core/                     # Blockchain engine (pure logic, no DOM)
│   ├── ai-verifier.js        # Deterministic AI inference engine (simulated zkML)
│   ├── block.js              # Block structure, Merkle tree, SHA3-256
│   ├── blockchain.js         # Chain, AccountState, mempool, consensus, AI aggregation
│   ├── consensus.js          # ValidatorSet, Vote, BFT engine
│   ├── mempool.js            # Tx pool (500 cap, 1h TTL)
│   ├── mining.js             # Tokenomics, halving, session lifecycle
│   ├── transaction.js        # 6 tx types, Ed25519 signing, validation
│   └── wallet.js             # Ed25519 keygen, BIP39, encrypt/decrypt
├── network/
│   └── peer.js               # libp2p node: mDNS, WebRTC, DHT, GossipSub, PEX, sync
├── web/
│   ├── index.html            # PWA shell, all CSS, lock screen, modals
│   └── js/
│       ├── app.js            # SPA orchestrator, lock screen, AI training (1/day), P2P, copilot
│       ├── ai-worker.js      # Background WebWorker for non-blocking TF.js training
│       ├── wallet.js         # Create/import/backup wallet, passkey, QR, tx history
│       ├── mining.js         # Session UI, claim flow, PoI bonus display
│       ├── send.js           # Send form, MAX button, Ed25519 signing, P2P broadcast
│       ├── explorer.js       # Block explorer (DOM-built, no innerHTML), detail view
│       ├── decompute.js      # AI training UI and WebWorker dispatcher
│       └── buffer-polyfill.js # Buffer polyfill for bip39 in browser
├── cli-miner.js              # Desktop CLI miner (headless, terminal-based)
├── bootstrap-node/           # Optional WebSocket relay + DHT server
│   ├── index.js
│   ├── Dockerfile            # node:22-alpine (for container deployment)
│   └── fly.toml              # Fly.io config (reference only)
├── docs/                     # Architecture, core, mining, crypto, network, UI, etc.
├── tests/                    # Jest test suite (7 suites, 41 tests)
└── package.json
```

### Dual-Mode Networking

| Environment | Transports | Role |
|-------------|-----------|------|
| **Browser** (mobile/desktop PWA) | WebRTC + WebSockets + Circuit Relay | Light client (no voting) |
| **Node.js** (Linux/RPi) | WebSockets + Circuit Relay Server + DHT Server | Full validator (can vote) |

Discovery uses **mDNS** (local WiFi), **Kademlia DHT** (global routing), and **Peer Exchange (PEX)** (GossipSub announcements every 5 minutes). No hardcoded bootstrap servers.

---

## Tokenomics

| Parameter | Value |
|-----------|-------|
| Ticker | MZY |
| Total Supply | 21,000,000,000 |
| Initial Mining Rate | 1.618 MZY/hour (golden ratio) |
| Halving Period | Every 2 years |
| Floor Rate | 0.202 MZY/hour |
| Validator Bonus | +25% (stake ≥ 100 MZY) |
| Validator Reward | +10% of every mining claim, shared by stake |
| Fee | Min 0.000001 MZY; 50% burned, 50% to block producer |
| PoI Bonus | Up to +10% additive (accuracy-weighted) |

Full rules: [docs/ECONOMY.md](docs/ECONOMY.md).

### Halving Schedule

| Year | Rate (MZY/h) |
|------|-------------|
| 0–2  | 1.618 |
| 2–4  | 0.809 |
| 4–6  | 0.404 |
| 6+   | 0.202 (floor) |

---

## Proof-of-Intelligence (PoI)

Training a local AI model is **strictly optional** — base mining works without it. Users who train get an additive bonus:

```
poiBonus = earned × bestAccuracy × 0.10
total     = earned + poiBonus
```

The practice model (`mziya-sentiment-v1`) is a TF.js sequential model trained in a background WebWorker on a dataset seeded by the current block hash. Training it during an open mining session records your accuracy on-chain and raises that session's reward. PoI accuracy is self-reported, which is why the bonus is capped at +10%. Paid DeCompute models are verified before they pay out (see [docs/ECONOMY.md](docs/ECONOMY.md)).

---

## Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| Public key in every tx | No separate key registry needed; self-verifying |
| PBKDF2 1M iterations | OWASP 2026+ guidelines; resists GPU/ASIC brute-force |
| Ed25519 over secp256k1 | Faster verification, smaller sigs, constant-time |
| SHA3-256 over SHA-256 | NIST FIPS 202, no length-extension attacks |
| Vanilla JS (no framework) | Smaller bundle, no virtual DOM, easier PWA debugging |
| Account model (AccountState) | Simpler wallet UX for mobile |
| mDNS + WebRTC + DHT + PEX | Maximum connectivity without servers |

---

## Documentation

See the `docs/` directory for detailed technical references:

- [Architecture](docs/ARCHITECTURE.md)
- [Core Blockchain](docs/CORE.md)
- [Economy: supply, fees, staking, AI payouts](docs/ECONOMY.md)
- [Mining & Tokenomics](docs/MINING.md)
- [Cryptography & Wallets](docs/CRYPTO.md)
- [Transactions](docs/TRANSACTIONS.md)
- [P2P Networking](docs/NETWORK.md)
- [UI / Frontend](docs/UI.md)
- [Deployment Guide](docs/DEPLOYMENT.md)
- [DeCompute ML Market](docs/DECOMPUTE.md)
- [Whitepaper](docs/whitepaper.md)
- [Project Memory & Roadmap](docs/PROJECT_MEMORY.md)

---

## Running a Bootstrap Node

Anyone can run a bootstrap node. They have **zero authority** — they just help peers discover each other. **Requires Node.js v22+**.

```bash
PORT=4001 npm run bootstrap
```

Set `BOOTSTRAP_PEERS` env var on other nodes to point at it:

```bash
BOOTSTRAP_PEERS="/dns4/my-node.example.com/tcp/443/wss/p2p/PEER_ID" npm run dev
```

**Perpetually free hosting options:** Oracle Cloud Always Free, self-host on Raspberry Pi, or a cheap VPS (~$15/yr).

---

## License

MIT — Build on it, fork it, make it yours.
