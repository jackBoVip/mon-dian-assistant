import { useState, type FormEvent, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { queryKeys } from '../../lib/queryClient';
import { toNormalisedError } from '../../lib/errors';
import {
  buildUpdateItemPatch,
  describeUpdateItemPatch,
  type ClearableField,
  type ConfirmBeforeFillChoice,
  type ItemPatchBaseline,
  type ItemPatchForm,
} from '../../lib/itemPatch';
import type { ItemDetail, ItemView } from '../../lib/types';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { Badge } from '../ui/Badge';
import { Loading, ErrorState } from '../ui/StateBlocks';
import { TextField, TextAreaField, SelectField } from '../ui/Field';
import { PasswordField } from '../ui/PasswordField';
import { LedgerAccountHint } from '../auth/TermHints';
import { formatTimestamp } from '../../lib/format';
import { notify } from '../../state/notify';

export interface EditItemDialogProps {
  open: boolean;
  /** 列表里的这一行（ItemView）：只含后端愿意回显的字段，本对话框不假装知道秘密原文 */
  item: ItemView | null;
  onClose: () => void;
}

/** 已存密码与可清空字段共用同一个"待二次确认"槽位，避免同时武装两个危险动作。 */
type ClearKey = 'password' | ClearableField;

const CLEAR_LABELS: Record<ClearKey, string> = {
  password: '已存密码',
  username: '已存用户名',
  authMethod: '已存认证方式',
  browserHint: '已存浏览器提示',
  loginUrlOverride: '已存登录地址覆盖',
  note: '已存备注',
};

/**
 * 编辑一条外部系统账号凭据（Vault Item）：只提交改动过的键。
 * 后端语义是"缺省=保留、空串=清空"，所以未改动的键一律不发——这正是防止只改别名把密码清空的关键。
 * 注意：这里的用户名/密码属于外部系统，与本软件使用者（昵称+主密码解锁）无关。
 */
export function EditItemDialog({ open, item, onClose }: EditItemDialogProps) {
  if (!item) return null;
  // key=item.id：每次换条目都重建表单，初值不会被上一条目的状态污染
  return <EditItemForm key={item.id} open={open} item={item} onClose={onClose} />;
}

function EditItemForm({ open, item, onClose }: { open: boolean; item: ItemView; onClose: () => void }) {
  // 非秘密字段与写入权限都由 item_detail 给出；拿不到基准时宁可只显示加载/失败，也不渲染"看起来能填"的表单
  const detail = useQuery({
    queryKey: queryKeys.itemDetail(item.id),
    queryFn: () => api.itemDetail(item.id),
    enabled: open,
  });

  const title = `编辑外部系统账号（${item.accountAlias}）`;

  if (!open) return null;

  if (detail.isError) {
    return (
      <Modal open title={title} onClose={onClose} footer={<Button onClick={onClose}>关闭</Button>}>
        <ErrorState raw={detail.error} onRetry={() => void detail.refetch()} />
      </Modal>
    );
  }

  if (!detail.data) {
    return (
      <Modal open title={title} onClose={onClose} footer={<Button onClick={onClose}>关闭</Button>}>
        <Loading label="加载账号原值…" />
      </Modal>
    );
  }

  return <EditItemFields detail={detail.data} onClose={onClose} />;
}

function EditItemFields({ detail, onClose }: { detail: ItemDetail; onClose: () => void }) {
  const qc = useQueryClient();

  /** 后端判定当前使用者能否写这条凭据；false 时不提供任何保存动作（而不是给一个点不动的按钮）。 */
  const readOnly = !detail.canUpdate;
  /** 无查看秘密权限时后端连用户名原文都不给：此时用户名不可编辑，补丁里也永不出现 username。 */
  const usernameKnown = detail.username !== null;

  const [alias, setAlias] = useState(detail.accountAlias);
  const [tags, setTags] = useState(detail.tags.join(', '));

  // —— item_detail 回显的非秘密字段：初值即后端原值，只有改动才会进入补丁 ——
  const [username, setUsername] = useState(detail.username ?? '');
  const [authMethod, setAuthMethod] = useState(detail.authMethod);
  const [browserHint, setBrowserHint] = useState(detail.browserHint);
  const [loginUrlOverride, setLoginUrlOverride] = useState(detail.loginUrlOverride);
  const [note, setNote] = useState(detail.note);
  const [confirmBeforeFill, setConfirmBeforeFill] = useState<ConfirmBeforeFillChoice>(
    detail.confirmBeforeFill ? 'required' : 'not_required',
  );

  // —— 秘密：永不回显，只能"写入新值"或"显式清空" ——
  const [password, setPassword] = useState('');
  const [passwordCleared, setPasswordCleared] = useState(false);
  const [cleared, setCleared] = useState<ClearableField[]>([]);
  const [armed, setArmed] = useState<ClearKey | null>(null);

  const [aliasError, setAliasError] = useState<string | undefined>(undefined);

  const form: ItemPatchForm = {
    accountAlias: alias.trim(),
    username: username.trim(),
    authMethod: authMethod.trim(),
    browserHint: browserHint.trim(),
    loginUrlOverride: loginUrlOverride.trim(),
    note: note.trim(),
    tags,
    confirmBeforeFill,
    password,
    passwordCleared,
    cleared,
  };
  const baseline: ItemPatchBaseline = {
    accountAlias: detail.accountAlias,
    tags: detail.tags,
    username: detail.username ?? undefined,
    note: detail.note,
    authMethod: detail.authMethod,
    browserHint: detail.browserHint,
    loginUrlOverride: detail.loginUrlOverride,
    confirmBeforeFill: detail.confirmBeforeFill,
  };
  const patch = buildUpdateItemPatch(form, baseline);
  const summary = describeUpdateItemPatch(patch);
  const changedCount = Object.keys(patch).length;

  const update = useMutation({
    mutationFn: () => api.updateItem(detail.id, patch),
    onSuccess: (row) => {
      void qc.invalidateQueries({ queryKey: queryKeys.targetDetail(row.targetId) });
      void qc.invalidateQueries({ queryKey: queryKeys.targetItems(row.targetId) });
      void qc.invalidateQueries({ queryKey: queryKeys.itemDetail(row.id) });
      void qc.invalidateQueries({ queryKey: ['targets'] });
      void qc.invalidateQueries({ queryKey: queryKeys.stats });
      notify('success', `已更新账号：${row.accountAlias}（版本 v${row.version}，未提交的字段保持原值）`);
      onClose();
    },
    onError: (raw) => notify('danger', toNormalisedError(raw).message),
  });

  function toggleArm(key: ClearKey) {
    setArmed((current) => (current === key ? null : key));
  }

  /** 第二次点击才真正记入补丁：此后该字段发送空串，后端清空它。 */
  function confirmClear(key: ClearKey) {
    if (key === 'password') setPasswordCleared(true);
    else setCleared((prev) => (prev.includes(key) ? prev : [...prev, key]));
    setArmed(null);
  }

  /** 撤销清空＝该键回到"不提交"状态，后端原值保住。 */
  function cancelClear(key: ClearKey) {
    if (key === 'password') setPasswordCleared(false);
    else setCleared((prev) => prev.filter((k) => k !== key));
    setArmed(null);
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    if (readOnly) {
      notify('info', '后端判定你没有这条凭据的写入权限：不会提交任何改动。');
      return;
    }
    if (!alias.trim()) {
      setAliasError('账号别名不能为空（后端要求每条凭据都有可读别名）。');
      return;
    }
    setAliasError(undefined);
    if (changedCount === 0) {
      notify('info', '没有需要保存的改动：未提交的字段都会保持后端原值。');
      return;
    }
    update.mutate();
  }

  const echoHint = '后端已回显原值：只有改动过的字段才会提交；把内容全部删掉再保存＝清空该字段。';
  const maskedHint = detail.usernameMasked ? ` 后端另给出的脱敏值是 ${detail.usernameMasked}。` : '';

  return (
    <Modal
      open
      title={`编辑外部系统账号（${detail.accountAlias}）`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose} disabled={update.isPending}>
            {readOnly ? '关闭' : '取消'}
          </Button>
          {readOnly ? (
            <Badge tone="warning">后端报告：无写入权限（只读）</Badge>
          ) : (
            <Button variant="primary" onClick={submit} disabled={update.isPending || changedCount === 0}>
              {update.isPending ? '保存中…' : `保存改动${changedCount > 0 ? `（${changedCount} 项）` : ''}`}
            </Button>
          )}
        </>
      }
    >
      <form onSubmit={submit} className="flex flex-col gap-4">
        <p className="text-xs text-ink-muted">
          本对话框编辑的是<strong>外部系统的账号凭据</strong>，不是本软件使用者的登录身份，也不涉及主密码。
          秘密字段从不回显，因此只提交你真正改动过的字段，其余由后端保持原值。
        </p>

        {readOnly ? (
          <p className="text-xs text-ink-muted" role="status">
            后端报告当前使用者对这条凭据没有写入权限：以下字段全部不可编辑，也不提供保存按钮，仅供核对。
          </p>
        ) : null}

        <section className="flex flex-col gap-3" aria-label="后端已回显的字段">
          <h3 className="text-sm font-semibold">台账可见信息（可编辑）</h3>
          <TextField
            label="账号别名"
            value={alias}
            onChange={(e) => setAlias(e.target.value)}
            disabled={readOnly}
            error={aliasError}
            hint={`当前值来自后端。创建时间 ${formatTimestamp(detail.createdAt)} · 版本 v${detail.version}`}
          />
          <TextField
            label="标签（逗号分隔）"
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            disabled={readOnly}
            hint={
              detail.tags.length > 0
                ? `后端回显：${detail.tags.map((t) => `#${t}`).join(' ')}。把内容全部删掉再保存＝清空该账号的全部标签。`
                : '该账号当前没有标签。'
            }
          />
        </section>

        <section className="flex flex-col gap-3" aria-label="外部系统账号信息">
          <h3 className="text-sm font-semibold">外部系统账号信息（原值来自后端）</h3>

          <TextField
            label="外部系统用户名"
            value={usernameKnown ? username : ''}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="off"
            disabled={readOnly || !usernameKnown || cleared.includes('username')}
            hint={
              usernameKnown
                ? `${echoHint}当前脱敏对照：${detail.usernameMasked || '（后端未给出脱敏值）'}。`
                : `后端未回显用户名原文（无查看秘密权限）：此处不展示也不可编辑${maskedHint}保存时不会提交用户名，因此不存在"读不到就清空"的风险；要抹掉它请用下方「清空已存用户名」。`
            }
          />
          <ClearRow
            field="username"
            armed={armed}
            cleared={cleared.includes('username')}
            disabled={readOnly}
            onToggleArm={toggleArm}
            onConfirm={confirmClear}
            onCancel={cancelClear}
          />

          <TextField
            label="认证方式"
            value={authMethod}
            onChange={(e) => setAuthMethod(e.target.value)}
            placeholder="password / token / key"
            disabled={readOnly || cleared.includes('authMethod')}
            hint={echoHint}
          />
          <ClearRow
            field="authMethod"
            armed={armed}
            cleared={cleared.includes('authMethod')}
            disabled={readOnly}
            onToggleArm={toggleArm}
            onConfirm={confirmClear}
            onCancel={cancelClear}
          />

          <TextField
            label="浏览器提示"
            value={browserHint}
            onChange={(e) => setBrowserHint(e.target.value)}
            placeholder="chrome / edge / 其他"
            disabled={readOnly || cleared.includes('browserHint')}
            hint={echoHint}
          />
          <ClearRow
            field="browserHint"
            armed={armed}
            cleared={cleared.includes('browserHint')}
            disabled={readOnly}
            onToggleArm={toggleArm}
            onConfirm={confirmClear}
            onCancel={cancelClear}
          />

          <TextField
            label="登录地址覆盖"
            value={loginUrlOverride}
            onChange={(e) => setLoginUrlOverride(e.target.value)}
            placeholder="仅当该系统登录页与目标地址不同才填"
            disabled={readOnly || cleared.includes('loginUrlOverride')}
            hint={echoHint}
          />
          <ClearRow
            field="loginUrlOverride"
            armed={armed}
            cleared={cleared.includes('loginUrlOverride')}
            disabled={readOnly}
            onToggleArm={toggleArm}
            onConfirm={confirmClear}
            onCancel={cancelClear}
          />

          <TextAreaField
            label="备注"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            disabled={readOnly || cleared.includes('note')}
            hint={echoHint}
          />
          <ClearRow
            field="note"
            armed={armed}
            cleared={cleared.includes('note')}
            disabled={readOnly}
            onToggleArm={toggleArm}
            onConfirm={confirmClear}
            onCancel={cancelClear}
          />

          <SelectField
            label="每次自动填充前需要确认"
            value={confirmBeforeFill}
            onChange={(e) => setConfirmBeforeFill(e.target.value as ConfirmBeforeFillChoice)}
            disabled={readOnly}
            hint={`后端回显：当前为「${detail.confirmBeforeFill ? '需要确认' : '无需确认'}」。选择「保持当前（不提交）」时不会发送任何值。`}
          >
            <option value="keep">保持当前（不提交）</option>
            <option value="required">需要确认</option>
            <option value="not_required">无需确认</option>
          </SelectField>
        </section>

        <section className="flex flex-col gap-3" aria-label="外部系统密码">
          <h3 className="text-sm font-semibold">外部系统密码（永不回显）</h3>
          <p className="text-xs text-ink-muted">
            {detail.hasPassword ? (
              <Badge tone="success">后端报告：已存有密码</Badge>
            ) : (
              <Badge tone="muted">后端报告：当前没有已存密码</Badge>
            )}
          </p>
          <PasswordField
            label="新的外部系统密码（留空不修改）"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            disabled={readOnly || passwordCleared}
            hint="留空表示不修改已存密码；要写入新密码就直接输入。已存密码无法在这里查看，只有显式清空才会删除它。"
          />
          {detail.hasPassword ? (
            <ClearRow
              field="password"
              armed={armed}
              cleared={passwordCleared}
              disabled={readOnly}
              onToggleArm={toggleArm}
              onConfirm={confirmClear}
              onCancel={cancelClear}
            />
          ) : null}
          <p className="text-xs text-ink-muted">
            令牌/私钥/口令短语本对话框不提交（后端报告：
            {detail.hasToken ? '已存令牌' : '无令牌'} /{detail.hasPrivateKey ? '已存私钥' : '无私钥'}
            ），不发送这些键即保持原值。
          </p>
        </section>

        <div className="rounded-sm border border-line p-3" aria-live="polite">
          <div className="mb-1 text-sm font-medium">本次将提交 {changedCount} 个字段</div>
          {changedCount === 0 ? (
            <p className="text-xs text-ink-muted">
              {readOnly
                ? '没有写入权限：不会提交任何字段，含已存密码在内的所有值保持后端原值。'
                : '没有改动。未列出的字段（含已存密码）一律保持后端原值，因此「保存改动」当前不可点。'}
            </p>
          ) : (
            <ul className="flex flex-col gap-1">
              {summary.map((s) => (
                <li key={s} className="text-xs">
                  · {s}
                </li>
              ))}
            </ul>
          )}
        </div>

        {update.isError ? <ErrorState raw={update.error} onRetry={() => update.mutate()} /> : null}

        <LedgerAccountHint />
      </form>
    </Modal>
  );
}

