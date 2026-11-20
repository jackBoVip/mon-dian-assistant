import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { invalidateTargetLists, queryKeys } from '../../lib/queryClient';
import {
  TARGET_TYPE_LABELS,
  targetTypeLabel,
  type KnownTargetType,
  type TargetDetail,
  type TargetMeta,
} from '../../lib/types';
import {
  ADDRESS_FIELD_BY_TYPE,
  CREATABLE_TARGET_TYPES,
  buildTargetInput,
  deriveAddress,
  initialAddress,
} from '../../lib/targetAddress';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { TextField, SelectField } from '../ui/Field';
import { Loading, ErrorState } from '../ui/StateBlocks';
import { notify } from '../../state/notify';
import { toNormalisedError } from '../../lib/errors';

export interface TargetFormDialogProps {
  open: boolean;
  /**
   * 传 id 即编辑那一套系统，不传（或 null）即新增。两种形态共用同一张表：
   * 交付方 2026-10-19 要求系统能改「名称 + 全部字段」，字段口径与新增时必须一致，
   * 分两张表迟早长歪（尤其那一栏地址→后端分列的派生规则）。
   */
  targetId?: string | null;
  onClose: () => void;
  onSaved: (targetId: string) => void;
}

/** 表单初值：新增是空表，编辑是后端回的那一版。 */
interface FormSeed {
  displayName: string;
  targetType: string;
  address: string;
  groupId: string | null;
  /** 编辑时后端已有的 tenant/vendor —— 地址栏派生不出这两栏，原样带回去才不被覆盖成空。 */
  meta: TargetMeta | null;
}

const EMPTY_SEED: FormSeed = { displayName: '', targetType: 'web', address: '', groupId: null, meta: null };

/**
 * 新增 / 编辑系统。版式与字段照 design/prototype.html:948-1004（类型 / 分组 一行，系统名称，一栏地址），
 * 类型只有网页·终端·数据库三档（交付方 2026-10-18 指定）。
 * 后端分列存的 host/port/protocol/库名由那一栏地址派生（lib/targetAddress.ts），
 * 相似地址检查保留——需求 §8「防止误建重复目标」靠它，原型没画但不等于可以撤。
 */
export function TargetFormDialog({ open, targetId = null, onClose, onSaved }: TargetFormDialogProps) {
  // key=targetId：换一条系统就重建表单，初值不会被上一条目的状态污染（与 EditItemDialog 同一招）
  return <TargetForm key={targetId ?? 'new'} open={open} targetId={targetId} onClose={onClose} onSaved={onSaved} />;
}

function TargetForm({ open, targetId, onClose, onSaved }: Required<TargetFormDialogProps>) {
  const editing = targetId !== null;
  const detail = useQuery({
    queryKey: queryKeys.targetDetail(targetId as string),
    queryFn: () => api.targetDetail(targetId as string),
    enabled: open && editing,
  });

  const title = editing ? '编辑系统' : '新增系统';

  if (!open) return null;

  // 编辑形态没有后端初值就不渲染表单：对着空表点保存，等于把这条系统的地址栏清空
  if (editing && detail.isError) {
    return (
      <Modal open title={title} onClose={onClose} footer={<Button onClick={onClose}>关闭</Button>}>
        <ErrorState raw={detail.error} onRetry={() => void detail.refetch()} />
      </Modal>
    );
  }
  if (editing && !detail.data) {
    return (
      <Modal open title={title} onClose={onClose} footer={<Button onClick={onClose}>关闭</Button>}>
        <Loading label="加载系统原值…" />
      </Modal>
    );
  }

  return <TargetFields seed={seedOf(detail.data ?? null)} title={title} targetId={targetId} onClose={onClose} onSaved={onSaved} />;
}

function seedOf(detail: TargetDetail | null): FormSeed {
  if (!detail) return EMPTY_SEED;
  return {
    displayName: detail.target.displayName,
    targetType: detail.target.targetType,
    address: initialAddress(detail.target.targetType, detail.meta),
    groupId: detail.target.groupId,
    meta: detail.meta,
  };
}

