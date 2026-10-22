import { useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryKeys } from '../lib/queryClient';
import { pageItems } from '../components/accounts/Pagination';
import { TargetDetailDrawer } from '../components/accounts/TargetDetailDrawer';
import { TargetFormDialog } from '../components/accounts/TargetFormDialog';
import { CreateItemDialog } from '../components/accounts/CreateItemDialog';
import { EditItemDialog } from '../components/accounts/EditItemDialog';
import { SystemIODialog, type SystemIOMode } from '../components/accounts/SystemIODialog';
import { Button } from '../components/ui/Button';
import { DropdownItem, Menu } from '../components/ui/dropdown-menu';
import { targetTypeLabel, type ItemView, type TargetRow } from '../lib/types';
import { Loading, ErrorState } from '../components/ui/StateBlocks';
import { Icon } from '../components/ui/Icon';
import { formatTimestamp } from '../lib/format';
import { notify } from '../state/notify';
import { toNormalisedError } from '../lib/errors';
import { connectTerminal, openAndFill } from '../lib/actions';

/**
 * 左侧系统列表一次取满后端上限：原型没有分页控件，超出部分靠顶栏那颗全局检索收窄。
 * 后端 page_size 夹取 1..=200（src-tauri/src/commands/accounts.rs:126-127），所以 200 条以上是可达范围边界，
 * 必须在界面上说出来，不能谎称列全了。
 */
const LIST_LIMIT = 200;
/** 右侧账号表每页行数（原型页脚是"共 N 条数据 + 页码"，没有每页条数下拉）。 */
const PAGE_SIZE = 10;

/**
 * 账号中心（原型的主从两栏）：左 240px 接入系统列表，右栏当前系统下的托管账号表。
 *
 * 原型的筛选（类型胶囊、分组、标签）与统计条在这一轮从界面撤下。账号的查看/复制与删除仍收在
 * 「点账号名称打开的抽屉」里，但编辑这一条 2026-10-19 提到行上来（行内四颗钮：打开/编辑/设为默认/关注）——
 * 交付方的原话是找不到入口。系统同名同址的编辑走右栏那颗「编辑系统」。后端命令一条没动。
 */
