import { Fragment, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import type { LauncherPreferences, LauncherSyntaxHint, QuickAction, QuickResult } from '../lib/types';
import { queryKeys } from '../lib/queryClient';
import { quickSearchOptions } from '../lib/queryOptions';
import { targetTypeLabel } from '../lib/types';
import { parseConditions, formatCondition } from '../lib/query';
import { displayMaskedUsername } from '../lib/mask';
import { formatElapsed } from '../lib/format';
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
 * 浮层不渲染的动作（交付方 2026-10-21：取消「选择其他账号」那颗钮）。
 * 后端在多账号目标下会下发 select_other_account，但它对应的回执只有一句
 * "请选择要使用的账号"——浮层里没有账号列表可挑，这颗钮兑不出承诺。
 * 命令本身保留，只是不在这扇窗里给出入口。
 */
const HIDDEN_ACTIONS: ReadonlySet<QuickAction> = new Set(['select_other_account']);

/** 浮层里真正可执行的动作：顺序沿用后端，只摘掉不渲染的那几条。 */
function visibleActions(r: QuickResult): QuickAction[] {
  return r.actions.filter((a) => !HIDDEN_ACTIONS.has(a));
}

/**
 * Enter 主操作优先级：网页优先安全填充，否则打开目标。
 * 兜底那一条是硬约束：主操作绝不落在「复制密码」上（需求 §304/§605——Enter 不得意外复制密码），
 * 即便后端给出的动作顺序把 copy_password 放在第一位也不能改变这一点。
 */
function primaryAction(r: QuickResult): QuickAction | null {
  const actions = visibleActions(r);
  if (actions.includes('open_and_fill')) return 'open_and_fill';
  if (actions.includes('open_target')) return 'open_target';
  return actions.find((a) => a !== 'copy_password') ?? null;
}

/**
 * 一行里可用动作的键盘顺序：0 号一定是主操作（Enter 的默认动作），其余按后端给出的顺序跟随。
 * Tab/Shift+Tab 就在这个数组上前后循环（需求 line 261：Tab 或快捷菜单切换可用操作）。
 */
function actionOrder(r: QuickResult | undefined): QuickAction[] {
  if (!r) return [];
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

  // 换行、或结果集刷新导致当前行换成另一条凭据时，动作选择退回主操作。
  // 不退回的话：上一次 Tab 停在「复制密码」，换行后直接按 Enter 就把密码复制了。
  useEffect(() => {
    setActionIndex(0);
  }, [active, activeRow?.itemId]);

  async function runAction(action: QuickAction, r: QuickResult) {
    try {
      const res = await api.quickAction(action, r.itemId, r.targetId, r.isDefault ? r.itemId : undefined);
      setReply(res.message); // 原样回显，包括降级说明
    } catch (raw) {
      setReply(toNormalisedError(raw).message);
    }
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
      // 执行当前选中的动作；未 Tab 过时它就是主操作（actionIndex 默认 0）
      if (activeRow && selectedAction) {
        e.preventDefault();
        void runAction(selectedAction, activeRow);
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
            placeholder="搜索所有系统、账号或配置..."
            autoComplete="off"
            aria-label="快速查找账号"
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
         * 内容区是可滚动的，摘要放进去会跟着滚走，所以留在它与输入行之间。 */}
        {search.data && !search.data.locked && (debounced || results.length > 0) ? (
          <div className="search-meta">
            <span>
              {debounced
                ? `命中 ${results.length} 条 · 耗时 ${formatElapsed(search.data.elapsedMs)} · 索引 ${search.data.indexed} 条`
                : `最近使用 / 收藏推荐 ${results.length} 条 · 耗时 ${formatElapsed(search.data.elapsedMs)}`}
            </span>
            <button type="button" className="launcher-refresh" onClick={() => void search.refetch()}>
              <Icon name="refresh" size={14} />
              刷新
            </button>
          </div>
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
            {results.map((r, i) => (
              <li
                key={`${r.targetId}-${r.itemId}`}
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
                  <span className="launcher-row-name">{r.systemName}</span>
                  <span className="badge badge-muted">{targetTypeLabel(r.itemType)}</span>
                  {r.isDefault ? <span className="badge badge-success">默认</span> : null}
                  {r.favorite ? <Icon name="star" label="收藏" className="shrink-0" /> : null}
                </div>
                <div className="launcher-row-meta">
                  {r.accountAlias} · {displayMaskedUsername(r.usernameMasked)} · {r.addressSummary}
                  {r.credentialCountOnTarget > 1 ? ` · 该目标共 ${r.credentialCountOnTarget} 个账号` : ''}
                </div>
                {i === active ? (
                  <div className="launcher-row-actions">
                    {selectedAction ? (
                      <p className="launcher-row-hint" aria-live="polite">
                        <kbd>Enter</kbd> 执行「{ACTION_LABELS[selectedAction]}」
                        {activeOrder.length > 1 ? (
                          <>
                            {' '}
                            · <kbd>Tab</kbd> 切换 {activeOrder.length} 项操作
                          </>
                        ) : null}
                      </p>
                    ) : null}
                    <div className="launcher-row-chips">
                      {actionOrder(r).map((a) => {
                        const selected = a === selectedAction;
                        return (
                          <button
                            key={a}
                            type="button"
                            aria-pressed={selected}
                            className="launcher-chip"
                            onClick={() => void runAction(a, r)}
                          >
                            {ACTION_LABELS[a]}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>

          {/* 没输入、也没有推荐时的引导语。锁库走同一档两行式状态块（下面那条），
           * 两档只换句子不换版式；字段怎么限定交给下面的语法块，这里不重复。 */}
          {!debounced && !search.data?.locked && !search.isError && results.length === 0 ? (
            <div className="search-lead">
              <p className="search-lead-title">输入关键字检索保险库</p>
              <p className="search-lead-sub">可直接键入关键词，也可按字段限定检索</p>
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
         * 照抄成"选择"会让文案承诺得比代码做得到的少，所以这两档保留自己的说法。 */}
        <div className="search-footer">
          <span>
            <kbd>↑</kbd> <kbd>↓</kbd> 导航
          </span>
          <span>
            <kbd>Tab</kbd> 切换操作
          </span>
          <span>
            <kbd>Enter</kbd> 执行选中操作
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
