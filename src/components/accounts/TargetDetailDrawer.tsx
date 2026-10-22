import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { invalidateTargetLists, queryKeys } from '../../lib/queryClient';
import { targetTypeLabel, type ItemView, type TargetMeta } from '../../lib/types';
import { Drawer } from '../ui/Drawer';
import type { Tone } from '../../lib/tone';
import { Button } from '../ui/Button';
import { Badge } from '../ui/Badge';
import { Icon } from '../ui/Icon';
import { Loading, ErrorState, EmptyState } from '../ui/StateBlocks';
import { RevealField } from './RevealField';
import { CreateItemDialog } from './CreateItemDialog';
import { EditItemDialog } from './EditItemDialog';
import { copyPassword, copyUsername, openAndFill, openTarget } from '../../lib/actions';
import { useSession } from '../../state/session';
import { formatTimestamp } from '../../lib/format';
import { notify } from '../../state/notify';
import { toNormalisedError } from '../../lib/errors';

type MetaStringKey = Exclude<keyof TargetMeta, 'extra'>;

const META_LABELS: Array<{ key: MetaStringKey; label: string }> = [
  { key: 'url', label: 'URL' },
  { key: 'allowedOrigin', label: '允许填充 Origin' },
  { key: 'host', label: '主机' },
  { key: 'port', label: '端口' },
  { key: 'databaseName', label: '数据库/实例' },
  { key: 'tenant', label: '租户/项目' },
  { key: 'vendor', label: '厂商/型号' },
  { key: 'protocol', label: '协议' },
];

export interface TargetDetailDrawerProps {
  targetId: string | null;
  onClose: () => void;
}