export function AccountsPage() {
  const [picked, setPicked] = useState<string | null>(null);
  const [keyword, setKeyword] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [favoriteOnly, setFavoriteOnly] = useState(false);
  const [page, setPage] = useState(1);

  const [drawerTarget, setDrawerTarget] = useState<string | null>(null);
  const [createTargetOpen, setCreateTargetOpen] = useState(false);
  const [createItemOpen, setCreateItemOpen] = useState(false);
  /** 右栏标题那颗「编辑系统」打开的那条系统（id）：与新增共用同一张表，见 TargetFormDialog。 */
  const [editingTarget, setEditingTarget] = useState<string | null>(null);
  /** 行内「编辑」打开的那条账号：抽屉里那套入口藏得太深（点名称→抽屉→卡片），交付方 2026-10-19 反馈找不到。 */
  const [editingItem, setEditingItem] = useState<ItemView | null>(null);
  // 导入/导出共用一只弹窗（原型那一屏就是这么一张卡）：靠 mode 分两面
  const [ioOpen, setIoOpen] = useState(false);
  const [ioMode, setIoMode] = useState<SystemIOMode>('import');
  const [ioFormat, setIoFormat] = useState<'csv' | 'xlsx'>('xlsx');

  // 筛选条件全撤 → 只发空对象：Rust TargetFilter 是 deny_unknown_fields，多发的键是硬运行时错误
  const targets = useQuery({
    queryKey: queryKeys.targetsPaged({}, 1, LIST_LIMIT),
    queryFn: () => api.listTargetsPaged({}, 1, LIST_LIMIT),
    placeholderData: keepPreviousData,
  });

  const rows: TargetRow[] = targets.data?.rows ?? [];
  const total = targets.data?.total ?? 0;
  // 未选或选中的目标已被删除时回落到第一条：派生值，不写 effect，也不让右栏对着一个不存在的 id 取数
  const selected = picked && rows.some((r) => r.id === picked) ? picked : (rows[0]?.id ?? null);
  const selectedRow = rows.find((r) => r.id === selected) ?? null;

  const items = useQuery({
    queryKey: selected ? queryKeys.targetItems(selected) : ['targetItems', 'none'],
    queryFn: () => api.targetItems(selected as string),
    enabled: !!selected,
  });

  const all: ItemView[] = items.data ?? [];
  const kw = keyword.trim().toLowerCase();
  const filtered = all.filter((it) => {
    if (favoriteOnly && !it.favorite) return false;
    if (!kw) return true;
    return it.accountAlias.toLowerCase().includes(kw) || it.usernameMasked.toLowerCase().includes(kw);
  });
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const current = Math.min(page, totalPages);
  const pageRows = filtered.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE);
  const defaultItem = all.find((it) => it.isDefaultForCurrentUser) ?? null;

  const qc = useQueryClient();
  function refresh() {
    if (selected) void qc.invalidateQueries({ queryKey: queryKeys.targetItems(selected) });
    // credentialCount 是后端算出来的，账号增删改都要它重取；左栏那一列不能留在旧数上
    void qc.invalidateQueries({ queryKey: queryKeys.targetsAll });
  }

  const setDefault = useMutation({
    mutationFn: (itemId: string) => api.setDefaultCredential(selected as string, itemId),
    onSuccess: () => {
      notify('success', '已更新默认账号（仅影响本软件使用者，不改动任何凭据内容）');
      refresh();
    },
    onError: (raw) => notify('danger', toNormalisedError(raw).message),
  });

  const favorite = useMutation({
    mutationFn: (v: { id: string; on: boolean }) => api.setFavorite(v.id, v.on),
    onSuccess: refresh,
    onError: (raw) => notify('danger', toNormalisedError(raw).message),
  });

  function openOne(item: ItemView) {
    // 终端类凭据的"打开"是连终端，其余才是打开并填充：文案得跟命令真正做的事一致
    if (item.itemType === 'terminal') void connectTerminal(item.id);
    else if (selected) void openAndFill(selected, item.id);
  }

  /** 导出下拉那两行只决定格式与开弹窗；系统取左栏当前选中的那一个（没选中时由弹窗如实报"请先选择系统"）。 */
  function openExport(fmt: 'csv' | 'xlsx') {
    setIoFormat(fmt);
    setIoMode('export');
    setIoOpen(true);
  }

  return (
    <>
      <div className="left-panel">
        <div className="panel-header">
          <div className="panel-title">接入系统</div>
          <div className="header-actions">
            {/* 原型 658-677 的三颗钮，逐字照抄：导入（向下托盘）/ 导出（向上托盘，下拉 Excel·CSV）/ 新增（+）。
                这一轮后端 export_commit 补上了 format 与 shape 两个参数，「导出 Excel」与
                「在导出文件中包含明文密码」都兑得出承诺了，所以原来那颗导航钮换回原型那三颗。
                完整的导入导出流程（逐行核对、冲突选「更新」、口令加密容器）仍在「导入导出」页，本弹窗不复制它。 */}
            <Button variant="bare" className="btn-mini" aria-label="导入系统" title="导入系统" onClick={() => { setIoMode('import'); setIoOpen(true); }}>
              <Icon name="importTray" size={13} />
            </Button>

            <Menu
              label="导出系统"
              icon="exportTray"
              align="start"
              /* 原先由 .export-panel 的 top:calc(100%+8px) 给那 8px；Radix 走 Popper，改由 sideOffset 承担 */
              sideOffset={8}
              triggerClassName="btn-mini"
              panelClassName="export-panel"
            >
              <DropdownItem onPick={() => openExport('xlsx')}>导出 Excel</DropdownItem>
              <DropdownItem onPick={() => openExport('csv')}>导出 CSV</DropdownItem>
            </Menu>

            <Button variant="bare" className="btn-mini" aria-label="新增系统" title="新增系统" onClick={() => setCreateTargetOpen(true)}>
              <Icon name="plus" size={13} />
            </Button>
          </div>
        </div>

        <div className="system-list" aria-busy={targets.isLoading}>
          {targets.isLoading ? <Loading label="加载系统列表…" /> : null}
          {targets.isError ? <ErrorState raw={targets.error} onRetry={() => void targets.refetch()} /> : null}
          {targets.data && rows.length === 0 ? (
            <p className="system-list-empty">还没有接入系统。点上方「+」新建一个目标，再在它下面添加账号。</p>
          ) : null}
          {rows.map((r) => (
            <button
              key={r.id}
              type="button"
              className={r.id === selected ? 'system-item active' : 'system-item'}
              aria-current={r.id === selected ? 'true' : undefined}
              onClick={() => {
                setPicked(r.id);
                setPage(1);
              }}
            >
              <span className="sys-icon" aria-hidden>
                {r.displayName.slice(0, 1)}
              </span>
              <span className="sys-info">
                <span className="sys-name">{r.displayName}</span>
                <span className="sys-meta">
                  {targetTypeLabel(r.targetType)} · {r.credentialCount}个账号
                  {r.status === 'active' ? '' : ' · 已停用'}
                </span>
              </span>
            </button>
          ))}
        </div>

        {targets.data && total > rows.length ? (
          <p className="list-note">
            本页载入 {rows.length} 个系统，后端共有 {total} 个；单次最多取 {LIST_LIMIT} 个（后端上限），其余请用顶栏全局搜索定位。
          </p>
        ) : null}
      </div>

      <div className="right-panel">
        <div className="right-header">
          <div className="right-title">
            <h2>{selectedRow?.displayName ?? '未选择系统'}</h2>
            <p>当前系统下的所有托管账号 · 这里是外部系统账号台账，不是本软件的登录凭据</p>
          </div>

          <div className="right-actions">
            <div className={searchOpen ? 'search-box-wrapper active' : 'search-box-wrapper'}>
              <button
                type="button"
                className="btn-search-toggle"
                aria-label="搜索账号名称"
                aria-expanded={searchOpen}
                onClick={() => {
                  setSearchOpen((v) => !v);
                  if (searchOpen) setKeyword('');
                }}
              >
                <Icon name="search" size={18} />
              </button>
              {searchOpen ? (
                <input
                  type="text"
                  className="table-search-input"
                  placeholder="搜索账号名称..."
                  autoFocus
                  value={keyword}
                  onChange={(e) => {
                    setKeyword(e.target.value);
                    setPage(1);
                  }}
                />
              ) : null}
            </div>

            <button
              type="button"
              className="filter-btn"
              aria-label="打开默认账号"
              title={defaultItem ? `打开默认账号：${defaultItem.accountAlias}` : '该系统还没有默认账号，先在账号行上点「设为默认」'}
              disabled={!defaultItem || !selected}
              onClick={() => {
                if (defaultItem && selected) void openAndFill(selected, defaultItem.id);
              }}
            >
              <Icon name="externalLink" size={18} />
            </button>

            <button
              type="button"
              className={favoriteOnly ? 'filter-btn active-star' : 'filter-btn'}
              aria-label="只看关注"
              aria-pressed={favoriteOnly}
              title="只看关注的账号"
              onClick={() => {
                setFavoriteOnly((v) => !v);
                setPage(1);
              }}
            >
              <Icon name="star" size={18} />
            </button>

            {/* 交付方 2026-10-19：系统也要能改（名称 + 全部字段）。入口放在右栏标题这一排——
                这一排说的就是"当前这个系统"，不用先进抽屉再找卡片。 */}
            <button
              type="button"
              className="filter-btn"
              aria-label="编辑当前系统"
              title={selectedRow ? `编辑系统：${selectedRow.displayName}` : '请先选择一个系统'}
              disabled={!selected}
              onClick={() => setEditingTarget(selected)}
            >
              <Icon name="edit" size={18} />
            </button>

            <button
              type="button"
              className="btn-icon-primary"
              aria-label="添加账号"
              title={selected ? '添加账号' : '请先选择一个系统'}
              disabled={!selected}
              onClick={() => setCreateItemOpen(true)}
            >
              <Icon name="plus" size={20} />
            </button>
          </div>
        </div>

        <div className="data-table-wrapper">
          <div className="data-table" role="table" aria-label="当前系统的托管账号">
            <div className="table-header" role="row">
              <div role="columnheader">账号名称</div>
              <div role="columnheader">状态</div>
              <div role="columnheader">最近更新</div>
              <div role="columnheader" style={{ textAlign: 'right' }}>
                操作
              </div>
            </div>

            <div className="table-body-scroll">
              <div role="rowgroup">
                {items.isLoading ? <Loading label="加载账号列表…" /> : null}
                {items.isError ? <ErrorState raw={items.error} onRetry={() => void items.refetch()} /> : null}
                {pageRows.map((it) => (
                  <CredentialRow
                    key={it.id}
                    item={it}
                    pending={setDefault.isPending || favorite.isPending}
                    onOpen={() => openOne(it)}
                    onEdit={() => setEditingItem(it)}
                    onDefault={() => setDefault.mutate(it.id)}
                    onFavorite={(on) => favorite.mutate({ id: it.id, on })}
                    onDetail={() => setDrawerTarget(selected)}
                  />
                ))}
              </div>

              {items.data && filtered.length === 0 ? (
                <p className="empty-search-tip show">
                  {all.length === 0
                    ? '该系统下还没有账号，点右上角「+」添加第一个。'
                    : `未找到匹配的账号${favoriteOnly ? '（已开启「只看关注」）' : ''}`}
                </p>
              ) : null}
            </div>

            <div className="table-pagination">
              <div className="page-info" role="status">
                共 {filtered.length} 条数据{all.length !== filtered.length ? `（本系统合计 ${all.length} 条）` : ''}
              </div>
              <div className="page-controls">
                <Button variant="bare" className="page-btn" disabled={current <= 1} onClick={() => setPage(current - 1)}>
                  上一页
                </Button>
                {pageItems(current, totalPages).map((n, i) =>
                  n === 'gap' ? (
                    <span key={`gap-${i}`} aria-hidden className="page-num">
                      …
                    </span>
                  ) : (
                    <button
                      key={n}
                      type="button"
                      className={n === current ? 'page-num active' : 'page-num'}
                      aria-current={n === current ? 'page' : undefined}
                      onClick={() => setPage(n)}
                    >
                      {n}
                    </button>
                  ),
                )}
                <Button variant="bare" className="page-btn" disabled={current >= totalPages} onClick={() => setPage(current + 1)}>
                  下一页
                </Button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <TargetDetailDrawer targetId={drawerTarget} onClose={() => setDrawerTarget(null)} />
      <TargetFormDialog
        open={createTargetOpen}
        onClose={() => setCreateTargetOpen(false)}
        onSaved={(id) => {
          setCreateTargetOpen(false);
          setPicked(id);
        }}
      />
      {/* 编辑系统：与新增共用那张表（那一栏地址→后端分列的派生规则只有一份） */}
      <TargetFormDialog
        open={editingTarget !== null}
        targetId={editingTarget}
        onClose={() => setEditingTarget(null)}
        onSaved={() => setEditingTarget(null)}
      />
      {/* 行内编辑与抽屉里那张卡片的「编辑」开的是同一个对话框，字段口径只有一份 */}
      <EditItemDialog open={editingItem !== null} item={editingItem} onClose={() => setEditingItem(null)} />
      {selected ? (
        <CreateItemDialog
          open={createItemOpen}
          targetId={selected}
          hasExistingItems={all.length > 0}
          onClose={() => setCreateItemOpen(false)}
        />
      ) : null}
      <SystemIODialog
        open={ioOpen}
        mode={ioMode}
        format={ioFormat}
        targetId={selected}
        targetName={selectedRow?.displayName ?? ''}
        onClose={() => setIoOpen(false)}
      />
    </>
  );
}

