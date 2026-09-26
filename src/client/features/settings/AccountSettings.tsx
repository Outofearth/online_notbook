import { useEffect, useRef, useState } from 'react'
import { Ban, Camera, Check, Copy, KeyRound, LogOut, Plus, RefreshCw, RotateCcw, ShieldCheck, Trash2, UserRound } from 'lucide-react'
import { PROFILE_NAME_MAX_LENGTH } from '@shared/avatar'
import { LIMITS } from '@shared/constants'
import { Avatar, Badge, Button } from '../../components/primitives'
import { Input, SettingRow, Switch } from '../../components/form'
import { Modal, confirm } from '../../components/overlay'
import { api, ApiError } from '../../lib/api'
import { t, useLocale } from '../../lib/i18n'
import { useSession } from '../../store/session'
import { useUi } from '../../store/ui'
import { AvatarPicker } from './AvatarPicker'
import { TotpSettings } from './TotpSettings'

export function AccountSettings() {
  const user = useSession((state) => state.user)
  if (!user) return null

  return (
    <div className="space-y-6">
      <ProfileSection />

      <section>
        <h3 className="mb-2 px-1 text-[12px] font-semibold text-[var(--text-secondary)]">
          {t("settings.sign_in_security")}
        </h3>
        <div className="space-y-2">
          <PasswordSection />
          <TotpSettings />
        </div>
      </section>

      {user.role === 'owner' && (
        <section className="space-y-4">
          <div>
            <h3 className="mb-2 px-1 text-[12px] font-semibold text-[var(--text-secondary)]">
              {t("common.access_control")}
            </h3>
            <RegistrationSection />
          </div>

          <div>
            <h3 className="mb-2 px-1 text-[12px] font-semibold text-[var(--text-secondary)]">
              {t("settings.user_management")}
            </h3>
            <UserManagementSection />
          </div>
        </section>
      )}
    </div>
  )
}

