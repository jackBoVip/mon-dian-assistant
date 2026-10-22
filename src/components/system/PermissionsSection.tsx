import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { invalidateRbac, queryKeys } from '../../lib/queryClient';
import type { MenuNode, PermissionRow } from '../../lib/types';
import { Button } from '../ui/Button';
import { Checkbox } from '../ui/checkbox';
import { Icon } from '../ui/Icon';
import { Loading, ErrorState, EmptyState } from '../ui/StateBlocks';
import { Tabs, TabsList, TabsTrigger } from '../ui/tabs';
import { notify } from '../../state/notify';
import { toNormalisedError } from '../../lib/errors';

function groups(rows: PermissionRow[]): Array<{ label: string; rows: PermissionRow[] }> {
  const actions = rows.filter((row) => row.type === 'action');
  const accounts = actions.filter((row) => row.key.startsWith('accounts.'));
  const system = actions.filter((row) => row.key.startsWith('system.'));
  const other = actions.filter(
    (row) => !row.key.startsWith('accounts.') && !row.key.startsWith('system.'),
  );
  return [
    { label: '账号台账操作', rows: accounts },
    { label: '系统管理操作', rows: system },
    { label: '其他操作', rows: other },
  ].filter((group) => group.rows.length > 0);
}

function sameSet(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((key) => b.includes(key));
}

function sortNodes(nodes: MenuNode[]): MenuNode[] {
  return [...nodes].sort((a, b) => a.sortOrder - b.sortOrder || a.nodeKey.localeCompare(b.nodeKey));
}

function pct(part: number, whole: number): number {
  return whole === 0 ? 0 : Math.round((part / whole) * 100);
}

function Tag({ children }: { children: string }) {
  return (
    <span className="shrink-0 rounded-full border border-line px-1.5 text-[9.5px] leading-[15px] text-ink-muted">
      {children}
    </span>
  );
}

interface KpiProps {
  label: string;
  value: number;
  total?: number;
  unit?: string;
  percent: number;
}

/** 统计卡：标签 + 数值 + 一条主色进度条；数值与进度都直接来自当前草稿。 */
function Kpi({ label, value, total, unit, percent }: KpiProps) {
  return (
    <div className="perm-kpi" role="group" aria-label={label}>
      <span className="perm-kpi-label">{label}</span>
      <span className="flex items-baseline gap-1">
        <span className="perm-kpi-value">{value}</span>
        <span className="perm-kpi-total">{total === undefined ? unit : `/ ${total}`}</span>
      </span>
      <span className="perm-meter" aria-hidden="true">
        <span style={{ width: `${percent}%` }} />
      </span>
    </div>
  );
}

interface CardProps {
  label: string;
  keyText: string;
  tag?: string;
  roleName: string;
  checked: boolean;
  disabled?: boolean;
  inactive?: boolean;
  description?: string | null;
  meta?: string;
  kind?: 'root' | 'leaf' | 'action';
  onToggle: (checked: boolean) => void;
}

/**
 * 面板里的一枚权限：
 * 未选是中性灰面，选中换成主色淡染 + 左侧主色细轨。
 * 两种面都写在全局 `.perm-card` 里，由 data-selected 切换，四套主题各自生效。
 */
