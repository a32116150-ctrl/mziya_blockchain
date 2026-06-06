/**
 * Mziya Blockchain — Wallet System
 * Ed25519 keypairs + BIP39 12-word mnemonic seed phrases.
 * Private key NEVER leaves the device. All signing is local.
 */

import { ed25519 } from '@noble/curves/ed25519';
import { sha3_256 } from '@noble/hashes/sha3';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import * as bip39 from 'bip39';

// ── Key Generation ─────────────────────────────────────────────────────────

/**
 * Generate a brand new wallet with a 12-word mnemonic.
 * The mnemonic is the master secret — store it safely.
 */
export async function createWallet() {
  const mnemonic = bip39.generateMnemonic(128); // 128 bits = 12 words
  return walletFromMnemonic(mnemonic);
}

/**
 * Restore a wallet from an existing mnemonic phrase.
 */
export async function walletFromMnemonic(mnemonic) {
  if (!bip39.validateMnemonic(mnemonic)) {
    throw new Error('Invalid mnemonic phrase');
  }

  // Derive seed from mnemonic
  const seed = await bip39.mnemonicToSeed(mnemonic);

  // Use first 32 bytes as Ed25519 private key
  const privateKeyBytes = seed.slice(0, 32);
  const publicKeyBytes = ed25519.getPublicKey(privateKeyBytes);

  const privateKey = bytesToHex(privateKeyBytes);
  const publicKey = bytesToHex(publicKeyBytes);
  const address = deriveAddress(publicKey);

  return {
    mnemonic,
    privateKey,
    publicKey,
    address,
  };
}

/**
 * Import wallet from raw private key hex (advanced use).
 */
export function walletFromPrivateKey(privateKeyHex) {
  const privateKeyBytes = hexToBytes(privateKeyHex);
  const publicKeyBytes = ed25519.getPublicKey(privateKeyBytes);
  const publicKey = bytesToHex(publicKeyBytes);
  const address = deriveAddress(publicKey);

  return { privateKey: privateKeyHex, publicKey, address };
}

// ── Address Derivation ─────────────────────────────────────────────────────

/**
 * Mziya address format: MZ + first 38 hex chars of SHA3(publicKey)
 * Example: MZ4a9f2c1b8e3d7a6f5c2b1e9d8c7a6b5f4e3d2c1
 */
export function deriveAddress(publicKeyHex) {
  const pubKeyBytes = hexToBytes(publicKeyHex);
  const hash = sha3_256(pubKeyBytes);
  return 'MZ' + bytesToHex(hash).slice(0, 38);
}

// ── Signing ────────────────────────────────────────────────────────────────

/**
 * Sign any payload with Ed25519 private key.
 * Returns hex signature.
 */
export function sign(payload, privateKeyHex) {
  const message = typeof payload === 'string'
    ? new TextEncoder().encode(payload)
    : new TextEncoder().encode(JSON.stringify(payload));
  const privateKeyBytes = hexToBytes(privateKeyHex);
  const signature = ed25519.sign(message, privateKeyBytes);
  return bytesToHex(signature);
}

/**
 * Verify an Ed25519 signature.
 */
export function verify(payload, signatureHex, publicKeyHex) {
  try {
    const message = typeof payload === 'string'
      ? new TextEncoder().encode(payload)
      : new TextEncoder().encode(JSON.stringify(payload));
    const signature = hexToBytes(signatureHex);
    const publicKey = hexToBytes(publicKeyHex);
    return ed25519.verify(signature, message, publicKey);
  } catch {
    return false;
  }
}

export async function encryptData(plaintext, password) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw', enc.encode(password), { name: 'PBKDF2' }, false, ['deriveKey']
  );
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iterations = 1_000_000;
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt']
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    enc.encode(plaintext)
  );
  return {
    encrypted: bytesToHex(new Uint8Array(encrypted)),
    iv: bytesToHex(iv),
    salt: bytesToHex(salt),
    iterations,
  };
}

export async function decryptData(encryptedData, password) {
  const dec = new TextDecoder();
  const salt = hexToBytes(encryptedData.salt);
  const iv = hexToBytes(encryptedData.iv);
  const encrypted = hexToBytes(encryptedData.encrypted);
  const iterations = encryptedData.iterations || 600_000; // backwards compatibility fallback
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw', enc.encode(password), { name: 'PBKDF2' }, false, ['deriveKey']
  );
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt']
  );
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, encrypted);
  return dec.decode(decrypted);
}

export async function encryptPrivateKey(privateKeyHex, password) {
  return encryptData(privateKeyHex, password);
}

export async function decryptPrivateKey(encryptedData, password) {
  return decryptData(encryptedData, password);
}

// ── Address Validation ─────────────────────────────────────────────────────

export function isValidAddress(address) {
  return typeof address === 'string' &&
    address.startsWith('MZ') &&
    address.length === 40 &&
    /^[0-9a-f]+$/.test(address.slice(2));
}