function ProfileSection() {
  const user = useSession((state) => state.user)!
  const updateProfile = useSession((state) => state.updateProfile)
  const toast = useUi((state) => state.toast)
  const [name, setName] = useState(user.name)
  const [edited, setEdited] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const busyRef = useRef(false)

  useEffect(() => {
    if (!edited) setName(user.name)
  }, [edited, user.name])

  const normalizedName = name.trim().replace(/\s+/gu, ' ')
  const validName = Boolean(normalizedName) && [...normalizedName].length <= PROFILE_NAME_MAX_LENGTH
  const changed = normalizedName !== user.name

  const saveName = async () => {
    if (busyRef.current) return
    if (!validName) {
      setError(t('settings.display_name_length', { max: PROFILE_NAME_MAX_LENGTH }))
      return
    }
    if (!changed) {
      setEdited(false)
      return
    }
    busyRef.current = true
    setBusy(true)
    setError(null)
    try {
      const updated = await updateProfile({ name: normalizedName })
      setName(updated.name)
      setEdited(false)
      toast({ title: t('settings.display_name_saved'), tone: 'success' })
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : t('settings.action_failed_try_again'))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  return (
    <section>
      <h3 className="mb-2 px-1 text-[12px] font-semibold text-[var(--text-secondary)]">
        {t('settings.personal_profile')}
      </h3>
      <div className="overflow-hidden rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-base)]">
        <div className="flex items-center gap-3 p-4">
          <button
            type="button"
            aria-label={t('settings.change_avatar')}
            onClick={() => setPickerOpen(true)}
            className="group relative shrink-0 rounded-full outline-none ring-offset-2 ring-offset-[var(--bg-base)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
          >
            <Avatar src={user.avatarUrl} name={user.name} size={52} />
            <span className="absolute inset-0 flex items-center justify-center rounded-full bg-black/0 text-white opacity-0 transition-[background-color,opacity] group-hover:bg-black/40 group-hover:opacity-100 group-focus-visible:bg-black/40 group-focus-visible:opacity-100">
              <Camera size={16} />
            </span>
          </button>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate text-[14px] font-semibold text-[var(--text-primary)]">
                {user.name}
              </span>
              {user.role === 'owner' && <Badge tone="accent">{t('common.owner')}</Badge>}
            </div>
            <div className="mt-0.5 flex items-center gap-1.5 text-[11.5px] text-[var(--text-tertiary)]">
              <UserRound size={11} />@{user.username}
            </div>
            <p className="mt-1 text-[10.5px] text-[var(--text-quaternary)]">
              {t('settings.username_is_sign_in_id')}
            </p>
          </div>
          <LogoutButton />
        </div>

        <form
          className="border-t border-[var(--border-subtle)] px-4 py-3.5"
          onSubmit={(event) => {
            event.preventDefault()
            void saveName()
          }}
        >
          <label htmlFor="profile-display-name" className="block text-[11.5px] font-medium text-[var(--text-secondary)]">
            {t('settings.display_name')}
          </label>
          <div className="mt-1.5 flex flex-col gap-2 sm:flex-row">
            <Input
              id="profile-display-name"
              value={name}
              maxLength={PROFILE_NAME_MAX_LENGTH * 2}
              onChange={(event) => {
                setName(event.target.value)
                setEdited(true)
                setError(null)
              }}
              disabled={busy}
              autoComplete="name"
              className="flex-1"
            />
            <Button
              type="submit"
              variant="primary"
              size="sm"
              loading={busy}
              disabled={!edited || !changed || !validName}
            >
              {t('common.save')}
            </Button>
          </div>
          {error && <p role="alert" className="mt-1.5 text-[12px] text-[var(--danger)]">{error}</p>}
        </form>
      </div>

      <AvatarPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        displayName={user.name}
        preference={user.avatarUrl}
      />
    </section>
  )
}

function LogoutButton() {
  const logout = useSession((state) => state.logout)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const run = async () => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    try {
      const ok = await confirm({
        title: t("common.log_out"),
        description: t("settings.this_device_will_be_signed_out_and_its_local_cache_cleared_cloud_data_is"),
        confirmLabel: t("common.exit"),
      })
      if (ok) await logout()
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }
  return (
    <Button
      size="sm"
      variant="ghost"
      icon={<LogOut size={13} />}
      loading={busy}
      onClick={() => void run()}
    >
      {t("common.exit")}
    </Button>
  )
}

function PasswordSection() {
  const user = useSession((state) => state.user)!
  const toast = useUi((state) => state.toast)
  const [open, setOpen] = useState(false)
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const busyRef = useRef(false)

  const resetForm = () => {
    setCurrentPassword('')
    setNewPassword('')
    setConfirmation('')
    setError(null)
  }

  const submit = async () => {
    if (busyRef.current) return
    setError(null)
    if (!currentPassword) return setError(t("settings.enter_your_current_password"))
    if (newPassword.length < 8) return setError(t("settings.new_password_must_be_at_least_8_characters"))
    if (newPassword !== confirmation) return setError(t("common.the_passwords_do_not_match"))
    busyRef.current = true
    setBusy(true)
    try {
      await api.auth.setPassword({ currentPassword, newPassword })
      toast({
        title: t("settings.password_updated"),
        description: t("settings.other_devices_have_been_logged_out"),
        tone: 'success',
      })
      setOpen(false)
      resetForm()
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : t("settings.action_failed_try_again"))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  return (
    <div className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-base)]">
      <SettingRow
        className="px-4"
        title={t("settings.login_password")}
        description={t("settings.username_value0_changing_the_password_signs_out_other_devices", {
          value0: user.username,
        })}
      >
        <Button
          size="sm"
          variant="secondary"
          icon={<KeyRound size={12} />}
          disabled={busy}
          onClick={() => {
            setOpen(!open)
            resetForm()
          }}
        >
          {open ? t("common.collapse") : t("settings.change_password")}
        </Button>
      </SettingRow>

      {open && (
        <form
          className="space-y-2.5 border-t border-[var(--border-subtle)] px-4 py-3.5"
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
          }}
        >
          <label className="block">
            <span className="mb-1 block text-[11.5px] text-[var(--text-tertiary)]">
              {t("settings.current_password")}
            </span>
            <Input
              type="password"
              value={currentPassword}
              maxLength={LIMITS.passwordMaxLength}
              onChange={(event) => setCurrentPassword(event.target.value)}
              disabled={busy}
              autoComplete="current-password"
            />
          </label>
          <div className="grid grid-cols-1 gap-2.5 md:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-[11.5px] text-[var(--text-tertiary)]">
                {t("settings.new_password")}
              </span>
              <Input
                type="password"
                value={newPassword}
                maxLength={LIMITS.passwordMaxLength}
                onChange={(event) => setNewPassword(event.target.value)}
                disabled={busy}
                autoComplete="new-password"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-[11.5px] text-[var(--text-tertiary)]">
                {t("settings.confirm_new_password")}
              </span>
              <Input
                type="password"
                value={confirmation}
                maxLength={LIMITS.passwordMaxLength}
                onChange={(event) => setConfirmation(event.target.value)}
                disabled={busy}
                autoComplete="new-password"
              />
            </label>
          </div>
          {error && <p role="alert" className="text-[12px] text-[var(--danger)]">{error}</p>}
          <div className="flex justify-end">
            <Button type="submit" variant="primary" size="sm" loading={busy}>
              {t("common.save")}
            </Button>
          </div>
        </form>
      )}
    </div>
  )
}

