import { useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { queryKeys } from '../../lib/queryClient';
import {
  KNOWN_TARGET_TYPES,
  TARGET_TYPE_LABELS,
  targetTypeLabel,
  type CreateTargetInput,
  type KnownTargetType,
} from '../../lib/types';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { TextField, SelectField } from '../ui/Field';
import { notify } from '../../state/notify';
import { toNormalisedError } from '../../lib/errors';

export interface CreateTargetDialogProps {
  open: boolean;
  onClose: () => void;
  onCreated: (targetId: string) => void;
}

const EMPTY: CreateTargetInput = { displayName: '', targetType: 'web' };

/** 新建目标：先按地址调用 find_similar_targets 展示可能重复的目标，地址绝不作为唯一键。 */
export function CreateTargetDialog({ open, onClose, onCreated }: CreateTargetDialogProps) {
  const qc = useQueryClient();
  const [input, setInput] = useState<CreateTargetInput>(EMPTY);
  const [url, setUrl] = useState('');
  const [allowedOrigin, setAllowedOrigin] = useState('');
  const [host, setHost] = useState('');
  const [port, setPort] = useState('');
  const [protocol, setProtocol] = useState('');
  const [databaseName, setDatabaseName] = useState('');
  const [tenant, setTenant] = useState('');
  const [vendor, setVendor] = useState('');
  const [groupId, setGroupId] = useState('');

  // 相似检查用的地址：网页类取 URL，其余取主机
  const address = input.targetType === 'web' ? url.trim() : host.trim();

  const groups = useQuery({
    queryKey: queryKeys.groups,
    queryFn: () => api.listGroups(),
    enabled: open,
  });

  const similar = useQuery({
    queryKey: queryKeys.similar(address),
    queryFn: () => api.similarTargets(address),
    enabled: open && address.length >= 3,
  });

  const create = useMutation({
    mutationFn: () => {
      const payload: CreateTargetInput = {
        displayName: input.displayName.trim(),
        targetType: input.targetType,
        url: url.trim(),
        allowedOrigin: allowedOrigin.trim(),
        host: host.trim(),
        port: port.trim(),
        databaseName: databaseName.trim(),
        tenant: tenant.trim(),
        vendor: vendor.trim(),
        protocol: protocol.trim(),
        groupId: groupId || null,
      };
      return api.createTarget(payload);
    },
    onSuccess: (row) => {
      void qc.invalidateQueries({ queryKey: ['targets'] });
      void qc.invalidateQueries({ queryKey: queryKeys.stats });
      notify('success', `已创建目标：${row.displayName}`);
      setInput(EMPTY);
      setUrl('');
      setAllowedOrigin('');
      setHost('');
      setPort('');
      setProtocol('');
      setDatabaseName('');
      setTenant('');
      setVendor('');
      setGroupId('');
      onCreated(row.id);
    },
    onError: (raw) => {
      const err = toNormalisedError(raw);
      notify('danger', err.message);
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!input.displayName.trim()) {
      notify('warning', '请填写目标/系统名称。');
      return;
    }
    create.mutate();
  }

  const matches = similar.data ?? [];
  const isWeb = input.targetType === 'web';
  const groupOptions = useMemo(() => groups.data ?? [], [groups.data]);

  return (
    <Modal
      open={open}
      title="新增目标 / 系统"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" onClick={submit} disabled={create.isPending}>
            {create.isPending ? '创建中…' : '创建目标'}
          </Button>
        </>
      }
    >
      <form onSubmit={submit} className="flex flex-col gap-4">
        <SelectField
          label="目标类型"
          value={input.targetType}
          onChange={(e) => setInput({ ...input, targetType: e.target.value as KnownTargetType })}
        >
          {KNOWN_TARGET_TYPES.map((t) => (
            <option key={t} value={t}>
              {TARGET_TYPE_LABELS[t]}
            </option>
          ))}
        </SelectField>

        <TextField
          label="目标 / 系统名称"
          value={input.displayName}
          onChange={(e) => setInput({ ...input, displayName: e.target.value })}
          required
        />

        {isWeb ? (
          <>
            <TextField
              label="登录地址 / URL"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://oa.example.cn"
              hint="地址用于相似目标提示，不作为唯一键；同一地址允许保存多个账号。"
            />
            <TextField
              label="允许自动填充的精确 Origin（可选）"
              value={allowedOrigin}
              onChange={(e) => setAllowedOrigin(e.target.value)}
              placeholder="https://oa.example.cn"
              hint="填充时浏览器页面 Origin 必须与之一致，否则后端拒绝。"
            />
          </>
        ) : (
          <>
            <TextField
              label="主机 / 地址"
              value={host}
              onChange={(e) => setHost(e.target.value)}
              placeholder="10.0.0.22"
              hint="地址用于相似目标提示，不作为唯一键；同一地址允许保存多个账号。"
            />
            <div className="grid grid-cols-2 gap-3">
              <TextField label="端口（可选）" value={port} onChange={(e) => setPort(e.target.value)} />
              <TextField label="协议（可选，如 ssh/sftp）" value={protocol} onChange={(e) => setProtocol(e.target.value)} />
            </div>
            {input.targetType === 'database' ? (
              <div className="grid grid-cols-2 gap-3">
                <TextField label="数据库/实例（可选）" value={databaseName} onChange={(e) => setDatabaseName(e.target.value)} />
                <TextField label="租户/项目（可选）" value={tenant} onChange={(e) => setTenant(e.target.value)} />
              </div>
            ) : (
              <TextField label="租户/项目（可选）" value={tenant} onChange={(e) => setTenant(e.target.value)} />
            )}
            <TextField label="厂商/型号（可选）" value={vendor} onChange={(e) => setVendor(e.target.value)} />
          </>
        )}

        <div>
          <SelectField label="分组（可选）" value={groupId} onChange={(e) => setGroupId(e.target.value)}>
            <option value="">未分组</option>
            {groupOptions.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}（{g.targetCount} 个目标）
              </option>
            ))}
          </SelectField>
          {groups.isError ? <p className="mt-1 text-xs text-danger">分组列表加载失败，可先不选分组。</p> : null}
        </div>

        {address.length >= 3 ? (
          <div className="rounded-sm border border-line p-3" aria-live="polite">
            <div className="mb-1 text-sm font-medium">相似地址检查</div>
            {similar.isLoading ? <p className="text-xs text-ink-muted">正在查询…</p> : null}
            {similar.isError ? <p className="text-xs text-danger">相似检查失败，不影响创建。</p> : null}
            {!similar.isLoading && matches.length > 0 ? (
              <>
                <p className="text-xs text-warning">
                  发现 {matches.length} 个地址相近的已有目标。若这是同一系统，请改为在其下新增账号，避免重复建目标；不同租户/环境可继续新建。
                </p>
                <ul className="mt-1 flex flex-col gap-1">
                  {matches.map((m) => (
                    <li key={m.id} className="text-xs">
                      {m.displayName} · {targetTypeLabel(m.targetType)} · 已有 {m.credentialCount} 个账号
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
            {!similar.isLoading && matches.length === 0 ? (
              <p className="text-xs text-ink-muted">未发现地址相近的已有目标。</p>
            ) : null}
          </div>
        ) : null}
      </form>
    </Modal>
  );
}
