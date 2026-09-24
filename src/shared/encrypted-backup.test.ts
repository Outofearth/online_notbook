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
    it('returns 0 for empty password', () => {
      expect(passwordStrength('')).toBe(0)
    })
    it('8-digit numeric-only returns 2', () => {
      expect(passwordStrength('12345678')).toBe(2)
    })
    it('mixed case + digits returns 3', () => {
      expect(passwordStrength('Abcd1234')).toBe(3)
    })
    it('long + three character classes returns 4', () => {
      expect(passwordStrength('This-Is-A-V3ry-Str0ng-Passw0rd!')).toBe(4)
    })
  })

  describe('isEncryptedBackup', () => {
    it('recognizes valid magic number', () => {
      const codes = ['I', 'N', 'K', 'E', 'N', 'C'].map((c) => c.charCodeAt(0))
      const buf = new Uint8Array([...codes, 1, 0]) // magic + version + reserved
      expect(isEncryptedBackup(buf)).toBe(true)
    })
    it('rejects wrong magic', () => {
      const buf = new Uint8Array([0x50, 0x4b, 0x03, 0x04]) // ZIP magic
      expect(isEncryptedBackup(buf)).toBe(false)
    })
    it('rejects too-short data', () => {
      expect(isEncryptedBackup(new Uint8Array(4))).toBe(false)
    })
  })

  describe('isEncryptedBackupFilename', () => {
    it('recognizes .enc suffix', () => {
      expect(isEncryptedBackupFilename('backup.enc')).toBe(true)
      expect(isEncryptedBackupFilename('backup.ENC')).toBe(true)
      expect(isEncryptedBackupFilename('backup.zip')).toBe(false)
    })
  })

  describe('deriveAesKey', () => {
    it('same password + same salt decrypts to the same plaintext (round-trip)', async () => {
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
    it('encrypt → decrypt round-trip succeeds', async () => {
      const plaintext = new Uint8Array(new TextEncoder().encode('# Hello\n\nThis is a test note body.\n'.repeat(100)))
      const encrypted = await encryptBackupData('my-secret-p@ss', plaintext)
      expect(isEncryptedBackup(encrypted)).toBe(true)
      const decrypted = await decryptBackupData('my-secret-p@ss', encrypted)
      expect(decrypted).toEqual(plaintext)
    })

    it('wrong password throws', async () => {
      const plaintext = new Uint8Array([1, 2, 3, 4, 5])
      const encrypted = await encryptBackupData('correct', plaintext)
      await expect(decryptBackupData('wrong', encrypted)).rejects.toThrow(/Wrong password|corrupt/)
    })

    it('empty password is rejected on encrypt', async () => {
      await expect(encryptBackupData('', new Uint8Array([1]))).rejects.toThrow()
    })

    it('empty data is rejected on encrypt', async () => {
      await expect(encryptBackupData('pw', new Uint8Array(0))).rejects.toThrow()
    })

    it('tampered ciphertext causes decrypt failure', async () => {
      const plaintext = new Uint8Array([1, 2, 3, 4, 5])
      const encrypted = await encryptBackupData('pw', plaintext)
      // Flip one byte at the end (in the auth tag region)
      encrypted[encrypted.length - 1] ^= 0xff
      await expect(decryptBackupData('pw', encrypted)).rejects.toThrow()
    })
  })

  describe('encryptBackupBlob / decryptBackupBlob', () => {
    it('Blob wrapper round-trip', async () => {
      const original = new Blob(['test data blob'.repeat(50)], { type: 'text/plain' })
      const enc = await encryptBackupBlob('abc', original)
      expect(enc.size).toBeGreaterThan(0)
      const dec = await decryptBackupBlob('abc', enc)
      expect(await dec.text()).toBe(await original.text())
    })
  })
})
