import { Fragment, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import type {
  AccountHit,
  LauncherPreferences,
  LauncherSyntaxHint,
  QuickAction,
  QuickHit,
  QuickSource,
} from '../lib/types';
import { queryKeys } from '../lib/queryClient';
import { quickSearchOptions } from '../lib/queryOptions';
import { targetTypeLabel, TASK_ENV_LABELS } from '../lib/types';
import { parseConditions, formatCondition } from '../lib/query';
import { displayMaskedUsername } from '../lib/mask';
import { formatElapsed, formatTimestamp } from '../lib/format';
import { qtypeLabel } from '../lib/quiz';
import { useBackendEvent, useVaultLocked } from '../lib/vaultEvents';
import { toNormalisedError } from '../lib/errors';
import { useTheme } from '../state/theme';
import { Icon } from '../components/ui/Icon';

const ACTION_LABELS: Record<QuickAction, string> = {
  open_target: '打开目标',
  open_and_fill: '打开并填充',
  copy_username: '复制用户名',
  copy_password: '复制密码',
  view_detail: '查看详情',
  select_other_account: '选择其他账号',
  set_default: '设为默认',
};

/**
 * 来源徽标：一行结果属于哪一类。账号/笔记/题库/工具四个名字必须是那一页在顶栏胶囊上的原话，
 * 浮层里叫「工具」而顶栏胶囊叫「页面库」这种，人就找不着落点了。
 * 「任务」是唯一的例外：任务中心在顶栏没有胶囊（2026-11-02 交付方要求隐藏），
 * 浮层这一行是它对外唯一的说法，落点由 AppShell 现算。
 */
const SOURCE_LABELS: Record<QuickSource, string> = {
  account: '账号',
  note: '笔记',
  quiz: '题库',
  tool: '工具',
  task: '任务',
};

/** 列表 key：跨五类都要唯一。账号那条仍是原来的 目标-凭据 复合键。 */
function hitKey(h: QuickHit): string {
  switch (h.source) {
    case 'account':
      return `account-${h.targetId}-${h.itemId}`;
    case 'note':
      return `note-${h.noteId}`;
    case 'quiz':
      return `quiz-${h.questionId}`;
    case 'tool':
      return `tool-${h.pageId}`;
    case 'task':
      return `task-${h.taskKey}-${h.env}`;
  }
}

/** 名称行。每类取它在该页面上被当作"名字"的那一列。 */
function rowTitle(h: QuickHit): string {
  switch (h.source) {
    case 'account':
      return h.systemName;
    case 'note':
    case 'tool':
      return h.title;
    case 'quiz':
      return h.stem;
    case 'task':
      return h.label;
  }
}

/**
 * 非账号那四类的 Enter 说法：一句一个，且必须是 `quick_reveal` 真做到的那件事。
 * 「打开这篇笔记」能兑现（笔记页会选中它）；写「打开笔记」就变成了一句没有落点的空话。
 */
function revealHint(h: Exclude<QuickHit, AccountHit>): string {
  switch (h.source) {
    case 'note':
      return '打开这篇笔记';
    case 'quiz':
      return '在题库里翻到这道题';
    case 'tool':
      return '在工具页选中这一页';
    case 'task':
      return `切到${TASK_ENV_LABELS[h.env]}那一档`;
  }
}

/**
 * 浮层不渲染的动作（交付方 2026-10-21：取消「选择其他账号」那颗钮）。
 * 后端在多账号目标下会下发 select_other_account，但它对应的回执只有一句
 * "请选择要使用的账号"——浮层里没有账号列表可挑，这颗钮兑不出承诺。
 * 命令本身保留，只是不在这扇窗里给出入口。
 */
const HIDDEN_ACTIONS: ReadonlySet<QuickAction> = new Set(['select_other_account']);

/** 浮层里真正可执行的动作：顺序沿用后端，只摘掉不渲染的那几条。 */
function visibleActions(r: AccountHit): QuickAction[] {
  return r.actions.filter((a) => !HIDDEN_ACTIONS.has(a));
}

/**
 * Enter 主操作优先级：网页优先安全填充，否则打开目标。
 * 兜底那一条是硬约束：主操作绝不落在「复制密码」上（需求 §304/§605——Enter 不得意外复制密码），
 * 即便后端给出的动作顺序把 copy_password 放在第一位也不能改变这一点。
 */
function primaryAction(r: AccountHit): QuickAction | null {
  const actions = visibleActions(r);
  if (actions.includes('open_and_fill')) return 'open_and_fill';
  if (actions.includes('open_target')) return 'open_target';
  return actions.find((a) => a !== 'copy_password') ?? null;
}

/**
 * 一行里可用动作的键盘顺序：0 号一定是主操作（Enter 的默认动作），其余按后端给出的顺序跟随。
 * Tab/Shift+Tab 就在这个数组上前后循环（需求 line 261：Tab 或快捷菜单切换可用操作）。
 *
 * 只有保险库那一条有动作集：另外四类没有"多枚动作"这回事，Enter 就是打开它，
 * 给它们摆一颗「查看详情」的钮反而是空头承诺——那一页里没有"详情"这一层。
 */
function actionOrder(r: QuickHit | undefined): QuickAction[] {
  if (!r || r.source !== 'account') return [];
  const actions = visibleActions(r);
  const pa = primaryAction(r);
  if (!pa) return [];
  return [pa, ...actions.filter((a) => a !== pa)];
}

export function LauncherApp() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [active, setActive] = useState(0);
  const [actionIndex, setActionIndex] = useState(0);
  const [reply, setReply] = useState<string | null>(null);
  const [prefs, setPrefs] = useState<LauncherPreferences | null>(null);

  function refreshPreferences() {
    api
      .launcherPreferences()
      .then(setPrefs)
      .catch(() => setPrefs(null));
  }

  useEffect(() => {
    useTheme.getState().apply();
    void useTheme.getState().load();
    inputRef.current?.focus();
    refreshPreferences();
  }, []);

  /**
   * 浮层关闭是 hide() 不是销毁，组件一直挂在内存里；不重新读设置的话，管理员改的开关要等到重启才生效。
   *
   * 主题同理，而且更早暴露：这扇窗的 `data-theme` 只在**挂载那一次**从后端读（上面那个 useEffect），
   * 之后主窗里换主题不会通知它——于是 `.search-modal` 的 `background: var(--t-surface-elevated)`
   * 一直取的是启动时那一套的四套值，看起来就是"弹窗背景不跟主题"（交付方 2026-10-20 报的这条）。
   * 换主题必然发生在主窗（浮层是置顶窗，浮层显示时点不到主窗的主题菜单），
   * 所以"每次唤起重读一次"就足够把它追平，不需要额外的跨窗广播。
   */
  useBackendEvent('launcher://shown', () => {
    void useTheme.getState().load();
    refreshPreferences();
    inputRef.current?.focus();
  });

  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(query.trim()), 200);
    return () => window.clearTimeout(t);
  }, [query]);

  // 需求 §285：输入为空时**可由设置启用**显示最近使用/收藏项。后端每次请求都读该设置，
  // 这里只决定"空输入要不要发请求"；关掉时不发请求，开启时发出去也可能被后端返回空。
  const showEmptySuggestions = prefs?.showRecentWhenEmpty === true;

  const search = useQuery(quickSearchOptions(debounced, debounced.length > 0 || showEmptySuggestions));

  // 锁定后搜索结果必须从界面与缓存中一起消失：命中条目含账号别名与用户名，属于敏感元数据。
  const queryClient = useQueryClient();
  useVaultLocked(() => {
    queryClient.removeQueries({ queryKey: queryKeys.quickSearchAll });
    setQuery('');
    setDebounced('');
    setActive(0);
    setReply('保险库已锁定，重新解锁后才能搜索与操作');
    // 置顶搜索框不能带着历史命中留在桌面上
    void import('@tauri-apps/api/window')
      .then(({ getCurrentWindow }) => getCurrentWindow().hide())
      .catch(() => undefined);
  });

  // 开关可能刚被管理员关掉，而 react-query 的缓存里还留着上一次唤起的推荐：此时一律不渲染。
  const results = debounced || showEmptySuggestions ? search.data?.results ?? [] : [];
  const conditions = parseConditions(debounced);

  const activeRow = results[active];
  const activeOrder = actionOrder(activeRow);
  const selectedAction = activeOrder.length > 0 ? activeOrder[Math.min(actionIndex, activeOrder.length - 1)] : null;

  useEffect(() => {
    if (active >= results.length) setActive(Math.max(0, results.length - 1));
  }, [results.length, active]);

  // 换行、或结果集刷新导致当前行换成另一条时，动作选择退回主操作。
  // 不退回的话：上一次 Tab 停在「复制密码」，换行后直接按 Enter 就把密码复制了。
  const activeKey = activeRow ? hitKey(activeRow) : null;
  useEffect(() => {
    setActionIndex(0);
  }, [active, activeKey]);

  async function runAction(action: QuickAction, r: AccountHit) {
    try {
      const res = await api.quickAction(action, r.itemId, r.targetId, r.isDefault ? r.itemId : undefined);
      setReply(res.message); // 原样回显，包括降级说明
    } catch (raw) {
      setReply(toNormalisedError(raw).message);
    }
  }

  /** 非账号那四类的 Enter：只交回来源与这一条的 id，落点坐标与权限由后端现判现查。 */
  async function runReveal(r: Exclude<QuickHit, AccountHit>) {
    const id = r.source === 'note' ? r.noteId : r.source === 'quiz' ? r.questionId : r.source === 'tool' ? r.pageId : r.taskKey;
    try {
      const res = await api.quickReveal(r.source, id, r.source === 'task' ? r.env : undefined);
      setReply(res.message);
    } catch (raw) {
      setReply(toNormalisedError(raw).message);
    }
  }

  /** Enter 与行内点击的唯一入口：账号走动作集，其余四类走 reveal。 */
  function activate(r: QuickHit | undefined) {
    if (!r) return;
    if (r.source === 'account') {
      if (selectedAction) void runAction(selectedAction, r);
      return;
    }
    void runReveal(r);
  }

  async function hide() {
    try {
      await api.launcherVisibility(false);
    } catch {
      /* 非桌面环境忽略 */
    }
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      void hide();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      // 审查 F25：空结果时 results.length - 1 === -1，Math.min(-1, i + 1) 把 active 推成负数，
      // 而下面那条兜底只修 `active >= length`（上界），负值就这么留着了。
      setActive((i) => (results.length === 0 ? 0 : Math.min(results.length - 1, i + 1)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === 'Tab') {
      // 只接管裸 Tab 与 Shift+Tab；Ctrl/Cmd/Alt 组合留给系统，输入框内的编辑快捷键一律不动
      if (!e.metaKey && !e.ctrlKey && !e.altKey && activeOrder.length > 1) {
        e.preventDefault();
        const n = activeOrder.length;
        setActionIndex((i) => (e.shiftKey ? (i - 1 + n) % n : (i + 1) % n));
      }
    } else if (e.key === 'Enter') {
      // 账号行：执行当前选中的动作（未 Tab 过时它就是主操作）；其余四类：打开这一条
      if (activeRow) {
        e.preventDefault();
        activate(activeRow);
      }
    }
  }

  // 骨架照原型那枚全局搜索弹窗：.search-overlay 是撑满整扇窗的定位层（遮罩染色已按交付方要求撤掉，
  // 本体四周只留一圈透明的阴影落点），.search-modal 是 600px 本体，
  // 本体只有三块——.search-input-wrap（放大镜 + 输入 + Esc 芯片）、.search-body（内容区）、
  // .search-footer（键位图例）。既有能力一条没减，只是全部收进这三块里。
  return (
    <div className="search-overlay">
      <div className="search-modal">
        <div className="search-input-wrap">
          <Icon name="search" size={20} />
          <input
            ref={inputRef}
            placeholder="搜索账号、笔记、题库、工具与任务..."
            autoComplete="off"
            aria-label="全局搜索：账号、笔记、题库、工具与任务"
            aria-expanded={results.length > 0}
            aria-controls="launcher-results"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
          />
          {/* 原型这里是 <span class="search-kbd">Esc</span> 且点它能关；做成 button，点的就是按 Esc 那条 hide()。 */}
          <button type="button" className="search-kbd" aria-label="关闭" onClick={() => void hide()}>
            Esc
          </button>
        </div>

        {/* 原型没有命中摘要这一行，但"命中 N 条 · 耗时 · 索引 M 条"和手动刷新是既有能力。
         * 内容区是可滚动的，摘要放进去会跟着滚走，所以留在它与输入行之间。
         * "索引 M 条"说的是保险库那一份内存索引的条数——笔记与题库那几类是每次现查数据库的，
         * 没有一份常驻索引可报；把它写成"索引"而不写明是保险库的，就是一句会让人误估的含糊话。 */}
        {search.data && !search.data.locked && (debounced || results.length > 0) ? (
          <div className="search-meta">
            <span>
              {debounced
                ? `命中 ${results.length} 条 · 耗时 ${formatElapsed(search.data.elapsedMs)} · 保险库索引 ${search.data.indexed} 条`
                : `最近使用 / 收藏推荐 ${results.length} 条 · 耗时 ${formatElapsed(search.data.elapsedMs)}`}
            </span>
            <button type="button" className="launcher-refresh" onClick={() => void search.refetch()}>
              <Icon name="refresh" size={14} />
              刷新
            </button>
          </div>
        ) : null}

        {/* 字段限定与逗号多条件只作用于保险库（那套字段语法是保险库的列，另外四类没有对应字段）。
         * 这件事必须说出来：不说，"输入 系统:OA 之后笔记那一类整体消失"看着就是搜索坏了。 */}
        {search.data && !search.data.locked && search.data.vaultOnly ? (
          <p className="launcher-note" role="status">
            带字段限定或多条件的检索只覆盖保险库；要连笔记、题库、工具与任务一起搜，直接键入一个关键词。
          </p>
        ) : null}

        <div className="search-body">
          {search.isError ? (
            <div className="launcher-note text-danger" role="alert" aria-live="assertive">
              {toNormalisedError(search.error).message}
            </div>
          ) : null}

          {search.data?.locked ? (
            <div className="search-lead" role="status" aria-live="polite">
              <p className="search-lead-title">保险库已锁定</p>
              <p className="search-lead-sub">结果已全部清除，请在主窗口解锁后重新查询</p>
            </div>
          ) : null}

          {search.data?.syntaxError ? (
            <div className="launcher-note text-warning" role="alert">
              {search.data.syntaxError}
            </div>
          ) : null}

          <ul id="launcher-results" className="launcher-results" role="listbox" aria-label="搜索结果">
            {results.map((r, i) => {
              // 两个方向的收窄各拿一个变量：`account` 是要读凭据那一批字段，
              // `other` 是让剩下四类在类型上真的互斥（直接在 `r` 上判 source 收不掉 AccountHit）。
              const account = r.source === 'account' ? r : null;
              const other = r.source === 'account' ? null : r;
              return (
                <li
                  key={hitKey(r)}
                  className="launcher-row"
                  role="option"
                  aria-selected={i === active}
                  onMouseEnter={() => setActive(i)}
                >
                  {/* 三档纵向排：名称一行（含徽标）、元信息一行、选中那一行才有操作条。
                   * 之前是 `1fr auto` 两列 + 操作条塞在右列里，右列按 max-content 取宽：那句
                   * "Enter 执行… · Tab 切换本条可用操作：A / B / C / D" 实测 max-content = 507px，
                   * 而行内可用宽度只有 558px ⇒ 左列只剩 43px——交付方 2026-10-20 那张真机照片上
                   * 系统名称就是这么没的，提示本身也冲出本体右沿被窗口裁掉。 */}
                  <div className="launcher-row-title">
                    <span className="launcher-row-name">{rowTitle(r)}</span>
                    <span className="badge badge-muted">{SOURCE_LABELS[r.source]}</span>
                    {account ? <span className="badge badge-muted">{targetTypeLabel(account.itemType)}</span> : null}
                    {account?.isDefault ? <span className="badge badge-success">默认</span> : null}
                    {account?.favorite ? <Icon name="star" label="收藏" className="shrink-0" /> : null}
                  </div>
                  <div className="launcher-row-meta">
                    {account ? (
                      <>
                        {account.accountAlias} · {displayMaskedUsername(account.usernameMasked)} · {account.addressSummary}
                        {account.credentialCountOnTarget > 1 ? ` · 该目标共 ${account.credentialCountOnTarget} 个账号` : ''}
                      </>
                    ) : other?.source === 'note' ? (
                      other.snippet
                    ) : other?.source === 'quiz' ? (
                      <>
                        {other.libraryName} · 第 {other.seq} 题 · {qtypeLabel(other.qtype)}
                      </>
                    ) : other?.source === 'tool' ? (
                      `更新于 ${formatTimestamp(other.updatedAt)}`
                    ) : other ? (
                      TASK_ENV_LABELS[other.env]
                    ) : null}
                  </div>
                  {i === active ? (
                    <div className="launcher-row-actions">
                      {/* 账号行有动作集；其余四类的 Enter 就是"打开这一条"，一句话说明落到哪儿。 */}
                      <p className="launcher-row-hint" aria-live="polite">
                        {account ? (
                          selectedAction ? (
                            <>
                              <kbd>Enter</kbd> 执行「{ACTION_LABELS[selectedAction]}」
                              {activeOrder.length > 1 ? (
                                <>
                                  {' '}
                                  · <kbd>Tab</kbd> 切换 {activeOrder.length} 项操作
                                </>
                              ) : null}
                            </>
                          ) : null
                        ) : (
                          <>
                            <kbd>Enter</kbd> {other ? revealHint(other) : null}
                          </>
                        )}
                      </p>
                      {account ? (
                        <div className="launcher-row-chips">
                          {actionOrder(r).map((a) => {
                            const selected = a === selectedAction;
                            return (
                              <button
                                key={a}
                                type="button"
                                aria-pressed={selected}
                                className="launcher-chip"
                                onClick={() => void runAction(a, account)}
                              >
                                {ACTION_LABELS[a]}
                              </button>
                            );
                          })}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>

          {/* 没输入、也没有推荐时的引导语。锁库走同一档两行式状态块（下面那条），
           * 两档只换句子不换版式；字段怎么限定交给下面的语法块，这里不重复。 */}
          {!debounced && !search.data?.locked && !search.isError && results.length === 0 ? (
            <div className="search-lead">
              <p className="search-lead-title">输入关键字检索账号、笔记、题库、工具与任务</p>
              <p className="search-lead-sub">直接键入一个关键词五类一起搜；按字段限定检索只覆盖保险库</p>
            </div>
          ) : null}

          {conditions.length > 1 ? (
            <p className="launcher-conditions" aria-live="polite">
              多条件 AND：{conditions.map((c) => formatCondition(c)).join(' 且 ')}
            </p>
          ) : null}

          {reply ? (
            <div className="launcher-note launcher-reply" role="status" aria-live="polite">
              {reply}
            </div>
          ) : null}

          {!debounced ? <SyntaxHelp syntax={prefs?.syntax ?? null} /> : null}
        </div>

        {/* 「导航」「关闭」用原型原话；Tab 与 Enter 这两档我们比原型多做了事（切换可用操作、执行选中操作），
         * 照抄成"选择"会让文案承诺得比代码做得到的少，所以这两档保留自己的说法。
         * Enter 那一档现在按来源分两件事：账号行执行选中的动作，其余四类打开那一条，
         * 所以写成「打开或执行」——只写"执行"就把"打开这篇笔记"那四类漏在话外了。 */}
        <div className="search-footer">
          <span>
            <kbd>↑</kbd> <kbd>↓</kbd> 导航
          </span>
          <span>
            <kbd>Tab</kbd> 切换操作
          </span>
          <span>
            <kbd>Enter</kbd> 打开或执行
          </span>
          <span>
            <kbd>Esc</kbd> 关闭
          </span>
          {prefs?.shortcut ? <span className="search-footer-shortcut">全局快捷键：{prefs.shortcut}</span> : null}
        </div>
      </div>
    </div>
  );
}

/**
 * 语法块整体来自后端 launcher_preferences().syntax（parser::syntax_help），前端只做分带渲染：
 * 组名一变就插一条带标题，行与行的字段名前缀就是解析器自己的 `Field::label()`（后端有测试钉住这一点），
 * 所以这里不存在"界面教的写法解析器不认"的漂移空间。后端未就绪时不展示伪造说明。
 */
function SyntaxHelp({ syntax }: { syntax: LauncherSyntaxHint[] | null }) {
  if (!syntax) {
    return (
      <p className="search-help-note" role="status">
        检索语法说明暂时读取失败，重新唤起浮层会再试一次。
      </p>
    );
  }
  return (
    <div className="search-help">
      {syntax.map((h, i) => (
        <Fragment key={h.pattern}>
          {i === 0 || syntax[i - 1].group !== h.group ? <p className="search-help-group">{h.group}</p> : null}
          <span className="search-help-pattern">{h.pattern}</span>
          <span className="search-help-desc">{h.desc}</span>
        </Fragment>
      ))}
    </div>
  );
}
