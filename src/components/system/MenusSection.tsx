import { Fragment, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { invalidateRbac, queryKeys } from '../../lib/queryClient';
import { disableWouldLockOutMenusPage } from '../../lib/menuTree';
import { PAGE_ICONS, PAGE_META, PAGE_REQUIRES, type PageKey } from '../../lib/pageMeta';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { Modal } from '../ui/Modal';
import { SelectField, TextField } from '../ui/Field';
import { Switch } from '../ui/switch';
import { Loading, ErrorState, EmptyState } from '../ui/StateBlocks';
import { notify } from '../../state/notify';
import { toNormalisedError } from '../../lib/errors';
import type { MenuNode } from '../../lib/types';

/**
 * 菜单管理：菜单节点的表格树。
 * 每行只有两个动作——折叠看子项、状态开关；改名 / 排序 / 删除本轮按交付方要求撤掉了界面入口
 * （后端命令与权限仍在，恢复是一列按钮的事）。
 */
const BINDABLE_PAGES: PageKey[] = [
  'users',
  'roles',
  'menus',
  'permissions',
  'audit',
  'security',
  'appearance',
  'backup',
  'update',
  'launcher',
];

/** 只用于弹窗里那句「将出现在：…」；真正的父组由后端按 page_key 推导。 */
const GROUP_LABEL: Partial<Record<PageKey, string>> = {
  users: '系统管理',
  roles: '系统管理',
  menus: '系统管理',
  permissions: '系统管理',
  audit: '系统管理',
  security: '设置',
  appearance: '设置',
  backup: '设置',
  update: '设置',
  launcher: '快捷入口',
};

const LOCK_OUT_HINT = '停用后就没有入口能回到菜单管理页，这一项不能停用';

function sortNodes(nodes: MenuNode[]): MenuNode[] {
  return [...nodes].sort((a, b) => a.sortOrder - b.sortOrder || a.nodeKey.localeCompare(b.nodeKey));
}

export function MenusSection() {
  const qc = useQueryClient();
  const nodesQuery = useQuery({ queryKey: queryKeys.menuNodes, queryFn: () => api.listMenuNodes() });

  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [addOpen, setAddOpen] = useState(false);
  const [addLabel, setAddLabel] = useState('');
  const [addPage, setAddPage] = useState('');

  /**
   * 两条命令共用一枚 mutation：新增要弹窗与清空，开关要"失败就把滑块弹回去"。
   * 开关本身是受控的（checked 来自服务端数据），所以失败时不需要回滚——不写本地副本，
   * 也就没有"界面显示已停用而库里还是启用"这种两本账。
   */
  const create = useMutation({
    mutationFn: () => api.createMenuNode(addLabel, addPage),
    onSuccess: () => {
      notify('success', '菜单已新增');
      setAddOpen(false);
      setAddLabel('');
      setAddPage('');
      invalidateRbac(qc);
    },
    onError: (raw) => notify('danger', toNormalisedError(raw).message),
  });

  const toggle = useMutation({
    mutationFn: (input: { id: string; status: 'active' | 'disabled' }) =>
      api.setMenuNodeStatus(input.id, input.status),
    onSuccess: (_data, input) => notify('success', input.status === 'active' ? '菜单已启用' : '菜单已停用'),
    onError: (raw) => notify('danger', toNormalisedError(raw).message),
    onSettled: () => invalidateRbac(qc),
  });

  const nodes = nodesQuery.data ?? [];
  const roots = sortNodes(nodes.filter((node) => node.parentId === null));
  const children = nodes.filter((node) => node.parentId !== null);

  const childrenOf = (rootId: string): MenuNode[] =>
    sortNodes(children.filter((node) => node.parentId === rootId));

  function toggleCollapse(id: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function requiresText(node: MenuNode): string {
    if (!node.pageKey) return '由子项决定';
    const requires = PAGE_REQUIRES[node.pageKey];
    return requires.length ? requires.join(' 且 ') : '无需额外权限';
  }

  /**
   * 状态列的开关。被挡住的那几枚不是"某两枚内置项"，而是**这一棵树上所有回得来的路**：
   * 停掉任何一条会让菜单管理页再无入口的路径，就置灰并把理由写在 title 上。
   */
  function statusCell(node: MenuNode) {
    const active = node.status === 'active';
    const locksOut = active && disableWouldLockOutMenusPage(nodes, node.id);
    return (
      <td>
        <Switch
          checked={active}
          disabled={toggle.isPending || locksOut}
          aria-label={`${node.label} 是否启用`}
          title={locksOut ? LOCK_OUT_HINT : active ? '停用该入口' : '启用该入口'}
          onCheckedChange={(checked) => toggle.mutate({ id: node.id, status: checked ? 'active' : 'disabled' })}
        />
      </td>
    );
  }

  function nameCell(node: MenuNode, isChild: boolean) {
    return (
      <th scope="row">
        <div className={isChild ? 'flex items-center justify-center gap-2 pl-6' : 'flex items-center justify-center gap-2'}>
          {isChild ? (
            <span aria-hidden className="text-ink-muted">
              └
            </span>
          ) : null}
          <Icon
            name={node.pageKey ? PAGE_ICONS[node.pageKey] : node.nodeKey === 'gear.tools' ? 'zap' : 'settings'}
            size={16}
          />
          <span className="font-medium">{node.label}</span>
          {node.kind === 'group' ? <Badge tone="muted">分组</Badge> : null}
          {node.builtin ? null : <Badge tone="muted">自定义</Badge>}
        </div>
      </th>
    );
  }

  function row(node: MenuNode, siblings: MenuNode[] | null) {
    const isChild = siblings !== null;
    return (
      <tr key={node.id} data-depth={isChild ? '2' : '1'}>
        {nameCell(node, isChild)}
        <td>
          {node.pageKey ? (
            <>
              <span>{PAGE_META[node.pageKey].label}</span>
              <span className="mono block text-xs text-ink-muted">{node.pageKey}</span>
            </>
          ) : (
            <span className="text-xs text-ink-muted">—（分组）</span>
          )}
        </td>
        <td className="mono text-xs">{requiresText(node)}</td>
        {statusCell(node)}
      </tr>
    );
  }

  const loading = nodesQuery.isLoading;
  const error = nodesQuery.error;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      {loading ? <Loading label="加载菜单树…" /> : null}
      {error ? <ErrorState raw={error} onRetry={() => void nodesQuery.refetch()} /> : null}
      {!loading && !error && nodes.length === 0 ? (
        <EmptyState>菜单表为空，请检查数据库迁移是否完成。</EmptyState>
      ) : null}

      {nodes.length > 0 && !error ? (
        <>
          <div className="flex shrink-0 justify-end">
            <button
              type="button"
              className="btn-icon-primary"
              aria-label="新增菜单"
              title="新增菜单"
              onClick={() => setAddOpen(true)}
            >
              <Icon name="plus" size={20} />
            </button>
          </div>

          {/* 表格自己滚：`.table-wrap` 是卡片（overflow:hidden），滚动条挂在里面这一层上。
              表头要吸顶就不能让 .system-page-body 代它滚——页面级滚动会把 <th> 先滚走。 */}
          <div className="table-wrap flex min-h-0 flex-1 flex-col">
            <div className="min-h-0 flex-1 overflow-auto overscroll-contain">
              <table className="table table-sticky-head table-center" aria-label="菜单树">
                <thead>
                  <tr>
                    <th scope="col">菜单名称</th>
                    <th scope="col">落点页面</th>
                    <th scope="col">所需权限</th>
                    <th scope="col">状态</th>
                  </tr>
                </thead>
                <tbody>
                  {roots.map((root) => {
                    const kids = childrenOf(root.id);
                    const isCollapsed = collapsed.has(root.id);
                    return (
                      <Fragment key={root.id}>
                        <tr data-depth="1">
                          <th scope="row">
                            <div className="flex items-center justify-center gap-2">
                              {kids.length > 0 ? (
                                <Button
                                  variant="bare"
                                  className="btn-mini"
                                  aria-label={`${isCollapsed ? '展开' : '收起'} ${root.label}`}
                                  aria-expanded={!isCollapsed}
                                  title={isCollapsed ? '展开' : '收起'}
                                  onClick={() => toggleCollapse(root.id)}
                                >
                                  <Icon name={isCollapsed ? 'chevronNext' : 'chevronDown'} />
                                </Button>
                              ) : (
                                <span aria-hidden className="inline-block w-[26px]" />
                              )}
                              <Icon
                                name={
                                  root.pageKey
                                    ? PAGE_ICONS[root.pageKey]
                                    : root.nodeKey === 'gear.tools'
                                      ? 'zap'
                                      : 'settings'
                                }
                                size={16}
                              />
                              <span className="font-medium">{root.label}</span>
                              <Badge tone="muted">{root.kind === 'group' ? '一级 · 分组' : '一级'}</Badge>
                            </div>
                          </th>
                          <td>
                            {root.pageKey ? (
                              <>
                                <span>{PAGE_META[root.pageKey].label}</span>
                                <span className="mono block text-xs text-ink-muted">{root.pageKey}</span>
                              </>
                            ) : (
                              <span className="text-xs text-ink-muted">—（分组）</span>
                            )}
                          </td>
                          <td className="mono text-xs">{requiresText(root)}</td>
                          {statusCell(root)}
                        </tr>
                        {!isCollapsed ? kids.map((child) => row(child, kids)) : null}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>
      ) : null}

      <Modal
        open={addOpen}
        title="新增菜单"
        onClose={() => {
          if (!create.isPending) setAddOpen(false);
        }}
        footer={
          <>
            <Button variant="ghost" disabled={create.isPending} onClick={() => setAddOpen(false)}>
              取消
            </Button>
            <Button
              variant="primary"
              disabled={create.isPending || !addLabel.trim() || !addPage}
              onClick={() => create.mutate()}
            >
              {create.isPending ? '新增中…' : '新增菜单'}
            </Button>
          </>
        }
      >
        <p className="mb-4 text-xs text-ink-muted">
          新增项只能绑定现有页面，父分组由页面推导；新增入口会同时生成一枚可分配的菜单权限（默认授权给所有角色），页面所需操作权限仍按版本定义。
        </p>
        <div className="flex flex-col gap-4">
          <TextField
            label="菜单名称"
            value={addLabel}
            maxLength={40}
            onChange={(event) => setAddLabel(event.target.value)}
          />
          <SelectField
            label="落点页面"
            value={addPage}
            onValueChange={setAddPage}
            hint={addPage ? `将出现在：${GROUP_LABEL[addPage as PageKey] ?? '—'}` : undefined}
            options={[
              { value: '', label: '请选择页面' },
              ...BINDABLE_PAGES.map((page) => ({
                value: page,
                label: `${PAGE_META[page].label}（${page}）`,
              })),
            ]}
          />
        </div>
      </Modal>
    </div>
  );
}
