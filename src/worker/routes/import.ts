/**
 * Worker-side URL importer: fetches an arbitrary public URL via Cloudflare's edge
 * network, validates it against SSRF rules, and returns the raw HTML for the
 * frontend to process with readability.js + turndown.
 *
 * The Worker does NOT parse HTML — that's left to the browser (DOMParser +
 * Readability) because:
 *   1. Workers V8 runtime has no full DOM (no DOMParser, no document.body)
 *   2. Adding an HTML parser to the Worker bundle violates the "zero new Worker
 *      dependencies" policy for this phase
 *   3. The frontend already has all the parsing machinery from Phase 1/2A
 *
 * Route: POST /api/import/url   body: { url: string }
 * Response: { html: string; finalUrl: string; title: string | null }
 *
 * Security — SSRF protection:
 *   - Only http(s):// allowed
 *   - Hostname must NOT resolve to private / link-local / loopback IPs
 *     (127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16,
 *      0.0.0.0, ::1, fc00::/7, fe80::/10)
 *   - This is defense in depth — Workers fetch from Cloudflare edge nodes so
 *     DNS rebinding is less of a concern, but hostname-level blocking of
 *     private ranges still prevents the most common SSRF patterns.
 */

import { Hono } from 'hono'
import type { AppBindings } from '../env'
import { requireAuth } from '../middleware/auth'
import { ApiError } from '../lib/errors'

export const importRoutes = new Hono<AppBindings>()

importRoutes.use('*', requireAuth)

/** Max HTML size we will fetch (prevents giant pages from eating Worker memory) */
const MAX_HTML_BYTES = 2 * 1024 * 1024 // 2 MB

/** Fetch timeout — Workers free plan has a ~10s CPU limit; 20s is enough for most pages */
const FETCH_TIMEOUT_MS = 20_000

/** Allowed URL protocols */
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:'])

/**
 * Parses + validates the URL, then fetches it via Cloudflare's network edge.
 * Returns raw HTML + resolved title + final URL (after redirects).
 */
