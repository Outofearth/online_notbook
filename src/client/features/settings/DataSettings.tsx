import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, Download, FileJson, FileLock, FileUp, FolderOpen, ImageIcon, RefreshCw, Sparkles, Trash2 } from 'lucide-react';
import { api } from '../../lib/api';
import { formatBytes, formatNumber } from '../../lib/time';
import { Button } from '../../components/primitives';
import { SettingsLoading as LoadingBlock } from './SettingsLoading';
import { SettingRow } from '../../components/form';
import { Modal, confirm } from '../../components/overlay';
import { decryptBackupBlob, isEncryptedBackupFilename } from '@shared/encrypted-backup';
import { useUi } from '../../store/ui';
import { useNotes } from '../../store/notes';
import { AttachmentManager } from '../attachments/AttachmentManager';
import { t } from "../../lib/i18n";
import { restoreMarkdownBackupFolder } from '../../lib/backup-import';
import { useSettingsResource } from './resource';
import { statsResource } from './resources';
import { passwordStrength } from '@shared/encrypted-backup';
export function DataSettings() {
    const [attachmentManagerOpen, setAttachmentManagerOpen] = useState(false);
    const [stats] = useSettingsResource(statsResource);
    const [statsError, setStatsError] = useState<string | null>(null);
    const [busy, setBusy] = useState<string | null>(null);
    const [encryptExport, setEncryptExport] = useState(false);
    const [exportPassword, setExportPassword] = useState('');
    const [exportPasswordConfirm, setExportPasswordConfirm] = useState('');
    const [decryptDialogOpen, setDecryptDialogOpen] = useState(false);
    const [decryptPassword, setDecryptPassword] = useState('');
    const [decryptError, setDecryptError] = useState<string | null>(null);
    const [pendingEncryptedFiles, setPendingEncryptedFiles] = useState<File[]>([]);
    const fileRef = useRef<HTMLInputElement>(null);
    const backupFolderRef = useRef<HTMLInputElement>(null);
    const busyRef = useRef<string | null>(null);
    const statsEpoch = useRef(0);
    const mountedRef = useRef(true);
    const toast = useUi((s) => s.toast);
    const emptyTrash = useNotes((s) => s.emptyTrash);
    const pull = useNotes((s) => s.pull);
    const loadStats = useCallback(async (force = true) => {
        if (!mountedRef.current)
            return;
        const epoch = ++statsEpoch.current;
        setStatsError(null);
        try {
            await statsResource.load(force);
            if (mountedRef.current && epoch === statsEpoch.current) {
                setStatsError(null);
            }
        }
        catch (error) {
            if (mountedRef.current && epoch === statsEpoch.current) {
                setStatsError(error instanceof Error ? error.message : t("settings.could_not_load_data_overview"));
            }
        }
    }, []);
    const run = async (key: string, task: () => Promise<void>) => {
        if (busyRef.current)
            return;
        busyRef.current = key;
        setBusy(key);
        try {
            await task();
        }
        finally {
            if (busyRef.current === key) {
                busyRef.current = null;
                setBusy(null);
            }
        }
    };
    const exportData = async (format: 'zip' | 'json') => {
        if (encryptExport) {
            if (!exportPassword || exportPassword.length < 8) {
                toast({ title: t('settings.encryption_password_too_short'), tone: 'danger' });
                return;
            }
            if (exportPassword !== exportPasswordConfirm) {
                toast({ title: t('settings.encryption_password_mismatch'), tone: 'danger' });
                return;
            }
        }
        await run(`export-${format}`, async () => {
            try {
                await api.transfer.save(format, encryptExport ? exportPassword : undefined);
                // 导出完成后清除密码 (防止在 UI 中停留)
                setExportPassword('');
                setExportPasswordConfirm('');
            }
            catch (error) {
                toast({
                    title: t("common.export_failed"),
                    description: error instanceof Error ? error.message : String(error),
                    tone: 'danger',
                });
            }
        });
    };
    const reportImport = async (result: Awaited<ReturnType<typeof api.transfer.import>>) => {
        const refreshed = await pull({ force: true }).then(() => true, () => false);
        void loadStats();
        const summary = t("settings.created_value0_updated_value1_skipped_value2_restored_value3_attachments", { value0: result.createdNotes, value1: result.updatedNotes, value2: result.skippedNotes, value3: result.createdAttachments, value4: result.skippedAttachments });
        const details = [summary];
        if (result.warnings.length)
            details.push(result.warnings[0]);
        if (!refreshed)
            details.push(t("settings.operation_completed_but_refresh_failed"));
        toast({
            title: t("settings.import_completed"),
            description: details.join('\uFF1B'),
            tone: result.warnings.length || !refreshed ? 'warning' : 'success',
            duration: 7000,
        });
        if (result.warnings.length)
            console.warn(t("settings.inkstone_import_reminder"), result.warnings);
    };
    useEffect(() => {
        mountedRef.current = true;
        void loadStats(false);
        return () => {
            mountedRef.current = false;
            statsEpoch.current++;
            busyRef.current = null;
        };
    }, [loadStats]);
    return (<div className="space-y-6">
      <section>
        <h3 className="mb-2 text-[11px] font-semibold tracking-[0.06em] text-[var(--text-quaternary)]">{t("settings.overview")}</h3>
        {stats === null ? (statsError ? (<div role="alert" className="flex items-start gap-2 rounded-[var(--r-md)] border border-[color-mix(in_oklab,var(--danger)_25%,var(--border-subtle))] bg-[var(--bg-base)] px-3 py-3">
            <AlertCircle size={14} className="mt-0.5 shrink-0 text-[var(--danger)]"/>
            <div className="min-w-0 flex-1">
              <div className="text-[12.5px] font-medium text-[var(--text-primary)]">{t("settings.could_not_load_data_overview")}</div>
              <p className="mt-0.5 break-words text-[11.5px] text-[var(--text-tertiary)]">{statsError}</p>
            </div>
            <Button size="sm" variant="secondary" onClick={() => void loadStats()}>{t("common.retry")}</Button>
          </div>) : (<LoadingBlock label={t("common.loading")}/>)) : (<>
          {statsError && (<div role="alert" className="mb-2 flex items-start gap-2 rounded-[var(--r-md)] border border-[color-mix(in_oklab,var(--danger)_25%,var(--border-subtle))] bg-[var(--bg-base)] px-3 py-2 text-[11.5px] text-[var(--danger)]">
              <AlertCircle size={13} className="mt-0.5 shrink-0"/>
              <span className="min-w-0 flex-1 break-words">{statsError}</span>
              <button type="button" className="shrink-0 font-medium underline underline-offset-2" onClick={() => void loadStats()}>{t("common.retry")}</button>
            </div>)}
          <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
          {[
            { label: t("common.note"), value: stats.notes ?? 0 },
            { label: t("navigation.folder"), value: stats.folders ?? 0 },
            { label: t("navigation.tag"), value: stats.tags ?? 0 },
            { label: t("common.wiki_links"), value: stats.links ?? 0 },
            { label: t("settings.total_words"), value: stats.words ?? 0 },
            { label: t("settings.version_history"), value: stats.versions ?? 0 },
            { label: t("settings.attachments"), value: stats.attachments ?? 0 },
            { label: t("navigation.trash"), value: stats.trashed ?? 0 },
        ].map((item) => (<div key={item.label} className="rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-base)] px-3 py-2.5">
              <div className="text-[17px] font-semibold tabular tracking-[-0.02em] text-[var(--text-primary)]">
                {formatNumber(item.value)}
              </div>
              <div className="mt-0.5 text-[11px] text-[var(--text-quaternary)]">{item.label}</div>
            </div>))}
          </div>
          {stats.attachmentBytes ? (<p className="mt-2 text-[11.5px] text-[var(--text-quaternary)]">{t("settings.attachment_storage")}{formatBytes(stats.attachmentBytes)}
            </p>) : null}
        </>)}
      </section>

      <section>
        <h3 className="mb-1 text-[11px] font-semibold tracking-[0.06em] text-[var(--text-quaternary)]">{t("settings.attachments")}</h3>

        <SettingRow title={t("attachments.manage")} description={t("attachments.manage_description")}>
          <Button size="sm" icon={<ImageIcon size={13}/>} onClick={() => setAttachmentManagerOpen(true)}>{t("attachments.manage")}</Button>
        </SettingRow>
      </section>

      <section>
        <h3 className="mb-1 text-[11px] font-semibold tracking-[0.06em] text-[var(--text-quaternary)]">{t("settings.export")}</h3>

        <SettingRow title={t("settings.export_to_zip")} description={t("settings.includes_every_note_folder_tag_and_attachment_for_a_complete_restore_plu")}>
          <Button size="sm" icon={<Download size={13}/>} loading={busy === 'export-zip'} disabled={busy !== null} onClick={() => void exportData('zip')}>{t("settings.download_zip")}</Button>
        </SettingRow>

        <SettingRow title={t("settings.export_to_json")} description={t("settings.structured_note_data_without_attachment_binaries_download_zip_for_a_comp")}>
          <Button size="sm" variant="ghost" icon={<FileJson size={13}/>} loading={busy === 'export-json'} disabled={busy !== null} onClick={() => void exportData('json')}>{t("settings.download_json")}</Button>
        </SettingRow>

        {/* 客户端密码加密导出 */}
        <div className="mt-3 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-base)] px-3 py-3">
          <label className="flex cursor-pointer items-center gap-2 text-[12.5px] font-medium text-[var(--text-primary)]">
            <input
              type="checkbox"
              checked={encryptExport}
              onChange={(e) => setEncryptExport(e.target.checked)}
              className="h-4 w-4 cursor-pointer accent-[var(--accent)]"
            />
            <FileLock size={14} className="shrink-0 text-[var(--accent)]" />
            {t('settings.use_password_encryption')}
          </label>

          {encryptExport && (
            <div className="mt-3 space-y-2">
              <p className="text-[11.5px] text-[var(--text-tertiary)]">{t('settings.encryption_description')}</p>

              <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                <div>
                  <label className="mb-1 block text-[11px] text-[var(--text-quaternary)]">{t('settings.encryption_password')}</label>
                  <input
                    type="password"
                    value={exportPassword}
                    onChange={(e) => setExportPassword(e.target.value)}
                    placeholder={t('settings.encryption_password_placeholder')}
                    className="w-full rounded-md border border-[var(--border-subtle)] bg-[var(--bg-input)] px-2.5 py-1.5 text-[12.5px] text-[var(--text-primary)] outline-none transition focus:border-[var(--accent)]"
                    autoComplete="new-password"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-[11px] text-[var(--text-quaternary)]">{t('settings.encryption_password_confirm')}</label>
                  <input
                    type="password"
                    value={exportPasswordConfirm}
                    onChange={(e) => setExportPasswordConfirm(e.target.value)}
                    placeholder={t('settings.encryption_password_confirm_placeholder')}
                    className="w-full rounded-md border border-[var(--border-subtle)] bg-[var(--bg-input)] px-2.5 py-1.5 text-[12.5px] text-[var(--text-primary)] outline-none transition focus:border-[var(--accent)]"
                    autoComplete="new-password"
                  />
                </div>
              </div>

              {/* 密码强度条 */}
              {exportPassword.length > 0 && (
                <div className="flex items-center gap-2">
                  <div className="flex gap-1">
                    {[0, 1, 2, 3, 4].map((i) => {
                      const level = passwordStrength(exportPassword);
                      const filled = i < level;
                      const colors = ['var(--danger)', 'var(--danger)', '#e6a23c', '#409eff', '#22c55e'];
                      return (
                        <span
                          key={i}
                          className="h-1 w-6 rounded-full transition-colors"
                          style={{ backgroundColor: filled ? colors[level] : 'var(--border-subtle)' }}
                        />
                      );
                    })}
                  </div>
                  <span className="text-[11px] text-[var(--text-quaternary)]">
                    {(() => {
                      const level = passwordStrength(exportPassword);
                      switch (level) {
                        case 0: return t('settings.password_strength_0');
                        case 1: return t('settings.password_strength_1');
                        case 2: return t('settings.password_strength_2');
                        case 3: return t('settings.password_strength_3');
                        case 4: return t('settings.password_strength_4');
                        default: return '';
                      }
                    })()}
                  </span>
                </div>
              )}

              <div role="note" className="flex gap-1.5 rounded-md bg-[var(--bg-muted)] px-2.5 py-2 text-[11px] text-[var(--text-tertiary)]">
                <AlertCircle size={12} className="mt-0.5 shrink-0 text-[var(--warning)]" />
                <span>{t('settings.encryption_warning')}</span>
              </div>
            </div>
          )}
        </div>
      </section>

      <section>
        <h3 className="mb-1 text-[11px] font-semibold tracking-[0.06em] text-[var(--text-quaternary)]">{t("settings.import")}</h3>

        <SettingRow title={t("settings.restore_backup_folder")} description={t("settings.restore_backup_folder_description")}>
          <Button size="sm" icon={<FolderOpen size={13}/>} loading={busy === 'restore-backup'} disabled={busy !== null} onClick={() => backupFolderRef.current?.click()}>{t("settings.select_backup_folder")}</Button>
        </SettingRow>

        <input ref={backupFolderRef} type="file" hidden multiple {...({ webkitdirectory: '', directory: '' } as Record<string, string>)} onChange={async (event) => {
            const files = [...(event.target.files ?? [])];
            event.target.value = '';
            if (!files.length)
                return;
            await run('restore-backup', async () => {
                try {
                    const result = await restoreMarkdownBackupFolder(files, (batch, manifest, paths) => api.transfer.import(batch, 'newer', { manifest, paths }));
                    await reportImport(result);
                }
                catch (err) {
                    toast({ title: t("settings.import_failed"), description: err instanceof Error ? err.message : String(err), tone: 'danger' });
                }
            });
        }}/>

        <SettingRow title={t("settings.import_file")} description={t("settings.supports_md_txt_zip_and_inkstone_json_exports_for_matching_ids_the_newer")}>
          <Button size="sm" icon={<FileUp size={13}/>} loading={busy === 'import'} disabled={busy !== null} onClick={() => fileRef.current?.click()}>{t("settings.select_file")}</Button>
        </SettingRow>

        <input ref={fileRef} type="file" hidden multiple accept=".md,.markdown,.txt,.json,.zip,.enc" onChange={async (event) => {
            const files = [...(event.target.files ?? [])];
            event.target.value = '';
            if (!files.length)
                return;
            // 检测是否有加密备份文件
            const encryptedFiles = files.filter((f) => isEncryptedBackupFilename(f.name));
            const plainFiles = files.filter((f) => !isEncryptedBackupFilename(f.name));
            // 如果全是加密文件，弹密码框解密后再导入
            if (encryptedFiles.length > 0) {
                if (plainFiles.length > 0) {
                    toast({ title: t('settings.encryption_mixed_import'), tone: 'warning' });
                }
                setPendingEncryptedFiles(encryptedFiles);
                setDecryptPassword('');
                setDecryptError(null);
                setDecryptDialogOpen(true);
                return;
            }
            // 普通文件 → 直接导入
            await run('import', async () => {
                try {
                    const result = await api.transfer.import(plainFiles);
                    await reportImport(result);
                }
                catch (err) {
                    toast({ title: t("settings.import_failed"), description: err instanceof Error ? err.message : String(err), tone: 'danger' });
                }
            });
        }}/>
      </section>

      <section>
        <h3 className="mb-1 text-[11px] font-semibold tracking-[0.06em] text-[var(--text-quaternary)]">{t("settings.maintenance")}</h3>

        <SettingRow title={t("settings.rebuild_search_index")} description={t("settings.try_this_when_your_search_results_don_t_look_right")}>
          <Button size="sm" variant="secondary" icon={<RefreshCw size={13}/>} loading={busy === 'reindex'} disabled={busy !== null} onClick={() => run('reindex', async () => {
            try {
                const res = await api.reindex();
                toast({ title: t("settings.rebuilt_the_index_for_value0_notes", { value0: res.indexed }), tone: 'success' });
            }
            catch (err) {
                toast({ title: t("settings.rebuild_failed"), description: err instanceof Error ? err.message : String(err), tone: 'danger' });
            }
        })}>{t("settings.rebuild_index")}</Button>
        </SettingRow>

        <SettingRow title={t("settings.clean_unreferenced_attachments")} description={t("settings.delete_pictures_and_files_that_no_longer_appear_in_any_notes")}>
          <Button size="sm" variant="secondary" icon={<Sparkles size={13}/>} loading={busy === 'prune'} disabled={busy !== null} onClick={() => run('prune', async () => {
            const ok = await confirm({
                title: t("settings.clean_unreferenced_attachments_a17dbd"),
                description: t("settings.only_files_that_do_not_appear_in_the_body_of_any_note_will_be_deleted_an"),
                confirmLabel: t("settings.clean_up"),
                tone: 'danger',
            });
            if (!ok)
                return;
            try {
                const res = await api.files.prune();
                void loadStats();
                toast({
                    title: res.removed ? t("settings.cleaned_value0_attachments", { value0: res.removed }) : t("settings.there_are_no_attachments_to_clean"),
                    description: res.removed ? t("settings.freed_value0", { value0: formatBytes(res.freedBytes) }) : undefined,
                    tone: 'success',
                });
            }
            catch (err) {
                toast({ title: t("settings.cleanup_failed"), description: err instanceof Error ? err.message : String(err), tone: 'danger' });
            }
        })}>{t("settings.clean_up")}</Button>
        </SettingRow>

        <SettingRow title={t("settings.empty_trash")} description={t("settings.permanently_delete_every_note_in_trash")}>
          <Button size="sm" variant="ghost" icon={<Trash2 size={13}/>} className="text-[var(--danger)]" loading={busy === 'trash'} disabled={busy !== null} onClick={() => run('trash', async () => {
            const ok = await confirm({
                title: t("common.empty_trash"),
                description: t("settings.cannot_be_undone"),
                confirmLabel: t("common.clear"),
                tone: 'danger',
            });
            if (!ok)
                return;
            try {
                const purged = await emptyTrash();
                if (purged === null)
                    return;
                void loadStats();
                toast({
                    title: t("common.permanently_deleted_value0_notes", { value0: purged }),
                    tone: 'success',
                });
            }
            catch (err) {
                toast({
                    title: t("common.delete_failed"),
                    description: err instanceof Error ? err.message : String(err),
                    tone: 'danger',
                });
            }
        })}>{t("common.clear")}</Button>
        </SettingRow>
      </section>

      {/* 加密备份解密弹窗 */}
      <Modal
        open={decryptDialogOpen}
        onClose={() => {
            setDecryptDialogOpen(false);
            setDecryptError(null);
            setDecryptPassword('');
            setPendingEncryptedFiles([]);
        }}
        title={t('settings.decrypt_backup')}
        description={t('settings.decrypt_backup_description')}
        width={420}
        footer={<>
          <Button variant="ghost" onClick={() => setDecryptDialogOpen(false)}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={busy === 'decrypt'} disabled={busy !== null || !decryptPassword} onClick={async () => {
            await run('decrypt', async () => {
                try {
                    const decrypted: File[] = [];
                    for (const enc of pendingEncryptedFiles) {
                        const blob = await decryptBackupBlob(decryptPassword, enc);
                        // 解密后当作 ZIP 处理 (覆盖原 .enc 的 name 改为 .zip)
                        const zipName = enc.name.replace(/\.enc$/i, '.zip');
                        decrypted.push(new File([blob], zipName, { type: 'application/zip' }));
                    }
                    setDecryptDialogOpen(false);
                    setDecryptPassword('');
                    setDecryptError(null);
                    setPendingEncryptedFiles([]);
                    // 解密完成后走正常导入
                    await run('import', async () => {
                        try {
                            const result = await api.transfer.import(decrypted);
                            await reportImport(result);
                        }
                        catch (err) {
                            toast({ title: t("settings.import_failed"), description: err instanceof Error ? err.message : String(err), tone: 'danger' });
                        }
                    });
                }
                catch (err) {
                    setDecryptError(err instanceof Error ? err.message : String(err));
                }
            });
          }} data-autofocus>
            {t('settings.decrypt_and_restore')}
          </Button>
        </>}>
        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-[11px] text-[var(--text-quaternary)]">{t('settings.encryption_password')}</label>
            <input
              type="password"
              value={decryptPassword}
              onChange={(e) => { setDecryptPassword(e.target.value); setDecryptError(null); }}
              placeholder={t('settings.encryption_password_placeholder')}
              className="w-full rounded-md border border-[var(--border-subtle)] bg-[var(--bg-input)] px-2.5 py-1.5 text-[12.5px] text-[var(--text-primary)] outline-none transition focus:border-[var(--accent)]"
              autoComplete="current-password"
              onKeyDown={(e) => { if (e.key === 'Enter') (e.currentTarget.closest('[role="dialog"]')?.querySelector('button[data-autofocus]') as HTMLElement | null)?.click(); }}
            />
          </div>
          {decryptError && (
            <div role="alert" className="rounded-md bg-[var(--danger)]/10 px-2.5 py-1.5 text-[11.5px] text-[var(--danger)]">{decryptError}</div>
          )}
        </div>
      </Modal>

      <AttachmentManager open={attachmentManagerOpen} onClose={() => setAttachmentManagerOpen(false)} onChanged={() => void loadStats()}/>
    </div>);
}
