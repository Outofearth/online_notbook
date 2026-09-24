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
