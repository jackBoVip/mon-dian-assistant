import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { queryKeys } from '../../lib/queryClient';
import type { BackupInfo } from '../../lib/types';
import { useSession } from '../../state/session';
import { Button } from '../ui/Button';
import { Badge } from '../ui/Badge';
import { Icon } from '../ui/Icon';
import { Modal } from '../ui/Modal';
import { Loading, ErrorState, EmptyState } from '../ui/StateBlocks';
import { notify } from '../../state/notify';
import { toNormalisedError } from '../../lib/errors';
import { formatBytes, formatTimestamp } from '../../lib/format';

/** 备份目录里文件名就是 `<id>.mdbak`；表格只留短标识，完整 id 放 title。 */
function shortId(id: string): string {
  return id.slice(0, 8);
}

function newestBy(rows: BackupInfo[], pick: (row: BackupInfo) => string | null): BackupInfo | null {
  return rows.reduce<BackupInfo | null>((acc, row) => {
    const at = pick(row);
    if (!at) return acc;
    if (!acc) return row;
    return Date.parse(at) > Date.parse(pick(acc) ?? '') ? row : acc;
  }, null);
}

function SummaryTile({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="surface p-4">
      <p className="text-xs text-ink-muted">{label}</p>
      <p className="mt-1 truncate text-[15px] font-semibold leading-6 text-ink tabular-nums" title={title ?? value}>
        {value}
      </p>
    </div>
  );
}