/** 一行账号：名称（点开明细）+ 状态 + 最近更新时间 + 四颗行内动作（打开 / 编辑 / 设为默认 / 关注）。 */
function CredentialRow({
  item,
  pending,
  onOpen,
  onEdit,
  onDefault,
  onFavorite,
  onDetail,
}: {
  item: ItemView;
  /** 默认账号/关注这两条写命令正在飞行中：同一行的那两颗写命令钮先别让人连点。 */
  pending: boolean;
  onOpen: () => void;
  onEdit: () => void;
  onDefault: () => void;
  onFavorite: (on: boolean) => void;
  onDetail: () => void;
}) {
  const disabled = item.status !== 'active';
  return (
    <div className="table-row" role="row">
      <div className="table-cell title" role="cell">
        <Button variant="bare" className="cell-title-btn" onClick={onDetail} title="查看该账号的明细（含查看/复制、编辑、删除）">
          {item.accountAlias}
        </Button>
      </div>
      <div className="table-cell" role="cell">
        <span className={disabled ? 'badge-status is-disabled' : 'badge-status'}>
          <span className="status-dot" aria-hidden />
          {disabled ? '停用' : '启用'}
        </span>
      </div>
      <div className="table-cell" role="cell">
        {formatTimestamp(item.updatedAt)}
      </div>
      <div className="table-cell" role="cell">
        <div className="table-actions">
          <button
            type="button"
            className="action-icon-btn"
            aria-label={item.itemType === 'terminal' ? `连接终端 ${item.accountAlias}` : `打开并填充 ${item.accountAlias}`}
            title={item.itemType === 'terminal' ? '连接终端' : disabled ? '账号已停用，先启用后再打开' : '打开'}
            disabled={disabled}
            onClick={onOpen}
          >
            <Icon name="externalLink" size={16} />
          </button>
          {/* 编辑挂在行上（交付方 2026-10-19：原先只有抽屉里那层入口，用户找不到）。
              停用的账号照样能改：改完启用是两条独立命令，不该互相挡。 */}
          <button
            type="button"
            className="action-icon-btn"
            aria-label={`编辑 ${item.accountAlias}`}
            title="编辑该账号（别名、外部系统用户名、密码、备注等）"
            onClick={onEdit}
          >
            <Icon name="edit" size={16} />
          </button>
          {/* 后端只有 set_default_credential、没有"取消默认"：已是默认时把这句实话写在 title 上，
              界面不能出现「取消默认」这种兑不出来的承诺。 */}
          <button
            type="button"
            className={item.isDefaultForCurrentUser ? 'action-icon-btn active-default' : 'action-icon-btn'}
            aria-label={`设为默认 ${item.accountAlias}`}
            aria-pressed={item.isDefaultForCurrentUser}
            title={item.isDefaultForCurrentUser ? '当前默认账号（把其它账号设为默认即取消本条）' : '设为默认'}
            disabled={item.isDefaultForCurrentUser || pending}
            onClick={onDefault}
          >
            <Icon name="checkCircle" size={16} />
          </button>
          <button
            type="button"
            className={item.favorite ? 'action-icon-btn active-star' : 'action-icon-btn'}
            aria-label={`${item.favorite ? '取消关注' : '关注'} ${item.accountAlias}`}
            aria-pressed={item.favorite}
            title={item.favorite ? '取消关注' : '关注'}
            disabled={pending}
            onClick={() => onFavorite(!item.favorite)}
          >
            <Icon name="star" size={16} />
          </button>
        </div>
      </div>
    </div>
  );
}
