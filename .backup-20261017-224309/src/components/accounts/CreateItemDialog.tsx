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

/** 在某目标下新增一条外部系统账号凭据。除非显式勾选"设为默认"，否则不覆盖现有默认账号。 */
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
        username: username.trim(),
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
      notify('warning', '请填写账号别名。');
      return;
    }
    create.mutate();
  }

  return (
    <Modal
      open={open}
      title="新增外部系统账号（台账凭据）"
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
          label="账号别名"
          value={alias}
          onChange={(e) => setAlias(e.target.value)}
          placeholder="例如：日常办公 / 运维账号 / 只读"
          required
        />
        <TextField label="外部系统用户名" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" />
        <PasswordField label="外部系统密码" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
        <PasswordField label="令牌（可选）" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="new-password" />
        <TextAreaField label="备注" value={note} onChange={(e) => setNote(e.target.value)} />
        <TextField label="标签（逗号分隔）" value={tags} onChange={(e) => setTags(e.target.value)} />

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