function RegistrationSection() {
  const site = useSession((state) => state.site)
  const updateRegistration = useSession((state) => state.updateRegistration)
  const toast = useUi((state) => state.toast)
  const [target, setTarget] = useState<boolean | null>(null)
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const busyRef = useRef(false)
  const enabled = site?.registrationOpen ?? false
  const confirming = target !== null

  useEffect(() => {
    if (target !== null && target === enabled && !busy) {
      setTarget(null)
      setPassword('')
      setError(null)
    }
  }, [busy, enabled, target])

  const beginToggle = (next: boolean) => {
    if (busyRef.current) return
    setError(null)
    setPassword('')
    setTarget(next)
  }

  const finishToggle = async () => {
    if (busyRef.current || target === null) return
    const requested = target
    setError(null)
    if (!password) return setError(t("settings.enter_your_password"))
    busyRef.current = true
    setBusy(true)
    const currentPassword = password
    setTarget(null)
    setPassword('')
    try {
      await updateRegistration(requested, currentPassword)
      toast({
        title: requested ? t("settings.registration_open") : t("settings.registration_closed"),
        description: requested ? t("settings.anyone_can_now_register_a_new_account") : t("settings.only_existing_accounts_can_log_in"),
        tone: 'success',
      })
    } catch (caught) {
      setTarget(requested)
      setError(caught instanceof ApiError ? caught.message : t("settings.action_failed_try_again"))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  return (
    <div className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-base)]">
      <SettingRow
        className="px-4"
        title={t("common.open_registration")}
        description={`${
          enabled
            ? t("settings.open_anyone_can_register_with_a_username_and_password")
            : t("settings.off_default_only_existing_accounts_can_log_in")
        } ${t("settings.changing_this_requires_your_current_password_and_takes_effect_immediatel")}`}
      >
        <Switch
          checked={enabled}
          disabled={busy}
          onChange={beginToggle}
          label={t("common.open_registration")}
        />
      </SettingRow>

      {confirming && (
        <form
          className="space-y-2.5 border-t border-[var(--border-subtle)] px-4 py-3.5"
          onSubmit={(event) => {
            event.preventDefault()
            void finishToggle()
          }}
        >
          <label className="block">
            <span className="mb-1 flex items-center gap-1.5 text-[11.5px] text-[var(--text-tertiary)]">
              <ShieldCheck size={12} />
              {target ? t("settings.open_registration_requires_password_verification") : t("settings.close_registration_requires_password_verification")}
            </span>
            <Input
              type="password"
              value={password}
              maxLength={LIMITS.passwordMaxLength}
              onChange={(event) => setPassword(event.target.value)}
              disabled={busy}
              autoComplete="current-password"
              autoFocus
            />
          </label>
          {error && <p role="alert" className="text-[12px] text-[var(--danger)]">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setTarget(null)
                setPassword('')
                setError(null)
              }}
            >
              {t("common.cancel")}
            </Button>
            <Button
              type="submit"
              size="sm"
              variant={target ? 'danger' : 'primary'}
              loading={busy}
            >
              {target ? t("settings.confirm_opening_registration") : t("settings.confirm_closing_registration")}
            </Button>
          </div>
        </form>
      )}
    </div>
  )
}

interface AdminUserRow {
  id: string
  username: string
  login: string
  name: string
  avatarUrl: string
  role: 'owner' | 'member'
  createdAt: number
  lastSeenAt: number
  disabledAt: number | null
  isConfiguredOwner: boolean
}

