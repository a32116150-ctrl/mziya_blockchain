# Mziya Cryptography & Wallet System

> File: `core/wallet.js`

---

## Key Generation

### Ed25519

All keys use the **Edwards-curve Digital Signature Algorithm (Ed25519)**, implemented via `@noble/curves/ed25519`. Ed25519 provides:

- 32-byte private keys
- 32-byte public keys (derived from private)
- 64-byte signatures
- High performance with constant-time operations

### BIP39 Mnemonics

Wallets are generated from a **128-bit entropy → 12-word BIP39 mnemonic**:

```js
const mnemonic = bip39.generateMnemonic(128);
// e.g. "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"
```

The seed is derived via `bip39.mnemonicToSeed(mnemonic)` (PBKDF2 with 2048 rounds). The first 32 bytes of the seed become the Ed25519 private key.

### Address Derivation

```js
function deriveAddress(publicKeyHex) {
  const hash = sha3_256(hexToBytes(publicKeyHex));
  return 'MZ' + bytesToHex(hash).slice(0, 38);
}
// Result: MZ + 38 hex characters = 40 characters total
// e.g. "MZ8a4f5e2c9b1d7a3e6f8c0b2d4a6e8f0c2a4b6d8"
```

### Address Validation

```js
function isValidAddress(address) {
  return typeof address === 'string'
    && address.startsWith('MZ')
    && address.length === 40
    && /^[0-9a-f]+$/.test(address.slice(2));
}
```

---

## Signing

### Sign

```js
function sign(payload, privateKeyHex) {
  const message = new TextEncoder().encode(JSON.stringify(payload));
  return bytesToHex(ed25519.sign(message, hexToBytes(privateKeyHex)));
}
```

Payload is JSON-stringified before signing. The signature is returned as a hex string (128 hex chars = 64 bytes).

### Verify

```js
function verify(payload, signatureHex, publicKeyHex) {
  const message = new TextEncoder().encode(JSON.stringify(payload));
  return ed25519.verify(hexToBytes(signatureHex), message, hexToBytes(publicKeyHex));
}
```

Returns `false` on any exception (e.g. invalid hex, wrong key length) — never throws.

---

## Private Key & Mnemonic Encryption at Rest

Private keys and mnemonics are **never stored in plain text**. The `encryptData` / `decryptData` pair uses the **Web Crypto API** with:

| Parameter | Value |
|-----------|-------|
| KDF | PBKDF2 with **1,000,000** iterations (OWASP guidelines; backward compatible fallback to 600,000) |
| KDF Hash | SHA-256 |
| Encryption | AES-256-GCM |
| IV | 12 random bytes |
| Salt | 16 random bytes |

The 1,000,000 iteration count makes GPU/ASIC brute-force economically impractical.

```js
// Encrypt
encryptedData = {
  encrypted: Hex,   // AES-256-GCM ciphertext
  iv: Hex,          // 12-byte IV
  salt: Hex,        // 16-byte PBKDF2 salt
  iterations: Int,  // PBKDF2 iterations count (1,000,000)
}
```

Both `encryptPrivateKey(privateKeyHex, password)` and `encryptData(mnemonic, password)` use the same underlying `encryptData` function. The mnemonic is stored as `mnemonicEncrypted` in localStorage — never as plaintext.

The password is prompted from the user on:
- Every transaction signing (send, AI submission)
- Wallet unlock (lock screen)
- Backup/recovery phrase reveal (decrypted on demand, never cached)

---

## Wallet Types

### Standard (mnemonic)
Full keypair derived from BIP39 12-word mnemonic. User can backup/restore.

### Passkey (WebAuthn)
Creates a wallet and secures it with the device's biometric authentication (Touch ID / Face ID / Windows Hello). The private key is still derived from a mnemonic, but the lock screen uses `navigator.credentials.get()` instead of a password prompt.

### Watch-Only
Stores only an address. No private key, no signing capability. Used to track balances of other addresses.

---

## Wallet Storage Format

```json
{
  "address": "MZ8a4f5e2c9b1d7a3e6f8c0b2d4a6e8f0c2a4b6d8",
  "publicKey": "abc123...",
  "privateKeyEncrypted": {
    "encrypted": "hex...",
    "iv": "hex...",
    "salt": "hex..."
  },
  "mnemonic": "abandon abandon abandon...",
  "isPasskey": false,
  "isWatchOnly": false
}
```

- `mnemonic` is present only for standard wallets (not passkey/watch-only)
- `privateKeyEncrypted` is absent for watch-only wallets
- `isPasskey` / `isWatchOnly` flags control the lock screen flow

---

## Hash Function

All hashing uses **SHA3-256** from `@noble/hashes/sha3`:

```js
import { sha3_256 } from '@noble/hashes/sha3';
import { bytesToHex } from '@noble/hashes/utils';

export function hashData(data) {
  const bytes = typeof data === 'string'
    ? new TextEncoder().encode(data)
    : data;
  return bytesToHex(sha3_256(bytes));
}
```

SHA3-256 (Keccak-based) was chosen over SHA-256 for its resistance to length-extension attacks and its NIST-standardized status (FIPS 202).
