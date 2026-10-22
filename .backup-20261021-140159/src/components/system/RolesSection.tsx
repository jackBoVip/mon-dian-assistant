import { useId, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { invalidateRbac, queryKeys } from '../../lib/queryClient';
import type { RoleAdminSummary } from '../../lib/types';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { FormShell } from '../ui/form';
import { TextField, SelectField } from '../ui/Field';
import { Badge } from '../ui/Badge';
import { Modal } from '../ui/Modal';
import { Loading, ErrorState, EmptyState } from '../ui/StateBlocks';
import { notify } from '../../state/notify';
import { toNormalisedError } from '../../lib/errors';

const STATUS_OPTIONS = [
  { value: 'active', label: '启用' },
  { value: 'disabled', label: '停用' },
];

/** 角色管理：角色元数据的增删改与启停；内置角色的元数据锁定，只有权限集合可调。 */
export function RolesSection() {
  const qc = useQueryClient();
  const roles = useQuery({ queryKey: queryKeys.rolesAdmin, queryFn: () => api.listRolesAdmin() });
  const [createOpen, setCreateOpen] = useState(false);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [editing, setEditing] = useState<RoleAdminSummary | null>(null);
  const [editName, setEditName] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editStatus, setEditStatus] = useState('active');
  const [deleteTarget, setDeleteTarget] = useState<RoleAdminSummary | null>(null);
  const createFormId = useId();
  const editFormId = useId();

  const onError = (raw: unknown) => notify('danger', toNormalisedError(raw).message);
  const done = (message: string) => {
    notify('success', message);
    invalidateRbac(qc);
  };

  const create = useMutation({
    mutationFn: () => api.createRole(code.trim(), name.trim(), description.trim()),
    onSuccess: () => {
      done('角色已创建');
      setCode('');
      setName('');
      setDescription('');
      setCreateOpen(false);
    },
    onError,
  });

  const update = useMutation({
    mutationFn: () =>
      api.updateRole(editing?.id ?? '', editName.trim(), editDescription.trim(), editStatus as 'active' | 'disabled'),
    onSuccess: () => {
      done('角色已更新');
      setEditing(null);
    },
    onError,
  });

  const remove = useMutation({
    mutationFn: (roleId: string) => api.deleteRole(roleId),
    onSuccess: () => {
      done('角色已删除');
      setDeleteTarget(null);
    },
    onError,
  });

  function openCreate() {
    setCode('');
    setName('');
    setDescription('');
    setCreateOpen(true);
  }

  function closeCreate() {
    if (!create.isPending) setCreateOpen(false);
  }

  function startEdit(role: RoleAdminSummary) {
    setEditing(role);
    setEditName(role.name);
    setEditDescription(role.description);
    setEditStatus(role.status);
  }

  function onCreate() {
    if (!code.trim() || !name.trim()) {
      notify('warning', '角色标识与名称必填。');
      return;
    }
    create.mutate();
  }

  function onEdit() {
    if (!editName.trim()) {
      notify('warning', '角色名称必填。');
      return;
    }
    update.mutate();
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {roles.data ? <p className="text-xs text-ink-muted">共 {roles.data.length} 个角色</p> : null}
        <button
          type="button"
          className="btn-icon-primary"
          aria-label="新建角色"
          title="新建角色"
          onClick={openCreate}
        >
          <Icon name="plus" size={20} />
        </button>
      </div>

      {roles.isLoading ? <Loading label="加载角色…" /> : null}
      {roles.isError ? <ErrorState raw={roles.error} onRetry={() => void roles.refetch()} /> : null}
      {roles.data ? (
        roles.data.length === 0 ? (
          <EmptyState>尚未定义任何角色。</EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="table table-center">
              <thead>
                <tr>
                  <th scope="col">名称</th>
                  <th scope="col">标识</th>
                  <th scope="col">说明</th>
                  <th scope="col">状态</th>
                  <th scope="col">内置</th>
                  <th scope="col">绑定使用者</th>
                  <th scope="col">操作</th>
                </tr>
              </thead>
              <tbody>
                {roles.data.map((role) => (
                  <RoleRow
                    key={role.id}
                    role={role}
                    busy={update.isPending || remove.isPending}
                    onEdit={() => startEdit(role)}
                    onDelete={() => setDeleteTarget(role)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : null}

      <Modal
        open={createOpen}
        title="新建角色"
        onClose={closeCreate}
        footer={
          <>
            <Button variant="ghost" disabled={create.isPending} onClick={closeCreate}>
              取消
            </Button>
            <Button type="submit" form={createFormId} variant="primary" disabled={create.isPending}>
              {create.isPending ? '创建中…' : '创建角色'}
            </Button>
          </>
        }
      >
        <FormShell id={createFormId} onSubmit={onCreate} className="flex flex-col gap-5 pt-1" noValidate>
          <TextField
            label="角色标识"
            required
            value={code}
            onChange={(e) => setCode(e.target.value)}
            hint="小写字母开头，仅 a-z0-9_-，2–32 位"
          />
          <TextField label="名称" required value={name} onChange={(e) => setName(e.target.value)} />
          <TextField label="说明" value={description} onChange={(e) => setDescription(e.target.value)} />
        </FormShell>
      </Modal>

      <Modal
        open={editing !== null}
        title="编辑角色"
        onClose={() => {
          if (!update.isPending) setEditing(null);
        }}
        footer={
          <>
            <Button variant="ghost" disabled={update.isPending} onClick={() => setEditing(null)}>
              取消
            </Button>
            <Button
              type="submit"
              form={editFormId}
              variant="primary"
              disabled={update.isPending || !editName.trim() || editing?.builtin === true}
              title={editing?.builtin ? '内置角色的元数据不可修改' : undefined}
            >
              {update.isPending ? '保存中…' : '保存角色'}
            </Button>
          </>
        }
      >
        <p className="mb-4 text-xs text-ink-muted">
          {editing?.builtin
            ? '内置角色：名称、说明与状态不可修改；权限集合仍可在权限管理页调整。'
            : `角色标识 ${editing?.code ?? ''} 创建后不可修改。`}
        </p>
        <FormShell id={editFormId} onSubmit={onEdit} className="flex flex-col gap-5 pt-1" noValidate>
          <TextField
            label="名称"
            value={editName}
            disabled={editing?.builtin === true}
            onChange={(e) => setEditName(e.target.value)}
          />
          <TextField
            label="说明"
            value={editDescription}
            disabled={editing?.builtin === true}
            onChange={(e) => setEditDescription(e.target.value)}
          />
          <SelectField
            label="状态"
            value={editStatus}
            options={STATUS_OPTIONS}
            disabled={editing?.builtin === true}
            onValueChange={setEditStatus}
          />
        </FormShell>
        {editing && editing.userCount > 0 ? (
          <p className="mt-4 text-xs text-ink-muted">
            该角色仍有 {editing.userCount} 个使用者绑定，删除前请先解除绑定。
          </p>
        ) : null}
      </Modal>

      <Modal
        open={deleteTarget !== null}
        title="删除角色"
        onClose={() => setDeleteTarget(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleteTarget(null)}>
              取消
            </Button>
            <Button
              variant="primary"
              disabled={remove.isPending}
              onClick={() => deleteTarget && remove.mutate(deleteTarget.id)}
            >
              {remove.isPending ? '删除中…' : '确认删除'}
            </Button>
          </>
        }
      >
        <p className="text-sm">
          确认删除角色「{deleteTarget?.name}」（{deleteTarget?.code}）？该操作不可撤销。
        </p>
      </Modal>
    </div>
  );
}

function RoleRow({
  role,
  busy,
  onEdit,
  onDelete,
}: {
  role: RoleAdminSummary;
  busy: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const bound = role.userCount > 0;
  return (
    <tr>
      <td>{role.name}</td>
      <td className="mono text-xs">{role.code}</td>
      <td className="text-xs text-ink-muted">{role.description || '—'}</td>
      <td>
        <Badge tone={role.status === 'active' ? 'success' : 'muted'}>{role.status === 'active' ? '启用' : '停用'}</Badge>
      </td>
      <td>{role.builtin ? <Badge tone="muted">内置</Badge> : '—'}</td>
      <td>{role.userCount}</td>
      <td>
        <div className="flex flex-wrap justify-center gap-2">
          <Button variant="ghost" aria-label={`编辑角色 ${role.name}`} disabled={busy} onClick={onEdit}>
            编辑
          </Button>
          <Button
            variant="ghost"
            aria-label={`删除角色 ${role.name}`}
            disabled={busy || role.builtin || bound}
            title={
              role.builtin
                ? '内置角色不能删除'
                : bound
                  ? '该角色仍有使用者绑定，请先解除绑定'
                  : undefined
            }
            onClick={onDelete}
          >
            删除
          </Button>
        </div>
      </td>
    </tr>
  );
}