/** Admin user management panel (owner visibility only) */
function UserManagementSection() {
  const toast = useUi((state) => state.toast)
  const locale = useLocale()
  const currentUserId = useSession((state) => state.user?.id ?? '')
  const [users, setUsers] = useState<AdminUserRow[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [newUsername, setNewUsername] = useState('')
  const [creating, setCreating] = useState(false)
  const [copied, setCopied] = useState(false)
  // Generated credentials are returned once, so they are held in memory only long
  // enough for the operator to copy them, then dropped together with the dialog.
  const [revealed, setRevealed] = useState<{ username: string; password: string } | null>(null)

  const load = async () => {
    setLoading(true)
    setError(null)
    try {
      const result = await api.admin.users.list()
      setUsers(result.users)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  const closeReveal = () => {
    setRevealed(null)
    setCopied(false)
  }

  const onCreate = async () => {
    const username = newUsername.trim().toLowerCase()
    if (!username || creating) return
    setCreating(true)
    try {
      const result = await api.admin.users.create(username, locale)
      setCreateOpen(false)
      setNewUsername('')
      setCopied(false)
      setRevealed({ username, password: result.password })
      toast({ title: t('settings.user_created'), tone: 'success' })
      await load()
    } catch (err) {
      toast({
        title: t('settings.user_create_failed'),
        description: err instanceof Error ? err.message : String(err),
        tone: 'danger',
      })
    } finally {
      setCreating(false)
    }
  }

  const onResetPassword = async (target: AdminUserRow) => {
    if (target.id === currentUserId) return
    const confirmed = await confirm({
      title: t('settings.user_reset_password_confirm_title'),
      description: t('settings.user_reset_password_confirm_description', { username: target.username }),
      confirmLabel: t('settings.user_reset_password'),
    })
    if (!confirmed) return
    setBusyId(target.id)
    try {
      const result = await api.admin.users.resetPassword(target.id)
      setCopied(false)
      setRevealed({ username: target.username, password: result.password })
      toast({ title: t('settings.user_password_reset'), tone: 'success' })
    } catch (err) {
      toast({
        title: t('settings.user_password_reset_failed'),
        description: err instanceof Error ? err.message : String(err),
        tone: 'danger',
      })
    } finally {
      setBusyId(null)
    }
  }

  const onToggleStatus = async (target: AdminUserRow) => {
    if (target.id === currentUserId) return
    const nextDisabled = target.disabledAt === null
    const confirmed = await confirm({
      title: t(nextDisabled ? 'settings.user_suspend_confirm_title' : 'settings.user_restore_confirm_title'),
      description: t(
        nextDisabled
          ? 'settings.user_suspend_confirm_description'
          : 'settings.user_restore_confirm_description',
        { username: target.username },
      ),
      confirmLabel: t(nextDisabled ? 'settings.user_suspend' : 'settings.user_restore'),
    })
    if (!confirmed) return
    setBusyId(target.id)
    try {
      await api.admin.users.setDisabled(target.id, nextDisabled)
      toast({
        title: t(nextDisabled ? 'settings.user_suspended' : 'settings.user_restored'),
        tone: 'success',
      })
      await load()
    } catch (err) {
      toast({
        title: t('settings.user_status_change_failed'),
        description: err instanceof Error ? err.message : String(err),
        tone: 'danger',
      })
    } finally {
      setBusyId(null)
    }
  }

  const onCopyPassword = async () => {
    if (!revealed) return
    try {
      await navigator.clipboard.writeText(revealed.password)
      setCopied(true)
      toast({ title: t('common.copied'), tone: 'success' })
    } catch {
      toast({ title: t('settings.user_password_copy_failed'), tone: 'danger' })
    }
  }

  const onRemove = async (target: AdminUserRow) => {
    if (target.id === currentUserId) return
    const confirmed = await confirm({
      title: t('settings.user_delete_confirm_title'),
      description: t('settings.user_delete_confirm_description', { username: target.username }),
      confirmLabel: t('common.delete'),
      tone: 'danger',
    })
    if (!confirmed) return
    setBusyId(target.id)
    try {
      await api.admin.users.remove(target.id)
      toast({ title: t('settings.user_deleted'), tone: 'success' })
      await load()
    } catch (err) {
      toast({
        title: t('settings.user_delete_failed'),
        description: err instanceof Error ? err.message : String(err),
        tone: 'danger',
      })
    } finally {
      setBusyId(null)
    }
  }

  const onToggleRole = async (target: AdminUserRow) => {
    if (target.id === currentUserId) return
    const newRole: 'owner' | 'member' = target.role === 'owner' ? 'member' : 'owner'
    const confirmed = await confirm({
      title: t('settings.user_role_change_title'),
      description: t(
        newRole === 'owner'
          ? 'settings.user_role_promote_description'
          : 'settings.user_role_demote_description',
        { username: target.username },
      ),
      confirmLabel: t('settings.confirm'),
    })
    if (!confirmed) return
    setBusyId(target.id)
    try {
      await api.admin.users.setRole(target.id, newRole)
      toast({
        title: t(
          newRole === 'owner'
            ? 'settings.user_promoted_to_owner'
            : 'settings.user_demoted_to_member',
        ),
        tone: 'success',
      })
      await load()
    } catch (err) {
      toast({
        title: t('settings.user_role_change_failed'),
        description: err instanceof Error ? err.message : String(err),
        tone: 'danger',
      })
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-base)]">
      <div className="flex items-center justify-between gap-3 border-b border-[var(--border-subtle)] px-4 py-2.5">
        <p className="text-[11.5px] leading-relaxed text-[var(--text-tertiary)]">
          {t('settings.user_management_description')}
        </p>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button size="sm" icon={<Plus size={12} />} onClick={() => setCreateOpen(true)}>
            {t('settings.user_management_new_user')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            icon={<RefreshCw size={12} className={loading ? 'animate-[ink-spin_.7s_linear_infinite]' : ''} />}
            onClick={() => void load()}
            disabled={loading}
            aria-label={t('app.reload')}
          />
        </div>
      </div>

      {loading && !users && (
        <div className="px-4 py-6 text-center text-[12px] text-[var(--text-quaternary)]">
          {t('common.loading')}
        </div>
      )}

      {error && !users && (
        <div role="alert" className="px-4 py-6 text-center text-[12px] text-[var(--danger)]">
          {error}
        </div>
      )}

      {users && (
        <ul className="divide-y divide-[var(--border-subtle)]">
          {users.map((u) => {
            const isSelf = u.id === currentUserId
            const isBusy = busyId === u.id
            // The account named by the ADMINISTRATOR secret is managed through the
            // deployment config, so every UI action on it is disabled.
            const isManaged = u.isConfiguredOwner
            const canDelete = u.role !== 'owner' && !isSelf && !isManaged
            const canToggleRole = !isSelf && !isManaged
            const canResetPassword = !isSelf && !isManaged
            const canToggleStatus = !isSelf && !isManaged
            const isSuspended = u.disabledAt !== null
            const protectedHint = isManaged ? t('settings.user_managed_by_configuration') : undefined
            return (
              <li key={u.id} className="flex items-center gap-3 px-4 py-2.5">
                <Avatar
                  src={u.avatarUrl}
                  size={30}
                  name={u.name || u.username}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-[13px] font-medium text-[var(--text-primary)]">
                      {u.name || u.username}
                    </span>
                    {u.role === 'owner' ? (
                      <Badge tone="accent">{t('settings.role_owner')}</Badge>
                    ) : (
                      <Badge tone="neutral">{t('settings.role_member')}</Badge>
                    )}
                    {isSelf && (
                      <Badge tone="success">{t('settings.current_user')}</Badge>
                    )}
                    {isManaged && (
                      <Badge tone="neutral">{t('settings.user_managed_by_configuration')}</Badge>
                    )}
                    {isSuspended && (
                      <Badge tone="danger">{t('settings.user_suspended_badge')}</Badge>
                    )}
                  </div>
                  <div className="mt-0.5 text-[11px] text-[var(--text-quaternary)]">
                    @{u.username}
                    {u.lastSeenAt ? ` · ${t('settings.user_last_seen_at', { when: formatRelative(u.lastSeenAt) })}` : ''}
                  </div>
                </div>

                <div className="flex shrink-0 gap-1.5">
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={!canToggleRole || isBusy}
                    loading={isBusy}
                    onClick={() => void onToggleRole(u)}
                    title={protectedHint ?? (canToggleRole
                      ? (u.role === 'owner' ? t('settings.demote_to_member') : t('settings.promote_to_owner'))
                      : t('settings.cannot_change_own_role'))}
                  >
                    {u.role === 'owner' ? t('settings.demote') : t('settings.promote')}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<KeyRound size={12} />}
                    disabled={!canResetPassword || isBusy}
                    loading={isBusy}
                    onClick={() => void onResetPassword(u)}
                    title={protectedHint ?? (canResetPassword
                      ? t('settings.user_reset_password')
                      : t('settings.cannot_reset_own_password'))}
                    aria-label={t('settings.user_reset_password')}
                  />
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<Trash2 size={12} className="text-[var(--danger)]" />}
                    disabled={!canDelete || isBusy}
                    loading={isBusy}
                    onClick={() => void onRemove(u)}
                    title={protectedHint ?? (canDelete ? t('settings.delete_user') : t('settings.owner_cannot_be_deleted'))}
                    className={canDelete ? 'text-[var(--danger)] hover:text-[var(--danger)]' : ''}
                  />
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={isSuspended ? <RotateCcw size={12} /> : <Ban size={12} />}
                    disabled={!canToggleStatus || isBusy}
                    loading={isBusy}
                    onClick={() => void onToggleStatus(u)}
                    title={protectedHint ?? (canToggleStatus
                      ? t(isSuspended ? 'settings.user_restore' : 'settings.user_suspend')
                      : t('settings.cannot_suspend_own_account'))}
                    aria-label={t(isSuspended ? 'settings.user_restore' : 'settings.user_suspend')}
                  />
                </div>
              </li>
            )
          })}
        </ul>
      )}

      <Modal
        open={createOpen}
        onClose={() => { if (!creating) { setCreateOpen(false); setNewUsername('') } }}
        title={t('settings.user_create_title')}
        description={t('settings.user_create_description')}
        width={420}
        footer={
          <>
            <Button variant="ghost" onClick={() => { setCreateOpen(false); setNewUsername('') }} disabled={creating}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="primary"
              loading={creating}
              disabled={!newUsername.trim() || creating}
              onClick={() => void onCreate()}
            >
              {t('settings.user_create_confirm')}
            </Button>
          </>
        }
      >
        <label className="block">
          <span className="mb-1.5 block text-[12px] font-medium text-[var(--text-secondary)]">
            {t('settings.user_create_username_label')}
          </span>
          <Input
            value={newUsername}
            onChange={(event) => setNewUsername(event.target.value)}
            placeholder={t('settings.user_create_username_placeholder')}
            aria-label={t('settings.user_create_username_label')}
            autoFocus
            onKeyDown={(event) => { if (event.key === 'Enter') void onCreate() }}
          />
        </label>
      </Modal>

      <Modal
        open={revealed !== null}
        onClose={closeReveal}
        title={t('settings.user_password_reveal_title', { username: revealed?.username ?? '' })}
        description={t('settings.user_password_reveal_description')}
        width={420}
        footer={<Button variant="primary" onClick={closeReveal}>{t('settings.user_password_done')}</Button>}
      >
        <div className="flex items-center gap-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-inset)] px-3 py-2">
          <code className="min-w-0 flex-1 truncate font-mono text-[13px] text-[var(--text-primary)]">
            {revealed?.password ?? ''}
          </code>
          <Button
            size="sm"
            variant="ghost"
            icon={copied ? <Check size={12} className="text-[var(--success)]" /> : <Copy size={12} />}
            onClick={() => void onCopyPassword()}
            aria-label={t('settings.user_password_copy')}
          >
            {t('settings.user_password_copy')}
          </Button>
        </div>
      </Modal>
    </div>
  )
}

/** Relative time description (X minutes ago / yesterday / date) */
function formatRelative(timestamp: number): string {
  const now = Date.now()
  const diffMs = Math.max(0, now - timestamp)
  const sec = Math.floor(diffMs / 1000)
  if (sec < 60) return t('settings.just_now')
  const min = Math.floor(sec / 60)
  if (min < 60) return t('settings.minutes_ago', { n: min })
  const hr = Math.floor(min / 60)
  if (hr < 24) return t('settings.hours_ago', { n: hr })
  const day = Math.floor(hr / 24)
  if (day < 7) return t('settings.days_ago', { n: day })
  return new Date(timestamp).toLocaleDateString()
}

