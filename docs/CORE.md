# Mziya Core Blockchain

> Files: `core/block.js` · `core/blockchain.js` · `core/consensus.js` · `core/mempool.js`

---

## Block (`core/block.js`)

### Block Structure

```js
class Block {
  index: Number              // Sequential block height (0 = genesis)
  previousHash: String       // SHA3-256 hex of parent block
  transactions: Array        // Array of transaction objects or Transaction instances
  timestamp: Number          // Unix ms
  miner: String              // Address of block producer
  nonce: Number              // Unused in PoA (reserved for future PoW)
  signature: String|null     // Reserved for BLS aggregate signature from validators
  modelStates: Object        // { modelId: [weights] } — aggregated AI weights
  merkleRoot: String         // SHA3-256 Merkle root of all transactions
  hash: String               // SHA3-256 of block content (excl. transactions)
}
```

### Merkle Tree

`buildMerkleTree()` hashes each transaction with SHA3-256, then recursively pairs and re-hashes until a single root remains. An odd number of nodes duplicates the last node. Empty transaction sets produce `hashData('empty')`.

### Block Validation (`isValid`)

1. `this.hash === this.computeHash()` — hash integrity
2. `this.previousHash === previousBlock.hash` — chain linkage
3. `this.merkleRoot === buildMerkleTree(this.transactions)` — transaction integrity
4. `this.index === previousBlock.index + 1` — height continuity

### Chain Validation (`validateBlock`)

In addition to `isValid()`, `blockchain.validateBlock()` enforces the physics of the chain:
1. **Monotonic Timestamps**: A block's timestamp must be strictly greater than its parent (`block.timestamp > previous.timestamp`). Time-travel is impossible.
2. **Future Drift Limits**: Blocks cannot be stamped more than 60 seconds into the future (`Date.now() + 60_000`).
3. **Reward Bounds**: Total mining rewards in the block cannot exceed the physical max rate for the elapsed time (`(elapsedMs / 3_600_000) * 3.5`).
4. **AI Determinism**: If the block contains `AI_SUBMISSION` transactions, the submitted weights are evaluated deterministically using `ai-verifier.js`.

### Genesis Block

`createGenesisBlock()`:
- Index 0, previousHash = `0x0000...0000` (64 zeros)
- Single GENESIS transaction: `{ supply: 21_000_000_000, ticker: 'MZY' }`
- Timestamp: `1748736000000` (2026-06-01 00:00:00 UTC)
- Miner: `'GENESIS'`

---

## Blockchain (`core/blockchain.js`)

### Class: `Blockchain`

**Properties:**
- `chain: Block[]` — canonical chain (array, not linked list)
- `utxo: AccountState` — balance + nonce state
- `mempool: Mempool` — unified transaction pool
- `consensusEngine: ConsensusEngine|null` — BFT consensus driver
- `pendingBlocks: Block[]` — blocks awaiting validator finalization
- `publicKeyMap: Map<address, publicKey>` — registered public keys for signature verification
- `validatorSet: ValidatorSet` — active validator registry
- `globalModelStates: Object` — latest AI aggregated weights from the tip block

**Key Methods:**

| Method | Description |
|--------|-------------|
| `initialize(validatorSet?)` | Create genesis if empty, instantiate ConsensusEngine |
| `addPendingTransaction(tx)` | Validate + add to mempool |
| `forgeBlock(minerAddress)` | Build a Block from all mempool txs + AI weight aggregation |
| `addBlock(block)` | Validate + append to chain, update AccountState, clear mempool |
| `validateBlock(block)` | Integrity check + AI modelStates verification + per-tx validation |
| `validateChain(chain)` | Full chain re-validation from genesis |
| `mergeBlocks(incomingBlocks)` | Replace chain if incoming is longer and valid |
| `receiveVote(voteData)` | Forward vote to ConsensusEngine |
| `getBalance(address)` | Query AccountState balance |
| `getTransactionHistory(address)` | Scan all blocks for matching txs |
| `getStats()` | Height, tx count, supply, validator/model counts |

### AI Weight Aggregation (`aggregateAIWeights`)

