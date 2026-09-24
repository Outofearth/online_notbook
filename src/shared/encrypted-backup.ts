/**
 * 客户端密码加密备份模块
 *
 * 使用 PBKDF2-SHA256 (600,000 次迭代) 从用户密码派生 AES-256 密钥,
 * 然后用 AES-256-GCM 加密整个备份二进制数据 (ZIP / JSON).
 *
 * 密钥完全在浏览器内派生, Worker / 服务器永远看不到明文密钥.
 *
 * 二进制格式 (.enc 文件):
 *   [0..5]   MAGIC = "INKENC" (6 bytes)
 *   [6]      VERSION = 1 (1 byte)
 *   [7]      RESERVED = 0x00 (1 byte)
 *   [8..23]  SALT (16 bytes, 随机)
 *   [24..35] IV (12 bytes, 随机)
 *   [36..37] KDF_INFO_LEN (2 bytes, little-endian)
 *   [38..38+KDF_INFO_LEN-1] KDF_INFO (JSON, 包含 iterations / hash 等参数)
 *   [38+KDF_INFO_LEN .. END] AES-256-GCM ciphertext (末尾 16 bytes 为 auth tag)
 */

const MAGIC = new Uint8Array([0x49, 0x4e, 0x4b, 0x45, 0x4e, 0x43]) // "INKENC"
const VERSION = 1
const RESERVED = 0x00

const SALT_BYTES = 16
const IV_BYTES = 12
const KDF_INFO_MAX_BYTES = 256

/** PBKDF2 参数 (OWASP 2024 推荐区间 210k-900k, 取中值) */
const PBKDF2_ITERATIONS = 600_000
const PBKDF2_HASH = 'SHA-256'
const AES_KEY_BYTES = 32 // AES-256

export interface KdfInfo {
  /** 密钥派生算法 */
  kdf: 'PBKDF2'
  /** 哈希算法, 固定 SHA-256 */
  hash: typeof PBKDF2_HASH
  /** 迭代次数 */
  iterations: number
  /** 派生密钥长度 (bytes) */
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

/** 判断二进制数据是否为加密备份文件 */
export function isEncryptedBackup(data: Uint8Array): boolean {
  if (data.byteLength < 8) return false
  for (let i = 0; i < MAGIC.byteLength; i++) {
    if (data[i] !== MAGIC[i]) return false
  }
  return data[6] === VERSION
}

/** 判断文件名是否暗示加密备份 (额外的快速判定, 不依赖 magic) */
export function isEncryptedBackupFilename(filename: string): boolean {
  return /\.enc$/i.test(filename)
}

/**
 * 用 PBKDF2 从密码派生 AES-GCM 密钥
 * @param password 用户输入的原始密码
 * @param salt 随机盐 (加密时自己生成, 解密时从文件读取)
 * @param kdf KDF 参数 (解密时从文件读取, 加密时用默认值)
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

/** 生成密码强度标签 (仅 5 档) */
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
 * 加密整个备份二进制数据
 * @param password 用户密码
 * @param plaintext 原始二进制 (ZIP / JSON)
 * @returns 加密后的 .enc 文件二进制
 */
export async function encryptBackupData(
  password: string,
  plaintext: Uint8Array,
): Promise<Uint8Array> {
  if (password.length === 0) throw new Error('密码不能为空')
  if (plaintext.byteLength === 0) throw new Error('没有可加密的数据')

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
    throw new Error('加密参数元数据过长')
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
 * 加密 Blob (ZIP / JSON 下载) — 便捷封装
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

/** 解析 .enc 文件头, 用于在解密前提取 salt / iv / KDF info */
function parseEncryptedHeader(data: Uint8Array): {
  salt: Uint8Array
  iv: Uint8Array
  kdf: KdfInfo
  ciphertext: Uint8Array
} {
  if (!isEncryptedBackup(data)) {
    throw new Error('这不是一个加密备份文件')
  }
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const kdfLenOffset = 8 + SALT_BYTES + IV_BYTES
  const kdfLen = dv.getUint16(kdfLenOffset, true)
  if (kdfLen === 0 || kdfLen > KDF_INFO_MAX_BYTES) {
    throw new Error('加密文件头已损坏 (KDF info 长度无效)')
  }
  const kdfBytesOffset = kdfLenOffset + 2
  if (kdfBytesOffset + kdfLen > data.byteLength) {
    throw new Error('加密文件头已损坏 (超出文件边界)')
  }
  let kdf: KdfInfo
  try {
    const parsed = JSON.parse(textDecoder.decode(data.subarray(kdfBytesOffset, kdfBytesOffset + kdfLen))) as unknown
    kdf = validateKdfInfo(parsed)
  } catch {
    throw new Error('加密文件头已损坏 (KDF info JSON 无效)')
  }
  const cipherOffset = kdfBytesOffset + kdfLen
  if (cipherOffset + 16 > data.byteLength) {
    throw new Error('加密文件过短')
  }
  return {
    salt: data.subarray(8, 8 + SALT_BYTES).slice(),
    iv: data.subarray(8 + SALT_BYTES, 8 + SALT_BYTES + IV_BYTES).slice(),
    kdf,
    ciphertext: data.subarray(cipherOffset).slice(),
  }
}

/** 严格校验 KDF info, 避免参数被篡改为弱值 */
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
 * 解密 .enc 文件二进制
 * @param password 用户输入的密码
 * @param data 加密备份二进制
 * @returns 原始明文 (ZIP / JSON)
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
    throw new Error('密码错误或加密文件已损坏')
  }
  return new Uint8Array(decrypted)
}

/**
 * 解密 Blob — 便捷封装
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