function TargetFields({
  seed,
  title,
  targetId,
  onClose,
  onSaved,
}: {
  seed: FormSeed;
  title: string;
  targetId: string | null;
  onClose: () => void;
  onSaved: (targetId: string) => void;
}) {
  const qc = useQueryClient();
  const editing = targetId !== null;
  const [targetType, setTargetType] = useState(seed.targetType);
  const [displayName, setDisplayName] = useState(seed.displayName);
  const [address, setAddress] = useState(seed.address);
  const [groupId, setGroupId] = useState(seed.groupId ?? '');
  // 精确 Origin 单独可编辑：详情抽屉撤掉后这一栏既看不见也改不了，导入来的空值用户永远修不好。
  const [allowedOrigin, setAllowedOrigin] = useState(seed.meta?.allowedOrigin ?? '');
  const [originTouched, setOriginTouched] = useState(false);

  const addressField = ADDRESS_FIELD_BY_TYPE[targetType] ?? { label: '地址', placeholder: '' };
  const trimmedAddress = address.trim();

  // 派生结果实时显示：用户填一栏就得看得见后端拿到的是哪几栏，端口写错在这里就能发现
  const derived = deriveAddress(targetType, trimmedAddress);
  const derivedOrigin = derived.allowedOrigin;
  /**
   * 精确 Origin 的三条口径合在一处：
   * - F15：编辑时地址一字未动、后端原有非空精确 Origin（导入方刻意指定、可能 ≠ 地址 origin）
   *   必须原样带回，否则保存一次就把填充指向了别的站点；
   * - 自愈：编辑时地址没动、原值为空（Chrome 形状导入留下的坏数据）→ 用派生值补齐，
   *   「打开编辑 → 保存」即可修好，不必先改一次地址；
   * - 跟随：新建、或地址改了、或用户没手填过 Origin → 一律跟随当前地址派生。
   * 用户一旦手动编辑过这一栏就始终以手填值为准，改地址也不覆盖。
   */
  const preserveImported =
    editing && trimmedAddress === seed.address.trim() && !!seed.meta?.allowedOrigin.trim();
  const autoOrigin = preserveImported ? (seed.meta?.allowedOrigin ?? derivedOrigin) : derivedOrigin;
  const effectiveOrigin = originTouched ? allowedOrigin : autoOrigin;

  const groups = useQuery({
    queryKey: queryKeys.groups,
    queryFn: () => api.listGroups(),
  });

  /**
   * 审查 F24：地址原先每敲一个字符就发一次相似目标查询——本仓库另外两处输入即查的地方
   * 都防了抖（启动器 200ms、口令强度 250ms），这一处漏了，输完一条长地址要打到十几次后端。
   * 防抖只做延迟，判定阈值（≥3 字）与提示内容一字未改。
   */
  const [debouncedAddress, setDebouncedAddress] = useState('');
  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedAddress(trimmedAddress), 200);
    return () => window.clearTimeout(t);
  }, [trimmedAddress]);

  const similar = useQuery({
    queryKey: queryKeys.similar(debouncedAddress),
    queryFn: () => api.similarTargets(debouncedAddress),
    enabled: debouncedAddress.length >= 3,
  });

  const save = useMutation({
    mutationFn: () => {
      const input = buildTargetInput(displayName, targetType, trimmedAddress, groupId || null);
      // 地址派生不出 tenant/vendor：编辑时把后端原值带回去，保存一次不该顺手抹掉导入带进来的这两栏
      if (seed.meta) {
        input.tenant = seed.meta.tenant;
        input.vendor = seed.meta.vendor;
      }
      // 精确 Origin 以界面上那一栏为准：可见、可改，空值自愈与 F15 保留都由 effectiveOrigin 决定。
      // buildTargetInput 已带 allowedOrigin 键，这里只覆盖值，字段集合一个不少。
      input.allowedOrigin = effectiveOrigin.trim();
      return editing ? api.updateTarget(targetId, input) : api.createTarget(input);
    },
    onSuccess: (row) => {
      invalidateTargetLists(qc);
      void qc.invalidateQueries({ queryKey: queryKeys.stats });
      if (editing) void qc.invalidateQueries({ queryKey: queryKeys.targetDetail(row.id) });
      notify('success', editing ? `已保存系统：${row.displayName}` : `已创建系统：${row.displayName}`);
      onSaved(row.id);
    },
    onError: (raw) => notify('danger', toNormalisedError(raw).message),
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!displayName.trim()) {
      notify('warning', '请填写系统名称。');
      return;
    }
    if (!trimmedAddress) {
      notify('warning', `请填写${addressField.label}。没有地址无法打开或填充。`);
      return;
    }
    save.mutate();
  }

  // 编辑时自己就在相似结果里：不排掉的话，改个名字保存会被提示"这是同一系统，别重复建"
  const matches = useMemo(() => (similar.data ?? []).filter((m) => m.id !== targetId), [similar.data, targetId]);
  const groupChoices = useMemo<Array<{ id: string; name: string }>>(() => {
    const list = groups.data ?? [];
    // 编辑那条的分组若不在回来的列表里（分组被删、或列表加载失败），补一条原值选项：
    // 否则下拉显示「未分组」，用户改完名称一保存就把这条系统移出了它原本的分组
    if (groupId && !list.some((g) => g.id === groupId)) {
      return [{ id: groupId, name: '当前分组（后端原值）' }, ...list];
    }
    return list;
  }, [groups.data, groupId]);
  // 类型下拉：三档之外，编辑那条原本若是导入来的其它类型，多给它一档原值——不然初值落不进下拉，
  // 打开看着是「网页」、保存就把后端真正的类型改了
  const typeOptions = useMemo(() => {
    const creatable: string[] = [...CREATABLE_TARGET_TYPES];
    return creatable.includes(seed.targetType) ? creatable : [seed.targetType, ...creatable];
  }, [seed.targetType]);
  return (
    <Modal
      open
      title={title}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" onClick={submit} disabled={save.isPending}>
            {save.isPending ? '保存中…' : editing ? '保存修改' : '保存系统'}
          </Button>
        </>
      }
    >
      <form onSubmit={submit} className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-3">
          <SelectField
            label="系统类型"
            value={targetType}
            onValueChange={setTargetType}
            options={typeOptions.map((t) => ({ value: t, label: TARGET_TYPE_LABELS[t as KnownTargetType] ?? t }))}
          />

          <SelectField
            label="分组"
            value={groupId}
            onValueChange={setGroupId}
            options={[{ value: '', label: '未分组' }, ...groupChoices.map((g) => ({ value: g.id, label: g.name }))]}
          />
        </div>
        {groups.isError ? <p className="mt-1 text-xs text-danger">分组列表加载失败，可先选「未分组」。</p> : null}

        <TextField
          label="系统名称"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          placeholder="例如：蒙电OA"
          required
        />

        <TextField
          label={addressField.label}
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          placeholder={addressField.placeholder}
        />

        <TextField
          label="允许填充 Origin"
          value={effectiveOrigin}
          onChange={(e) => {
            setAllowedOrigin(e.target.value);
            setOriginTouched(true);
          }}
          placeholder={derivedOrigin ? '留空则跟随上方地址' : '终端 / 数据库通常留空'}
          hint="未手动修改时自动跟随上方地址派生；手动填写后以手填值为准。填充按此值逐字比对。"
        />
        <p className="text-xs text-ink-muted" aria-live="polite">
          按地址派生：{derivedOrigin || '（当前类型不派生 Origin）'}
        </p>
        {effectiveOrigin.trim() && effectiveOrigin.trim() !== derivedOrigin ? (
          <p className="text-xs text-warning">
            当前值与地址派生值不一致，填充将以「{effectiveOrigin.trim()}」逐字比对。
          </p>
        ) : null}

        {trimmedAddress ? (
          <p className="text-xs text-ink-muted">
            解析结果：主机 {derived.host || '—'} · 端口 {derived.port || '—'} · 协议{' '}
            {derived.protocol || '—'}
            {targetType === 'database' && derived.databaseName ? ` · 库名 ${derived.databaseName}` : ''}
          </p>
        ) : null}

        {trimmedAddress.length >= 3 ? (
          <div className="rounded-sm border border-line p-3" aria-live="polite">
            <div className="mb-1 text-sm font-medium">相似地址检查</div>
            {similar.isLoading ? <p className="text-xs text-ink-muted">正在查询…</p> : null}
            {similar.isError ? <p className="text-xs text-danger">相似检查失败，不影响保存。</p> : null}
            {!similar.isLoading && matches.length > 0 ? (
              <>
                <p className="text-xs text-warning">
                  发现 {matches.length} 个地址相近的已有系统。若这是同一系统，请改为在其下新增账号，避免重复建系统；不同租户/环境可继续新建。
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
              <p className="text-xs text-ink-muted">未发现地址相近的已有系统。</p>
            ) : null}
          </div>
        ) : null}
      </form>
    </Modal>
  );
}
