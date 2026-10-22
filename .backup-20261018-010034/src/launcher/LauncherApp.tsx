import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import type { LauncherPreferences, QuickAction, QuickResult, SearchReply } from '../lib/types';
import { targetTypeLabel } from '../lib/types';
import { parseConditions, formatCondition } from '../lib/query';
import { displayMaskedUsername } from '../lib/mask';
import { formatElapsed } from '../lib/format';
import { useBackendEvent, useVaultLocked } from '../lib/vaultEvents';
import { toNormalisedError } from '../lib/errors';
import { useTheme } from '../state/theme';
import { Button } from '../components/ui/Button';
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
 * Enter 主操作优先级：网页优先安全填充，否则打开目标。
 * 兜底那一条是硬约束：主操作绝不落在「复制密码」上（需求 §304/§605——Enter 不得意外复制密码），
 * 即便后端给出的动作顺序把 copy_password 放在第一位也不能改变这一点。
 */
function primaryAction(r: QuickResult): QuickAction | null {
  if (r.actions.includes('open_and_fill')) return 'open_and_fill';
  if (r.actions.includes('open_target')) return 'open_target';
  return r.actions.find((a) => a !== 'copy_password') ?? null;
}

/**
 * 一行里可用动作的键盘顺序：0 号一定是主操作（Enter 的默认动作），其余按后端给出的顺序跟随。
 * Tab/Shift+Tab 就在这个数组上前后循环（需求 line 261：Tab 或快捷菜单切换可用操作）。
 */
