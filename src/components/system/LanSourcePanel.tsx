import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { queryKeys } from '../../lib/queryClient';
import { openDirectory } from '../../lib/dialogs';
import { PERM, has, permissionSet, useMyPermissions } from '../../lib/permissions';
import { toNormalisedError } from '../../lib/errors';
import type { LanSourceView, LanStatus, UpdateInfo } from '../../lib/types';
import { notify } from '../../state/notify';
import { Button } from '../ui/Button';
import { Badge, type BadgeTone } from '../ui/Badge';
import { Icon } from '../ui/Icon';
import { Switch } from '../ui/switch';
import { Input } from '../ui/field-primitives';
import { Progress } from '../ui/progress';
import { Loading, ErrorState } from '../ui/StateBlocks';

/** 扫描宽限期：不到这个时长就显示"扫描中"，免得每次进页面都先报"没发现"。 */
export const LAN_SCAN_GRACE_MS = 8_000;

export interface LanUiInput {
  enabled: boolean;
  discoveryError: string | null;
  /** 发现线程已运行的时长（取「进程运行时长」与「进页面时长」的较小值） */
  elapsedMs: number;
  sourceCount: number;
  /** 其中版本高于本机的源数量 */
  newerCount: number;
  manualSource: string | null;
}

export interface LanUiState {
  kind: 'off' | 'unavailable' | 'found' | 'stale' | 'scanning' | 'manual' | 'empty';
  tone: BadgeTone;
  label: string;
  hint: string;
  /** 是否展开手填 IP:端口 的输入框 */
  showManual: boolean;
}

/**
 * 面板状态机。分支顺序即优先级：关闭 → 组播不可用 → 有源（分「有新版本/都比本机旧」）
 * → 还在扫描 → 只剩手填地址 → 什么也没有。
 */
export function lanUiState(input: LanUiInput): LanUiState {
  if (!input.enabled) {
    return {
      kind: 'off',
      tone: 'muted',
      label: '发现已关闭',
      hint: '组播发现已关闭；仍可在下面手填更新源地址。',
      showManual: true,
    };
  }
  if (input.discoveryError) {
    return {
      kind: 'unavailable',
      tone: 'warning',
      label: '组播不可用',
      hint: `组播监听失败：${input.discoveryError}。可在下面手填更新源地址。`,
      showManual: true,
    };
  }
  if (input.sourceCount > 0 && input.newerCount > 0) {
    return {
      kind: 'found',
      tone: 'success',
      label: `已发现 ${input.sourceCount} 个源`,
      hint: '',
      showManual: false,
    };
  }
  if (input.sourceCount > 0) {
    return {
      kind: 'stale',
      tone: 'muted',
      label: `已发现 ${input.sourceCount} 个源`,
      hint: '这些源的版本都不高于本机，不会提示升级。',
      showManual: false,
    };
  }
  if (input.elapsedMs < LAN_SCAN_GRACE_MS) {
    return {
      kind: 'scanning',
      tone: 'muted',
      label: '扫描中…',
      hint: '正在等待同网段更新源的宣告。',
      showManual: false,
    };
  }
  if (input.manualSource) {
    return {
      kind: 'manual',
      tone: 'muted',
      label: '使用手填地址',
      hint: '',
      showManual: true,
    };
  }
  return {
    kind: 'empty',
    tone: 'warning',
    label: '未发现更新源',
    hint: '同网段内没有人开启「在本机提供更新」；可以手填地址，或由本机开启托管。',
    showManual: true,
  };
}

function SourceRow({
  source,
  busy,
  canInstall,
  onUse,
}: {
  source: LanSourceView;
  busy: boolean;
  canInstall: boolean;
  onUse: () => void;
}) {
  return (
    <div className="grid grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_auto_minmax(0,0.9fr)_auto] items-center gap-3 border-b border-line py-2 text-xs last:border-b-0">
      <span className="truncate text-ink-body" title={source.host}>
        {source.host}
      </span>
      <span className="mono truncate text-ink-muted" title={`${source.ip}:${source.port}`}>
        {source.ip}:{source.port}
      </span>
      <span className="mono text-ink-body">v{source.version}</span>
      <span className="mono truncate text-ink-muted">
        {source.platform}/{source.arch}
      </span>
      <span className="justify-self-end">
        {source.newerThanLocal ? (
          <Button variant="primary" disabled={!canInstall || busy} onClick={onUse}>
            {busy ? '更新中…' : '从局域网更新'}
          </Button>
        ) : (
          <span className="text-ink-muted">低于本机</span>
        )}
      </span>
    </div>
  );
}

interface Props {
  /** 主卡片自己的更新信息：打开安装包后用它刷新「已下载」状态 */
  progress: { percent?: number; received?: number; total?: number; stage?: string } | null;
}

