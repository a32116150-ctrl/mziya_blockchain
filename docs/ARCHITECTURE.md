# Mziya Architecture Overview

> A decentralized blockchain for mobile mining with Proof-of-Intelligence (PoI)

---

## System Diagram

```
┌─────────────────────────────────────────────────────────┐
│                      Browser (PWA)                       │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────┐  │
│  │ wallet.js   │  │  mining.js   │  │   app.js       │  │
│  │ Key Mgmt    │  │ Session Tick │  │ Orchestrator   │  │
│  │ Passkey     │  │ Claim Reward │  │ Global State   │  │
│  │ Import/Back │  │ PoI Bonus    │  │ UI Updates     │  │
│  └─────────────┘  └──────────────┘  └────────────────┘  │
│  ┌────────────────────────────────────────────────────┐  │
│  │              network/peer.js (P2P)                 │  │
│  │  libp2p · GossipSub · DHT · mDNS · WebRTC · PEX  │  │
│  └────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
                            │
                    WebRTC / WebSockets
                            │
┌─────────────────────────────────────────────────────────┐
│                  Linux / RPi Node                         │
│  ┌────────────────┐  ┌──────────────────────────────┐   │
│  │ bootstrap-node │  │  network/peer.js with         │   │
│  │ (optional)     │  │  WebSocket listener + relay   │   │
│  │ WS + relay     │  │  circuit-relay-server         │   │
│  └────────────────┘  └──────────────────────────────┘   │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────┐  │
│  │ blockchain  │  │ consensus.js │  │   mining.js    │  │
│  │ Chain + State│  │ BFT Voting   │  │ Tokenomics     │  │
│  └─────────────┘  └──────────────┘  └────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

---

## Layer Architecture

### 1. Core Layer (`core/`)
Pure logic — no DOM, no browser APIs, no libp2p.

| Module | Responsibility |
|--------|---------------|
| `wallet.js` | Ed25519 keygen, BIP39 mnemonics, signing, encryption |
| `transaction.js` | TX class, validation, type system, factory helpers |
| `ai-verifier.js` | Deterministic AI inference engine (Simulated zkML) |
| `block.js` | Block structure, Merkle tree, genesis, serialization |
| `blockchain.js` | Chain management, AccountState, mempool integration, aggregation |
| `consensus.js` | BFT validator set, voting, block finalization |
| `mempool.js` | Transaction pool with TTL + size eviction |
| `mining.js` | Tokenomics (halving, rates), session lifecycle, reward claims |

### 2. Network Layer (`network/`)
libp2p-based P2P with no server dependency.

| Module | Responsibility |
|--------|---------------|
| `peer.js` | Full MziyaP2P class: transport, discovery, GossipSub routing, sync, PEX |

### 3. Web Layer (`web/`)
Browser PWA frontend built with vanilla JS + Vite.

| Module | Responsibility |
|--------|---------------|
| `js/app.js` | SPA orchestrator, routing, lock screen, global state, persistence, AI training, P2P connect |
| `js/wallet.js` | Create/import/backup wallet, passkey, watch-only, unlock |
| `js/mining.js` | Session UI, start/confirm/tick/claim, PoI bonus display |
| `js/decompute.js` | AI training UI and WebWorker dispatcher |
| `js/ai-worker.js` | Background WebWorker executing TF.js training |
| `index.html` | Shell with mount points, tooltip HTML, CSS variables |

### 4. Bootstrap Node (`bootstrap-node/`)
Optional lightweight Node.js entry point for the network.

| Module | Responsibility |
|--------|---------------|
| `index.js` | WebSocket listener, DHT server, circuit relay, PeerId display |

---

## Data Flow

### Mining + Claim
```
User taps "Start Session" → mining.js creates MiningSession
  → miner ticks → earned MZY accrues
  → 24h later → claimReward():
     → compute base + PoI bonus
     → create MINING Transaction via createMiningReward()
     → blockchain.mempool.add(tx)
     → blockchain.forgeBlock(address)
     → blockchain.addBlock(block)
     → broadcast block via P2P (GossipSub mziya/block/v1)
```

### Peer-to-Peer Block Sync
```
Peer A forges a block → broadcast via GossipSub
  → Peer B receives → _handleIncomingBlock()
  → If ConsensusEngine exists: pendingBlocks[], cast Vote
  → Votes accumulate → quorum reached → finalize()
  → blockchain.addBlock(finalizedBlock)
```

### AI Training Flow
```
User clicks "Train Local AI Model" → decompute.js
  → decrypt private key (password prompt)
  → dispatch to ai-worker.js (background thread)
  → deterministically seed dataset using `latestBlock.hash`
  → TF.js model trains on 100 seeded samples, 10 epochs
  → extract weights + accuracy
  → return to main thread
  → create AI_SUBMISSION Transaction
  → sign + mempool.add + broadcast
  → 30s delay → updatePoIBonusDisplay()
```

---

## File Dependencies

```
bootstrap-node/index.js
  └── network/peer.js
       ├── core/blockchain.js
       │    ├── core/block.js
       │    ├── core/transaction.js
       │    ├── core/consensus.js
       │    ├── core/mempool.js
       │    └── core/wallet.js (for hash function + address validation)
       └── @libp2p/* + various libp2p modules

core/mining.js
  └── core/transaction.js
  └── core/blockchain.js

web/js/app.js
  ├── core/blockchain.js
  ├── core/mining.js
  ├── network/peer.js
  └── web/js/wallet.js

web/js/wallet.js
  └── core/wallet.js

web/js/mining.js
  └── core/mining.js
```

---

## Design Principles

1. **No server**: Every node is a first-class peer. No backend API, no central authority.
2. **No vendor lock**: All dependencies are open-source. libp2p, Noble crypto, TF.js.
3. **Mobile-first**: The primary UX target is a mobile PWA. The web layer must work on iOS Safari and Android Chrome.
4. **Optional AI**: AI training (PoI bonus) is strictly optional — users who never use it earn full base mining rewards.
5. **Progressive enhancement**: A single browser tab works as a wallet/explorer. P2P networking enhances but doesn't gate the experience.
6. **Deterministic tokenomics**: All emission schedules, halving, and bonuses are computed client-side from the same constants.
