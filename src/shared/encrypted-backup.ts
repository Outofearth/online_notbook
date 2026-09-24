/**
 * Client-side password-based encrypted backup module
 *
 * Derives an AES-256 key from the user's password via PBKDF2-SHA256 (600,000 iterations),
 * then encrypts the entire backup binary (ZIP / JSON) with AES-256-GCM.
 *
 * The key is derived entirely inside the browser; the Worker / server never sees the plaintext key.
 *
 * Binary format (.enc file):
 *   [0..5]   MAGIC = "INKENC" (6 bytes)
 *   [6]      VERSION = 1 (1 byte)
 *   [7]      RESERVED = 0x00 (1 byte)
 *   [8..23]  SALT (16 bytes, random)
 *   [24..35] IV (12 bytes, random)
 *   [36..37] KDF_INFO_LEN (2 bytes, little-endian)
 *   [38..38+KDF_INFO_LEN-1] KDF_INFO (JSON, contains iterations / hash and other params)
 *   [38+KDF_INFO_LEN .. END] AES-256-GCM ciphertext (last 16 bytes is the auth tag)
 */

const MAGIC = new Uint8Array([0x49, 0x4e, 0x4b, 0x45, 0x4e, 0x43]) // "INKENC"
const VERSION = 1
const RESERVED = 0x00

const SALT_BYTES = 16
const IV_BYTES = 12
const KDF_INFO_MAX_BYTES = 256

/** PBKDF2 parameters (OWASP 2024 recommended range is 210k-900k, using midpoint) */
const PBKDF2_ITERATIONS = 600_000
const PBKDF2_HASH = 'SHA-256'
const AES_KEY_BYTES = 32 // AES-256

export interface KdfInfo {
  /** Key derivation algorithm */
  kdf: 'PBKDF2'
  /** Hash algorithm, fixed SHA-256 */
  hash: typeof PBKDF2_HASH
  /** Iteration count */
  iterations: number
  /** Derived key length (bytes) */
  keyBytes: typeof AES_KEY_BYTES
}

const DEFAULT_KDF_INFO: KdfInfo = {
  kdf: 'PBKDF2',
  hash: PBKDF2_HASH,
  iterations: PBKDF2_ITERATIONS,
  keyBytes: AES_KEY_BYTES,
}

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }) as TextDecoder

/** Checks whether a binary blob is an encrypted backup file */
export function isEncryptedBackup(data: Uint8Array): boolean {
  if (data.byteLength < 8) return false
  for (let i = 0; i < MAGIC.byteLength; i++) {
    if (data[i] !== MAGIC[i]) return false
  }
  return data[6] === VERSION
}

/** Quick check based on filename suffix (additional fast path, does not depend on magic bytes) */
export function isEncryptedBackupFilename(filename: string): boolean {
  return /\.enc$/i.test(filename)
}

/**
 * Derives an AES-GCM key from a password using PBKDF2
 * @param password The plaintext password entered by the user
 * @param salt Random salt (generated during encryption, read from the file during decryption)
 * @param kdf KDF parameters (read from file during decryption, use defaults during encryption)
 */
export async function deriveAesKey(
  password: string,
  salt: Uint8Array,
  kdf: KdfInfo = DEFAULT_KDF_INFO,
): Promise<CryptoKey> {
  const imported = await crypto.subtle.importKey(
    'raw',
    textEncoder.encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveKey'],
  )
  return await crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt as BufferSource,
      iterations: kdf.iterations,
      hash: kdf.hash as any,
    },
    imported,
    { name: 'AES-GCM', length: kdf.keyBytes * 8 },
    false,
    ['encrypt', 'decrypt'],
  )
}

/** Produces a password strength label (5 tiers only) */
export function passwordStrength(password: string): 0 | 1 | 2 | 3 | 4 {
  if (!password) return 0
  let score = 0
  if (password.length >= 8) score++
  if (password.length >= 16) score++
  if (/[A-Z]/.test(password) && /[a-z]/.test(password)) score++
  if (/\d/.test(password)) score++
  if (/[^A-Za-z0-9]/.test(password)) score++
  return Math.min(4, score) as 0 | 1 | 2 | 3 | 4
}

/**
 * Encrypts an entire backup binary blob
 * @param password User password
 * @param plaintext Raw binary (ZIP / JSON)
 * @returns Encrypted .enc file binary
 */
