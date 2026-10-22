import { useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { queryKeys } from '../../lib/queryClient';
import { openFile, saveTextFile } from '../../lib/dialogs';
import { toNormalisedError } from '../../lib/errors';
import { notify } from '../../state/notify';
import {
  KNOWN_TARGET_TYPES,
  targetTypeLabel,
  type ContainerPreview,
  type ImportCommitResult,
  type ImportPreview,
  type RowError,
} from '../../lib/types';
import { Button } from '../ui/Button';
import { Badge } from '../ui/Badge';
import { PasswordField } from '../ui/PasswordField';
import { SelectField } from '../ui/Field';
import { Label } from '../ui/field-primitives';
import { RadioGroup, RadioGroupItem } from '../ui/radio-group';
import { Loading, ErrorState } from '../ui/StateBlocks';
import { usePermissionGate } from './usePermissionGate';

type ConflictPolicy = 'skip' | 'update' | 'abort';

/** 导入来源：CSV（明文结构 + 手工填的秘密列）与口令加密容器（导出的另一半）。 */
type SourceMode = 'csv' | 'container';

/** 两种预览的计数与错误形状字段同名，只有列头/摘要不同，所以按 kind 分流、公共部分共用渲染。 */
type PreviewState = { kind: 'csv'; data: ImportPreview } | { kind: 'container'; data: ContainerPreview };

const POLICIES: Array<{ value: ConflictPolicy; label: string; explain: string }> = [
  { value: 'skip', label: '跳过', explain: '与台账中已有目标冲突的行不写入，保留库内现有数据（后端把该行计入跳过）。' },
  { value: 'update', label: '更新', explain: '冲突行复用台账中已存在的目标，把 CSV 中的凭据作为新账号写入该目标之下。' },
  { value: 'abort', label: '中止', explain: '遇到第一条冲突行即停止导入后续所有行；此前已写入的行不会自动回滚，需检查后重新导入。' },
];

const SECRET_COLUMNS = new Set(['密码', '令牌', '私钥', '私钥口令']);

/** 行错误列表：只呈现后端给的行号/字段/中文说明，绝不回显单元格原文（可能是口令）。 */
function RowErrorList({ title, errors }: { title: string; errors: RowError[] }) {
  if (errors.length === 0) return null;
  return (
    <div className="mt-3">
      <h4 className="mb-1 text-sm font-semibold">
        {title} <Badge tone="danger">{errors.length} 条</Badge>
      </h4>
      <ul className="flex flex-col gap-1 text-sm">
        {errors.map((e, i) => (
          <li key={`${e.rowNo}-${e.code}-${i}`} className="rounded-sm border border-line px-3 py-2">
            <span className="mono text-xs text-ink-muted">第 {e.rowNo} 行 · {e.code}{e.field ? ` · 字段：${e.field}` : ''}</span>
            <div>{e.message}</div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** 台账批量导入：模板下载 → 选择 CSV 或加密容器 → 预览校验 → 冲突策略 → 提交落库。全部为真实命令调用。 */
export function ImportPanel() {
  const qc = useQueryClient();
  const [source, setSource] = useState<SourceMode>('csv');
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [policy, setPolicy] = useState<ConflictPolicy>('skip');
  const [defaultType, setDefaultType] = useState('');
  const [commitResult, setCommitResult] = useState<ImportCommitResult | null>(null);
  const [statusText, setStatusText] = useState<string | null>(null);
  // 容器口令只在一次调用中转手：提交尝试后立即清空受控状态与输入框
  const [passphrase, setPassphrase] = useState('');
  const [containerPath, setContainerPath] = useState('');
  const passRef = useRef<HTMLInputElement>(null);
  const [reauthAskedFor, setReauthAskedFor] = useState(false);
  const [reauthPw, setReauthPw] = useState('');
  const [inlineError, setInlineError] = useState<string | null>(null);
  const reauthRef = useRef<HTMLInputElement>(null);

  const gate = usePermissionGate(['data-perm-gate', 'import'], () =>
    // 真实探针：非 .csv 扩展名会被后端在 RBAC 之后立即拒绝（INVALID_INPUT），
    // 无权限则回 FORBIDDEN；两者都不触碰文件系统。CSV 与容器共用 accounts.import 权限。
    api.importPreview('权限探测.txt'),
  );

  const validRows = preview?.data.validRows ?? 0;

  function clearPassphrase() {
    setPassphrase('');
    if (passRef.current) passRef.current.value = '';
  }

  function switchSource(next: SourceMode) {
    setSource(next);
    setPreview(null);
    setCommitResult(null);
    setInlineError(null);
    clearPassphrase();
  }

  const template = useMutation({
    mutationFn: async () => {
      const t = await api.importTemplate();
      const saved = await saveTextFile(
        {
          title: '保存导入模板（CSV）',
          defaultPath: '导入模板.csv',
          filters: [{ name: 'CSV 文件', extensions: ['csv'] }],
        },
        t.csv,
      );
      return { t, saved };
    },
    onSuccess: ({ t, saved }) => {
      if (!saved) {
        setStatusText('已取消模板保存。');
        return;
      }
      const text = `模板文件「${saved.fileName}」已生成（经系统下载通道落盘，请从应用下载目录获取；当前桌面壳未开放按任意路径直接写入）。${t.note}`;
      setStatusText(text);
      notify('success', `模板已生成：${saved.fileName}`);
    },
    onError: (raw) => {
      const err = toNormalisedError(raw);
      setStatusText(null);
      notify('danger', `${err.message}${err.detail ? `（${err.detail}）` : ''}`);
    },
  });

  const previewMut = useMutation({
    mutationFn: async () => {
      const path = await openFile({
        title: '选择要导入的 CSV 文件（仅支持 .csv）',
        filters: [{ name: 'CSV 文件（后端仅接受 .csv）', extensions: ['csv'] }],
      });
      if (!path) return null;
      return api.importPreview(path);
    },
    onSuccess: (p) => {
      setCommitResult(null);
      if (!p) {
        setStatusText('已取消文件选择。');
        return;
      }
      setPreview({ kind: 'csv', data: p });
      setStatusText(`已预览「${p.filename}」。`);
    },
    onError: (raw) => {
      setPreview(null);
      setStatusText(null);
      notify('danger', toNormalisedError(raw).message);
    },
  });

  /** 容器预览：口令与路径一起交给后端，前端只留下计数与文件摘要。 */
  const containerPreviewMut = useMutation({
    mutationFn: async () => {
      if (!passphrase) throw new Error('打开加密容器需要口令');
      const path = await openFile({
        title: '选择要导入的加密容器（仅支持 .mdaexport）',
        filters: [{ name: 'MDA 加密导出容器（后端仅接受 .mdaexport）', extensions: ['mdaexport'] }],
      });
      if (!path) return null;
      setContainerPath(path);
      return api.containerPreview(path, passphrase);
    },
    onSuccess: (p) => {
      setCommitResult(null);
      if (!p) {
        setStatusText('已取消文件选择。');
        return;
      }
      setPreview({ kind: 'container', data: p });
      setStatusText(`已预览容器「${p.filename}」，文件摘要 ${p.fingerprint.slice(0, 12)}…；口令保留到本次提交完成后立即清空。`);
    },
    onError: (raw) => {
      setPreview(null);
      setStatusText(null);
      clearPassphrase();
      notify('danger', toNormalisedError(raw).message);
    },
  });

  /** 提交容器导入前必须完成主密码二次认证：后端 container_commit 先执行 require_reauth。 */
  const reauthMut = useMutation({
    mutationFn: (password: string) => api.reauthenticate(password),
    onSuccess: () => {
      setReauthAskedFor(false);
      setReauthPw('');
      if (reauthRef.current) reauthRef.current.value = '';
      commit.mutate();
    },
    onError: (raw) => {
      setReauthPw('');
      if (reauthRef.current) reauthRef.current.value = '';
      setInlineError(`二次认证未通过：${toNormalisedError(raw).message}`);
    },
  });

  const commit = useMutation({
    mutationFn: () => {
      if (!preview) throw new Error('缺少预览结果');
      if (preview.kind === 'csv') {
        const defaults = defaultType ? { targetType: defaultType } : undefined;
        return api.importCommit(preview.data.jobId, policy, defaults);
      }
      if (!containerPath || !passphrase) throw new Error('缺少容器路径或口令');
      return api.containerCommit({
        path: containerPath,
        passphrase,
        fingerprint: preview.data.fingerprint,
        conflictPolicy: policy,
      });
    },
    onSuccess: (res) => {
      setCommitResult(res);
      setPreview(null);
      setContainerPath('');
      clearPassphrase();
      // 落库后刷新账号管理相关缓存，列表立即可见新数据
      void qc.invalidateQueries({ queryKey: queryKeys.targetsAll });
      void qc.invalidateQueries({ queryKey: queryKeys.groups });
      void qc.invalidateQueries({ queryKey: queryKeys.stats });
      notify('success', res.message);
    },
    onError: (raw) => {
      // 失败同样不留口令：CONTAINER_STALE / CONTAINER_UNOPENABLE 都要重新走一遍预览
      if (source === 'container') {
        clearPassphrase();
        setInlineError(`容器导入失败：${toNormalisedError(raw).message}`);
      } else {
        notify('danger', toNormalisedError(raw).message);
      }
    },
  });

  function submitReauth() {
    if (!reauthPw) {
      setInlineError('请输入本软件主密码完成二次认证。');
      return;
    }
    // 主密码只在本次调用中转手；进入 mutation 前即清空受控状态与输入框
    const pw = reauthPw;
    setReauthPw('');
    if (reauthRef.current) reauthRef.current.value = '';
    reauthMut.mutate(pw);
  }

  function onCommitClick() {
    setInlineError(null);
    if (preview === null) return;
    if (source === 'container') {
      if (!passphrase) {
        setInlineError('容器导入必须填写口令：后端要用它派生密钥解开文件，空口令会被拒绝（INVALID_INPUT）。');
        return;
      }
      if (!reauthAskedFor) {
        setReauthAskedFor(true);
        return;
      }
    }
    commit.mutate();
  }

  if (gate.status === 'checking') return <Loading label="校验导入权限…" />;
  if (gate.status === 'denied' || gate.status === 'error') {
    const denied = gate.status === 'denied';
    return (
      <div className="empty-state" role="alert" aria-live="assertive">
        <span className="badge badge-danger">无权限</span>
        <span>{gate.message}</span>
        {!denied && gate.status === 'error' ? (
          <span className="text-xs text-ink-muted">错误码 · {gate.code}{gate.detail ? ` · ${gate.detail}` : ''}</span>
        ) : null}
        <Button onClick={gate.retry}>重新检查权限</Button>
      </div>
    );
  }

  const canCommit = preview !== null && validRows > 0 && !commit.isPending && !reauthAskedFor;

  return (
    <div className="flex flex-col gap-6">
      <p aria-live="polite" role="status" className="text-sm text-ink-muted">
        CSV 导入要求表头与模板一致（中文表头或后端登记的英文别名）；加密容器导入要用导出时设定的口令打开。
        两种来源都一样：预览与提交之间文件内容被改动过会被后端拒绝，需重新预览。
      </p>

      <section aria-labelledby="import-template">
        <h3 id="import-template" className="mb-2 text-sm font-semibold">第一步 · 获取模板</h3>
        <Button variant="primary" onClick={() => template.mutate()} disabled={template.isPending}>
          {template.isPending ? '生成中…' : '下载/保存导入模板（CSV）'}
        </Button>
        {template.isError ? <ErrorState raw={template.error} /> : null}
      </section>

      <section aria-labelledby="import-choose">
        <h3 id="import-choose" className="mb-2 text-sm font-semibold">第二步 · 选择来源与文件并预览</h3>
        <fieldset className="mb-3">
          <legend id="import-source-legend" className="mb-1 text-sm">导入来源</legend>
          {/* 原生 `<label>` 包住 input 就能拿到可及名，Radix 的档是 `<button role=radio>`，
           *  label 不给它命名——所以每档都要 id + Label htmlFor，整组再靠 legend 拿组名。 */}
          <RadioGroup value={source} onValueChange={(v) => switchSource(v as SourceMode)} aria-labelledby="import-source-legend">
            <div className="flex items-start gap-2 text-sm">
              <RadioGroupItem id="import-source-csv" value="csv" className="mt-1" />
              <Label htmlFor="import-source-csv">
                <span className="font-semibold">CSV 文件（.csv）</span>
                <span className="block text-xs text-ink-muted">按模板表头逐行校验；秘密列以明文存在于所选文件里，请自行控制文件权限。</span>
              </Label>
            </div>
            <div className="flex items-start gap-2 text-sm">
              <RadioGroupItem id="import-source-container" value="container" className="mt-1" />
              <Label htmlFor="import-source-container">
                <span className="font-semibold">口令加密容器（.mdaexport）</span>
                <span className="block text-xs text-ink-muted">
                  「导出 → 包含秘密」的产物。口令独立派生密钥，与本机设备密钥无关，所以它是设备密钥丢失或换机后唯一还能重建台账的路径。
                </span>
              </Label>
            </div>
          </RadioGroup>
        </fieldset>

        {source === 'csv' ? (
          <>
            <Button onClick={() => previewMut.mutate()} disabled={previewMut.isPending}>
              {previewMut.isPending ? '解析中…' : '选择 CSV 文件并预览'}
            </Button>
            {previewMut.isError ? <ErrorState raw={previewMut.error} /> : null}
          </>
        ) : (
          <>
            <div className="mb-2 w-full max-w-md">
              <PasswordField
                ref={passRef}
                label="容器口令（导出时设定的那个）"
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                autoComplete="off"
                name="container-passphrase"
                hint="只用于在本机派生密钥打开文件；不入库、不进日志、不进审计。口令错了打不开（CONTAINER_UNOPENABLE）。"
              />
            </div>
            <Button
              onClick={() => {
                setInlineError(null);
                if (!passphrase) {
                  setInlineError('请先输入容器口令再选择文件——后端没有口令无法打开容器。');
                  return;
                }
                containerPreviewMut.mutate();
              }}
              disabled={containerPreviewMut.isPending}
            >
              {containerPreviewMut.isPending ? '解密并解析中…' : '输入口令后选择容器并预览'}
            </Button>
            {containerPreviewMut.isError ? <ErrorState raw={containerPreviewMut.error} /> : null}
          </>
        )}
      </section>

      {preview ? (
        <section className="panel p-4" aria-label="导入预览">
          <h3 className="panel-title mb-2">预览 · {preview.data.filename}</h3>
          <div className="mb-2 flex flex-wrap gap-2 text-sm">
            <Badge>总行数 {preview.data.totalRows}</Badge>
            <Badge tone="success">有效 {preview.data.validRows}</Badge>
            <Badge tone={preview.data.errorRows > 0 ? 'danger' : 'muted'}>错误 {preview.data.errorRows}</Badge>
            <Badge tone={preview.data.conflictRows > 0 ? 'warning' : 'muted'}>冲突 {preview.data.conflictRows}</Badge>
            <Badge tone="muted">新建目标 {preview.data.newTargets}</Badge>
            {preview.kind === 'container' ? (
              <Badge tone={preview.data.containsSecrets ? 'warning' : 'muted'}>
                {preview.data.containsSecrets ? '含秘密字段' : '不含秘密字段'}
              </Badge>
            ) : null}
            {preview.data.truncated ? <Badge tone="warning">错误列表已截断</Badge> : null}
          </div>
          <p className="mb-2 text-xs text-ink-muted">{preview.data.message}</p>
          {preview.kind === 'container' ? (
            <p className="mono mb-2 break-all text-xs text-ink-muted">文件 sha256：{preview.data.fingerprint}</p>
          ) : (
            <div className="flex flex-wrap gap-1" aria-label="模板列">
              {preview.data.columns.map((c) => (
                <span key={c} className={`badge ${SECRET_COLUMNS.has(c) ? 'badge-warning' : 'badge-muted'}`}>
                  {c}
                  {SECRET_COLUMNS.has(c) ? '（秘密列：预览不回显内容）' : ''}
                </span>
              ))}
            </div>
          )}
          <RowErrorList title="行错误" errors={preview.data.errors} />
          {preview.data.conflicts.length > 0 ? (
            <div className="mt-3">
              <h4 className="mb-1 text-sm font-semibold">
                冲突提示 <Badge tone="warning">{preview.data.conflicts.length} 行</Badge>
              </h4>
              <ul className="flex flex-col gap-1 text-sm">
                {preview.data.conflicts.map((c, i) => (
                  <li key={`${c.rowNo}-${i}`} className="rounded-sm border border-line px-3 py-2">
                    <span className="mono text-xs text-ink-muted">第 {c.rowNo} 行</span> {c.targetName} · {c.reason}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </section>
      ) : null}

      <section aria-labelledby="import-policy">
        <h3 id="import-policy" className="mb-2 text-sm font-semibold">第三步 · 冲突策略与默认值</h3>
        <fieldset className="mb-3">
          <legend id="import-policy-legend" className="mb-1 text-sm">目标已存在（冲突）时的处理方式</legend>
          <RadioGroup value={policy} onValueChange={(v) => setPolicy(v as typeof policy)} aria-labelledby="import-policy-legend">
            {POLICIES.map((p) => (
              <div key={p.value} className="flex items-start gap-2 text-sm">
                <RadioGroupItem id={`import-policy-${p.value}`} value={p.value} className="mt-1" />
                <Label htmlFor={`import-policy-${p.value}`}>
                  <span className="font-semibold">{p.label}</span>
                  <span className="block text-xs text-ink-muted">{p.explain}</span>
                </Label>
              </div>
            ))}
          </RadioGroup>
        </fieldset>
        {source === 'csv' ? (
          <div className="w-64">
            <SelectField
              label="默认目标类型（可选）"
              value={defaultType}
              onValueChange={setDefaultType}
              hint="仅作用于「目标类型」留空的行；留空且未选时后端按 web 处理。"
              options={[{ value: '', label: '不设置' }, ...KNOWN_TARGET_TYPES.map((t) => ({ value: t, label: `${targetTypeLabel(t)}（${t}）` }))]}
            />
          </div>
        ) : (
          <p className="text-xs text-ink-muted">
            容器来源没有「默认目标类型」这一项：导出的每一行都自带目标类型，这一列只在 CSV 导入里对留空的行起作用。
          </p>
        )}
      </section>

      <section aria-labelledby="import-commit">
        <h3 id="import-commit" className="mb-2 text-sm font-semibold">第四步 · 提交导入</h3>
        <Button
          variant="primary"
          onClick={onCommitClick}
          disabled={!canCommit}
          title={preview === null ? '请先完成预览' : validRows === 0 ? '预览没有任何有效行，无法提交' : undefined}
        >
          {commit.isPending
            ? '导入中…'
            : source === 'container'
              ? reauthAskedFor
                ? '验证主密码并提交导入'
                : '二次认证后提交容器导入'
              : '按上方策略提交导入'}
        </Button>
        {preview === null ? (
          <p className="mt-1 text-xs text-ink-muted">
            按钮暂不可用：还没有预览结果——请先在第二步选择{source === 'csv' ? ' CSV ' : '容器 '}文件。
          </p>
        ) : validRows === 0 ? (
          <p className="mt-1 text-xs text-ink-muted">按钮暂不可用：本次预览没有任何有效行（错误 {preview.data.errorRows} 行），请修正文件后重新预览。</p>
        ) : null}
        {source === 'container' && reauthAskedFor ? (
          <div className="mt-3 surface p-4" role="alertdialog" aria-label="主密码二次认证">
            <p className="mb-2 text-sm">把容器里的凭据写进保险库属于敏感动作，需要二次认证，请输入本软件主密码。</p>
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
                {reauthMut.isPending ? '验证中…' : '验证并提交导入'}
              </Button>
              <Button
                onClick={() => {
                  setReauthAskedFor(false);
                  setReauthPw('');
                  if (reauthRef.current) reauthRef.current.value = '';
                }}
              >
                取消
              </Button>
            </div>
          </div>
        ) : null}
        {commit.isError && source === 'csv' ? <ErrorState raw={commit.error} /> : null}
        {inlineError ? (
          <p role="alert" aria-live="assertive" className="mt-2 rounded-sm border border-danger px-3 py-2 text-sm text-danger">
            {inlineError}
          </p>
        ) : null}
      </section>

      {commitResult ? (
        <section className="panel p-4" aria-label="导入结果" role="status" aria-live="polite">
          <h3 className="panel-title mb-2">导入结果</h3>
          <div className="mb-2 flex flex-wrap gap-2 text-sm">
            <Badge tone="success">写入 {commitResult.importedRows} 行</Badge>
            <Badge tone="muted">新建目标 {commitResult.createdTargets}</Badge>
            <Badge tone="muted">新增凭据 {commitResult.createdItems}</Badge>
            <Badge tone="warning">跳过 {commitResult.skippedRows}</Badge>
            <Badge tone={commitResult.conflictRows > 0 ? 'danger' : 'muted'}>冲突 {commitResult.conflictRows}</Badge>
            <Badge tone={commitResult.errors.length > 0 ? 'danger' : 'muted'}>错误 {commitResult.errors.length}</Badge>
          </div>
          <p className="text-xs text-ink-muted">{commitResult.message}</p>
          <RowErrorList title="提交时的行错误" errors={commitResult.errors} />
        </section>
      ) : null}

      {statusText ? (
        <p role="status" aria-live="polite" className="text-sm text-ink">
          {statusText}
        </p>
      ) : null}
    </div>
  );
}