function PermissionCard({
  label,
  keyText,
  tag,
  roleName,
  checked,
  disabled = false,
  inactive = false,
  description,
  meta,
  kind = 'leaf',
  onToggle,
}: CardProps) {
  const root = kind === 'root';
  const action = kind === 'action';
  /** 菜单键统一去掉 `menu.node.` 前缀再上屏：卡片最大只有一栏宽，完整键会把标签挤到省略号。
   * 完整键仍留在 title 与读屏文本里（下一条）。`menu.accounts` / `menu.system` 两枚旧键原样显示。 */
  const isMenu = !action;
  const shortKey = isMenu ? keyText.replace(/^menu\.node\./, '') : keyText;
  const keyShortened = shortKey !== keyText;
  return (
    <label
      data-selected={checked ? 'true' : 'false'}
      data-disabled={disabled ? 'true' : 'false'}
      className={`perm-card flex gap-2 rounded-sm border ${
        root ? 'min-h-[34px] items-center px-2.5 py-1.5' : 'items-start px-2 py-1.5'
      } ${disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'} ${
        checked ? 'border-primary' : 'border-line'
      }`}
    >
      <Checkbox
        aria-label={`${roleName} · ${label}`}
        className={root ? undefined : 'mt-0.5'}
        checked={checked}
        disabled={disabled}
        onCheckedChange={(value) => onToggle(value === true)}
      />
      <span className={`flex min-w-0 flex-1 flex-col ${root ? 'gap-0.5' : 'gap-px'}`}>
        <span className="flex min-w-0 items-center gap-1.5">
          <span
            className={`truncate text-ink ${
              root ? 'text-[13px] font-semibold' : 'text-xs font-medium'
            }`}
          >
            {label}
          </span>
          {tag ? <Tag>{tag}</Tag> : null}
          {inactive ? <Tag>已停用</Tag> : null}
          {root || action ? (
            <span
              aria-hidden={keyShortened ? true : undefined}
              className="ml-auto truncate pl-2 font-mono text-[9.5px] leading-4 text-ink-muted"
              title={keyText}
            >
              {shortKey}
            </span>
          ) : null}
          {keyShortened ? <span className="sr-only">{keyText}</span> : null}
        </span>
        {description ? (
          <span className="truncate text-[10.5px] leading-4 text-ink-body" title={description}>
            {description}
          </span>
        ) : null}
        {kind === 'leaf' && !description ? (
          <span
            aria-hidden="true"
            className="truncate font-mono text-[9.5px] leading-[13px] text-ink-muted"
            title={keyText}
          >
            {shortKey}
          </span>
        ) : null}
      </span>
      {meta ? (
        <span className="shrink-0 self-center text-[10px] tabular-nums text-ink-muted">{meta}</span>
      ) : null}
    </label>
  );
}

/**
 * 权限管理：顶部是角色切换与三枚统计卡，下面分「菜单权限 / 操作权限」两块面板。
 *
 * 菜单权限按节点逐枚授权，一级与二级分开；操作权限按前缀分区。
 * 菜单键与操作权限在后端是两条命令（`set_role_menu_permissions` /
 * `set_role_action_permissions`），各自只替换自己那一类，所以保存时按"哪一类脏了"
 * 分开提交——只改了操作权限就绝不顺手把菜单那组写回去。
 */
