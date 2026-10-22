import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { queryKeys } from '../../lib/queryClient';
import type { CreateItemInput } from '../../lib/types';
import { parseTags } from '../../lib/itemPatch';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { TextField, TextAreaField } from '../ui/Field';
import { PasswordField } from '../ui/PasswordField';
import { LedgerAccountHint } from '../auth/TermHints';
import { notify } from '../../state/notify';
import { toNormalisedError } from '../../lib/errors';

export interface CreateItemDialogProps {
  open: boolean;
  targetId: string;
  hasExistingItems: boolean;
  onClose: () => void;
}

/**
 * 在某目标下新增一条外部系统账号凭据。除非显式勾选"设为默认"，否则不覆盖现有默认账号。
 *
 * 界面默认只有 账号名称 + 登录密码 两栏（原型 922-946，也是 Chrome / Edge 存一条口令的形状；
 * 交付方 2026-10-18 指定"字段默认保持和谷歌浏览器和 Edge 一样"）。用户名、令牌、备注、标签收在
 * 「更多信息」里——值存在组件状态里，折叠与否都不丢，也不影响提交。
 * 账号名称在未单独填用户名时同时作为登录用户名提交：填充链路（quick_launcher）拿的是 payload.username，
 * 只起别名不填用户名的话，"打开并填充"会填出一个空用户名。
 */
export function CreateItemDialog({ open, targetId, hasExistingItems, onClose }: CreateItemDialogProps) {
  const qc = useQueryClient();
  const [alias, setAlias] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [token, setToken] = useState('');
  const [note, setNote] = useState('');
  const [tags, setTags] = useState('');
  const [setAsDefault, setSetAsDefault] = useState(!hasExistingItems);
  const [confirmBeforeFill, setConfirmBeforeFill] = useState(true);

  const create = useMutation({
    mutationFn: () => {
      const input: CreateItemInput = {
        targetId,
        accountAlias: alias.trim(),
        username: username.trim() || alias.trim(),
        password,
        token,
        note: note.trim(),
        tags: parseTags(tags),
        confirmBeforeFill,
        setAsDefault,
      };
      return api.createItem(input);
    },
    onSuccess: (row) => {
      void qc.invalidateQueries({ queryKey: queryKeys.targetDetail(targetId) });
      void qc.invalidateQueries({ queryKey: queryKeys.targetItems(targetId) });
      void qc.invalidateQueries({ queryKey: ['targets'] });
      void qc.invalidateQueries({ queryKey: queryKeys.stats });
      notify('success', `已新增账号：${row.accountAlias}`);
      setAlias('');
      setUsername('');
      setPassword('');
      setToken('');
      setNote('');
      setTags('');
      onClose();
    },
    onError: (raw) => notify('danger', toNormalisedError(raw).message),
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!alias.trim()) {
      notify('warning', '请填写账号名称。');
      return;
    }
    create.mutate();
  }

  return (
    <Modal
      open={open}
      title="添加账号"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" onClick={submit} disabled={create.isPending}>
            {create.isPending ? '保存中…' : '保存账号'}
          </Button>
        </>
      }
    >
      <form onSubmit={submit} className="flex flex-col gap-4">
        <TextField
          label="账号名称"
          value={alias}
          onChange={(e) => setAlias(e.target.value)}
          placeholder="例如：admin@ashton.com"
          hint="未单独填用户名时，这一栏同时作为登录用户名提交。"
          required
        />
        {/* 原型这一格占位是 8 个圆点：密文框里它和"已经存了一条口令"长得一模一样，换成实话。 */}
        <PasswordField
          label="登录密码"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="请输入登录密码"
          autoComplete="new-password"
        />

        <details className="rounded-sm border border-line p-3">
          <summary className="cursor-pointer text-sm font-medium">更多信息（用户名、令牌、备注、标签）</summary>
          <div className="mt-3 flex flex-col gap-4">
            <TextField label="外部系统用户名" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" />
            <PasswordField label="令牌（可选）" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="new-password" />
            <TextAreaField label="备注" value={note} onChange={(e) => setNote(e.target.value)} />
            <TextField label="标签（逗号分隔）" value={tags} onChange={(e) => setTags(e.target.value)} />
          </div>
        </details>

        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={setAsDefault} onChange={(e) => setSetAsDefault(e.target.checked)} />
          设为我的默认账号
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={confirmBeforeFill} onChange={(e) => setConfirmBeforeFill(e.target.checked)} />
          每次自动填充前需要确认
        </label>
        {hasExistingItems && !setAsDefault ? (
          <p className="text-xs text-ink-muted">未勾选则保留该目标现有的默认账号，不会覆盖。</p>
        ) : null}
        <LedgerAccountHint />
      </form>
    </Modal>
  );
}