/** 备份与恢复：创建/验证真实调用后端；恢复需显式二次确认，confirmed=true 才提交。 */
export function BackupSection() {
  const qc = useQueryClient();
  const backups = useQuery({ queryKey: queryKeys.backups, queryFn: () => api.listBackups() });
  const [confirmTarget, setConfirmTarget] = useState<BackupInfo | null>(null);

  const create = useMutation({
    mutationFn: () => api.createBackup(),
    onSuccess: (b) => {
      notify('success', `已创建备份 ${b.id}`);
      void qc.invalidateQueries({ queryKey: queryKeys.backups });
    },
    onError: (raw) => notify('danger', toNormalisedError(raw).message),
  });

  const verify = useMutation({
    // 后端 verify_backup 返回校验通过后带 verifiedAt 的完整 BackupInfo
    mutationFn: (id: string) => api.verifyBackup(id),
    onSuccess: (b) => {
      notify('success', `备份 ${b.id} 校验通过${b.verifiedAt ? `（${formatTimestamp(b.verifiedAt)}）` : ''}`);
      void qc.invalidateQueries({ queryKey: queryKeys.backups });
    },
    onError: (raw) => notify('danger', toNormalisedError(raw).message),
  });

  const restore = useMutation({
    mutationFn: (id: string) => api.restoreBackup(id, true),
    onSuccess: () => {
      // 后端恢复成功后强制锁定会话（lock_down），必须重新用主密码解锁
      notify('warning', '恢复完成，保险库已锁定，请使用主密码重新解锁');
      setConfirmTarget(null);
      void qc.invalidateQueries();
      void useSession.getState().bootstrap();
    },
    onError: (raw) => notify('danger', toNormalisedError(raw).message),
  });

  const rows = backups.data ?? [];
  const latest = newestBy(rows, (row) => row.createdAt);
  const latestVerified = newestBy(rows, (row) => row.verifiedAt);
  const totalBytes = rows.reduce((sum, row) => sum + row.sizeBytes, 0);

  return (
    <div className="flex flex-col gap-4">
      <div className="surface flex flex-wrap items-center justify-between gap-4 p-4">
        <div className="flex min-w-0 items-start gap-3">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-sunken text-primary">
            <Icon name="database" size={20} />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-ink">本地加密备份</p>
            <p className="mt-0.5 text-xs leading-[18px] text-ink-muted">
              每份备份都是独立的 <span className="mono">.mdbak</span> 加密文件；恢复会覆盖当前数据并写入审计。
            </p>
          </div>
        </div>
        <Button variant="primary" disabled={create.isPending} onClick={() => create.mutate()}>
          {create.isPending ? '备份中…' : '立即备份'}
        </Button>
      </div>

      {backups.isLoading ? <Loading label="加载备份…" /> : null}
      {backups.isError ? <ErrorState raw={backups.error} onRetry={() => void backups.refetch()} /> : null}
      {backups.data ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <SummaryTile label="备份份数" value={`${rows.length} 份`} />
            <SummaryTile label="占用空间" value={formatBytes(totalBytes)} />
            <SummaryTile
              label="最近备份"
              value={latest ? formatTimestamp(latest.createdAt) : '—'}
              title={latest ? `${shortId(latest.id)}.mdbak · ${formatTimestamp(latest.createdAt)}` : undefined}
            />
            <SummaryTile
              label="最近校验"
              value={latestVerified?.verifiedAt ? formatTimestamp(latestVerified.verifiedAt) : '—'}
              title={latestVerified?.verifiedAt ? `${shortId(latestVerified.id)}.mdbak` : '还没有备份通过校验'}
            />
          </div>

          {rows.length === 0 ? (
            <EmptyState>尚无备份文件；点「立即备份」创建第一份。</EmptyState>
          ) : (
            <div className="table-wrap">
              <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5">
                <h3 className="text-sm font-semibold text-ink">备份记录</h3>
                <span className="text-xs text-ink-muted tabular-nums">
                  {rows.length} 份 · 合计 {formatBytes(totalBytes)}
                </span>
              </div>
              <table className="table table-center">
                <thead>
                  <tr>
                    <th scope="col">备份文件</th>
                    <th scope="col">创建时间</th>
                    <th scope="col">大小</th>
                    <th scope="col">库结构</th>
                    <th scope="col">加密</th>
                    <th scope="col">最近校验</th>
                    <th scope="col">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((b) => (
                    <tr key={b.id}>
                      <td>
                        <span className="mono text-xs" title={`${b.id} · ${b.fileName}`}>
                          {shortId(b.id)}
                          <span className="text-ink-muted">.mdbak</span>
                        </span>
                      </td>
                      <td className="whitespace-nowrap text-xs">{formatTimestamp(b.createdAt)}</td>
                      <td className="whitespace-nowrap text-xs">{formatBytes(b.sizeBytes)}</td>
                      <td className="whitespace-nowrap text-xs tabular-nums">v{b.schemaVersion}</td>
                      <td>
                        <Badge tone={b.encrypted ? 'success' : 'danger'}>{b.encrypted ? '已加密' : '未加密'}</Badge>
                      </td>
                      <td className="whitespace-nowrap text-xs">
                        {b.verifiedAt ? (
                          <span
                            className="inline-flex items-center gap-1 text-ink-body"
                            title={`校验通过：${formatTimestamp(b.verifiedAt)}`}
                          >
                            <Icon name="checkCircle" size={13} className="text-success" />
                            {formatTimestamp(b.verifiedAt)}
                          </span>
                        ) : (
                          <span className="text-ink-muted">未校验</span>
                        )}
                      </td>
                      <td>
                        <div className="flex flex-nowrap items-center justify-center gap-1.5">
                          <Button
                            variant="ghost"
                            className="whitespace-nowrap"
                            title="校验文件完整、签名与内容可恢复"
                            disabled={verify.isPending}
                            onClick={() => verify.mutate(b.id)}
                          >
                            校验
                          </Button>
                          <Button variant="danger" className="whitespace-nowrap" onClick={() => setConfirmTarget(b)}>
                            恢复
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      ) : null}

      <Modal
        open={!!confirmTarget}
        title="确认恢复备份"
        onClose={() => setConfirmTarget(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmTarget(null)}>
              取消
            </Button>
            <Button
              variant="danger"
              disabled={restore.isPending}
              onClick={() => confirmTarget && restore.mutate(confirmTarget.id)}
            >
              {restore.isPending ? '恢复中…' : '确认覆盖并恢复'}
            </Button>
          </>
        }
      >
        {confirmTarget ? (
          <div className="flex flex-col gap-3 text-sm">
            <div className="rounded-md bg-sunken p-3">
              <p className="text-xs text-ink-muted">将用这份备份覆盖当前保险库</p>
              <p className="mono mt-1 text-sm font-semibold text-ink">{confirmTarget.fileName}</p>
              <p className="mt-0.5 text-xs text-ink-muted tabular-nums">
                创建于 {formatTimestamp(confirmTarget.createdAt)} · {formatBytes(confirmTarget.sizeBytes)} · 库结构{' '}
                <span className="mono">v{confirmTarget.schemaVersion}</span>
              </p>
            </div>
            <p className="flex items-start gap-2 text-xs leading-[18px] text-danger" role="alert">
              <Icon name="warning" size={14} className="mt-0.5 shrink-0" />
              恢复会整体替换当前保险库并锁定会话；后端会先自动生成一份回滚备份，仍建议先确认列表里已有可用的备份。
            </p>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