1. Collect all AI_SUBMISSION transactions from the pending set
2. Group by `modelId` (default: `'mziya-sentiment-v1'`)
3. For each model, compute accuracy-weighted average of submitted weight vectors:
   ```
   averagedWeights[i] = Σ(weight[i] * accuracy) / Σ(accuracy)
   ```
4. Merge into previous `modelStates` (new model IDs added, existing ones overwritten)

---

## AI Verifier (`core/ai-verifier.js`)

The `AIVerifier` acts as a simulated zkML (Zero-Knowledge Machine Learning) evaluation engine. Since Mziya cannot trust clients to run compute honestly, the verifier deterministically checks submissions.

### Deterministic Seeding
The engine generates a synthetic dataset seeded purely by the `previousBlockHash` (converted into a numerical seed). This guarantees that every node on the network generates the exact same validation dataset without needing a central oracle.

### Execution
When a `TRAINING_SUBMIT` or `AI_SUBMISSION` enters the mempool:
1. The engine builds the deterministic validation set.
2. It executes a mathematical forward pass (Dot product + ReLU) using the submitted weights.
3. If the actual accuracy diverges significantly from the claimed accuracy, the transaction is rejected as fraudulent.

### Transaction Validation in Blocks

Every transaction in a block passes through `Transaction.validate(accountState, publicKeyMap)`:
- Valid recipient address (`MZ` + 38 hex chars)
- Non‑zero amount (except AI_SUBMISSION which must have amount=0)
- Valid Ed25519 signature against registered public key
- Sufficient balance for amount + fee

---

## Consensus (`core/consensus.js`)

### ValidatorSet

```js
class ValidatorSet {
  validators: Map<address, { address, publicKey, stake, active, registeredAt }>
}
```

| Method | Description |
|--------|-------------|
| `register(address, publicKey, stake)` | Add a validator |
| `unregister(address)` | Mark as inactive (not removed) |
| `getActive()` | All currently active validators |
| `count()` | Number of active validators |
| `quorum()` | `Math.floor((n * 2) / 3) + 1` — minimum for 2/3 supermajority |
| `isValidator(address)` | Check if address is registered and active |

### Vote

```js
class Vote {
  blockHash: String
  validatorAddress: String
  signature: String          // Ed25519 signature of { blockHash, validatorAddress, timestamp }
  timestamp: Number
}
```

`Vote.isValid(validatorSet)` — verifies the Ed25519 signature against the validator's registered public key.

### ConsensusEngine

```js
class ConsensusEngine {
  validatorSet: ValidatorSet
  pendingVotes: Map<blockHash, Vote[]>
  finalizedBlocks: Set<blockHash>
  onFinalize: callback({ blockHash, votes, finalizedAt })
}
```

- `castVote(vote)` — validates the voter and signature, appends to pending votes. When votes ≥ quorum, finalizes the block.
- `finalizeBlock(blockHash, votes)` — marks block as finalized, invokes `onFinalize` callback.
- `isFinalized(blockHash)` — check if a block has already been finalized.
- `recordActivity(address, signature, publicKey)` — validates a daily activity proof (PoA tap).

### Block Proposer Selection

`selectBlockProposer(validatorSet, blockIndex)` — simple round-robin: `active[blockIndex % active.length]`. Planned upgrade to VRF-based selection for production.

---

## Mempool (`core/mempool.js`)

```js
class Mempool {
  pool: Map<txHash, { tx: Transaction, receivedAt: Number }>
  maxSize: Number (default 500)
  maxAgeSec: Number (default 3600)
}
```

| Method | Description |
|--------|-------------|
| `add(tx)` | Insert if not duplicate, evict oldest if full |
| `has(txHash)` | Duplicate check |
| `getAll()` | Return all transactions as an array |
| `remove(txHash)` | Remove single |
| `removeMany(txHashes)` | Remove a set (used after block inclusion) |
| `evictOldest()` | Remove expired entries, then oldest if still over maxSize |

The mempool is per-peer with no central server. Transactions that are too old (>1h) or get included in a block are evicted automatically.
