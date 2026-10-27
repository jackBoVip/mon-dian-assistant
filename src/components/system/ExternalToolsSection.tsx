import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { queryKeys } from '../../lib/queryClient';
import { openFile } from '../../lib/dialogs';
import { toNormalisedError } from '../../lib/errors';
import { notify } from '../../state/notify';
import type { ExternalTool, ToolKind } from '../../lib/types';
import {
  TOOL_KIND_WORD,
  appPathIssue,
  databaseTools,
  engineIssue,
  fixedSlot,
  labelIssue,
  normalizeEngine,
  toolStatus,
} from '../../lib/externalTools';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { Input } from '../ui/field-primitives';
import { Modal } from '../ui/Modal';
import { ErrorState, Loading } from '../ui/StateBlocks';

/** 固定两档在页面上的顺序（与出厂行一致）；数据库档是可变清单，不在这两张里。 */
const FIXED_SLOTS: Extract<ToolKind, 'browser' | 'terminal'>[] = ['browser', 'terminal'];

const PICKER_PLACEHOLDER = '/Applications/Google Chrome.app　或　C:\\Program Files\\…\\chrome.exe';

/**
 * 「外部工具」页：配置账号中心的跳转交给哪个本机应用。
 *
 * 三条必须说清的口径（都兑得出，见 `src-tauri/src/external_tools/mod.rs::plan_launch`）：
 * - 留空 = 未配置 = 交系统默认，与本轮之前的行为一致；
 * - 填了但那个应用在本机找不到（换机、卸载）= 打开时回退系统默认，界面上这一行标红；
 * - 交给数据库客户端只等于"把地址递给它"，能不能自动建连取决于那个客户端认不认这个地址。
 */
export function ExternalToolsSection() {
  const qc = useQueryClient();
  const tools = useQuery({ queryKey: queryKeys.externalTools, queryFn: () => api.externalTools() });
  const rows = tools.data ?? [];

  // 新增/编辑共用一个弹窗状态；null=关，'' 之外的 id 表示改的是那一条数据库档
  const [editing, setEditing] = useState<ExternalTool | 'new' | null>(null);

  const invalidate = () => void qc.invalidateQueries({ queryKey: queryKeys.externalTools });

  const setFixed = useMutation({
    mutationFn: ({ kind, appPath }: { kind: Extract<ToolKind, 'browser' | 'terminal'>; appPath: string }) =>
      api.setExternalTool(kind, appPath),
    onSuccess: (tool) => {
      notify('success', tool.appPath ? `${TOOL_KIND_WORD[tool.kind]}已改为用该应用打开` : `${TOOL_KIND_WORD[tool.kind]}改用系统默认`);
      invalidate();
    },
    onError: (raw) => notify('danger', toNormalisedError(raw).message),
  });

  const upsertDb = useMutation({
    mutationFn: (input: { id: string | null; engine: string; label: string; appPath: string }) =>
      api.upsertDatabaseTool(input.id, input.engine, input.label, input.appPath),
    onSuccess: (tool) => {
      notify('success', `已保存数据库工具「${tool.label}」（引擎 ${tool.engine}）`);
      setEditing(null);
      invalidate();
    },
    onError: (raw) => notify('danger', toNormalisedError(raw).message),
  });

  const removeDb = useMutation({
    mutationFn: (id: string) => api.deleteExternalTool(id),
    onSuccess: () => {
      notify('success', '该引擎档已删除，对应账号将改用系统默认');
      invalidate();
    },
    onError: (raw) => notify('danger', toNormalisedError(raw).message),
  });

  /** 提交一颗路径：前端先挡一次形状问题，后端仍然说了算（它才知道本机文件系统）。 */
  function commit(kind: Extract<ToolKind, 'browser' | 'terminal'>, raw: string, dropDraft: () => void) {
    const value = raw.trim();
    const issue = appPathIssue(value);
    if (issue) {
      notify('warning', issue);
      return;
    }
    dropDraft();
    setFixed.mutate({ kind, appPath: value });
  }

  async function pickAndCommit(kind: Extract<ToolKind, 'browser' | 'terminal'>, dropDraft: () => void) {
    try {
      const picked = await openFile({ title: `选择${TOOL_KIND_WORD[kind]}应用` });
      if (!picked) return; // 取消对话框不该改任何东西
      commit(kind, picked, dropDraft);
    } catch (raw) {
      notify('danger', toNormalisedError(raw).message);
    }
  }

  if (tools.isLoading) return <Loading label="读取外部工具配置…" />;
  if (tools.isError) return <ErrorState raw={tools.error} onRetry={() => void tools.refetch()} />;

  return (
    <div className="flex flex-col gap-6">
      <section>
        <h3 className="mb-2 text-sm font-semibold">固定两档</h3>
        <p className="mb-3 max-w-2xl text-xs leading-relaxed text-ink-muted">
          留空即用系统默认。配置对本机所有使用者生效；换机或卸载后路径失效时，打开动作会自动回退系统默认并把这件事说给你听。
        </p>
        <div className="surface flex flex-col">
          {FIXED_SLOTS.map((kind) => (
            <FixedRow
              key={kind}
              kind={kind}
              tool={fixedSlot(rows, kind)}
              busy={setFixed.isPending}
              onCommit={(value, drop) => commit(kind, value, drop)}
              onPick={(drop) => void pickAndCommit(kind, drop)}
            />
          ))}
        </div>
      </section>

      <DatabaseSection
        rows={databaseTools(rows)}
        busy={removeDb.isPending}
        onNew={() => setEditing('new')}
        onEdit={(tool) => setEditing(tool)}
        onDelete={(id) => removeDb.mutate(id)}
      />

      {editing ? (
        <ToolDialog
          tool={editing === 'new' ? null : editing}
          busy={upsertDb.isPending}
          onClose={() => setEditing(null)}
          onSave={(input) => upsertDb.mutate(input)}
        />
      ) : null}
    </div>
  );
}

