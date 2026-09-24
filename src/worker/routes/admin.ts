import { Hono } from 'hono'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { JSON_BODY_LIMITS, readJson } from '../lib/request'
import { requireAuth } from '../middleware/auth'
import {
  attachmentCleanupTarget,
  attachmentObjectKey,
  type AttachmentObjectStorage,
  type StoredAttachmentKey,
} from '../attachments/keys'

/** User management routes (owner access only) */
export const adminRoutes = new Hono<AppBindings>()

adminRoutes.use('*', requireAuth)

/** Generic owner-only guard */
function requireOwner(c: { get: (key: 'user') => { role: 'owner' | 'member'; id: string } }) {
  if (c.get('user').role !== 'owner') {
    throw ApiError.forbidden('Only the owner can access this endpoint')
  }
}

/**
 * GET /api/admin/users
 * Returns the list of all users (password hashes excluded)
 */
adminRoutes.get('/users', async (c) => {
  requireOwner(c)
  const result = await c.env.DB.prepare(
    `SELECT id, username, login, name, avatar_url, role, created_at, last_seen_at
       FROM users
       ORDER BY role = 'owner' DESC, created_at ASC`,
  ).all<UserRow>()
  return c.json({
    users: result.results.map((row) => ({
      id: row.id,
      username: row.username,
      login: row.login,
      name: row.name,
      avatarUrl: row.avatar_url,
      role: row.role,
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at,
    })),
  })
})

interface UserRow {
  id: string
  username: string
  login: string
  name: string
  avatar_url: string
  role: 'owner' | 'member'
  created_at: number
  last_seen_at: number
}

/**
 * PATCH /api/admin/users/:id/role
 * Change user role (member ↔ owner)
 * - Owner cannot demote themselves to member (system must keep at least one owner)
 * - Operation is rejected when the target user id does not exist
 */
adminRoutes.patch('/users/:id/role', async (c) => {
  requireOwner(c)
  const targetId = c.req.param('id')!
  const currentUserId = c.get('user').id

  const body = await readJson<{ role?: 'owner' | 'member' }>(c, JSON_BODY_LIMITS.small)
  if (body.role !== 'owner' && body.role !== 'member') {
    throw ApiError.badRequest('role must be "owner" or "member"')
  }
  if (targetId === currentUserId) {
    throw ApiError.badRequest('You cannot change your own role')
  }

  // Read the target user
  const target = await c.env.DB.prepare(
    `SELECT id, role FROM users WHERE id = ?1`,
  ).bind(targetId).first<{ id: string; role: 'owner' | 'member' }>()
  if (!target) throw ApiError.notFound('User not found')

  // If downgrading owner → member, confirm at least one owner remains in the system
  if (target.role === 'owner' && body.role === 'member') {
    const ownerCount = await c.env.DB.prepare(
      `SELECT COUNT(*) AS n FROM users WHERE role = 'owner'`,
    ).first<{ n: number }>()
    if ((ownerCount?.n ?? 0) <= 1) {
      throw ApiError.badRequest('You cannot remove the last owner account')
    }
  }

  await c.env.DB.prepare(
    `UPDATE users SET role = ?1 WHERE id = ?2`,
  ).bind(body.role, targetId).run()

  return c.json({ ok: true, role: body.role })
})

/**
 * DELETE /api/admin/users/:id
 * Delete a member user (owner cannot be deleted)
 * Cascades cleanup of all related tables + marks attachments for pending cleanup
 */
adminRoutes.delete('/users/:id', async (c) => {
  requireOwner(c)
  const targetId = c.req.param('id')!
  const currentUserId = c.get('user').id

  if (targetId === currentUserId) {
    throw ApiError.badRequest('You cannot delete your own account')
  }

  const target = await c.env.DB.prepare(
    `SELECT id, username, role FROM users WHERE id = ?1`,
  ).bind(targetId).first<{ id: string; username: string; role: 'owner' | 'member' }>()
  if (!target) throw ApiError.notFound('User not found')
  if (target.role === 'owner') {
    throw ApiError.badRequest('Owner accounts cannot be deleted')
  }

  await deleteUserAndCascade(c.env.DB, targetId, target.username)

  return c.json({ ok: true })
})

