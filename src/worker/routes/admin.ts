import { Hono } from 'hono'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { JSON_BODY_LIMITS, readJson } from '../lib/request'
import { requireAuth } from '../middleware/auth'

/** 用户管理路由 (仅 owner 可访问) */
export const adminRoutes = new Hono<AppBindings>()

adminRoutes.use('*', requireAuth)

/** 通用 owner 守卫 */
function requireOwner(c: { get: (key: 'user') => { role: 'owner' | 'member'; id: string } }) {
  if (c.get('user').role !== 'owner') {
    throw ApiError.forbidden('Only the owner can access this endpoint')
  }
}

/**
 * GET /api/admin/users
 * 返回所有用户的列表 (不含密码哈希)
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
 * 修改用户角色 (member ↔ owner)
 * - 不允许 owner 把自己降为 member (系统必须有至少 1 个 owner)
 * - 不允许对 user id 不存在的用户操作
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

  // 读目标用户
  const target = await c.env.DB.prepare(
    `SELECT id, role FROM users WHERE id = ?1`,
  ).bind(targetId).first<{ id: string; role: 'owner' | 'member' }>()
  if (!target) throw ApiError.notFound('User not found')

  // 如果要降级 owner → member, 先确认系统里还剩至少 1 个 owner
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
 * 删除一个 member 用户 (owner 不能被删除)
 * 级联清理所有关联表 + 将附件标记为待清理
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
 * 删除用户及其所有关联数据
 * 注意: attachment 二进制 (R2/KV) 通过 attachment_cleanup 表做异步清理,
 *       调用方需确保定期触发清理
 */
async function deleteUserAndCascade(db: D1Database, userId: string): Promise<void> {
  const now = Date.now()

  // 把 attachment 登记到 attachment_cleanup (供 Worker 定期异步清理 R2 对象)
  await db.prepare(
    `INSERT OR IGNORE INTO attachment_cleanup (user_id, object_key, created_at)
     SELECT ?1, object_key, ?2 FROM attachments WHERE user_id = ?1 AND object_key IS NOT NULL`,
  ).bind(userId, now).run()

  // 按依赖顺序删除 (先删依赖表, 再删主表)
  const statements = [
    // --- 完全独立 / 轻量表 ---
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

    // --- 依赖 notes 的表 ---
    `DELETE FROM note_tags WHERE user_id = ?1`,
    `DELETE FROM links WHERE user_id = ?1`,
    `DELETE FROM note_versions WHERE user_id = ?1`,
    `DELETE FROM ai_note_embeddings WHERE user_id = ?1`,
    `DELETE FROM ai_index_queue WHERE user_id = ?1`,
    `DELETE FROM fts_index_queue WHERE user_id = ?1`,

    // --- 主数据 ---
    `DELETE FROM note_tags WHERE note_id IN (SELECT id FROM notes WHERE user_id = ?1)`,
    `DELETE FROM notes WHERE user_id = ?1`,
    `DELETE FROM folders WHERE user_id = ?1`,
    `DELETE FROM tags WHERE user_id = ?1`,

    // --- 附件 & 备份 ---
    `DELETE FROM attachments WHERE user_id = ?1`,
    `DELETE FROM backup_runs WHERE user_id = ?1`,
    `DELETE FROM backup_targets WHERE user_id = ?1`,
    `DELETE FROM import_mappings WHERE user_id = ?1`,
    `DELETE FROM attachment_cleanup WHERE user_id = ?1`,

    // --- 最后删 users 本身 ---
    `DELETE FROM users WHERE id = ?1`,
  ]

  // D1 单条 .run() 足够, 但为了好 debug 我们一条条执行
  for (const sql of statements) {
    await db.prepare(sql).bind(userId).run()
  }
}
