import {
  createWallet,
  walletFromMnemonic,
  deriveAddress,
  sign,
  verify,
  encryptPrivateKey,
  decryptPrivateKey,
  isValidAddress
} from '../core/wallet.js';

describe('Mziya Wallet & Cryptography', () => {
  let wallet;

  beforeAll(async () => {
    wallet = await createWallet();
  });

  test('should generate a valid 12-word mnemonic wallet', () => {
    expect(wallet.mnemonic.split(' ').length).toBe(12);
    expect(wallet.privateKey).toHaveLength(64);
    expect(wallet.publicKey).toHaveLength(64);
    expect(wallet.address.startsWith('MZ')).toBe(true);
    expect(wallet.address).toHaveLength(40);
  });

  test('should restore wallet accurately from mnemonic', async () => {
    const restored = await walletFromMnemonic(wallet.mnemonic);
    expect(restored.privateKey).toBe(wallet.privateKey);
    expect(restored.publicKey).toBe(wallet.publicKey);
    expect(restored.address).toBe(wallet.address);
  });

  test('should sign and verify transactions', () => {
    const payload = { from: wallet.address, to: 'MZrecipient123', amount: 50 };
    const signature = sign(payload, wallet.privateKey);
    expect(signature).toBeDefined();

    const isValid = verify(payload, signature, wallet.publicKey);
    expect(isValid).toBe(true);

    const isInvalid = verify({ ...payload, amount: 999 }, signature, wallet.publicKey);
    expect(isInvalid).toBe(false);
  });

  test('should encrypt and decrypt private keys securely', async () => {
    const password = 'secure-password-123';
    const encrypted = await encryptPrivateKey(wallet.privateKey, password);
    expect(encrypted.encrypted).toBeDefined();
    expect(encrypted.iv).toBeDefined();
    expect(encrypted.salt).toBeDefined();

    const decrypted = await decryptPrivateKey(encrypted, password);
    expect(decrypted).toBe(wallet.privateKey);
  });

  test('should decrypt legacy private keys with 600,000 iterations fallback', async () => {
    const password = 'legacy-password';
    const enc = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
      'raw', enc.encode(password), { name: 'PBKDF2' }, false, ['deriveKey']
    );
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const key = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: 600_000, hash: 'SHA-256' },
      keyMaterial,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt']
    );
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      enc.encode(wallet.privateKey)
    );
    
    const { bytesToHex } = await import('@noble/hashes/utils');
    const encryptedData = {
      encrypted: bytesToHex(new Uint8Array(encrypted)),
      iv: bytesToHex(iv),
      salt: bytesToHex(salt),
    };
    
    const decrypted = await decryptPrivateKey(encryptedData, password);
    expect(decrypted).toBe(wallet.privateKey);
  });

  test('should validate addresses correctly', () => {
    expect(isValidAddress(wallet.address)).toBe(true);
    expect(isValidAddress('invalid-addr')).toBe(false);
    expect(isValidAddress('MZ' + 'g'.repeat(38))).toBe(false); // g is not valid hex
  });
});
