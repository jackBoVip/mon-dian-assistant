import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { queryKeys } from '../../lib/queryClient';
import type { BackupInfo } from '../../lib/types';
import { useSession } from '../../state/session';
import { Button } from '../ui/Button';
import { Badge } from '../ui/Badge';
import { Modal } from '../ui/Modal';
import { Loading, ErrorState, EmptyState } from '../ui/StateBlocks';
import { notify } from '../../state/notify';
import { toNormalisedError } from '../../lib/errors';
import { formatBytes, formatTimestamp } from '../../lib/format';

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

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-ink-muted">备份为加密文件；恢复前请确认，操作会覆盖当前数据并写入审计。</p>
        <Button variant="primary" disabled={create.isPending} onClick={() => create.mutate()}>
          {create.isPending ? '备份中…' : '立即备份'}
        </Button>
      </div>

      {backups.isLoading ? <Loading label="加载备份…" /> : null}
      {backups.isError ? <ErrorState raw={backups.error} onRetry={() => void backups.refetch()} /> : null}
      {backups.data ? (
        backups.data.length === 0 ? (
          <EmptyState>尚无备份文件。</EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">标识</th>
                  <th scope="col">文件</th>
                  <th scope="col">时间</th>
                  <th scope="col">大小</th>
                  <th scope="col">schema</th>
                  <th scope="col">加密</th>
                  <th scope="col">最近校验</th>
                  <th scope="col">操作</th>
                </tr>
              </thead>
              <tbody>
                {backups.data.map((b) => (
                  <tr key={b.id}>
                    <td className="mono text-xs">{b.id}</td>
                    <td className="mono text-xs">{b.fileName}</td>
                    <td className="text-xs">{formatTimestamp(b.createdAt)}</td>
                    <td className="text-xs">{formatBytes(b.sizeBytes)}</td>
                    <td className="text-xs">{b.schemaVersion}</td>
                    <td>
                      <Badge tone={b.encrypted ? 'success' : 'danger'}>{b.encrypted ? '已加密' : '未加密'}</Badge>
                    </td>
                    <td className="text-xs text-ink-muted">{b.verifiedAt ? formatTimestamp(b.verifiedAt) : '未校验'}</td>
                    <td>
                      <div className="flex gap-2">
                        <Button variant="ghost" disabled={verify.isPending} onClick={() => verify.mutate(b.id)}>
                          校验
                        </Button>
                        <Button variant="danger" onClick={() => setConfirmTarget(b)}>
                          恢复
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : null}

      <Modal
        open={!!confirmTarget}
        title="确认恢复备份"
        onClose={() => setConfirmTarget(null)}
        footer={
          <>
            <Button onClick={() => setConfirmTarget(null)}>取消</Button>
            <Button variant="danger" disabled={restore.isPending} onClick={() => confirmTarget && restore.mutate(confirmTarget.id)}>
              {restore.isPending ? '恢复中…' : '确认覆盖并恢复'}
            </Button>
          </>
        }
      >
        {confirmTarget ? (
          <div className="text-sm">
            <p>
              即将用备份 <span className="mono">{confirmTarget.id}</span>（{formatTimestamp(confirmTarget.createdAt)}）覆盖当前保险库数据。
            </p>
            <p className="mt-2 text-danger">此操作不可逆，当前未备份的改动将丢失。确认前建议先"立即备份"。</p>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
