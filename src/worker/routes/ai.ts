/**
 * Worker AI summarize endpoint: calls the Workers AI llama-3.2-3b-instruct model
 * to generate a concise summary for a single note. No new Worker dependencies —
 * reuses the existing AI binding.
 *
 * Route structure:
 *   POST /api/ai/summarize/:noteId — returns { summary: string }
 *
 * Safety & degradation:
 *   - Guarded by requireAuth (must be logged in)
 *   - Returns 503 Service Unavailable when the AI binding is missing
 *   - 404 / 403 when the note does not exist or is not owned by the caller
 *   - Note content is truncated to 12KB before being sent to the model
 *   - User language is preserved by the system prompt ("use the note's original language")
 */

import { Hono } from 'hono'
import type { AppBindings } from '../env'
import { requireAuth } from '../middleware/auth'
import { ApiError } from '../lib/errors'
import { assertContentSize } from '../lib/request'
import { fuseByRrf, isAiSearchEnabled, searchSemanticNotes, type SemanticSearchHit } from '../mcp/ai-search'

export const aiRoutes = new Hono<AppBindings>()

aiRoutes.use('*', requireAuth)

/** Workers AI text generation model in use: small 3B model, free quota is generous (~1000 requests/day) */
const AI_SUMMARY_MODEL = '@cf/meta/llama-3.2-3b-instruct'

/** Max characters of note content sent to the AI (≈12KB UTF-8; reasonable context window for a 3B model) */
const MAX_CONTENT_CHARS_FOR_AI = 12_000

aiRoutes.post('/summarize/:noteId', async (c) => {
  const userId = c.get('userId')
  const noteId = c.req.param('noteId')
  const ai = c.env.AI

  if (!ai) {
    throw new ApiError(503, 'service_unavailable', 'AI functionality is not enabled. Configure the [ai] binding in wrangler.toml via the Cloudflare Dashboard.')
  }

  // Read the note (content + title only, avoid pulling all fields)
  const note = await c.env.DB.prepare(
    'SELECT content, title FROM notes WHERE id = ?1 AND user_id = ?2',
  )
    .bind(noteId, userId)
    .first<{ content: string; title: string }>()

  if (!note) {
    throw ApiError.notFound('Note not found')
  }

  if (!note.content.trim()) {
    throw ApiError.badRequest('This note has no content to summarize')
  }

  // Truncate + build messages
  const content = note.content.slice(0, MAX_CONTENT_CHARS_FOR_AI)
  const messages = [
    {
      role: 'system',
      content:
        'You are a concise note-summarization assistant. Summarize the user\'s note in 3–5 sentences, highlighting the key points and conclusions. Use the same language as the note itself.',
    },
    {
      role: 'user',
      content: `Please summarize the following note:\n\nTitle: ${note.title}\n\n${content}`,
    },
  ]

  let result: { response?: string } | unknown = {}
  try {
    result = await ai.run<{ response?: string }>(AI_SUMMARY_MODEL, { messages })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[inkstone] AI summarize model error:', message)
    throw new ApiError(502, 'ai_model_error', `AI model call failed: ${message}`)
  }

  const summary =
    (typeof result === 'object' && result !== null && 'response' in result
      ? (result as { response?: string }).response
      : '') ?? ''

  if (!summary.trim()) {
    throw new ApiError(502, 'ai_model_empty', 'AI returned an empty result, please try again later')
  }

  // Safety check (the content theoretically never exceeds the limit, but keep a defensive assertion)
  assertContentSize(summary)

  return c.json({ summary: summary.trim() }, 200)
})

/**
 * Extracts the Mermaid code from a model response — the model may wrap it in
 * a ```mermaid ... ``` fence, output plain code, or mix code with prose.
 * We try the fence first, fall back to extracting lines that look like Mermaid,
 * and finally strip any leading "Here's a diagram" preamble.
 */