/**
 * Deletes a user and all their related data.
 *
 * Everything runs in a single `batch()` so the deletion is atomic: a failure
 * part-way through can no longer leave a half-erased account behind.
 *
 * Attachment binaries (R2/KV) are only *queued* in attachment_cleanup; the
 * scheduled cleanup job purges the actual objects afterwards.
 */
async function deleteUserAndCascade(db: D1Database, userId: string, username: string): Promise<void> {
  const now = Date.now()

  // attachment_cleanup keys carry a storage prefix plus a MIME-derived file
  // extension, so they can only be assembled in JS. The attachments table has
  // no object_key column — reading `object_key` from it fails the whole cascade.
  const attachments = await db.prepare(
    `SELECT id, user_id, filename, mime, storage FROM attachments WHERE user_id = ?1`,
  ).bind(userId).all<StoredAttachmentKey & { storage: AttachmentObjectStorage }>()

  const statement = (sql: string): D1PreparedStatement => db.prepare(sql).bind(userId)

  const statements: D1PreparedStatement[] = [
    ...attachments.results.map((row) =>
      db.prepare(
        `INSERT OR IGNORE INTO attachment_cleanup (object_key, user_id, created_at)
         VALUES (?1, ?2, ?3)`,
      ).bind(attachmentCleanupTarget(row.storage, attachmentObjectKey(row)), userId, now),
    ),

    // Throttle rows are keyed by a string rather than by user id. Some keys end
    // with the user id, others with the login identity (the username); the
    // IP-scoped keys are deliberately left alone so they can expire on their own.
    db.prepare(
      `DELETE FROM login_attempts
        WHERE key IN ('login-account:' || ?2, 'pw-work:' || ?1, 'attachment-upload:' || ?1, 'fts-reindex:' || ?1)
           OR key LIKE 'login:%:' || ?2
           OR key LIKE 'login-work:%:' || ?2
           OR key LIKE 'backup-%:' || ?1`,
    ).bind(userId, username),

    // --- Fully independent / light tables ---
    statement(`DELETE FROM totp_login_challenges WHERE user_id = ?1`),
    statement(`DELETE FROM totp_recovery_codes WHERE user_id = ?1`),
    statement(`DELETE FROM totp_credentials WHERE user_id = ?1`),
    statement(`DELETE FROM mcp_api_keys WHERE user_id = ?1`),
    statement(`DELETE FROM mcp_preferences WHERE user_id = ?1`),
    statement(`DELETE FROM mcp_operations WHERE user_id = ?1`),
    statement(`DELETE FROM sessions WHERE user_id = ?1`),
    statement(`DELETE FROM changes WHERE user_id = ?1`),

    // share_asset_sessions is keyed by slug, not by share id; it must be drained
    // while the user's shares still exist, hence it runs before `shares`.
    statement(`DELETE FROM share_asset_sessions WHERE slug IN (SELECT slug FROM shares WHERE user_id = ?1)`),
    statement(`DELETE FROM shares WHERE user_id = ?1`),

    // note_tags has no user_id column — it is scoped through its notes.
    statement(`DELETE FROM note_tags WHERE note_id IN (SELECT id FROM notes WHERE user_id = ?1)`),
    statement(`DELETE FROM links WHERE user_id = ?1`),
    statement(`DELETE FROM note_versions WHERE user_id = ?1`),
    statement(`DELETE FROM ai_note_embeddings WHERE user_id = ?1`),
    statement(`DELETE FROM ai_index_queue WHERE user_id = ?1`),
    statement(`DELETE FROM fts_index_queue WHERE user_id = ?1`),

    // --- Main data ---
    statement(`DELETE FROM notes WHERE user_id = ?1`),
    statement(`DELETE FROM folders WHERE user_id = ?1`),
    statement(`DELETE FROM tags WHERE user_id = ?1`),

    // --- Attachments & backups ---
    statement(`DELETE FROM attachments WHERE user_id = ?1`),
    statement(`DELETE FROM backup_runs WHERE user_id = ?1`),
    statement(`DELETE FROM backup_targets WHERE user_id = ?1`),
    statement(`DELETE FROM import_mappings WHERE user_id = ?1`),
    statement(`DELETE FROM attachment_cleanup WHERE user_id = ?1`),

    // --- Finally remove the user itself ---
    statement(`DELETE FROM users WHERE id = ?1`),
  ]

  await db.batch(statements)
}
