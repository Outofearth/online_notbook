import { DEFAULT_SETTINGS } from '@shared/constants'
import type { AppLocale, UserSettings } from '@shared/types'

/**
 * Resolves a request locale to one of the locales the app ships.
 * Anything that is not English falls back to Chinese, matching the default UI locale.
 */
export function normalizeLocale(value: unknown): AppLocale {
  return typeof value === 'string' && value.toLowerCase().startsWith('en') ? 'en-US' : 'zh-CN'
}

/**
 * Builds the stored settings blob for a freshly created account: the shared
 * defaults with the requested language applied. Used by every account creation
 * path so self-registration and administrator provisioning stay identical.
 */
export function settingsFor(locale: AppLocale): UserSettings {
  return {
    ...DEFAULT_SETTINGS,
    appearance: { ...DEFAULT_SETTINGS.appearance, language: locale },
    editor: { ...DEFAULT_SETTINGS.editor },
    preview: { ...DEFAULT_SETTINGS.preview },
    backup: { ...DEFAULT_SETTINGS.backup },
    sync: { ...DEFAULT_SETTINGS.sync },
  }
}