export async function encryptBackupData(
  password: string,
  plaintext: Uint8Array,
): Promise<Uint8Array> {
  if (password.length === 0) throw new Error('Password must not be empty')
  if (plaintext.byteLength === 0) throw new Error('No data to encrypt')

  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES))
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
  const key = await deriveAesKey(password, salt, DEFAULT_KDF_INFO)

  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    key,
    plaintext as BufferSource,
  )

  const kdfBytes = textEncoder.encode(JSON.stringify(DEFAULT_KDF_INFO))
  if (kdfBytes.byteLength > KDF_INFO_MAX_BYTES) {
    throw new Error('KDF metadata is too long')
  }

  const out = new Uint8Array(8 + SALT_BYTES + IV_BYTES + 2 + kdfBytes.byteLength + ciphertext.byteLength)
  const dv = new DataView(out.buffer)

  // Header
  out.set(MAGIC, 0)
  out[6] = VERSION
  out[7] = RESERVED

  // Salt + IV
  out.set(salt, 8)
  out.set(iv, 8 + SALT_BYTES)

  // KDF info length + body
  const kdfLenOffset = 8 + SALT_BYTES + IV_BYTES
  dv.setUint16(kdfLenOffset, kdfBytes.byteLength, true) // little-endian
  out.set(kdfBytes, kdfLenOffset + 2)

  // Ciphertext
  const cipherOffset = kdfLenOffset + 2 + kdfBytes.byteLength
  out.set(new Uint8Array(ciphertext), cipherOffset)

  return out
}

/**
 * Encrypts a Blob (ZIP / JSON download) — convenience wrapper
 */
export async function encryptBackupBlob(
  password: string,
  blob: Blob,
): Promise<Blob> {
  const plaintext = new Uint8Array(await blob.arrayBuffer())
  const encrypted = await encryptBackupData(password, plaintext)
  const pure = encrypted.buffer.slice(encrypted.byteOffset, encrypted.byteOffset + encrypted.byteLength)
  return new Blob([pure as ArrayBuffer], { type: 'application/octet-stream' })
}

/** Parses the .enc file header, used to extract salt / iv / KDF info before decryption */
function parseEncryptedHeader(data: Uint8Array): {
  salt: Uint8Array
  iv: Uint8Array
  kdf: KdfInfo
  ciphertext: Uint8Array
} {
  if (!isEncryptedBackup(data)) {
    throw new Error('Not an encrypted backup file')
  }
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const kdfLenOffset = 8 + SALT_BYTES + IV_BYTES
  const kdfLen = dv.getUint16(kdfLenOffset, true)
  if (kdfLen === 0 || kdfLen > KDF_INFO_MAX_BYTES) {
    throw new Error('Encrypted file header is corrupt (invalid KDF info length)')
  }
  const kdfBytesOffset = kdfLenOffset + 2
  if (kdfBytesOffset + kdfLen > data.byteLength) {
    throw new Error('Encrypted file header is corrupt (out of file bounds)')
  }
  let kdf: KdfInfo
  try {
    const parsed = JSON.parse(textDecoder.decode(data.subarray(kdfBytesOffset, kdfBytesOffset + kdfLen))) as unknown
    kdf = validateKdfInfo(parsed)
  } catch {
    throw new Error('Encrypted file header is corrupt (invalid KDF info JSON)')
  }
  const cipherOffset = kdfBytesOffset + kdfLen
  if (cipherOffset + 16 > data.byteLength) {
    throw new Error('Encrypted file is too short')
  }
  return {
    salt: data.subarray(8, 8 + SALT_BYTES).slice(),
    iv: data.subarray(8 + SALT_BYTES, 8 + SALT_BYTES + IV_BYTES).slice(),
    kdf,
    ciphertext: data.subarray(cipherOffset).slice(),
  }
}

/** Strictly validates KDF info to ensure parameters are not tampered into weak values */
function validateKdfInfo(value: unknown): KdfInfo {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid_kdf_info')
  }
  const obj = value as Record<string, unknown>
  if (obj.kdf !== 'PBKDF2' || obj.hash !== 'SHA-256' || obj.keyBytes !== AES_KEY_BYTES) {
    throw new Error('unsupported_kdf_params')
  }
  const iterations = obj.iterations
  if (typeof iterations !== 'number' || !Number.isSafeInteger(iterations) || iterations < 100_000 || iterations > 1_000_000) {
    throw new Error('invalid_pbkdf2_iterations')
  }
  return {
    kdf: 'PBKDF2',
    hash: 'SHA-256',
    iterations,
    keyBytes: AES_KEY_BYTES,
  }
}

/**
 * Decrypts .enc file binary
 * @param password Password entered by the user
 * @param data Encrypted backup binary
 * @returns Original plaintext (ZIP / JSON)
 */
export async function decryptBackupData(
  password: string,
  data: Uint8Array,
): Promise<Uint8Array> {
  const header = parseEncryptedHeader(data)
  const key = await deriveAesKey(password, header.salt, header.kdf)
  let decrypted: ArrayBuffer
  try {
    decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: header.iv as BufferSource },
      key,
      header.ciphertext as BufferSource,
    )
  } catch {
    throw new Error('Wrong password or encrypted file is corrupt')
  }
  return new Uint8Array(decrypted)
}

/**
 * Decrypts a Blob — convenience wrapper
 */
export async function decryptBackupBlob(
  password: string,
  blob: Blob,
): Promise<Blob> {
  const data = new Uint8Array(await blob.arrayBuffer())
  const plaintext = await decryptBackupData(password, data)
  const pure = plaintext.buffer.slice(plaintext.byteOffset, plaintext.byteOffset + plaintext.byteLength)
  return new Blob([pure as ArrayBuffer], { type: 'application/zip' })
}
