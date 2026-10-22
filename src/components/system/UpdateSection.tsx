import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { api, isTauri } from '../../lib/api';
import { queryKeys } from '../../lib/queryClient';
import { useMyPermissions, permissionSet, has, PERM } from '../../lib/permissions';
import type { UpdateInfo } from '../../lib/types';
import { Button } from '../ui/Button';
import { Badge, type BadgeTone } from '../ui/Badge';
import { Icon } from '../ui/Icon';
import { Progress } from '../ui/progress';
import { Loading, ErrorState } from '../ui/StateBlocks';
import { notify } from '../../state/notify';
import { toNormalisedError } from '../../lib/errors';
import { formatBytes } from '../../lib/format';

interface UpdateProgress {
  percent?: number;
  received?: number;
  total?: number;
  stage?: string;
}

const CHANNEL_LABEL: Record<string, string> = { stable: '稳定版', beta: '测试版' };

/**
 * 进度文案：清单里没写 size 时后端不会伪造百分比（percent 为 null），
 * 此时如实显示"已下载 X / 未知"，而不是让界面停在 0%。
 */
export function describeProgress(p: UpdateProgress): string {
  if (typeof p.percent === 'number') return `${p.percent}%`;
  const got = formatBytes(p.received ?? 0);
  return p.total ? `${got} / ${formatBytes(p.total)}（清单未给大小）` : `${got}（清单未给大小）`;
}

/** 「已是最新」只在真的拿到了远端版本号时才成立；离线时 latestVersion 为 null。 */
function versionState(info: UpdateInfo): { tone: BadgeTone; label: string } {
  if (info.available) return { tone: 'success', label: '有更新' };
  if (info.latestVersion) return { tone: 'muted', label: '已是最新' };
  return { tone: 'muted', label: '未获取到版本' };
}

/** unknown = 未配置签名公钥，此时只能显示「未校验」，不得渲染成安全态。 */
function signatureState(info: UpdateInfo): { tone: BadgeTone; label: string } {
  if (info.signatureValid === 'ok') return { tone: 'success', label: '有效' };
  if (info.signatureValid === 'failed') return { tone: 'danger', label: '无效' };
  return { tone: 'muted', label: '未校验' };
}

function DetailTile({ label, value, title }: { label: string; value: React.ReactNode; title?: string }) {
  return (
    <div className="rounded-md bg-sunken px-3 py-2">
      <p className="text-[11px] leading-4 text-ink-muted">{label}</p>
      <div className="mt-0.5 truncate text-[13px] leading-5 text-ink-body" title={title}>
        {value}
      </div>
    </div>
  );
}