function actionOrder(r: QuickResult | undefined): QuickAction[] {
  if (!r) return [];
  const pa = primaryAction(r);
  if (!pa) return [];
  return [pa, ...r.actions.filter((a) => a !== pa)];
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

  // 浮层关闭是 hide() 不是销毁，组件一直挂在内存里；不重新读设置的话，管理员改的开关要等到重启才生效。
  useBackendEvent('launcher://shown', () => {
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

  const search = useQuery<SearchReply>({
    queryKey: ['quickSearch', debounced],
    queryFn: () => api.quickSearch(debounced),
    enabled: debounced.length > 0 || showEmptySuggestions,
  });

  // 锁定后搜索结果必须从界面与缓存中一起消失：命中条目含账号别名与用户名，属于敏感元数据。
  const queryClient = useQueryClient();
  useVaultLocked(() => {
    queryClient.removeQueries({ queryKey: ['quickSearch'] });
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
      setActive((i) => Math.min(results.length - 1, i + 1));
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

  return (
    <div className="launcher-shell">
      <div className="launcher-input-row">
        <Icon name="search" className="launcher-hint-icon" />
        <input
          ref={inputRef}
          className="launcher-input"
          placeholder="输入条件，逗号分隔即 AND（如：OA，地址:10.0.0.22）"
          aria-label="快速查找账号"
          aria-expanded={results.length > 0}
          aria-controls="launcher-results"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <Button variant="ghost" aria-label="关闭" onClick={() => void hide()}>
          <Icon name="close" />
        </Button>
      </div>

      {search.isError ? (
        <div className="px-4 py-3 text-sm text-danger" role="alert" aria-live="assertive">
          {toNormalisedError(search.error).message}
        </div>
      ) : null}

      {search.data?.locked ? (
        <div className="px-4 py-6 text-center text-sm" role="status" aria-live="polite">
          <p className="mb-2">保险库已锁定，快捷启动器不显示任何结果。</p>
          <p className="text-ink-muted">请在主窗口解锁后重新查询。</p>
        </div>
      ) : null}

      {search.data?.syntaxError ? (
        <div className="px-4 py-2 text-sm text-warning" role="alert">
          {search.data.syntaxError}
        </div>
      ) : null}

      {search.data && !search.data.locked && (debounced || results.length > 0) ? (
        <div className="flex items-center justify-between px-4 py-1 text-xs text-ink-muted">
          <span>
            {debounced
              ? `命中 ${results.length} 条 · 耗时 ${formatElapsed(search.data.elapsedMs)} · 索引 ${search.data.indexed} 条`
              : `最近使用 / 收藏推荐 ${results.length} 条（由设置启用，输入条件即切换为搜索） · 耗时 ${formatElapsed(search.data.elapsedMs)}`}
          </span>
          <button type="button" className="launcher-refresh hover:text-ink" onClick={() => void search.refetch()}>
            <Icon name="refresh" size={14} />
            刷新
          </button>
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
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="truncate font-medium">{r.systemName}</span>
                <span className="badge badge-muted">{targetTypeLabel(r.itemType)}</span>
                {r.isDefault ? <span className="badge badge-success">默认</span> : null}
                {r.favorite ? <Icon name="star" label="收藏" className="shrink-0" /> : null}
              </div>
              <div className="truncate text-xs text-ink-muted">
                {r.accountAlias} · {displayMaskedUsername(r.usernameMasked)} · {r.addressSummary}
                {r.credentialCountOnTarget > 1 ? ` · 该目标共 ${r.credentialCountOnTarget} 个账号` : ''}
              </div>
            </div>
            <div className="flex min-w-0 flex-col items-end gap-1">
              <div className="flex flex-wrap justify-end gap-1">
                {actionOrder(r).map((a) => {
                  const selected = i === active && a === selectedAction;
                  return (
                    <button
                      key={a}
                      type="button"
                      aria-pressed={selected}
                      className={`rounded-sm border px-2 py-0.5 text-xs ${
                        selected ? 'border-primary bg-sunken font-medium text-ink' : 'border-line text-ink-muted hover:border-primary'
                      }`}
                      onClick={() => void runAction(a, r)}
                    >
                      {ACTION_LABELS[a]}
                    </button>
                  );
                })}
              </div>
              {i === active && selectedAction ? (
                <p className="text-xs text-ink-muted" aria-live="polite">
                  <kbd>Enter</kbd> 执行「{ACTION_LABELS[selectedAction]}」
                  {activeOrder.length > 1 ? (
                    <>
                      {' '}
                      · <kbd>Tab</kbd> 切换本条可用操作：{activeOrder.map((a) => ACTION_LABELS[a]).join(' / ')}
                    </>
                  ) : null}
                </p>
              ) : null}
            </div>
          </li>
        ))}
      </ul>

      {reply ? (
        <div className="px-4 py-2 text-xs" role="status" aria-live="polite">
          {reply}
        </div>
      ) : null}

      <div className="launcher-hints">
        <span>
          <kbd>↑</kbd>
          <kbd>↓</kbd> 选择结果 · <kbd>Tab</kbd> 切换可用操作 · <kbd>Enter</kbd> 执行选中操作 · <kbd>Esc</kbd> 关闭
        </span>
        {prefs?.shortcut ? <span>全局快捷键：{prefs.shortcut}</span> : null}
      </div>

      {conditions.length > 1 ? (
        <div className="px-4 py-1 text-xs text-ink-muted" aria-live="polite">
          多条件 AND：{conditions.map((c) => formatCondition(c)).join(' 且 ')}
        </div>
      ) : null}

      {!debounced ? <SyntaxHelp syntax={prefs?.syntax ?? null} /> : null}
    </div>
  );
}

/** 语法说明完全来自后端 launcher_preferences().syntax（parser::syntax_help）；后端未就绪时不展示伪造说明。 */
function SyntaxHelp({ syntax }: { syntax: Array<[string, string]> | null }) {
  if (!syntax) {
    return (
      <div className="px-4 py-2 text-xs text-ink-muted">
        <p>未能读取后端语法说明（后端未就绪或未返回 syntax 字段）。</p>
      </div>
    );
  }
  return (
    <div className="px-4 py-2 text-xs text-ink-muted">
      <p className="mb-1 font-medium">搜索语法（来自后端）：</p>
      <ul className="flex flex-col gap-0.5">
        {syntax.map(([pattern, desc]) => (
          <li key={pattern}>
            <span className="mono">{pattern}</span> —— {desc}
          </li>
        ))}
      </ul>
    </div>
  );
}