/**
 * 局域网更新源面板：展示组播发现的同网段源，并允许本机托管已签名更新包。
 *
 * 三条与后端一致的硬约束会体现在界面上：
 * 1. 低于本机的源照常列出，但按钮禁用——绝不降级；
 * 2. 没有安装权限时按钮不渲染，说明原因；
 * 3. 托管目录自检不过时后端拒绝开启，这里如实显示 `serveError`。
 */
export function LanSourcePanel({ progress }: Props) {
  const qc = useQueryClient();
  const [mountedAt] = useState(() => Date.now());
  const [draftDir, setDraftDir] = useState<string | null>(null);
  const [manualDraft, setManualDraft] = useState<string | null>(null);
  const [ready, setReady] = useState<UpdateInfo | null>(null);

  const permsQuery = useMyPermissions();
  const perms = useMemo(() => permissionSet(permsQuery.data), [permsQuery.data]);
  const canInstall = has(perms, PERM.SYS_UPDATE_INSTALL);
  const canServe = has(perms, PERM.SYS_UPDATE_SERVE);

  const status = useQuery({
    queryKey: queryKeys.lan,
    queryFn: () => api.lanStatus(),
    refetchInterval: 3000,
  });

  const s: LanStatus | undefined = status.data;
  const elapsed = Math.min(s?.elapsedMs ?? 0, Date.now() - mountedAt);
  const ui = lanUiState({
    enabled: s?.discoveryEnabled ?? true,
    discoveryError: s?.discoveryError ?? null,
    elapsedMs: elapsed,
    sourceCount: s?.sources.length ?? 0,
    newerCount: (s?.sources ?? []).filter((x) => x.newerThanLocal).length,
    manualSource: s?.manualSource ?? null,
  });

  // 一次点击跑完「拉清单验签 → 取包校验」；任何一步不过都停在原处并说明原因。
  const run = useMutation({
    mutationFn: async (source?: string) => {
      const checked = await api.lanCheck(source);
      if (!checked.available) return { done: false, info: checked };
      const downloaded = await api.lanDownload();
      return { done: true, info: downloaded };
    },
    onSuccess: ({ done, info }) => {
      if (!done) {
        notify('warning', info.message || '该源的版本不高于本机，未执行下载。');
      } else {
        setReady(info);
        notify('success', info.message || '更新包已下载并校验通过');
      }
      void qc.invalidateQueries({ queryKey: queryKeys.lan });
      void qc.invalidateQueries({ queryKey: queryKeys.update });
    },
    onError: (raw) => notify('danger', toNormalisedError(raw).message),
  });

  const open = useMutation({
    mutationFn: () => api.installUpdate(),
    onSuccess: (info) => {
      notify('success', info.message);
      void qc.invalidateQueries({ queryKey: queryKeys.update });
    },
    onError: (raw) => notify('danger', toNormalisedError(raw).message),
  });

  const serve = useMutation({
    mutationFn: ({ enabled, dir }: { enabled: boolean; dir: string }) => api.lanSetServe(enabled, dir),
    onSuccess: (next) => {
      setDraftDir(null);
      qc.setQueryData(queryKeys.lan, next);
      if (next.serveError) notify('danger', `托管未启动：${next.serveError}`);
      else notify('success', next.serving ? `已开始托管，监听端口 ${next.servePort}` : '已停止托管');
    },
    onError: (raw) => notify('danger', toNormalisedError(raw).message),
  });

  const saveManual = useMutation({
    mutationFn: (value: string) => api.updateSetting('lan_manual_source', value),
    onSuccess: () => {
      setManualDraft(null);
      void qc.invalidateQueries({ queryKey: queryKeys.lan });
      notify('success', '手填更新源已保存');
    },
    onError: (raw) => notify('danger', toNormalisedError(raw).message),
  });

  const chosenDir = draftDir ?? s?.serveDir ?? '';
  const manualValue = manualDraft ?? s?.manualSource ?? '';

  async function pickDir() {
    try {
      const picked = await openDirectory({ title: '选择更新托管目录' });
      if (picked) setDraftDir(picked);
    } catch (raw) {
      notify('danger', toNormalisedError(raw).message);
    }
  }

  if (status.isLoading) return <Loading label="读取局域网更新状态…" />;
  if (status.isError) return <ErrorState raw={status.error} onRetry={() => void status.refetch()} />;

  return (
    <div className="surface">
      <div className="flex flex-wrap items-start justify-between gap-3 p-5 pb-4">
        <div className="flex min-w-0 items-start gap-3">
          <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-sunken text-primary">
            <Icon name="download" size={20} />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-ink">局域网更新源</p>
            <p className="mt-0.5 text-xs leading-[18px] text-ink-muted">
              同网段的机器开启托管后会广播自己；清单仍需发布公钥验签，明文信道不降低校验要求。
            </p>
          </div>
        </div>
        <Badge tone={ui.tone}>{ui.label}</Badge>
      </div>

      {ui.hint ? (
        <div className="border-t border-line px-5 py-3">
          <p className="flex items-start gap-2 text-xs leading-[18px] text-ink-muted" role="status">
            <Icon name="info" size={14} className="mt-0.5 shrink-0" />
            {ui.hint}
          </p>
        </div>
      ) : null}

      {s && s.sources.length > 0 ? (
        <div className="border-t border-line px-5 py-3">
          <div className="grid grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_auto_minmax(0,0.9fr)_auto] gap-3 pb-1 text-[11px] text-ink-muted">
            <span>源</span>
            <span>地址</span>
            <span>版本</span>
            <span>平台</span>
            <span className="justify-self-end">操作</span>
          </div>
          {s.sources.map((source) => (
            <SourceRow
              key={source.instance}
              source={source}
              busy={run.isPending}
              canInstall={canInstall}
              onUse={() => run.mutate(source.instance)}
            />
          ))}
          {!canInstall ? (
            <p className="pt-2 text-xs text-ink-muted">当前角色只能查看源；下载与打开安装包需要 system.update.install 权限。</p>
          ) : null}
        </div>
      ) : null}

      {progress ? (
        <div className="border-t border-line px-5 py-3">
          <div className="flex items-center justify-between gap-3 text-xs">
            <span className="text-ink-muted">{progress.stage ?? '下载中'}</span>
            <span className="text-ink-body tabular-nums" aria-live="polite">
              {typeof progress.percent === 'number' ? `${progress.percent}%` : ''}
            </span>
          </div>
          <Progress className="mt-2" value={progress.percent ?? 0} aria-label="局域网下载进度" />
        </div>
      ) : null}

      {ready?.downloaded ? (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line bg-sunken px-5 py-3">
          <p className="text-xs text-ink-muted">
            已从 <span className="mono">{ready.lanSource ?? '局域网源'}</span> 取得 v{ready.latestVersion}，SHA-256 与签名清单一致。
          </p>
          <Button variant="primary" disabled={open.isPending} onClick={() => open.mutate()}>
            {open.isPending ? '打开中…' : '打开安装包'}
          </Button>
        </div>
      ) : null}

      {ui.showManual ? (
        <div className="border-t border-line px-5 py-3">
          <p className="text-xs font-semibold text-ink">手填更新源地址</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Input
              className="min-w-0 flex-1"
              placeholder="10.0.0.5:8765"
              aria-label="手填更新源地址"
              value={manualValue}
              onChange={(e) => setManualDraft(e.target.value)}
            />
            <Button
              disabled={saveManual.isPending || run.isPending}
              onClick={() => {
                const value = manualValue.trim();
                if (!value) {
                  notify('warning', '请先填写同网段更新源地址，例如 10.0.0.5:8765。');
                  return;
                }
                saveManual.mutate(value, { onSuccess: () => run.mutate(value) });
              }}
            >
              保存并检查
            </Button>
            <Button variant="ghost" disabled={saveManual.isPending} onClick={() => saveManual.mutate('')}>
              清除
            </Button>
          </div>
          <p className="mt-1 text-[11px] leading-4 text-ink-muted">只接受私网 IP 字面量（如 192.168.1.20:8765）；域名不会被放行。</p>
        </div>
      ) : null}

      {canServe ? (
        <div className="border-t border-line px-5 py-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm text-ink">在本机提供更新</p>
              <p className="mt-0.5 text-xs leading-[18px] text-ink-muted">
                开启后监听 0.0.0.0:{s?.servePort ?? 8765}，仅同网段私网地址可达；托管的是已签名清单与安装包，不含任何账号秘密。
              </p>
            </div>
            <Switch
              aria-label="在本机提供更新"
              checked={s?.serving ?? false}
              disabled={serve.isPending}
              onCheckedChange={(checked) => {
                if (checked && !chosenDir) {
                  notify('warning', '请先选择托管目录（需包含 manifest.json 与 packages/）。');
                  return;
                }
                serve.mutate({ enabled: checked, dir: chosenDir });
              }}
            />
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <span className="mono min-w-0 flex-1 truncate text-xs text-ink-muted" title={chosenDir}>
              {chosenDir || '未选择托管目录'}
            </span>
            <Button onClick={() => void pickDir()}>选择目录</Button>
            {draftDir ? (
              <Button variant="primary" disabled={serve.isPending} onClick={() => serve.mutate({ enabled: true, dir: chosenDir })}>
                使用此目录开启
              </Button>
            ) : null}
          </div>
          {s?.serveError ? (
            <p className="mt-2 flex items-start gap-2 text-xs leading-[18px] text-ink-muted" role="status">
              <Icon name="warning" size={14} className="mt-0.5 shrink-0" />
              托管未启动：{s.serveError}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
