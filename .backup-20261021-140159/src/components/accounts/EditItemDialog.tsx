import { useState, type FormEvent, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { invalidateTargetLists, queryKeys } from '../../lib/queryClient';
import { toNormalisedError } from '../../lib/errors';
import { buildUpdateItemPatch, type ItemPatchBaseline, type ItemPatchForm } from '../../lib/itemPatch';
import type { ItemDetail, ItemView } from '../../lib/types';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { Badge } from '../ui/Badge';
import { Loading, ErrorState } from '../ui/StateBlocks';
import { TextField, TextAreaField } from '../ui/Field';
import { PasswordField } from '../ui/PasswordField';
import { notify } from '../../state/notify';

export interface EditItemDialogProps {
  open: boolean;
  /** 列表里的这一行（ItemView）：只含后端愿意回显的字段，本对话框不假装知道秘密原文 */
  item: ItemView | null;
  onClose: () => void;
}

/** 三处 Modal（加载、失败、表单）共用同一个标题，别名不在标题里重复一遍。 */
const EDIT_TITLE = '修改账号';

/**
 * 编辑一条账号凭据：只提交改动过的键。
 * 后端语义是"缺省=保留、空串=清空"，所以未改动的键一律不发——这正是防止只改别名把密码清空的关键。
 * 注意：这里的用户名/密码属于外部系统，与本软件使用者（昵称+主密码解锁）无关。
 *
 * 交付方 2026-10-21 点名收敛这一屏：标题不再带"外部系统"，认证方式 / 浏览器 / 登录地址三栏撤下，
 * 密码那一栏从"新密码"改回"密码"，「清空已存密码」整块撤掉。三栏在后端载荷里照旧存在，
 * 补丁不带它们＝已存值原样保留（登录地址若有人事先填过，「打开并填充」仍按它开页面）。
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

  if (!open) return null;

  if (detail.isError) {
    return (
      <Modal open title={EDIT_TITLE} onClose={onClose} footer={<Button onClick={onClose}>关闭</Button>}>
        <ErrorState raw={detail.error} onRetry={() => void detail.refetch()} />
      </Modal>
    );
  }

  if (!detail.data) {
    return (
      <Modal open title={EDIT_TITLE} onClose={onClose} footer={<Button onClick={onClose}>关闭</Button>}>
        <Loading label="加载中…" />
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
  const [note, setNote] = useState(detail.note);

  // —— 秘密：永不回显，界面只给"写一个新值"这一条路（留空＝不动它） ——
  const [password, setPassword] = useState('');
  const [usernameCleared, setUsernameCleared] = useState(false);
  const [clearArmed, setClearArmed] = useState(false);

  const [aliasError, setAliasError] = useState<string | undefined>(undefined);

  const form: ItemPatchForm = {
    accountAlias: alias.trim(),
    username: username.trim(),
    note: note.trim(),
    tags,
    confirmBeforeFill: 'keep',
    password,
    usernameCleared,
  };
  const baseline: ItemPatchBaseline = {
    accountAlias: detail.accountAlias,
    tags: detail.tags,
    username: detail.username ?? undefined,
    note: detail.note,
    confirmBeforeFill: detail.confirmBeforeFill,
  };
  const patch = buildUpdateItemPatch(form, baseline);
  const changedCount = Object.keys(patch).length;

  const update = useMutation({
    mutationFn: () => api.updateItem(detail.id, patch),
    onSuccess: (row) => {
      void qc.invalidateQueries({ queryKey: queryKeys.targetDetail(row.targetId) });
      void qc.invalidateQueries({ queryKey: queryKeys.targetItems(row.targetId) });
      void qc.invalidateQueries({ queryKey: queryKeys.itemDetail(row.id) });
      invalidateTargetLists(qc);
      void qc.invalidateQueries({ queryKey: queryKeys.stats });
      notify('success', `已更新账号：${row.accountAlias}`);
      onClose();
    },
    onError: (raw) => notify('danger', toNormalisedError(raw).message),
  });

  function toggleArm() {
    setClearArmed((current) => !current);
  }

  /** 第二次点击才真正记入补丁：此后 username 发送空串，后端清空它。 */
  function confirmClear() {
    setUsernameCleared(true);
    setClearArmed(false);
  }

  /** 撤销清空＝该键回到"不提交"状态，后端原值保住。 */
  function cancelClear() {
    setUsernameCleared(false);
    setClearArmed(false);
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    if (readOnly) {
      notify('info', '当前账号为只读，无法保存修改。');
      return;
    }
    if (!alias.trim()) {
      setAliasError('账号别名不能为空。');
      return;
    }
    setAliasError(undefined);
    if (changedCount === 0) {
      notify('info', '没有需要保存的改动。');
      return;
    }
    update.mutate();
  }

  return (
    <Modal
      open
      title={EDIT_TITLE}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose} disabled={update.isPending}>
            {readOnly ? '关闭' : '取消'}
          </Button>
          {readOnly ? (
            <Badge tone="muted">只读</Badge>
          ) : (
            <Button variant="primary" onClick={submit} disabled={update.isPending || changedCount === 0}>
              {update.isPending ? '保存中…' : '保存改动'}
            </Button>
          )}
        </>
      }
    >
      <form onSubmit={submit} className="flex flex-col gap-7 pt-1">
        {readOnly ? (
          <p className="text-sm text-ink-muted" role="status">
            当前账号为只读，无法保存修改。
          </p>
        ) : null}

        <section className="flex flex-col gap-4" aria-label="账号信息">
          <h3 className="text-xs font-semibold tracking-[0.08em] text-ink-muted">账号</h3>
          <div className="grid grid-cols-2 gap-4">
            <TextField
              label="账号别名"
              value={alias}
              onChange={(e) => setAlias(e.target.value)}
              disabled={readOnly}
              error={aliasError}
            />
            <TextField
              label="标签"
              placeholder="用逗号分隔"
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              disabled={readOnly}
            />
          </div>

          {/* 用户名与密码同排、备注整行收尾（交付方 2026-10-21 点名的两行布局）。
              密码不单开一节，也不带"已设置密码"那行提示："外部系统"那层前缀早已撤下。
              留空＝不动已存值这条判定在 lib/itemPatch 里，界面上没有"抹掉已存密码"的入口。 */}
          <div className="grid grid-cols-2 gap-4">
            <TextField
              label="用户名"
              value={usernameKnown ? username : ''}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="off"
              disabled={readOnly || !usernameKnown || usernameCleared}
            />
            <PasswordField
              label="密码"
              placeholder="留空则不修改"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              disabled={readOnly}
            />
          </div>
          {!usernameKnown ? (
            <ClearUsernameRow
              armed={clearArmed}
              cleared={usernameCleared}
              disabled={readOnly}
              onToggleArm={toggleArm}
              onConfirm={confirmClear}
              onCancel={cancelClear}
            />
          ) : null}

          <TextAreaField label="备注" value={note} onChange={(e) => setNote(e.target.value)} disabled={readOnly} />
        </section>

        {update.isError ? <ErrorState raw={update.error} onRetry={() => update.mutate()} /> : null}
      </form>
    </Modal>
  );
}

/**
 * 两段式危险开关：第一次进入待确认态，第二次点击才把"清空"写进补丁；清空后随时可撤销。
 * 只在读不到用户名原文时出现——那时输入框是禁的，这颗按钮是唯一抹掉它的入口。
 */
function ClearUsernameRow({
  armed,
  cleared,
  disabled,
  onToggleArm,
  onConfirm,
  onCancel,
}: {
  armed: boolean;
  cleared: boolean;
  disabled: boolean;
  onToggleArm: () => void;
  onConfirm: () => void;
  onCancel: () => void;
}): ReactNode {
  if (cleared) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="danger">已清空用户名</Badge>
        <Button variant="ghost" disabled={disabled} onClick={onCancel}>
          撤销清空
        </Button>
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      {armed ? (
        <>
          <Button variant="danger" disabled={disabled} onClick={onConfirm}>
            确认清空已存用户名（不可恢复）
          </Button>
          <Button variant="ghost" disabled={disabled} onClick={onCancel}>
            取消
          </Button>
        </>
      ) : (
        <Button variant="ghost" disabled={disabled} onClick={onToggleArm}>
          清空已存用户名
        </Button>
      )}
    </div>
  );
}
