import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { api, isTauri } from '../../lib/api';
import { queryKeys } from '../../lib/queryClient';
import { Button } from '../ui/Button';
import { Badge } from '../ui/Badge';
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

/**
 * 进度文案：清单里没写 size 时后端不会伪造百分比（percent 为 null），
 * 此时如实显示"已下载 X / 未知"，而不是让界面停在 0%。
 */
export function describeProgress(p: UpdateProgress): string {
  if (typeof p.percent === 'number') return `${p.percent}%`;
  const got = formatBytes(p.received ?? 0);
  return p.total ? `${got} / ${formatBytes(p.total)}（清单未给大小）` : `${got}（清单未给大小）`;
}

/** 系统更新：检查/下载/安装均走后端；下载进度来自 Tauri 事件 update://progress。 */
export function UpdateSection() {
  const qc = useQueryClient();
  const [progress, setProgress] = useState<UpdateProgress | null>(null);

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

  return (
    <div className="flex flex-col gap-4">
      {info.isLoading ? <Loading label="检查更新…" /> : null}
      {info.isError ? <ErrorState raw={info.error} onRetry={() => void info.refetch()} /> : null}
      {info.data ? (
        <div className="surface p-4">
          <div className="flex items-center justify-between">
            <span className="text-sm">当前版本</span>
            <span className="mono text-sm">{info.data.currentVersion}</span>
          </div>
          <div className="mt-2 flex items-center justify-between">
            <span className="text-sm">最新可用</span>
            <span className="mono text-sm">
              {info.data.latestVersion ?? '—'}{' '}
              {info.data.available ? <Badge tone="success">有更新</Badge> : <Badge tone="muted">已是最新</Badge>}
            </span>
          </div>
          <div className="mt-2 flex items-center justify-between">
            {/* 后端线格式：'ok' | 'failed' | 'unknown'（未配置公钥时 unknown，不得显示为安全） */}
            <span className="text-sm">签名校验</span>
            <Badge
              tone={info.data.signatureValid === 'ok' ? 'success' : info.data.signatureValid === 'failed' ? 'danger' : 'muted'}
            >
              {info.data.signatureValid === 'ok'
                ? '有效'
                : info.data.signatureValid === 'failed'
                  ? '无效'
                  : `未校验（${info.data.signatureValid}）`}
            </Badge>
          </div>
          {info.data.signer ? (
            <div className="mt-2 flex items-center justify-between">
              <span className="text-sm">签名者</span>
              <span className="mono text-xs">{info.data.signer}</span>
            </div>
          ) : null}
          <div className="mt-2 flex items-center justify-between">
            <span className="text-sm">来源 / 平台</span>
            <span className="mono text-xs">
              {info.data.sourceUrl || '未配置'}（通道：{info.data.channel}） · {info.data.platform}/{info.data.arch} ·{' '}
              {formatBytes(info.data.packageSize)}
            </span>
          </div>
          {info.data.releaseDate ? <p className="mt-1 text-xs text-ink-muted">发布日期：{info.data.releaseDate}</p> : null}
          {info.data.notes ? <p className="mt-2 text-xs text-ink-muted">{info.data.notes}</p> : null}
          {info.data.message ? <p className="mt-2 text-xs text-ink">{info.data.message}</p> : null}

          {progress ? (
            <div className="mt-3">
              <Progress value={progress.percent ?? 0} aria-label="下载进度" />
              <div className="mt-1 text-xs text-ink-muted" aria-live="polite">
                {progress.stage ?? '下载中'} · {describeProgress(progress)}
              </div>
            </div>
          ) : null}

          <div className="mt-3 flex gap-2">
            <Button onClick={() => void info.refetch()} disabled={info.isFetching}>
              重新检查
            </Button>
            <Button variant="primary" disabled={download.isPending || !info.data.available} onClick={() => download.mutate()}>
              {download.isPending ? '下载中…' : '下载更新'}
            </Button>
            <Button disabled={install.isPending || !info.data.downloaded} onClick={() => install.mutate()}>
              {install.isPending ? '安装中…' : '安装并重启'}
            </Button>
          </div>
          {!info.data.downloaded ? <p className="mt-1 text-xs text-ink-muted">需先下载完成才能安装。</p> : null}
        </div>
      ) : null}
    </div>
  );
}
