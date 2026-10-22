import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { queryKeys } from '../../lib/queryClient';
import { saveFileDialog } from '../../lib/dialogs';
import { toNormalisedError } from '../../lib/errors';
import { formatBytes } from '../../lib/format';
import { notify } from '../../state/notify';
import { targetTypeLabel, type ExportPreview, type ExportResult, type PasswordAssessment } from '../../lib/types';
import { Button } from '../ui/Button';
import { Badge } from '../ui/Badge';
import { PasswordField } from '../ui/PasswordField';
import { Loading, ErrorState } from '../ui/StateBlocks';
import { usePermissionGate } from './usePermissionGate';

const SECRET_COLUMNS = new Set(['密码', '令牌', '私钥', '私钥口令', '用户名']);

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

type PendingAction = 'preview' | 'commit';

/** 台账批量导出：选择范围 → （含秘密时二次认证）→ 预览 → 选择目标路径 → 提交落盘。 */
export function ExportPanel() {
  const gate = usePermissionGate(['data-perm-gate', 'export'], () => api.exportPreview({ includeSecrets: false }));

  const targets = useQuery({ queryKey: queryKeys.targets({}), queryFn: () => api.listTargets({}) });

  const [includeSecrets, setIncludeSecrets] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [preview, setPreview] = useState<ExportPreview | null>(null);
  const [result, setResult] = useState<ExportResult | null>(null);
  const [reauthAskedFor, setReauthAskedFor] = useState<PendingAction | null>(null);
  const [reauthPw, setReauthPw] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [inlineError, setInlineError] = useState<string | null>(null);
  const [commitPath, setCommitPath] = useState('');
  const reauthRef = useRef<HTMLInputElement>(null);
  const [strength, setStrength] = useState<PasswordAssessment | null>(null);

  /**
   * 容器口令的实时强度预览。判定仍然只在后端（`export_commit` 里的策略闸门），
   * 这里只是让人在按下导出之前就知道会被拒——否则要等一次完整的派生与拒绝。
   * 口令经 IPC 送到 `password_strength`，那条命令只回不可逆评估、绝不缓存也不记录它。
   */
  useEffect(() => {
    if (!includeSecrets || !passphrase) {
      setStrength(null);
      return;
    }
    let cancelled = false;
    const t = window.setTimeout(() => {
      api
        .passwordStrength(passphrase)
        .then((a) => {
          if (!cancelled) setStrength(a);
        })
        .catch(() => {
          if (!cancelled) setStrength(null);
        });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [includeSecrets, passphrase]);

  const activeTargetIds = selectedIds.length > 0 ? selectedIds : undefined;

  const previewMut = useMutation({
    mutationFn: () => api.exportPreview({ includeSecrets, targetIds: activeTargetIds ?? null }),
    onSuccess: (p) => {
      setPreview(p);
      setResult(null);
      setInlineError(null);
    },
    onError: (raw) => {
      setPreview(null);
      const err = toNormalisedError(raw);
      setInlineError(`${err.message}${err.detail ? `（${err.detail}）` : ''}`);
    },
  });

  /** 含秘密导出：后端 export_preview 先执行 require_reauth，未二次认证一律被拒。 */
  const reauthMut = useMutation({
    mutationFn: (password: string) => api.reauthenticate(password),
    onSuccess: () => {
      setReauthAskedFor(null);
      setReauthPw('');
      if (reauthAskedFor === 'commit') {
        commitFlow();
      } else {
        previewMut.mutate();
      }
    },
    onError: (raw) => {
      // 口令绝不留存：失败同样清空输入
      setReauthPw('');
      const err = toNormalisedError(raw);
      setInlineError(`二次认证未通过：${err.message}`);
    },
  });

  const commitMut = useMutation({
    mutationFn: async (vars: { path: string; passphrase: string }) => {
      return api.exportCommit({
        path: vars.path,
        includeSecrets,
        passphrase: includeSecrets ? vars.passphrase : null,
        targetIds: activeTargetIds ?? null,
      });
    },
    onSuccess: (res) => {
      setResult(res);
      setPassphrase('');
      notify('success', res.message);
    },
    onError: (raw) => {
      setPassphrase('');
      const err = toNormalisedError(raw);
      setInlineError(`导出失败：${err.message}${err.detail ? `（${err.detail}）` : ''}`);
    },
  });

  function currentActionNeedsReauth(): boolean {
    return includeSecrets;
  }

  function submitReauth() {
    if (!reauthPw) {
      setInlineError('请输入本软件主密码完成二次认证。');
      return;
    }
    // 口令只在本次调用中转手；进入 mutation 前即清空受控状态与输入框
    const pw = reauthPw;
    setReauthPw('');
    if (reauthRef.current) reauthRef.current.value = '';
    reauthMut.mutate(pw);
  }

  function onPreviewClick() {
    setInlineError(null);
    if (currentActionNeedsReauth()) {
      setReauthAskedFor('preview');
      return;
    }
    previewMut.mutate();
  }

  function commitFlow() {
    if (includeSecrets && !passphrase) {
      setInlineError('含秘密导出必须填写容器口令：后端会把导出内容加密为口令保护的容器，空口令会被拒绝（INVALID_INPUT）。');
      return;
    }
    commitMut
      .mutateAsync({ path: commitPath, passphrase })
      .catch(() => {
        /* onError 已呈现 */
      });
  }

  async function pickDestination() {
    setInlineError(null);
    const isSecrets = includeSecrets;
    const path = await saveFileDialog({
      title: isSecrets ? '选择加密容器保存路径（.mdaexport）' : '选择 CSV 导出路径（.csv）',
      defaultPath: isSecrets ? '台账导出.mdaexport' : '台账导出.csv',
      filters: isSecrets
        ? [{ name: 'MDA 加密导出容器', extensions: ['mdaexport'] }]
        : [{ name: 'CSV 文件', extensions: ['csv'] }],
    }).catch((raw: unknown) => {
      const err = toNormalisedError(raw);
      setInlineError(err.message);
      return null;
    });
    if (path) {
      setCommitPath(path);
    }
  }

  if (gate.status === 'checking') return <Loading label="校验导出权限…" />;
  if (gate.status === 'denied' || gate.status === 'error') {
    return (
      <div className="empty-state" role="alert" aria-live="assertive">
        <span className="badge badge-danger">无权限</span>
        <span>{gate.message}</span>
        {gate.status === 'error' ? (
          <span className="text-xs text-ink-muted">错误码 · {gate.code}{gate.detail ? ` · ${gate.detail}` : ''}</span>
        ) : null}
        <Button onClick={gate.retry}>重新检查权限</Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm text-ink-muted">
        默认导出不含任何秘密字段（CSV）。勾选「包含秘密」后，产物是口令加密的
        <span className="mono"> mdaexport </span>容器（AES-256-GCM，Argon2id 派生密钥），绝不落明文；后端要求先通过主密码二次认证。
      </p>

      <section aria-labelledby="export-scope">
        <h3 id="export-scope" className="mb-2 text-sm font-semibold">第一步 · 选择范围与内容</h3>
        <label className="mb-3 flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={includeSecrets}
            onChange={(e) => {
              setIncludeSecrets(e.target.checked);
              setPreview(null);
            }}
            className="mt-1"
          />
          <span>
            <span className="font-semibold">包含秘密字段（密码 / 令牌 / 私钥 / 私钥口令 / 用户名）</span>
            {includeSecrets ? (
              <span role="alert" className="mt-1 block rounded-sm border border-danger px-3 py-2 text-xs text-danger">
                警告：含秘密导出将把凭据加密进容器文件。容器口令丢失即无法恢复，请把文件与口令通过两条独立的安全渠道交付接收方。
              </span>
            ) : null}
          </span>
        </label>

        <div className="mb-2 text-sm">
          导出范围：{selectedIds.length > 0 ? `已选 ${selectedIds.length} 个目标` : '未选择目标 = 导出全部可见目标'}
        </div>
        {targets.isLoading ? (
          <Loading label="加载目标列表…" />
        ) : targets.isError ? (
          <ErrorState raw={targets.error} onRetry={() => void targets.refetch()} />
        ) : (
          <fieldset className="max-h-64 overflow-y-auto rounded-sm border border-line p-3" aria-label="选择导出目标（可多选）">
            <legend className="text-sm">按目标勾选（不勾选则全部导出）</legend>
            {(targets.data ?? []).map((t) => (
              <label key={t.id} className="flex items-center gap-2 py-1 text-sm">
                <input
                  type="checkbox"
                  checked={selectedIds.includes(t.id)}
                  onChange={(e) =>
                    setSelectedIds((ids) => (e.target.checked ? [...ids, t.id] : ids.filter((id) => id !== t.id)))
                  }
                />
                <span>{t.displayName}</span>
                <span className="text-xs text-ink-muted">
                  {targetTypeLabel(t.targetType)} · {t.credentialCount} 个账号
                </span>
              </label>
            ))}
            {targets.data && targets.data.length === 0 ? (
              <p className="text-xs text-ink-muted">后端未返回任何目标，无可导出范围。</p>
            ) : null}
          </fieldset>
        )}
      </section>

      <section aria-labelledby="export-preview">
        <h3 id="export-preview" className="mb-2 text-sm font-semibold">第二步 · 预览导出内容</h3>
        <Button variant="primary" onClick={onPreviewClick} disabled={previewMut.isPending || reauthMut.isPending}>
          {previewMut.isPending ? '统计中…' : '预览将要导出的内容'}
        </Button>
        {currentActionNeedsReauth() && reauthAskedFor === 'preview' ? (
          <div className="mt-3 surface p-4" role="alertdialog" aria-label="主密码二次认证">
            <p className="mb-2 text-sm">含秘密导出需要二次认证：请输入本软件主密码（不是外部系统的账号密码）。密码仅用于本次验证，不会保存。</p>
            <PasswordField
              label="主密码"
              value={reauthPw}
              ref={reauthRef}
              onChange={(e) => setReauthPw(e.target.value)}
              autoComplete="off"
              name="reauth-password"
            />
            <div className="mt-2 flex gap-2">
              <Button variant="primary" onClick={submitReauth} disabled={!reauthPw || reauthMut.isPending}>
                {reauthMut.isPending ? '验证中…' : '验证并继续'}
              </Button>
              <Button
                onClick={() => {
                  setReauthAskedFor(null);
                  setReauthPw('');
                  if (reauthRef.current) reauthRef.current.value = '';
                }}
              >
                取消
              </Button>
            </div>
          </div>
        ) : null}
        {preview ? (
          <div className="mt-3 surface p-4" role="status" aria-live="polite">
            <div className="mb-2 flex flex-wrap gap-2 text-sm">
              <Badge tone="muted">目标 {preview.targets}</Badge>
              <Badge tone="muted">凭据 {preview.items}</Badge>
              <Badge tone={preview.includeSecrets ? 'danger' : 'success'}>
                {preview.includeSecrets ? '含秘密（加密容器）' : '不含秘密'}
              </Badge>
              <Badge>{preview.format}</Badge>
            </div>
            <p className="mb-2 text-xs text-ink-muted">{preview.warning}</p>
            <div className="flex flex-wrap gap-1" aria-label="导出列">
              {preview.columns.map((c) => (
                <span key={c} className={`badge ${SECRET_COLUMNS.has(c) ? 'badge-warning' : 'badge-muted'}`}>
                  {c}
                  {SECRET_COLUMNS.has(c) ? '（秘密列）' : ''}
                </span>
              ))}
            </div>
          </div>
        ) : null}
      </section>

      <section aria-labelledby="export-commit">
        <h3 id="export-commit" className="mb-2 text-sm font-semibold">第三步 · 选择路径并导出</h3>
        <div className="flex flex-wrap items-end gap-2">
          <Button onClick={() => void pickDestination()} disabled={commitMut.isPending}>
            {commitPath ? '重新选择保存路径' : '选择保存路径'}
          </Button>
          <span className="text-sm text-ink-muted">
            {commitPath ? `已选：${baseName(commitPath)}` : '尚未选择保存路径'}
          </span>
        </div>
        {includeSecrets ? (
          <div className="mt-3 w-full max-w-md">
            <PasswordField
              label="容器口令（加密导出文件用）"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              autoComplete="new-password"
              hint="这一枚是导出文件的容器口令，仍由后端按强度策略校验（位数、字符类别、常见弱密码三项），太弱会被拒绝（WEAK_PASSWORD）。它与登录主密码无关，主密码本身没有任何强度要求。口令丢失无法恢复导出文件，请通过另一条安全渠道交付。"
              name="export-passphrase"
            />
            {strength ? (
              <p className="text-xs" role="status" aria-live="polite">
                <span className={strength.acceptable ? 'text-success' : 'text-warning'}>
                  后端强度评估：{strength.acceptable ? '满足策略' : '暂不满足策略，导出会被拒'}（{strength.score}/4）
                </span>
                <span className="text-ink-muted">
                  {' '}
                  · 长度{strength.lengthOk ? '达标' : '不足'} / 字符类别{strength.hasClassVariation ? '达标' : '不足'} /
                  常见弱密码检查{strength.notCommon ? '通过' : '未通过'}
                </span>
                {strength.hint ? <span className="mt-0.5 block text-ink-muted">{strength.hint}</span> : null}
                <span className="mt-0.5 block text-ink-muted">
                  判定仍在导出时由后端执行；这份容器的强度就等于这枚口令，请与文件分开保存。
                </span>
              </p>
            ) : null}
          </div>
        ) : null}
        {currentActionNeedsReauth() && reauthAskedFor === 'commit' ? (
          <div className="mt-3 surface p-4" role="alertdialog" aria-label="主密码二次认证">
            <p className="mb-2 text-sm">含秘密导出需要二次认证，请输入本软件主密码。</p>
            <PasswordField
              label="主密码"
              value={reauthPw}
              ref={reauthRef}
              onChange={(e) => setReauthPw(e.target.value)}
              autoComplete="off"
              name="reauth-password"
            />
            <div className="mt-2 flex gap-2">
              <Button variant="primary" onClick={submitReauth} disabled={!reauthPw || reauthMut.isPending}>
                {reauthMut.isPending ? '验证中…' : '验证并导出'}
              </Button>
              <Button
                onClick={() => {
                  setReauthAskedFor(null);
                  setReauthPw('');
                  if (reauthRef.current) reauthRef.current.value = '';
                }}
              >
                取消
              </Button>
            </div>
          </div>
        ) : null}
        <div className="mt-3">
          <Button
            variant="primary"
            onClick={() => {
              setInlineError(null);
              if (currentActionNeedsReauth() && reauthAskedFor !== 'commit') {
                if (!commitPath) {
                  setInlineError('请先选择保存路径，再进行二次认证。');
                  return;
                }
                setReauthAskedFor('commit');
                return;
              }
              if (!commitPath) {
                setInlineError('请先选择保存路径。');
                return;
              }
              commitFlow();
            }}
            disabled={commitMut.isPending}
          >
            {commitMut.isPending ? '导出中…' : includeSecrets ? '二次认证并导出加密容器' : '导出 CSV'}
          </Button>
        </div>
        {!preview ? (
          <p className="mt-1 text-xs text-ink-muted">建议先在第二步预览确认范围；跳过预览不会造成后端越权——后端仍会按同一套权限与认证校验。</p>
        ) : null}
      </section>

      {inlineError ? (
        <p role="alert" aria-live="assertive" className="rounded-sm border border-danger px-3 py-2 text-sm text-danger">
          {inlineError}
        </p>
      ) : null}

      {result ? (
        <section className="panel p-4" aria-label="导出结果" role="status" aria-live="polite">
          <h3 className="panel-title mb-2">导出完成</h3>
          <div className="mb-2 flex flex-wrap gap-2 text-sm">
            <Badge tone="muted">{baseName(result.path)}</Badge>
            <Badge tone={result.encrypted ? 'success' : 'muted'}>{result.encrypted ? '已加密' : '未加密'}</Badge>
            <Badge>{result.format}</Badge>
            <Badge tone="muted">{formatBytes(result.bytes)}</Badge>
            <Badge tone="muted">{result.items} 条凭据</Badge>
          </div>
          <p className="text-xs text-ink-muted">{result.message}</p>
          <p className="mono mt-1 break-all text-xs text-ink-muted">sha256：{result.sha256}</p>
        </section>
      ) : null}
    </div>
  );
}
