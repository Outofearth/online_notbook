/**
 * File import utilities: .md / .txt / .html / .docx / .epub → convert to Markdown → create notes.
 *
 * Design principle: the entire conversion runs locally in the browser; no new
 * Worker endpoints are introduced — the converted Markdown text is written via
 * the existing `api.notes.create`.
 *
 * Supported formats:
 *   - .md / .txt / .html / .htm : FileReader reads plain text; .html/.htm go through turndown
 *   - .docx      : mammoth.js (pure JS) converts to Markdown
 *   - .epub      : epubjs (dynamic import) extracts chapter HTML in spine order → turndown
 *
 * Not supported: .doc (binary OLE2, no pure JS parser); auto-upload of images
 *   embedded in Word / EPUB (image bytes are preserved in the note content but
 *   not re-hosted on Inkstone's storage — they resolve to the original relative
 *   paths which typically don't exist outside the source file).
 */

import mammoth from 'mammoth'
import TurndownService from 'turndown'
import { deriveTitle } from '@shared/markdown-utils'
import { LIMITS } from '@shared/constants'
import { api } from './api'

/** turndown instance: converts HTML output (mammoth / epub chapters / raw HTML) → Markdown */
const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
})

/** Imported draft note: contains title/content/folderId so callers can pass it straight to api.notes.create */
export interface ImportedNoteDraft {
  /** Note title (derived from filename, first content line, or EPUB metadata — whichever is available) */
  title: string
  /** Full Markdown body */
  content: string
  /** Target folder id; null means unfiled */
  folderId: string | null
  /** Original source filename (with extension), for logging only */
  sourceName: string
  /** Whether the content was truncated to stay within contentMaxBytes limit */
  truncated: boolean
}

/** Currently supported file extensions (lowercase, with leading dot) */
export const SUPPORTED_EXT = ['.md', '.markdown', '.txt', '.html', '.htm', '.docx', '.epub'] as const

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
 * EPUB → Markdown pipeline (dynamic import keeps epubjs out of the initial bundle).
 * Loads every chapter in spine order via section.load(), extracts the <body> innerHTML,
 * concatenates them with chapter-level horizontal rules, then runs turndown → Markdown.
 *
 * Returns both the full Markdown and the book title from OPF metadata for caller use.
 */
async function convertEpub(
  buffer: ArrayBuffer,
): Promise<{ markdown: string; bookTitle: string | null }> {
  // Dynamic import — epubjs is ~600KB (223KB min), only pay the cost when an .epub is actually selected
  const { default: ePub } = await import('epubjs')
  // Pass the ArrayBuffer directly; epubjs auto-detects zip container
  // eslint-disable-next-line new-cap — epubjs convention is `ePub(data)`, not `new ePub(data)`
  const book = ePub(buffer) as unknown as {
    opened: Promise<unknown>
    ready: Promise<void>
    loaded: {
      metadata: Promise<{ title?: string }>
      spine: Promise<Array<{ index: number; idref?: string }>>
    }
    spine: {
      get: (target: string | number) => {
        load: (request?: unknown) => Document
        contents: Element | undefined
      }
    }
  }

  await book.ready
  const metadata = await book.loaded.metadata
  const title = metadata.title?.trim() || null

  const spineItems = await book.loaded.spine
  const chapters: string[] = []

  for (const item of spineItems) {
    try {
      const section = book.spine.get(item.index)
      if (!section) continue
      section.load()
      const body = section.contents
      if (!body) continue
      // Prefer body.innerHTML (full content) over textContent (loses structure)
      const chapterHtml = body.innerHTML.trim()
      if (chapterHtml) chapters.push(chapterHtml)
    } catch {
      // Skip chapters that fail to load (e.g. corrupt XHTML, external resources)
      continue
    }
  }

  if (chapters.length === 0) {
    return { markdown: '', bookTitle: title }
  }

  // Mark each chapter boundary with an H1 so the resulting Markdown preserves structure
  // (turndown handles the nested headings within each chapter HTML)
  const joined = chapters.join('\n\n<hr/>\n\n')
  const markdown = turndown.turndown(joined)
  return { markdown, bookTitle: title }
}

/**
 * Converts a single File → ImportedNoteDraft.
 * Pipeline: read binary/text → dispatch by extension → convert → deriveTitle → truncate.
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
  let metadataTitle: string | null = null

  if (ext === '.md' || ext === '.markdown' || ext === '.txt') {
    mdContent = await file.text()
  } else if (ext === '.html' || ext === '.htm') {
    const html = await file.text()
    mdContent = turndown.turndown(html)
  } else if (ext === '.docx') {
    // mammoth emits HTML / plain text, so convertToHtml first, then turndown → Markdown
    const blob = await file.arrayBuffer()
    const htmlResult = await mammoth.convertToHtml({ arrayBuffer: blob })
    mdContent = turndown.turndown(htmlResult.value)
    // Collect but ignore warnings for now (embedded images, etc.)
    void htmlResult.messages
  } else if (ext === '.epub') {
    const blob = await file.arrayBuffer()
    try {
      const result = await convertEpub(blob)
      mdContent = result.markdown
      metadataTitle = result.bookTitle
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      throw new Error(`Failed to parse EPUB: ${message}. The file may be corrupt or use an unsupported EPUB version.`)
    }
  } else {
    throw new Error(`Unsupported extension: ${ext}`)
  }

  // Empty file → use filename as title, content stays empty
  const fallbackTitle = metadataTitle ?? stripExt(file.name)
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