export function TargetDetailDrawer({ targetId, onClose }: TargetDetailDrawerProps) {
  const qc = useQueryClient();
  const nickname = useSession((s) => s.status?.nickname);
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<ItemView | null>(null);

  // 详情（目标 + 元数据 + 后端标志）与账号列表（ItemView：脱敏用户名与可揭示标志）分别来自两条命令
  const detail = useQuery({
    queryKey: targetId ? queryKeys.targetDetail(targetId) : ['targetDetail', 'none'],
    queryFn: () => api.targetDetail(targetId as string),
    enabled: !!targetId,
  });
  const items = useQuery({
    queryKey: targetId ? queryKeys.targetItems(targetId) : ['targetItems', 'none'],
    queryFn: () => api.targetItems(targetId as string),
    enabled: !!targetId,
  });

  function invalidate() {
    if (!targetId) return;
    void qc.invalidateQueries({ queryKey: queryKeys.targetDetail(targetId) });
    void qc.invalidateQueries({ queryKey: queryKeys.targetItems(targetId) });
    invalidateTargetLists(qc);
    void qc.invalidateQueries({ queryKey: queryKeys.stats });
  }

  const setDefault = useMutation({
    mutationFn: (itemId: string) => api.setDefaultCredential(targetId as string, itemId),
    onSuccess: () => {
      notify('success', '已更新默认账号（仅影响本软件使用者，不改动任何凭据内容）');
      invalidate();
    },
    onError: (raw) => notify('danger', toNormalisedError(raw).message),
  });

  const setStatus = useMutation({
    mutationFn: (v: { id: string; status: 'active' | 'disabled' }) => api.setItemStatus(v.id, v.status),
    onSuccess: () => {
      notify('success', '账号状态已更新');
      invalidate();
    },
    onError: (raw) => notify('danger', toNormalisedError(raw).message),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.deleteItem(id),
    onSuccess: () => {
      // 当前界面没有恢复入口（回收站面板未挂载），所以这句话只陈述事实，不指一条走不通的路
      notify('success', '账号已删除（软删除）：记录仍在本机数据库里，当前界面没有恢复入口');
      invalidate();
      // 软删除会改动"已删除条目"这一集合；若日后挂回列表，它需要从后端重取
      void qc.invalidateQueries({ queryKey: queryKeys.deletedItems });
    },
    onError: (raw) => notify('danger', toNormalisedError(raw).message),
  });

  const setTargetStatus = useMutation({
    mutationFn: (status: 'active' | 'disabled') => api.setTargetStatus(targetId as string, status),
    onSuccess: () => {
      notify('success', '目标状态已更新');
      invalidate();
    },
    onError: (raw) => notify('danger', toNormalisedError(raw).message),
  });

  const fav = useMutation({
    mutationFn: (v: { id: string; on: boolean }) => api.setFavorite(v.id, v.on),
    onSuccess: () => invalidate(),
    onError: (raw) => notify('danger', toNormalisedError(raw).message),
  });

  if (!targetId) return null;

  const list: ItemView[] = items.data ?? [];
  const targetDisabled = detail.data?.target.status !== 'active';
  // 情绪只描述"这个目标现在怎么样"，不改任何判定：读不到详情=bad，
  // 明文协议=warn，目标停用=idle，其余=ok，还没取到=neutral
  const tone: Tone = detail.isError
    ? 'bad'
    : !detail.data
      ? 'neutral'
      : detail.data.insecureProtocol
        ? 'warn'
        : targetDisabled
          ? 'idle'
          : 'ok';

  return (
    <Drawer open={!!targetId} title="目标详情" tone={tone} onClose={onClose}>
      {detail.isLoading ? <Loading label="加载目标详情…" /> : null}
      {detail.isError ? <ErrorState raw={detail.error} onRetry={() => void detail.refetch()} /> : null}

      {detail.data ? (
        <div className="flex flex-col gap-5">
          <section>
            <div className="flex items-center gap-2">
              <h3 className="text-lg font-semibold">{detail.data.target.displayName}</h3>
              <Badge tone={detail.data.target.status === 'active' ? 'success' : 'muted'}>
                {detail.data.target.status === 'active' ? '启用' : '停用'}
              </Badge>
              {detail.data.insecureProtocol ? <Badge tone="warning">明文协议（已被策略禁用）</Badge> : null}
            </div>
            <p className="text-sm text-ink-muted">
              类型：{targetTypeLabel(detail.data.target.targetType)} · 更新于{' '}
              {formatTimestamp(detail.data.target.updatedAt)}
            </p>
            <div className="mt-2 flex gap-2">
              {targetDisabled ? (
                <Button variant="ghost" disabled={setTargetStatus.isPending} onClick={() => setTargetStatus.mutate('active')}>
                  启用目标
                </Button>
              ) : (
                <Button variant="ghost" disabled={setTargetStatus.isPending} onClick={() => setTargetStatus.mutate('disabled')}>
                  停用目标
                </Button>
              )}
            </div>
          </section>

          <section aria-label="地址与连接信息">
            <h4 className="mb-2 text-sm font-semibold text-ink-muted">地址 / 连接信息</h4>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              {META_LABELS.filter((m) => (detail.data!.meta[m.key] ?? '').length > 0).map((m) => (
                <div key={m.key} className="contents">
                  <dt className="text-ink-muted">{m.label}</dt>
                  <dd className="mono break-all">{detail.data!.meta[m.key]}</dd>
                </div>
              ))}
            </dl>
            <div className="mt-3 flex gap-2">
              <Button onClick={() => void openTarget(detail.data!.target.id)}>打开目标</Button>
              <Button variant="primary" onClick={() => void openAndFill(detail.data!.target.id)}>
                打开并安全填充
              </Button>
            </div>
            {!detail.data.fillAvailable ? (
              <p className="mt-2 text-xs text-warning" role="status">
                后端报告：浏览器扩展/填充宿主未就绪——「打开并安全填充」将降级为打开网站 + 手动输入（或单独复制用户名/密码）。
              </p>
            ) : null}
          </section>

          <section aria-label="账号列表">
            <div className="mb-2 flex items-center justify-between">
              <h4 className="text-sm font-semibold text-ink-muted">
                该目标下的外部系统账号（{list.length}）
              </h4>
              <Button onClick={() => setCreateOpen(true)}>新增账号</Button>
            </div>
            <p className="mb-2 text-xs text-ink-muted">
              默认账号是「本软件使用者{nickname ? `（${nickname}）` : ''} × 该目标」的个人偏好，不影响其他使用者，也不会改动凭据内容。
            </p>

            {items.isLoading ? <Loading label="加载账号列表…" /> : null}
            {items.isError ? <ErrorState raw={items.error} onRetry={() => void items.refetch()} /> : null}
            {items.data && list.length === 0 ? (
              <EmptyState>该目标下还没有账号，点击「新增账号」添加第一个外部系统凭据。</EmptyState>
            ) : null}

            {list.length > 0 ? (
              <ul className="flex flex-col gap-3">
                {list.map((item) => (
                  <ItemCard
                    key={item.id}
                    item={item}
                    onEdit={() => setEditing(item)}
                    onFavorite={(on) => fav.mutate({ id: item.id, on })}
                    onDefault={() => setDefault.mutate(item.id)}
                    onDisable={() => setStatus.mutate({ id: item.id, status: 'disabled' })}
                    onEnable={() => setStatus.mutate({ id: item.id, status: 'active' })}
                    onDelete={() => remove.mutate(item.id)}
                  />
                ))}
              </ul>
            ) : null}
          </section>

          <CreateItemDialog
            open={createOpen}
            targetId={detail.data.target.id}
            hasExistingItems={list.length > 0}
            onClose={() => setCreateOpen(false)}
          />
          {/* 编辑现有凭据：只提交改动过的键，未提交的秘密由后端保持原值 */}
          <EditItemDialog open={editing !== null} item={editing} onClose={() => setEditing(null)} />
        </div>
      ) : null}
    </Drawer>
  );
}

