# Mziya Blockchain Whitepaper
## A Peer-to-Peer, Mobile-First Cryptographic Ecosystem (MZY)

---

## 1. Introduction

Traditional blockchains like Bitcoin and Ethereum have achieved massive adoption but suffer from two major flaws: **extreme energy consumption** due to Proof-of-Work (PoW), and **increasing centralization** as validation power concentrates in large server farms and mining pools.

Mziya is a **fully decentralized, peer-to-peer (P2P) blockchain ecosystem** that brings cryptocurrency back to everyday users. By replacing resource-intensive mining with a lightweight **Proof-of-Activity (PoA)** model, anyone with a smartphone can mine Mziya Coin (MZY) without battery drain, data overhead, or central server dependencies.

---

## 2. Core Architecture

Mziya operates as a true peer-to-peer network. Every device running the Mziya application acts as a full participant in the network, holding a local copy of the ledger, validating transactions, and contributing to consensus.

```
       [Phone A] ◄───(WebRTC/DHT)───► [Phone B]
           ▲                             ▲
           │                             │
       (WebRTC)                       (WebRTC)
           │                             │
           ▼                             ▼
       [Phone C] ◄──────────────────► [Phone D]
```

### 2.1 Serverless Networking
- **Transport Layer**: Utilizes `libp2p` with WebRTC for browser-to-browser connections and WebSockets for desktop/server nodes.
- **NAT Traversal**: Employs STUN/TURN and circuit relay transports to permit direct connection between devices behind cell towers or home routers.
- **Discovery**: Uses a self-organizing **Kademlia DHT** (Distributed Hash Table) to discover nearby nodes without relying on a central directory.
- **Propagation**: Transactions, blocks, and activity proofs are broadcasted instantly across the network mesh using **GossipSub**.

---

## 3. Cryptographic Foundation

Mziya is built on modern, secure, and industry-standard cryptographic primitives to ensure the network is completely hack-proof.

- **Wallets & Keys**: Accounts utilize **Ed25519 keypairs** (similar to Solana and Polkadot). Private keys never leave the user's device and are encrypted locally using **AES-256-GCM** with a master password.
- **Addresses**: Public addresses are derived securely from public keys using a SHA-3 digest:
  $$\text{Address} = \text{"MZ"} + \text{First 38 characters of } \text{SHA3-256}(\text{PublicKey})$$
- **Transaction Model**: An account-based model with transaction nonces is implemented to prevent replay attacks and ensure double-spend protection.
- **Data Integrity**: Merkle Trees are constructed using **SHA3-256** to create cryptographically secure digests of transaction blocks.

---

## 4. Consensus & Mining: Proof-of-Activity

To solve the energy and access barriers of traditional mining, Mziya utilizes a **Proof-of-Activity (PoA)** model inspired by social consensus systems.

### 4.1 How It Works
1. **Humanity Verification**: A user taps the mining button once every 24 hours to prove they are an active, human participant.
2. **Local Session Accumulation**: An on-device session is initialized, calculating the reward balance in real-time without calling external APIs.
3. **Activity Proof Broadcast**: At the end of the 24-hour cycle, a signed activity proof is broadcasted to validator nodes.
4. **On-Chain Crediting**: The validators verify the signatures and include the coinbase reward transaction in the next block.

## 5. Decentralized Compute (DeCompute) & Proof-of-Intelligence

Mziya introduces a secondary layer of value creation: **DeCompute**. Instead of traditional Proof-of-Work which burns energy on useless hashes, Mziya devices can opt-in to train real Artificial Intelligence models.

### 5.1 Proof-of-Intelligence (PoI)
1. **Background Training**: Users run AI training tasks in the background using WebWorkers, preventing UI disruption.
2. **Deterministic Verification**: When weights are submitted, the Mziya blockchain evaluates them deterministically using a Simulated zkML engine. The test dataset is mathematically seeded by the previous block hash, making it impossible to fake training results.
3. **Reward**: Valid AI submissions grant the miner an additive percentage bonus to their base PoA mining rate.
4. **The DeCompute Market**: Companies can deploy models and deposit MZY into escrow. The network's fleet of mobile devices collaboratively trains the models, and the blockchain automatically distributes the escrow to verified contributors.

---

## 6. Tokenomics (MZY Coin)

Mziya Coin (MZY) has a hard-capped maximum supply, ensuring organic scarcity and inflation protection.

| Parameter | Value |
|-----------|-------|
| **Name** | Mziya Coin |
| **Ticker** | MZY |
| **Total Max Supply** | 21,000,000,000 MZY |
| **Block Time** | 60 seconds |
| **Base Mining Reward** | 1.618 MZY/hour |
| **Halving Schedule** | Every 2 years (reward halves) |
| **Floor Mining Reward** | 0.202 MZY/hour |

### 5.1 Mining Reward Halving Curve
Mining rewards decay exponentially to reward early adopters and protect the long-term purchasing power of the currency:

- **Years 1–2**: $1.618 \text{ MZY/hour}$
- **Years 3–4**: $0.809 \text{ MZY/hour}$
- **Years 5–6**: $0.404 \text{ MZY/hour}$
- **Years 7+**: $0.202 \text{ MZY/hour}$ (Fixed supply floor to maintain miner incentive)

---

## 6. Security & Attack Vectors

Mziya is resilient against common vector threats to peer-to-peer networks:

- **Sybil Attacks**: Mitigated via Web of Trust reputation scores and optional cryptographic identity loops.
- **Double-Spending**: Prevented through a strict validation engine that checks nonces and verifies balances using the AccountState model.
- **Time-Travel & Inflation Attacks**: The consensus engine enforces strict mathematical limits on block timestamps (monotonicity) and physically caps the maximum possible mining reward based on elapsed time, rejecting any hyper-inflationary blocks.
- **AI Fraud**: Simulated zkML ensures that fake AI weights are objectively rejected by the network without relying on trusted Oracles.
- **Server Vulnerabilities**: **Zero risk.** Because there is no central database or company server, there is nothing for a hacker to breach. All balances reside distributed across the ledger on thousands of peer devices.