/** 系统更新：检查/下载/安装均走后端；下载进度来自 Tauri 事件 update://progress。 */
export function UpdateSection() {
  const qc = useQueryClient();
  const [progress, setProgress] = useState<UpdateProgress | null>(null);
  const permsQuery = useMyPermissions();
  const perms = useMemo(() => permissionSet(permsQuery.data), [permsQuery.data]);
  const canInstall = has(perms, PERM.SYS_UPDATE_INSTALL);

  const info = useQuery({ queryKey: queryKeys.update, queryFn: () => api.checkUpdate() });

  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: UnlistenFn | undefined;
    let cancelled = false;
    listen<UpdateProgress>('update://progress', (e) => {
      setProgress(e.payload ?? {});
    })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(() => {
        /* 事件订阅失败不影响手动检查 */
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const download = useMutation({
    mutationFn: () => api.downloadUpdate(),
    onSuccess: (u) => {
      setProgress(null);
      notify('success', u.message || '下载完成');
      void qc.invalidateQueries({ queryKey: queryKeys.update });
    },
    onError: (raw) => notify('danger', toNormalisedError(raw).message),
  });

  const install = useMutation({
    mutationFn: () => api.installUpdate(),
    onSuccess: (u) => notify('success', u.message || '安装已提交'),
    onError: (raw) => notify('danger', toNormalisedError(raw).message),
  });

  const version = info.data ? versionState(info.data) : null;
  const signature = info.data ? signatureState(info.data) : null;
  const installHint = !canInstall
    ? '当前角色只能检查更新；下载与安装需要 system.update.install 权限。'
    : info.data?.available && !info.data.downloaded
      ? '需先下载完成才能安装。'
      : null;

  return (
    <div className="flex flex-col gap-4">
      {info.isLoading ? <Loading label="检查更新…" /> : null}
      {info.isError ? <ErrorState raw={info.error} onRetry={() => void info.refetch()} /> : null}
      {info.data ? (
        <div className="surface">
          <div className="flex flex-wrap items-start justify-between gap-4 p-5">
            <div className="flex min-w-0 items-start gap-3">
              <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-sunken text-primary">
                <Icon name="refresh" size={20} />
              </span>
              <div className="min-w-0">
                <p className="text-xs text-ink-muted">当前版本</p>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="mono text-2xl font-semibold leading-none text-ink">
                    v{info.data.currentVersion}
                  </span>
                  {version ? <Badge tone={version.tone}>{version.label}</Badge> : null}
                </div>
                <p className="mt-1 text-xs text-ink-muted">
                  {CHANNEL_LABEL[info.data.channel] ?? info.data.channel}通道 ·{' '}
                  <span className="mono">
                    {info.data.platform}/{info.data.arch}
                  </span>
                </p>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button onClick={() => void info.refetch()} disabled={info.isFetching}>
                {info.isFetching ? '检查中…' : '重新检查'}
              </Button>
              {canInstall ? (
                <>
                  <Button
                    variant="primary"
                    disabled={download.isPending || !info.data.available}
                    onClick={() => download.mutate()}
                  >
                    {download.isPending ? '下载中…' : '下载更新'}
                  </Button>
                  <Button disabled={install.isPending || !info.data.downloaded} onClick={() => install.mutate()}>
                    {install.isPending ? '安装中…' : '安装并重启'}
                  </Button>
                </>
              ) : null}
            </div>
          </div>

          <div className="border-t border-line p-5 pt-4">
            <div className="grid gap-2 sm:grid-cols-2">
              <DetailTile
                label="最新可用"
                value={info.data.latestVersion ? <span className="mono">v{info.data.latestVersion}</span> : '—'}
              />
              <DetailTile
                label="签名校验"
                value={
                  <span
                    className="inline-flex items-center gap-1.5"
                    title={
                      info.data.signatureValid === 'unknown'
                        ? '未配置签名公钥，无法验签'
                        : `后端状态：${info.data.signatureValid}`
                    }
                  >
                    {signature ? <Badge tone={signature.tone}>{signature.label}</Badge> : null}
                    {info.data.signatureValid === 'unknown' ? <span className="text-ink-muted">未配置公钥</span> : null}
                  </span>
                }
              />
              <DetailTile label="更新包大小" value={formatBytes(info.data.packageSize)} />
              <DetailTile
                label="更新源"
                value={info.data.sourceUrl || '未配置'}
                title={info.data.sourceUrl || '未配置更新源，当前不会发起网络请求'}
              />
              {info.data.signer ? (
                <DetailTile label="签名者" value={<span className="mono">{info.data.signer}</span>} />
              ) : null}
              {info.data.releaseDate ? <DetailTile label="发布日期" value={info.data.releaseDate} /> : null}
            </div>
          </div>

          {progress ? (
            <div className="border-t border-line px-5 py-3">
              <div className="flex items-center justify-between gap-3 text-xs">
                <span className="text-ink-muted">{progress.stage ?? '下载中'}</span>
                <span className="text-ink-body tabular-nums" aria-live="polite">
                  {describeProgress(progress)}
                </span>
              </div>
              <Progress className="mt-2" value={progress.percent ?? 0} aria-label="下载进度" />
            </div>
          ) : null}

          {info.data.notes ? (
            <div className="border-t border-line px-5 py-3">
              <p className="text-xs font-semibold text-ink">更新说明</p>
              <p className="mt-1 whitespace-pre-line text-xs leading-[18px] text-ink-body">{info.data.notes}</p>
            </div>
          ) : null}

          {info.data.message || installHint ? (
            <div className="flex flex-col gap-1.5 border-t border-line bg-sunken px-5 py-3">
              {info.data.message ? (
                <p className="flex items-start gap-2 text-xs leading-[18px] text-ink-muted" role="status">
                  <Icon name="info" size={14} className="mt-0.5 shrink-0" />
                  {info.data.message}
                </p>
              ) : null}
              {installHint ? <p className="text-xs leading-[18px] text-ink-muted">{installHint}</p> : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
