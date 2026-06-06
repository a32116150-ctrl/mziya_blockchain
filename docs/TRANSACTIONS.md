# Mziya Transactions & AccountState Model

> File: `core/transaction.js`

---

## Transaction Types (`TX_TYPE`)

| Constant | Value | Description |
|----------|-------|-------------|
| `TRANSFER` | `'TRANSFER'` | Send MZY between addresses |
| `MINING` | `'MINING'` | Coinbase reward (mining payout) |
| `STAKE` | `'STAKE'` | Lock MZY to become a validator |
| `UNSTAKE` | `'UNSTAKE'` | Unlock staked MZY |
| `GENESIS` | `'GENESIS'` | Initial distribution (genesis block only) |
| `AI_SUBMISSION` | `'AI_SUBMISSION'` | Federated AI model weight contribution |

---

## Transaction Class

```js
class Transaction {
  from: String|null       // Sender address ('GENESIS' for MINING, null for GENESIS)
  to: String              // Recipient address (or modelId for AI transactions)
  amount: Number          // MZY amount (6 decimal precision)
  type: String            // One of TX_TYPE values
  fee: Number             // Network fee (goes to block producer)
  nonce: Number           // Anti-replay counter (increments per sender)
  data: Object|null       // Arbitrary metadata
  timestamp: Number       // Unix ms
  publicKey: String|null  // Ed25519 public key hex — embedded for self-verification
  signature: String|null  // Ed25519 hex signature
  txHash: String|null     // SHA3-256 of payload
}
```

### Public Key Embedding

Every signed transaction embeds its own **Ed25519 public key**. During `sign()`, the public key is derived from the private key (`ed25519.getPublicKey`) and stored in `tx.publicKey`. During validation, the recipient:

1. Derives the expected MZ address from the embedded public key
2. Checks it matches `tx.from` (prevents address spoofing)
3. Uses the embedded public key to verify the signature
4. Registers the public key in `AccountState.publicKeys` for future lookups

This eliminates the need for a separate `publicKeyMap` registry.

### Payload

The `getPayload()` method returns the canonical payload for signing:

```js
{ from, to, amount, type, fee, nonce, data, timestamp }
```

### Signing

```js
tx.sign(privateKey)
```

- If type is `MINING` or `GENESIS`, no signature is needed — only `txHash` is computed. `MINING` must strictly come from `'GENESIS'`.
- Otherwise:
  1. Derive public key: `publicKey = ed25519.getPublicKey(privateKeyBytes)`
  2. Sign payload: `signature = Ed25519.sign(JSON.stringify(payload), privateKey)`
  3. Compute hash: `hashData(JSON.stringify(payloadWithSignatureAndPublicKey))`

### Hash (`txHash`)

```js
txHash = hashData(JSON.stringify({ ...payload, signature, publicKey }))
```

The hash includes `signature` and `publicKey` — making the transaction tamper-proof end-to-end.

### Validation

```js
tx.validate(accountState, publicKeyMap) → { valid: Boolean, error?: String }
```

Rules (checked in order):

1. **Recipient**: Must be a valid MZ address (`isValidAddress(to)`), unless it's a special type (`AI_SUBMISSION`, `TRAINING_SUBMIT`, `MODEL_DEPLOY`, etc.) which uses model IDs.
2. **Amount**:
   - `AI_SUBMISSION`/`TRAINING_SUBMIT`: must be 0, requires `data.weights` (array) and `data.accuracy` (0–1). Validated by `ai-verifier.js` (Simulated zkML).
   - All others: must be >= 0.000001
3. **Sender**: Non-coinbase txs must have a valid MZ `from` address. `MINING` must come from `'GENESIS'`.
4. **MINING/GENESIS**: `MINING` limits are bounded mathematically by `elapsedMs` logic in `validateBlock()`. Signature check skipped.
5. **Public key**: Must be present for standard txs; derived address must match `from`
6. **Signature**: Must be a valid Ed25519 signature against the embedded `publicKey`
7. **Nonce (replay protection)**: `tx.nonce === accountState.getNonce(from) + 1` — rejects replayed transactions
8. **Balance**: `accountState.getBalance(from) >= amount + fee`

If validation passes, the sender's public key is automatically registered in `accountState.publicKeys`.

---

## Account State

Despite historical references, Mziya uses an **account model** (like Ethereum) for simplicity, not Bitcoin-style UTXOs. The `AccountState` tracks three maps:

```js
class AccountState {
  balances:   Map<address, Number>   // Current balance per address
  nonces:     Map<address, Number>   // Last used nonce per address
  publicKeys: Map<address, String>   // Registered public key per address
}
```

### applyTransaction

```js
applyTransaction(tx):
  if MINING or GENESIS:
    balances[to] += amount            // Just credit the recipient
  else:
    if tx.publicKey not in publicKeys: // Auto-register public key
      register if deriveAddress(pubKey) matches tx.from
    balances[from] -= amount + fee     // Debit sender
    balances[to]   += amount           // Credit recipient
    nonces[from]    = tx.nonce         // Update nonce
```

### applyBlock

Iterates all transactions in a block and calls `applyTransaction` for each.

---

## Factory Helpers

### createMiningReward

```js
function createMiningReward(toAddress, amount, blockIndex) {
  const tx = new Transaction({
    from: 'GENESIS',
    to: toAddress,
    amount,
    type: TX_TYPE.MINING,
    data: { blockIndex },
  });
  tx.txHash = tx.computeHash();
  return tx;
}
```

A MINING transaction is unsigned — it must originate from `'GENESIS'`, and validation skips signature checks for this type. The `blockIndex` is stored in `data` for provenance. Additionally, the amount cannot exceed the hardcap of 100 MZY per transaction.

### createTransfer

```js
function createTransfer({ from, to, amount, fee = 0, nonce, privateKey }) {
  const tx = new Transaction({ from, to, amount, fee, nonce, type: TX_TYPE.TRANSFER });
  tx.sign(privateKey);  // Embeds publicKey, sets signature + txHash
  return tx;
}
```

---

## Serialization

```js
tx.toJSON() → {
  txHash, from, to, amount, type, fee, nonce, data, timestamp, signature, publicKey
}

Transaction.fromJSON(obj) → Transaction instance
```

Transactions are serialized as plain objects for storage and P2P broadcasting. `fromJSON` reconstructs a `Transaction` instance with all fields restored, including `publicKey`.

---

## Transaction History Queries

The `Blockchain.getTransactionHistory(address)` method scans every block in reverse order and collects transactions where `tx.from === address || tx.to === address`. The UI displays up to 20 recent entries with type-appropriate icons and colors.