function ItemCard({
  item,
  onEdit,
  onFavorite,
  onDefault,
  onDisable,
  onEnable,
  onDelete,
}: {
  item: ItemView;
  onEdit: () => void;
  onFavorite: (on: boolean) => void;
  onDefault: () => void;
  onDisable: () => void;
  onEnable: () => void;
  onDelete: () => void;
}) {
  const disabled = item.status === 'disabled';
  return (
    <li className="surface p-3">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          aria-pressed={item.favorite}
          aria-label={item.favorite ? '取消收藏' : '收藏'}
          className="fav-toggle"
          onClick={() => onFavorite(!item.favorite)}
        >
          <Icon name={item.favorite ? 'star' : 'starOff'} size={18} />
        </button>
        <span className="font-medium">{item.accountAlias}</span>
        <span className="mono text-sm text-ink-muted">{item.usernameMasked || '（无用户名）'}</span>
        {item.isDefaultForCurrentUser ? <Badge tone="success">默认账号</Badge> : null}
        {disabled ? <Badge tone="warning">已停用</Badge> : null}
        <span className="text-xs text-ink-muted">v{item.version}</span>
        {!item.canReveal ? <Badge tone="muted">无查看秘密权限</Badge> : null}
        {item.tags.length > 0 ? (
          <span className="text-xs text-ink-muted">{item.tags.map((t) => `#${t}`).join(' ')}</span>
        ) : null}
      </div>

      {item.canReveal ? (
        <div className="mt-2 flex flex-wrap gap-2">
          <Button variant="ghost" onClick={() => void copyUsername(item.id)}>
            复制用户名
          </Button>
          {item.hasPassword ? (
            <Button variant="ghost" onClick={() => void copyPassword(item.id)}>
              复制密码
            </Button>
          ) : null}
        </div>
      ) : null}

      {item.canReveal ? (
        <div className="mt-2">
          <RevealField
            itemId={item.id}
            has={{ password: item.hasPassword, token: item.hasToken, privateKey: item.hasPrivateKey }}
          />
        </div>
      ) : null}

      <div className="mt-2 flex flex-wrap gap-2">
        <Button variant="ghost" onClick={onEdit}>
          编辑
        </Button>
        {!item.isDefaultForCurrentUser && !disabled ? (
          <Button variant="ghost" onClick={onDefault}>
            设为默认
          </Button>
        ) : null}
        {disabled ? (
          <Button variant="ghost" onClick={onEnable}>
            启用
          </Button>
        ) : (
          <Button variant="ghost" onClick={onDisable}>
            停用
          </Button>
        )}
        <Button variant="danger" onClick={onDelete}>
          删除
        </Button>
      </div>
    </li>
  );
}