export function PermissionsSection() {
  const qc = useQueryClient();
  const roles = useQuery({ queryKey: queryKeys.rolesAdmin, queryFn: () => api.listRolesAdmin() });
  const catalog = useQuery({ queryKey: queryKeys.permissionsCatalog, queryFn: () => api.listPermissions() });
  const nodesQuery = useQuery({ queryKey: queryKeys.menuNodes, queryFn: () => api.listMenuNodes() });
  const [activeRoleId, setActiveRoleId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string[]>>({});
  const scrollRef = useRef<HTMLDivElement>(null);

  const save = useMutation({
    mutationFn: async (v: {
      roleId: string;
      menus: string[];
      actions: string[];
      saveMenus: boolean;
      saveActions: boolean;
    }) => {
      if (v.saveMenus) await api.setRoleMenuPermissions(v.roleId, v.menus);
      if (v.saveActions) await api.setRoleActionPermissions(v.roleId, v.actions);
    },
    onSuccess: (_data, v) => {
      notify('success', '权限已保存');
      setDrafts((prev) => {
        const next = { ...prev };
        delete next[v.roleId];
        return next;
      });
      invalidateRbac(qc);
    },
    onError: (raw) => notify('danger', toNormalisedError(raw).message),
  });

  const roleList = roles.data ?? [];
  const nodes = sortNodes(nodesQuery.data ?? []);
  const roots = nodes.filter((node) => !node.parentId);
  const childrenOf = (root: MenuNode) => nodes.filter((node) => node.parentId === root.id);
  const grouped = groups(catalog.data ?? []);

  const menuKeys = new Set(nodes.map((node) => node.permKey));
  const actionKeys = new Set(
    (catalog.data ?? []).filter((row) => row.type === 'action').map((row) => row.key),
  );
  const totalCount = menuKeys.size + actionKeys.size;

  const activeRole = roleList.find((role) => role.id === activeRoleId) ?? roleList[0];
  const savedMenus = activeRole ? activeRole.permissions.filter((key) => menuKeys.has(key)) : [];
  const savedActions = activeRole ? activeRole.permissions.filter((key) => actionKeys.has(key)) : [];
  const selected = activeRole ? (drafts[activeRole.id] ?? [...savedMenus, ...savedActions]) : [];
  const selectedMenus = selected.filter((key) => menuKeys.has(key));
  const selectedActions = selected.filter((key) => actionKeys.has(key));
  const menuDirty = !sameSet(selectedMenus, savedMenus);
  const actionDirty = !sameSet(selectedActions, savedActions);
  const dirty = menuDirty || actionDirty;

  // 切角色回到清单顶部：上一位角色滚到下半屏时切过来，会停在一片看着像空白的中间。
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [activeRole?.id]);

  function baseSelection(roleId: string): string[] {
    return drafts[roleId] ?? [...savedMenus, ...savedActions];
  }

  function toggle(key: string, checked: boolean) {
    if (!activeRole) return;
    const base = baseSelection(activeRole.id);
    const next = checked ? [...new Set([...base, key])] : base.filter((k) => k !== key);
    setDrafts((prev) => ({ ...prev, [activeRole.id]: next }));
  }

  /** 一级勾选/取消会带走整棵子树：二级离开父级没有意义。 */
  function toggleNode(node: MenuNode, descendants: MenuNode[], checked: boolean) {
    if (!activeRole) return;
    const base = baseSelection(activeRole.id);
    const keys = [node.permKey, ...descendants.map((child) => child.permKey)];
    const next = checked
      ? [...new Set([...base, ...keys])]
      : base.filter((key) => !keys.includes(key));
    setDrafts((prev) => ({ ...prev, [activeRole.id]: next }));
  }

  function resetDraft() {
    if (!activeRole) return;
    setDrafts((prev) => {
      const next = { ...prev };
      delete next[activeRole.id];
      return next;
    });
  }

  const loading = roles.isLoading || catalog.isLoading || nodesQuery.isLoading;
  const error = roles.error ?? catalog.error ?? nodesQuery.error;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2.5">
      {loading ? <Loading label="加载角色与权限目录…" /> : null}
      {error ? (
        <ErrorState
          raw={error}
          onRetry={() => {
            void roles.refetch();
            void catalog.refetch();
            void nodesQuery.refetch();
          }}
        />
      ) : null}
      {roleList.length === 0 && !loading && !error ? <EmptyState>尚未定义任何角色。</EmptyState> : null}

      {activeRole && totalCount > 0 ? (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Tabs value={activeRole.id} onValueChange={setActiveRoleId}>
              <TabsList className="tabs" aria-label="选择角色">
                {roleList.map((role) => (
                  <TabsTrigger key={role.id} value={role.id}>
                    {role.name}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
            <div className="flex items-center gap-2">
              <span
                className={`text-[11px] text-warning transition-opacity ${
                  dirty ? 'opacity-100' : 'opacity-0'
                }`}
                aria-hidden={!dirty}
              >
                有未保存更改
              </span>
              <Button
                variant="ghost"
                aria-label={`还原 ${activeRole.name} 的权限`}
                disabled={save.isPending || !dirty}
                onClick={resetDraft}
              >
                还原
              </Button>
              <Button
                variant="primary"
                aria-label={`保存 ${activeRole.name} 的权限`}
                disabled={save.isPending || !dirty}
                onClick={() =>
                  save.mutate({
                    roleId: activeRole.id,
                    menus: selectedMenus,
                    actions: selectedActions,
                    saveMenus: menuDirty,
                    saveActions: actionDirty,
                  })
                }
              >
                保存
              </Button>
            </div>
          </div>

          <div className="grid grid-cols-[minmax(0,1.6fr)_repeat(3,minmax(0,1fr))] gap-2.5">
            <div className="perm-kpi perm-kpi--role" role="group" aria-label="当前角色">
              <span className="perm-kpi-label">当前角色</span>
              <span className="perm-kpi-role-name">{activeRole.name}</span>
              <span className="perm-kpi-role-meta">
                <span className="shrink-0 font-mono">{activeRole.code}</span>
                {activeRole.description ? (
                  <span className="min-w-0 truncate" title={activeRole.description}>
                    · {activeRole.description}
                  </span>
                ) : null}
              </span>
              <Icon name="shield" size={30} className="perm-kpi-icon" />
            </div>
            <Kpi
              label="菜单入口"
              value={selectedMenus.length}
              total={menuKeys.size}
              percent={pct(selectedMenus.length, menuKeys.size)}
            />
            <Kpi
              label="操作权限"
              value={selectedActions.length}
              total={actionKeys.size}
              percent={pct(selectedActions.length, actionKeys.size)}
            />
            <Kpi
              label="授权覆盖率"
              value={pct(selected.length, totalCount)}
              unit="%"
              percent={pct(selected.length, totalCount)}
            />
          </div>

          <div
            className="table-wrap flex min-h-[240px] flex-1 flex-col"
            role="tabpanel"
            aria-label={`${activeRole.name} 的权限`}
          >
            <div
              className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto overscroll-contain p-3"
              ref={scrollRef}
            >
              <section className="panel p-3">
                <div className="mb-2.5 flex flex-wrap items-start justify-between gap-x-3 gap-y-1 border-b border-line pb-2">
                  <div className="min-w-0">
                    <h2 className="flex items-center gap-1.5 text-[13px] font-semibold text-ink">
                      <Icon name="listTree" size={14} className="text-ink-muted" />
                      菜单权限
                    </h2>
                    <p className="mt-0.5 text-[11px] leading-4 text-ink-muted">
                      一级与二级入口各自授权；父级未选中时，二级入口不可选。
                    </p>
                  </div>
                  <span className="shrink-0 text-[11px] tabular-nums text-ink-muted">
                    {selectedMenus.length} / {menuKeys.size}
                  </span>
                </div>

                <div className="perm-roots">
                  {roots.map((root) => {
                    const children = childrenOf(root);
                    const rootSelected = selected.includes(root.permKey);
                    return (
                      <div key={root.id} className="perm-root" role="group" aria-label={`${root.label} 菜单`}>
                        <PermissionCard
                          kind="root"
                          label={root.label}
                          keyText={root.permKey}
                          tag="一级"
                          roleName={activeRole.name}
                          checked={rootSelected}
                          inactive={root.status === 'disabled'}
                          meta={children.length > 0 ? `${children.length} 项` : undefined}
                          onToggle={(checked) => toggleNode(root, children, checked)}
                        />
                        {children.length > 0 ? (
                          <div className="perm-root-kids">
                            {children.map((child) => (
                              <PermissionCard
                                key={child.id}
                                label={child.label}
                                keyText={child.permKey}
                                tag="二级"
                                roleName={activeRole.name}
                                checked={selected.includes(child.permKey)}
                                disabled={!rootSelected}
                                inactive={child.status === 'disabled'}
                                onToggle={(checked) => toggle(child.permKey, checked)}
                              />
                            ))}
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </section>

              <section className="panel p-3">
                <div className="mb-2.5 flex flex-wrap items-start justify-between gap-x-3 gap-y-1 border-b border-line pb-2">
                  <div className="min-w-0">
                    <h2 className="flex items-center gap-1.5 text-[13px] font-semibold text-ink">
                      <Icon name="key" size={14} className="text-ink-muted" />
                      操作权限
                    </h2>
                    <p className="mt-0.5 text-[11px] leading-4 text-ink-muted">
                      操作权限由版本定义，不能增删；保存后后端从下一条命令起按新权限校验。
                    </p>
                  </div>
                  <span className="shrink-0 text-[11px] tabular-nums text-ink-muted">
                    {selectedActions.length} / {actionKeys.size}
                  </span>
                </div>

                <div className="flex flex-col gap-3">
                  {grouped.map((group) => (
                    <div key={group.label} className="flex flex-col gap-1.5">
                      <h3 className="flex items-center justify-between text-[11px] font-semibold text-ink-body">
                        {group.label}
                        <span className="text-[10px] font-normal tabular-nums text-ink-muted">
                          {group.rows.length} 项
                        </span>
                      </h3>
                      <div className="grid gap-1.5 sm:grid-cols-2 xl:grid-cols-3">
                        {group.rows.map((perm) => (
                          <PermissionCard
                            key={perm.key}
                            kind="action"
                            label={perm.name}
                            keyText={perm.key}
                            roleName={activeRole.name}
                            checked={selected.includes(perm.key)}
                            description={perm.description}
                            onToggle={(checked) => toggle(perm.key, checked)}
                          />
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            </div>

            <div className="table-pagination">
              <div className="page-info" role="status">
                已选 {selected.length} / {totalCount} 项
              </div>
              <span className="text-[11px] tabular-nums text-ink-muted">
                {selected.length === totalCount
                  ? '已覆盖全部权限项'
                  : `尚缺 ${totalCount - selected.length} 项`}
              </span>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