function FixedRow({
  kind,
  tool,
  busy,
  onCommit,
  onPick,
}: {
  kind: Extract<ToolKind, 'browser' | 'terminal'>;
  tool: ExternalTool | undefined;
  busy: boolean;
  onCommit: (value: string, drop: () => void) => void;
  onPick: (drop: () => void) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? tool?.appPath ?? '';
  const status = toolStatus({ appPath: value, pathExists: tool?.pathExists ?? false });
  const drop = () => setDraft(null);

  return (
    <div className="flex flex-col gap-2 border-b border-line p-4 last:border-b-0">
      <div className="flex items-center justify-between gap-4">
        <span className="min-w-0">
          <span className="block text-sm">{TOOL_KIND_WORD[kind]}</span>
          <span className="mt-0.5 block text-xs text-ink-muted">
            {kind === 'browser' ? '账号中心与浮层的「打开」用它打开网页地址。' : '终端类凭据的「打开」用它接 ssh；口令始终由你在终端里输入。'}
          </span>
        </span>
        <Badge tone={status.tone}>{status.label}</Badge>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          className="mono min-w-0 flex-1 text-xs"
          spellCheck={false}
          aria-label={`${TOOL_KIND_WORD[kind]}应用路径`}
          placeholder={PICKER_PLACEHOLDER}
          value={value}
          disabled={busy}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={(e) => {
            if (draft === null) return;
            onCommit(e.target.value, drop);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
          }}
        />
        <Button disabled={busy} onClick={() => onPick(drop)}>
          选择应用
        </Button>
        {value ? (
          <Button variant="ghost" disabled={busy} onClick={() => onCommit('', drop)}>
            改用系统默认
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function DatabaseSection({
  rows,
  busy,
  onNew,
  onEdit,
  onDelete,
}: {
  rows: ExternalTool[];
  busy: boolean;
  onNew: () => void;
  onEdit: (tool: ExternalTool) => void;
  onDelete: (id: string) => void;
}) {
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  return (
    <section>
      <div className="mb-2 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">数据库工具（按引擎）</h3>
          <p className="mt-1 max-w-2xl text-xs leading-relaxed text-ink-muted">
            引擎标识取自连接串里那段（<span className="mono">jdbc:mysql://…</span> 就是 mysql）。
            账号中心里数据库类系统点「打开」时，按它的引擎找这一张表；匹配不到就等于没配置，交系统默认。
          </p>
        </div>
        <Button variant="primary" onClick={onNew}>
          新增数据库工具
        </Button>
      </div>

      {rows.length === 0 ? (
        <div className="surface p-4">
          <p className="text-sm text-ink-muted">
            还没有一条。建好之后，对应引擎的数据库账号点「打开」就会交给那个应用，而不是把 jdbc 地址丢给浏览器。
          </p>
        </div>
      ) : (
        <div className="surface">
          <div className="grid grid-cols-[minmax(0,0.7fr)_minmax(0,1fr)_minmax(0,1.6fr)_auto_auto] gap-3 border-b border-line px-4 py-2 text-[11px] text-ink-muted">
            <span>引擎</span>
            <span>名称</span>
            <span>应用路径</span>
            <span>状态</span>
            <span className="justify-self-end">操作</span>
          </div>
          {rows.map((tool) => {
            const status = toolStatus(tool);
            return (
              <div
                key={tool.id}
                className="grid grid-cols-[minmax(0,0.7fr)_minmax(0,1fr)_minmax(0,1.6fr)_auto_auto] items-center gap-3 border-b border-line px-4 py-2 text-xs last:border-b-0"
              >
                <span className="mono truncate text-ink-body" title={tool.engine}>
                  {tool.engine}
                </span>
                <span className="truncate text-ink" title={tool.label}>
                  {tool.label}
                </span>
                <span className="mono truncate text-ink-muted" title={tool.appPath}>
                  {tool.appPath || '—（用系统默认）'}
                </span>
                <span>
                  <Badge tone={status.tone}>{status.label}</Badge>
                </span>
                <span className="flex justify-end gap-1">
                  <Button variant="ghost" aria-label={`编辑 ${tool.label}`} onClick={() => onEdit(tool)}>
                    <Icon name="edit" size={14} />
                  </Button>
                  {pendingDelete === tool.id ? (
                    <>
                      <Button
                        variant="ghost"
                        disabled={busy}
                        onClick={() => {
                          setPendingDelete(null);
                          onDelete(tool.id);
                        }}
                      >
                        确认删除
                      </Button>
                      <Button variant="ghost" onClick={() => setPendingDelete(null)}>
                        取消
                      </Button>
                    </>
                  ) : (
                    <Button variant="ghost" aria-label={`删除 ${tool.label}`} onClick={() => setPendingDelete(tool.id)}>
                      <Icon name="trash" size={14} />
                    </Button>
                  )}
                </span>
              </div>
            );
          })}
        </div>
      )}
      <p className="mt-2 text-[11px] leading-4 text-ink-muted">
        删除只是撤掉这一档配置，不动任何账号数据；删掉后对应引擎改用系统默认。
      </p>
    </section>
  );
}

function ToolDialog({
  tool,
  busy,
  onClose,
  onSave,
}: {
  tool: ExternalTool | null;
  busy: boolean;
  onClose: () => void;
  onSave: (input: { id: string | null; engine: string; label: string; appPath: string }) => void;
}) {
  const [engine, setEngine] = useState(tool?.engine ?? '');
  const [label, setLabel] = useState(tool?.label ?? '');
  const [appPath, setAppPath] = useState(tool?.appPath ?? '');

  const normalized = normalizeEngine(engine);
  const issues = [engineIssue(engine), labelIssue(label), appPathIssue(appPath)].filter((x): x is string => x !== null);
  // 数据库档必须给一个应用：留空的那一条等于"这一档存在但什么都不做"，而"什么都不做"本来就是删除这条。
  // （固定两档相反——它们删不掉，所以那边留空才是正当的"改用系统默认"。）
  const canSave = issues.length === 0 && normalized !== '' && label.trim() !== '' && appPath.trim() !== '';

  async function pick() {
    try {
      const picked = await openFile({ title: '选择数据库客户端应用' });
      if (picked) setAppPath(picked);
    } catch (raw) {
      notify('danger', toNormalisedError(raw).message);
    }
  }

  return (
    <Modal
      open
      title={tool ? `编辑数据库工具：${tool.label}` : '新增数据库工具'}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button
            variant="primary"
            disabled={!canSave || busy}
            onClick={() => onSave({ id: tool?.id ?? null, engine: normalized, label: label.trim(), appPath: appPath.trim() })}
          >
            {busy ? '保存中…' : '保存'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <label className="flex flex-col gap-1">
          <span className="text-xs font-semibold text-ink-body">引擎标识</span>
          <Input
            className="mono"
            spellCheck={false}
            placeholder="mysql / oracle / postgresql / sqlserver / dm…"
            value={engine}
            onChange={(e) => setEngine(e.target.value)}
          />
          <span className="text-[11px] leading-4 text-ink-muted">
            {normalized && normalized !== engine.trim().toLowerCase()
              ? `会存成 ${normalized}（pg、postgres、psql 都归到 postgresql 这一档）`
              : '与连接串里那段协议对齐，大小写不必在意'}
          </span>
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-xs font-semibold text-ink-body">名称</span>
          <Input placeholder="例如 DBeaver（MySQL）" value={label} onChange={(e) => setLabel(e.target.value)} />
          <span className="text-[11px] leading-4 text-ink-muted">只用于这一页与打开时的提示语，说清是谁即可。</span>
        </label>

        <div className="flex flex-col gap-1">
          <span className="text-xs font-semibold text-ink-body">应用路径</span>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              className="mono min-w-0 flex-1 text-xs"
              spellCheck={false}
              aria-label="应用路径"
              placeholder={PICKER_PLACEHOLDER}
              value={appPath}
              onChange={(e) => setAppPath(e.target.value)}
            />
            <Button onClick={() => void pick()}>选择应用</Button>
          </div>
          <span className="text-[11px] leading-4 text-ink-muted">
            必须是指向本机存在的应用或可执行文件的绝对路径。这一档不要了就删掉：删掉后该引擎回到系统默认。
          </span>
        </div>

        {/* 校验错误清单：危险色在这一页只用在这一处（后端还会再判一遍，这里只是把错误提前说） */}
        {issues.length > 0 ? (
          <ul className="flex flex-col gap-1 text-[11px] leading-4 text-danger">
            {issues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        ) : null}
      </div>
    </Modal>
  );
}