function extractMermaidCode(raw: string): string | null {
  // 1. ```mermaid ... ``` fence
  const fenced = raw.match(/```mermaid\s*\n([\s\S]*?)```/i)
  if (fenced && fenced[1]) {
    const code = fenced[1].trim()
    if (code) return code
  }
  // 2. ``` ... ``` fence (no language hint)
  const plainFenced = raw.match(/```\s*\n([\s\S]*?)```/)
  if (plainFenced && plainFenced[1]) {
    const code = plainFenced[1].trim()
    if (code && isLikelyMermaid(code)) return code
  }
  // 3. Fallback: take lines from the first known Mermaid keyword to end
  const lines = raw.split('\n')
  const startIdx = lines.findIndex((l) => /^\s*(graph|flowchart|sequenceDiagram|classDiagram|stateDiagram|erDiagram|gantt|pie|mindmap|timeline|requirementDiagram|gitGraph|journey|quadrantChart|block-beta)\b/i.test(l))
  if (startIdx >= 0) {
    // Drop common closing prose lines that appear after diagram code
    const codeLines = lines.slice(startIdx).filter((l) => !/^\s*Here's|^\s*This |^\s*Note:|^\s*Explanation/i.test(l))
    const code = codeLines.join('\n').trim()
    if (isLikelyMermaid(code)) return code
  }
  return null
}

/** Heuristic: does this block look like valid Mermaid? */
function isLikelyMermaid(code: string): boolean {
  return /\b(graph|flowchart|sequenceDiagram|classDiagram|stateDiagram|erDiagram|gantt|pie|mindmap|timeline)\b/i.test(code)
}

aiRoutes.post('/diagram/:noteId', async (c) => {
  const userId = c.get('userId')
  const noteId = c.req.param('noteId')
  const ai = c.env.AI

  if (!ai) {
    throw new ApiError(503, 'service_unavailable', 'AI functionality is not enabled. Configure the [ai] binding in wrangler.toml via the Cloudflare Dashboard.')
  }

  // Optional body — custom diagram description overrides note-based generation
  let customDescription: string | null = null
  try {
    const body = await c.req.json() as { description?: string } | null
    if (body?.description && body.description.trim()) {
      customDescription = body.description.trim().slice(0, 2_000)
    }
  } catch {
    // No body or invalid JSON — fine, fall back to note content
  }

  // Read the note
  const note = await c.env.DB.prepare(
    'SELECT content, title FROM notes WHERE id = ?1 AND user_id = ?2',
  )
    .bind(noteId, userId)
    .first<{ content: string; title: string }>()

  if (!note) {
    throw ApiError.notFound('Note not found')
  }

  const messages = [
    {
      role: 'system',
      content:
        'You are a Mermaid diagram generator. Given a topic or note, produce a single Mermaid diagram that best visualizes the key concepts, data flow, or relationships. Choose the most appropriate Mermaid diagram type (flowchart, sequence, class, state, ER, gantt, pie, mindmap, etc.). Return ONLY the Mermaid code inside a ```mermaid code block. No explanation text, no prose outside the code block.',
    },
    {
      role: 'user',
      content: customDescription
        ? `Generate a Mermaid diagram for this description:\n\n"${customDescription}"`
        : `Generate a Mermaid diagram that visualizes the key concepts in this note:\n\nTitle: ${note.title}\n\n${note.content.slice(0, MAX_CONTENT_CHARS_FOR_AI)}`,
    },
  ]

  let result: { response?: string } | unknown = {}
  try {
    result = await ai.run<{ response?: string }>(AI_SUMMARY_MODEL, { messages })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[inkstone] AI diagram model error:', message)
    throw new ApiError(502, 'ai_model_error', `AI model call failed: ${message}`)
  }

  const raw =
    (typeof result === 'object' && result !== null && 'response' in result
      ? (result as { response?: string }).response
      : '') ?? ''

  if (!raw.trim()) {
    throw new ApiError(502, 'ai_model_empty', 'AI returned an empty result, please try again later')
  }

  const code = extractMermaidCode(raw)
  if (!code) {
    throw new ApiError(502, 'ai_model_empty', `AI could not generate valid Mermaid. Raw output: ${raw.slice(0, 200)}`)
  }

  // Defensive size check — Mermaid blocks should be small, but keep the assertion
  assertContentSize(code)

  return c.json({ mermaid: code }, 200)
})

/**
 * RAG chat: answers the user's question by searching their personal notes
 * (semantic + lexical, RRF fused) then feeding the top hits as context to llama.
 *
 * Degradation chain:
 *   semantic enabled → fuseByRrf(semantic, lexical) → answer
 *   semantic disabled → pure lexical LIKE search → answer
 *   nothing found    → 404 with actionable message
 *
 * Returns { answer, sources, semanticEnabled, totalContextNotes } so the
 * client can show citations and indicate whether semantic search was active.
 */
aiRoutes.post('/chat', async (c) => {
  const userId = c.get('userId')
  const ai = c.env.AI

  if (!ai) {
    throw new ApiError(503, 'service_unavailable', 'AI functionality is not enabled. Configure the [ai] binding in wrangler.toml via the Cloudflare Dashboard.')
  }

  let question = ''
  try {
    const body = await c.req.json() as { question?: string } | null
    question = body?.question?.trim() ?? ''
  } catch {
    throw ApiError.badRequest('Request body must be valid JSON')
  }

  if (question.length < 3) {
    throw ApiError.badRequest('Question must be at least 3 characters long')
  }
  if (question.length > 500) {
    throw ApiError.badRequest('Question is too long — keep it under 500 characters')
  }

  const { DB } = c.env
  const semEnabled = await isAiSearchEnabled(DB, userId)

  // 1. Semantic search (vector similarity via bge-m3 embeddings)
  const semanticHits: SemanticSearchHit[] = semEnabled
    ? (await searchSemanticNotes(c.env, DB, userId, question, {})) ?? []
    : []

  // 2. Lexical fallback — LIKE on title + excerpt + content
  const lexicalHits = await lexicalSearch(DB, userId, question, 20)

  // 3. Fuse — RRF when both available, otherwise whichever works
  const hits = fuseHits(lexicalHits, semanticHits)

  if (hits.length === 0) {
    throw new ApiError(404, 'not_found',
      semEnabled
        ? 'No relevant notes found. Try rephrasing your question or checking that you have notes indexed.'
        : 'No notes matched your question. Enable AI Search in Settings to improve results.')
  }

  // 4. Pull full content (truncate each hit to keep the prompt small)
  const idList = hits.slice(0, 10).map((h) => h.id)
  const placeholders = idList.map((_, i) => `?${i + 2}`).join(',')
  const notesResult = await DB.prepare(
    `SELECT id, title, content FROM notes WHERE user_id = ?1 AND id IN (${placeholders}) AND deleted_at IS NULL`,
  ).bind(userId, ...idList).all<{ id: string; title: string; content: string }>()

  const byId = new Map(notesResult.results.map((n) => [n.id, n]))
  const orderedNotes = hits
    .slice(0, 10)
    .map((h) => byId.get(h.id))
    .filter((n): n is { id: string; title: string; content: string } => Boolean(n))

  if (orderedNotes.length === 0) {
    throw new ApiError(404, 'not_found', 'No valid notes available for this question')
  }

  // 5. Build context — each note contributes title + truncated content
  const CONTEXT_PER_NOTE = 1_500
  const contextBlocks = orderedNotes.map((n, i) => {
    const truncated = n.content.slice(0, CONTEXT_PER_NOTE)
    const suffix = n.content.length > CONTEXT_PER_NOTE ? ' ... [truncated]' : ''
    return `[Note ${i + 1}: ${n.title}]\n${truncated}${suffix}`
  })
  const context = contextBlocks.join('\n\n')

  // 6. Chat completion
  const messages = [
    {
      role: 'system',
      content:
        "You are a helpful Q&A assistant that answers questions based ONLY on the user's personal notes provided as context. " +
        'If the context does not contain enough information to answer, say so clearly. ' +
        'Always cite which Note number each point comes from (e.g. "According to Note 2..."). ' +
        'Use the same language as the user\'s question. Be concise but thorough.',
    },
    {
      role: 'user',
      content: `Context (my personal notes):\n\n${context}\n\nQuestion: ${question}`,
    },
  ]

  let result: { response?: string } | unknown = {}
  try {
    result = await ai.run<{ response?: string }>(AI_SUMMARY_MODEL, { messages })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[inkstone] AI chat model error:', message)
    throw new ApiError(502, 'ai_model_error', `AI model call failed: ${message}`)
  }

  const answer =
    (typeof result === 'object' && result !== null && 'response' in result
      ? (result as { response?: string }).response
      : '') ?? ''

  if (!answer.trim()) {
    throw new ApiError(502, 'ai_model_empty', 'AI returned an empty answer, please try again later')
  }

  assertContentSize(answer)

  return c.json({
    answer: answer.trim(),
    sources: orderedNotes.slice(0, 5).map((n) => ({ id: n.id, title: n.title })),
    semanticEnabled: semEnabled,
    totalContextNotes: orderedNotes.length,
  })
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Lexical LIKE search — fallback when semantic is unavailable */
async function lexicalSearch(
  db: D1Database,
  userId: string,
  query: string,
  limit: number,
): Promise<Array<{ id: string; title: string; excerpt: string; updatedAt: number }>> {
  // Escape LIKE wildcards the user might type in their query
  const safeQuery = query.replace(/[%_]/g, (c) => `\\${c}`)
  const pattern = `%${safeQuery}%`
  const { results } = await db.prepare(
    `SELECT id, title, excerpt, updated_at FROM notes
       WHERE user_id = ?1 AND deleted_at IS NULL
       AND (title LIKE ?2 ESCAPE '\\' OR excerpt LIKE ?2 ESCAPE '\\' OR content LIKE ?2 ESCAPE '\\')
       LIMIT ?3`,
  ).bind(userId, pattern, limit).all<{ id: string; title: string; excerpt: string; updated_at: number }>()
  return results.map((r) => ({
    id: r.id,
    title: r.title,
    excerpt: r.excerpt ?? '',
    updatedAt: r.updated_at,
  }))
}

/**
 * Fuses lexical + semantic hit lists. If both available, uses reciprocal-rank fusion
 * (rrf from ai-search.ts). If only one is available, uses that list as-is.
 */
function fuseHits(
  lexical: Array<{ id: string; title: string; excerpt: string; updatedAt: number }>,
  semantic: SemanticSearchHit[],
): Array<{ id: string; title: string; excerpt: string; updatedAt: number }> {
  if (semantic.length === 0) return lexical
  if (lexical.length === 0) {
    return semantic.map((h) => ({ id: h.id, title: h.title, excerpt: h.excerpt, updatedAt: h.updatedAt }))
  }
  const fused = fuseByRrf(lexical, semantic, 60)
  return fused.map(({ item }) => ({
    id: item.id,
    title: item.title,
    excerpt: item.excerpt,
    updatedAt: item.updatedAt,
  }))
}