/** 两段式危险开关：第一次进入待确认态，第二次点击才把"清空"写进补丁；清空后随时可撤销。 */
function ClearRow({
  field,
  armed,
  cleared,
  disabled,
  onToggleArm,
  onConfirm,
  onCancel,
}: {
  field: ClearKey;
  armed: ClearKey | null;
  cleared: boolean;
  disabled: boolean;
  onToggleArm: (key: ClearKey) => void;
  onConfirm: (key: ClearKey) => void;
  onCancel: (key: ClearKey) => void;
}): ReactNode {
  const label = CLEAR_LABELS[field];
  if (cleared) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="danger">已选择：清空{label}</Badge>
        <Button variant="ghost" disabled={disabled} onClick={() => onCancel(field)}>
          撤销清空
        </Button>
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      {armed === field ? (
        <>
          <Button variant="danger" disabled={disabled} onClick={() => onConfirm(field)}>
            {`确认清空${label}（不可恢复）`}
          </Button>
          <Button variant="ghost" disabled={disabled} onClick={() => onCancel(field)}>
            取消
          </Button>
        </>
      ) : (
        <Button variant="danger" disabled={disabled} onClick={() => onToggleArm(field)}>
          {`清空${label}`}
        </Button>
      )}
      <span className="text-xs text-ink-muted">需两次点击确认；未确认前不会提交空值。</span>
    </div>
  );
}