importRoutes.post('/url', async (c) => {
  // requireAuth guard above ensures the caller is logged in; we don't need to
  // actually read userId — all authenticated users may fetch URLs via this endpoint
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    throw ApiError.badRequest('Request body must be valid JSON')
  }

  if (typeof body !== 'object' || body === null) {
    throw ApiError.badRequest('Request body must be an object')
  }

  const urlInput = (body as { url?: unknown }).url
  if (typeof urlInput !== 'string' || !urlInput.trim()) {
    throw ApiError.badRequest('Field "url" is required and must be a non-empty string')
  }

  let parsed: URL
  try {
    parsed = new URL(urlInput.trim())
  } catch {
    throw ApiError.badRequest(`Invalid URL: "${urlInput}"`)
  }

  // Protocol check
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    throw ApiError.badRequest(`Unsupported protocol: "${parsed.protocol}". Only http: and https: are allowed.`)
  }

  // SSRF hostname check (blocks IP literals that point to private ranges)
  if (isPrivateIpHost(parsed.hostname)) {
    throw new ApiError(403, 'forbidden', `URL "${parsed.hostname}" resolves to a private/loopback/link-local address and cannot be fetched.`)
  }

  // Block obviously suspicious hostnames
  if (isBlacklistedHostname(parsed.hostname)) {
    throw new ApiError(403, 'forbidden', `Hostname "${parsed.hostname}" is not allowed.`)
  }

  // Cloudflare fetch with edge cache
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

  let response: Response
  try {
    response = await fetch(parsed.toString(), {
      headers: {
        // Identify ourselves as a bot so sites can serve appropriately (vs. block)
        'User-Agent': `Inkstone-URLImport/1.0 (+${new URL(c.req.url).origin})`,
        Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1',
        'Accept-Language': 'en,*;q=0.5',
      },
      signal: controller.signal,
      cf: {
        cacheTtl: 300,
        fetchKey: `inkstone-url-import:${parsed.hostname}:${parsed.pathname}`,
      } as unknown as RequestInitCfProperties,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (message.includes('aborted') || message.includes('abort')) {
      throw new ApiError(504, 'internal', `Timed out after ${FETCH_TIMEOUT_MS / 1000}s while fetching "${parsed.hostname}"`)
    }
    throw new ApiError(502, 'internal', `Failed to fetch URL: ${message}`)
  } finally {
    clearTimeout(timeout)
  }

  if (!response.ok) {
    throw new ApiError(502, 'internal', `Remote server returned HTTP ${response.status} ${response.statusText || ''}`.trim())
  }

  // Check Content-Type — must be HTML
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
  if (contentType && !contentType.includes('text/html') && !contentType.includes('application/xhtml+xml')) {
    throw ApiError.badRequest(`Remote resource is not HTML (got Content-Type: ${contentType || 'unknown'}). Only web pages can be imported.`)
  }

  // Read response body with size cap
  const reader = response.body?.getReader()
  if (!reader) {
    throw new ApiError(502, 'internal', 'Response body is empty or unreadable')
  }

  const chunks: Uint8Array[] = []
  let totalBytes = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    totalBytes += value.byteLength
    if (totalBytes > MAX_HTML_BYTES) {
      throw ApiError.badRequest(`Page HTML exceeds ${Math.round(MAX_HTML_BYTES / 1024 / 1024)}MB — refusing to fetch larger pages to prevent Worker memory exhaustion.`)
    }
    chunks.push(value)
  }

  // Decode — handle charset from Content-Type or default to UTF-8
  const encoding = extractEncoding(contentType)
  const htmlBytes = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    htmlBytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  const html = new TextDecoder(encoding).decode(htmlBytes)

  // Extract <title> for convenience (simple regex, no full DOM parse needed)
  const title = extractTitle(html)

  return c.json({
    html,
    finalUrl: response.url || parsed.toString(),
    title,
  })
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Hostname-level SSRF guard — checks whether the hostname itself is an IP literal
 * that falls into private / reserved ranges. DNS-resolved hostnames are not blocked
 * here (Workers fetching from edge nodes cannot easily pre-resolve hostnames), but
 * IP addresses like "http://127.0.0.1/admin" are caught.
 */
function isPrivateIpHost(hostname: string): boolean {
  // IPv4 pattern (bare IP or bracketed in IPv6)
  const ipv4 = hostname.replace(/^\[|\]$/g, '')
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ipv4)) {
    // 0.0.0.0
    if (ipv4 === '0.0.0.0') return true
    const parts = ipv4.split('.').map(Number) as [number, number, number, number]
    if (parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) return false
    const [a, b] = parts
    // 127.0.0.0/8 (loopback)
    if (a === 127) return true
    // 10.0.0.0/8 (private)
    if (a === 10) return true
    // 172.16.0.0/12 (private, 172.16–172.31)
    if (a === 172 && b >= 16 && b <= 31) return true
    // 192.168.0.0/16 (private)
    if (a === 192 && b === 168) return true
    // 169.254.0.0/16 (link-local)
    if (a === 169 && b === 254) return true
  }
  // IPv6 loopback
  if (ipv4 === '::1') return true
  // IPv6 ULA (fc00::/7)
  if (/^[fd][0-9a-f]{2}:/i.test(ipv4)) return true
  // IPv6 link-local (fe80::/10)
  if (/^fe[89ab][0-9a-f]:/i.test(ipv4)) return true
  return false
}

/** Hard-coded blocklist for hosts that are unambiguously dangerous */
const BLOCKED_HOSTNAME_PATTERNS = [
  /\.local$/i,
  /^localhost$/i,
  /\.internal$/i,
  /\.corp$/i,
  /\.lan$/i,
]

function isBlacklistedHostname(hostname: string): boolean {
  // Strip possible port
  const bare = hostname.split(':')[0] ?? hostname
  return BLOCKED_HOSTNAME_PATTERNS.some((pattern) => pattern.test(bare))
}

/** Extract charset from Content-Type header; default to UTF-8 */
function extractEncoding(contentType: string): string {
  const match = contentType.match(/charset=([a-zA-Z0-9-]+)/i)
  if (match && match[1]) {
    // Normalize common aliases
    const name = match[1].toLowerCase()
    if (name === 'iso-8859-1') return 'windows-1252' // Workers / browsers handle this alias
    return name
  }
  return 'utf-8'
}

/** Simple regex extraction of <title> content from raw HTML — no DOM parser needed */
function extractTitle(html: string): string | null {
  const match = html.match(/<title[^>]*>([^<]+?)<\/title>/is)
  if (!match || !match[1]) return null
  const title = match[1].trim().replace(/\s+/g, ' ')
  return title || null
}
