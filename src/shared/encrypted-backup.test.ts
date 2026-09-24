import { describe, it, expect } from 'vitest'
import {
  decryptBackupData,
  decryptBackupBlob,
  deriveAesKey,
  encryptBackupData,
  encryptBackupBlob,
  isEncryptedBackup,
  isEncryptedBackupFilename,
  passwordStrength,
} from './encrypted-backup'

describe('encrypted-backup', () => {
  describe('passwordStrength', () => {
    it('对空密码返回 0', () => {
      expect(passwordStrength('')).toBe(0)
    })
    it('8 位纯数字返回 2', () => {
      expect(passwordStrength('12345678')).toBe(2)
    })
    it('混合大小写 + 数字返回 3', () => {
      expect(passwordStrength('Abcd1234')).toBe(3)
    })
    it('长 + 三类字符返回 4', () => {
      expect(passwordStrength('This-Is-A-V3ry-Str0ng-Passw0rd!')).toBe(4)
    })
  })

  describe('isEncryptedBackup', () => {
    it('识别合法 magic number', () => {
      const codes = ['I', 'N', 'K', 'E', 'N', 'C'].map((c) => c.charCodeAt(0))
      const buf = new Uint8Array([...codes, 1, 0]) // magic + version + reserved
      expect(isEncryptedBackup(buf)).toBe(true)
    })
    it('拒绝错误 magic', () => {
      const buf = new Uint8Array([0x50, 0x4b, 0x03, 0x04]) // ZIP magic
      expect(isEncryptedBackup(buf)).toBe(false)
    })
    it('拒绝过短数据', () => {
      expect(isEncryptedBackup(new Uint8Array(4))).toBe(false)
    })
  })

  describe('isEncryptedBackupFilename', () => {
    it('识别 .enc 后缀', () => {
      expect(isEncryptedBackupFilename('backup.enc')).toBe(true)
      expect(isEncryptedBackupFilename('backup.ENC')).toBe(true)
      expect(isEncryptedBackupFilename('backup.zip')).toBe(false)
    })
  })

  describe('deriveAesKey', () => {
    it('相同密码+相同salt能解密出同一明文 (round-trip)', async () => {
      const salt = crypto.getRandomValues(new Uint8Array(16))
      const plaintext = new Uint8Array([1, 2, 3, 4, 5])
      const kdf = { kdf: 'PBKDF2' as const, hash: 'SHA-256' as const, iterations: 100_000, keyBytes: 32 as const }

      const keyA = await deriveAesKey('same-password', salt, kdf)
      const keyB = await deriveAesKey('same-password', salt, kdf)

      const iv = crypto.getRandomValues(new Uint8Array(12))
      const encA = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, keyA, plaintext)
      const decB = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, keyB, encA)
      expect(new Uint8Array(decB)).toEqual(plaintext)
    })
  })

  describe('encryptBackupData / decryptBackupData', () => {
    it('加密 → 解密 round-trip 成功', async () => {
      const plaintext = new Uint8Array(new TextEncoder().encode('# Hello\n\nThis is a test note body.\n'.repeat(100)))
      const encrypted = await encryptBackupData('my-secret-p@ss', plaintext)
      expect(isEncryptedBackup(encrypted)).toBe(true)
      const decrypted = await decryptBackupData('my-secret-p@ss', encrypted)
      expect(decrypted).toEqual(plaintext)
    })

    it('错误密码会抛出', async () => {
      const plaintext = new Uint8Array([1, 2, 3, 4, 5])
      const encrypted = await encryptBackupData('correct', plaintext)
      await expect(decryptBackupData('wrong', encrypted)).rejects.toThrow(/密码错误|损坏/)
    })

    it('空密码会在加密时拒绝', async () => {
      await expect(encryptBackupData('', new Uint8Array([1]))).rejects.toThrow()
    })

    it('空数据会在加密时拒绝', async () => {
      await expect(encryptBackupData('pw', new Uint8Array(0))).rejects.toThrow()
    })

    it('篡改密文会导致解密失败', async () => {
      const plaintext = new Uint8Array([1, 2, 3, 4, 5])
      const encrypted = await encryptBackupData('pw', plaintext)
      // 修改末尾一个字节 (auth tag 区域)
      encrypted[encrypted.length - 1] ^= 0xff
      await expect(decryptBackupData('pw', encrypted)).rejects.toThrow()
    })
  })

  describe('encryptBackupBlob / decryptBackupBlob', () => {
    it('Blob 封装 round-trip', async () => {
      const original = new Blob(['test data blob'.repeat(50)], { type: 'text/plain' })
      const enc = await encryptBackupBlob('abc', original)
      expect(enc.size).toBeGreaterThan(0)
      const dec = await decryptBackupBlob('abc', enc)
      expect(await dec.text()).toBe(await original.text())
    })
  })
})
