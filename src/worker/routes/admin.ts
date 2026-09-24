import { Hono } from 'hono'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { JSON_BODY_LIMITS, readJson } from '../lib/request'
import { requireAuth } from '../middleware/auth'

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
    `SELECT id, role FROM users WHERE id = ?1`,
  ).bind(targetId).first<{ id: string; role: 'owner' | 'member' }>()
  if (!target) throw ApiError.notFound('User not found')
  if (target.role === 'owner') {
    throw ApiError.badRequest('Owner accounts cannot be deleted')
  }

  await deleteUserAndCascade(c.env.DB, targetId)

  return c.json({ ok: true })
})

/**
 * Deletes a user and all their related data
 * Note: attachment binaries (R2/KV) are cleaned up asynchronously via the attachment_cleanup
 * table; the caller is expected to trigger cleanup regularly.
 */
async function deleteUserAndCascade(db: D1Database, userId: string): Promise<void> {
  const now = Date.now()

  // Register attachments in attachment_cleanup (Worker asynchronously purges R2 objects later)
  await db.prepare(
    `INSERT OR IGNORE INTO attachment_cleanup (user_id, object_key, created_at)
     SELECT ?1, object_key, ?2 FROM attachments WHERE user_id = ?1 AND object_key IS NOT NULL`,
  ).bind(userId, now).run()

  // Delete in dependency order (dependent tables first, then main tables)
  const statements = [
    // --- Fully independent / light tables ---
    `DELETE FROM login_attempts WHERE user_id = ?1`,
    `DELETE FROM totp_login_challenges WHERE user_id = ?1`,
    `DELETE FROM totp_recovery_codes WHERE user_id = ?1`,
    `DELETE FROM totp_credentials WHERE user_id = ?1`,
    `DELETE FROM mcp_api_keys WHERE user_id = ?1`,
    `DELETE FROM mcp_preferences WHERE user_id = ?1`,
    `DELETE FROM mcp_operations WHERE user_id = ?1`,
    `DELETE FROM sessions WHERE user_id = ?1`,
    `DELETE FROM changes WHERE user_id = ?1`,
    `DELETE FROM share_asset_sessions WHERE share_id IN (SELECT id FROM shares WHERE user_id = ?1)`,
    `DELETE FROM shares WHERE user_id = ?1`,

    // --- Tables that depend on notes ---
    `DELETE FROM note_tags WHERE user_id = ?1`,
    `DELETE FROM links WHERE user_id = ?1`,
    `DELETE FROM note_versions WHERE user_id = ?1`,
    `DELETE FROM ai_note_embeddings WHERE user_id = ?1`,
    `DELETE FROM ai_index_queue WHERE user_id = ?1`,
    `DELETE FROM fts_index_queue WHERE user_id = ?1`,

    // --- Main data ---
    `DELETE FROM note_tags WHERE note_id IN (SELECT id FROM notes WHERE user_id = ?1)`,
    `DELETE FROM notes WHERE user_id = ?1`,
    `DELETE FROM folders WHERE user_id = ?1`,
    `DELETE FROM tags WHERE user_id = ?1`,

    // --- Attachments & backups ---
    `DELETE FROM attachments WHERE user_id = ?1`,
    `DELETE FROM backup_runs WHERE user_id = ?1`,
    `DELETE FROM backup_targets WHERE user_id = ?1`,
    `DELETE FROM import_mappings WHERE user_id = ?1`,
    `DELETE FROM attachment_cleanup WHERE user_id = ?1`,

    // --- Finally remove the user itself ---
    `DELETE FROM users WHERE id = ?1`,
  ]

  // A single .run() is enough for D1, but execute one by one to make debugging easier
  for (const sql of statements) {
    await db.prepare(sql).bind(userId).run()
  }
}
