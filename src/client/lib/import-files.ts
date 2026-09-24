/**
 * File import utilities: .md / .txt / .docx → convert to Markdown → create notes.
 *
 * Design principle: the entire conversion runs locally in the browser; no new
 * Worker endpoints are introduced — the converted Markdown text is written via
 * the existing `api.notes.create`.
 *
 * Supported formats:
 *   - .md / .txt : FileReader reads plain text
 *   - .docx      : mammoth.js (pure JS) converts to Markdown, preserving headings/lists/tables/bold/italic
 *
 * Not supported: .doc (binary OLE2, no pure JS parser); auto-upload of images
 *   embedded in Word (Phase 2; for now image bytes are preserved in the note
 *   with an attachment-style TODO marker).
 */

import mammoth from 'mammoth'
import TurndownService from 'turndown'
import { deriveTitle } from '@shared/markdown-utils'
import { LIMITS } from '@shared/constants'
import { api } from './api'

/** turndown instance: converts mammoth's HTML output → Markdown */
const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
})

/** Imported draft note: contains title/content/folderId so callers can pass it straight to api.notes.create */
export interface ImportedNoteDraft {
  /** Note title (derived from filename or first content line, trimmed) */
  title: string
  /** Full Markdown body */
  content: string
  /** Target folder id; null means unfiled */
  folderId: string | null
  /** Original source filename (with extension), for logging only */
  sourceName: string
  /** Whether the content was truncated to stay within contentMaxBytes limit (caller should prompt) */
  truncated: boolean
}

/** Currently supported file extensions (lowercase, with leading dot) */
export const SUPPORTED_EXT = ['.md', '.markdown', '.txt', '.docx'] as const

/** Checks whether a single filename is in the support list */
export function isSupportedFilename(name: string): boolean {
  const lower = name.toLowerCase()
  return SUPPORTED_EXT.some((ext) => lower.endsWith(ext))
}

/** Strips the extension from a filename to return a "title candidate": report.md → report; Draft notes.docx → Draft notes */
function stripExt(name: string): string {
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return name
  const base = name.slice(0, dot).replace(/[-_]+/g, ' ').trim()
  return base || name
}

/**
 * Truncates content to fit within contentMaxBytes (UTF-8 bytes). A marker comment
 * is appended so the note can still be created successfully.
 */
function enforceByteLimit(content: string, limitBytes: number): { text: string; truncated: boolean } {
  const encoder = new TextEncoder()
  const bytes = encoder.encode(content)
  if (bytes.byteLength <= limitBytes) return { text: content, truncated: false }
  // Find a safe truncation point without splitting UTF-8 surrogate pairs
  const maxChars = Math.floor(content.length * (limitBytes / bytes.byteLength))
  let safe = content.slice(0, maxChars)
  const suffix = `\n\n<!-- truncated: content cut off at ${Math.round(limitBytes / 1024 / 1024)}MB limit; original file still on disk -->\n`
  while (encoder.encode(safe + suffix).byteLength > limitBytes) {
    safe = safe.slice(0, safe.length - 1)
    if (!safe) break
  }
  return { text: safe + suffix, truncated: true }
}

/**
 * Converts a single File → ImportedNoteDraft.
 * Pipeline: read binary → dispatch by extension → .md/.txt use as-is / .docx via mammoth → deriveTitle → truncate.
 */
export async function convertFileToNoteDraft(
  file: File,
  folderId: string | null,
): Promise<ImportedNoteDraft> {
  if (!isSupportedFilename(file.name)) {
    throw new Error(`Unsupported file type: ${file.name}`)
  }

  const ext = '.' + file.name.split('.').pop()!.toLowerCase()
  let mdContent = ''

  if (ext === '.md' || ext === '.markdown' || ext === '.txt') {
    mdContent = await file.text()
  } else if (ext === '.docx') {
    // mammoth emits HTML / plain text, so convertToHtml first, then turndown → Markdown
    const blob = await file.arrayBuffer()
    const htmlResult = await mammoth.convertToHtml({ arrayBuffer: blob })
    mdContent = turndown.turndown(htmlResult.value)
    // Collect but ignore warnings for now (embedded images, etc.) — first version skips them
    void htmlResult.messages
  } else {
    throw new Error(`Unsupported extension: ${ext}`)
  }

  // Empty file → use filename as title, content stays empty
  const fallbackTitle = stripExt(file.name)
  let title = deriveTitle(mdContent, fallbackTitle)
  // deriveTitle trims to 512-char cap internally via trimTitle, no need to handle it here

  // Apply truncation
  const { text, truncated } = enforceByteLimit(mdContent, LIMITS.contentMaxBytes)
  if (truncated) {
    title = title + ' (truncated)'
  }

  return {
    title,
    content: text,
    folderId,
    sourceName: file.name,
    truncated,
  }
}

/**
 * Batch import entry point: FileList → convert each → api.notes.create each → return stats.
 * On failure for a single file it skips and collects the error, continuing with the rest.
 *
 * Caller (Sidebar) is responsible for: creating a hidden <input type="file"> in the UI
 * → listening for change → calling this function → displaying the result. Errors are fed
 * back via Toast / confirm.
 */
export async function importFileList(
  files: FileList,
  folderId: string | null,
  onProgress?: (done: number, total: number, currentName: string) => void,
): Promise<ImportFileResult> {
  const total = files.length
  let created = 0
  let failed = 0
  const errors: string[] = []

  for (let i = 0; i < total; i++) {
    const file = files[i]!
    onProgress?.(i, total, file.name)
    try {
      const draft = await convertFileToNoteDraft(file, folderId)
      await api.notes.create({
        title: draft.title,
        content: draft.content,
        folderId: draft.folderId,
      })
      created++
    } catch (err) {
      failed++
      errors.push(`${file.name}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  onProgress?.(total, total, '')

  return { created, failed, errors, total }
}

/** Return value of importFileList, handed to the UI layer for stats display */
export interface ImportFileResult {
  /** Number of successfully created notes */
  created: number
  /** Number of conversion / creation failures */
  failed: number
  /** Detailed info for every failure (per-file granularity) */
  errors: string[]
  /** Total number of files processed in this run */
  total: number
}
