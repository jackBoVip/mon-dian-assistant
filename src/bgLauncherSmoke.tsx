/**
 * BG 轮临时探针（验完删除，不进产物）：在纯浏览器里渲染**真实的** LauncherSettingsPage，
 * 用 `__TAURI_INTERNALS__` 打桩后端那四条命令。桩会真的记住写入，所以拨一下开关、
 * 改一次快捷键以后，随后的重取数能读到新值——这样才验得到"界面跟着后端翻转"这半条。
 */
import './styles/tokens.css';
import './styles/global.css';

type Row = [string, string];

const settings: Row[] = [
  ['quick_launcher_enabled', 'true'],
  ['quick_launcher_show_recent', 'true'],
  ['quick_launcher_rank_recent_favorite', 'true'],
  ['quick_launcher_result_limit', '20'],
];
const DEFAULT_ACCEL = 'Cmd+Shift+Space';
let shortcut = DEFAULT_ACCEL;

const read = (key: string) => settings.find(([k]) => k === key)?.[1];
const write = (key: string, value: string) => {
  const row = settings.find(([k]) => k === key);
  if (row) row[1] = value;
};

const callbacks = new Map<number, (data: unknown) => void>();

(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
  metadata: { currentWindow: { label: 'main' }, packageInfo: { version: '0.0.0', name: 'bg-launcher-smoke' } },
  transformCallback(callback: (data: unknown) => void) {
    const id = Math.random();
    callbacks.set(id, callback);
    return id;
  },
  unregisterCallback(id: number) {
    callbacks.delete(id);
  },
  async invoke(command: string, args?: Record<string, unknown>) {
    switch (command) {
      case 'launcher_preferences':
        return {
          shortcut,
          default: DEFAULT_ACCEL,
          enabled: read('quick_launcher_enabled') === 'true',
          showRecentWhenEmpty: read('quick_launcher_show_recent') === 'true',
          rankRecentFavorite: read('quick_launcher_rank_recent_favorite') === 'true',
          resultLimit: Number(read('quick_launcher_result_limit')),
          syntax: [
            { group: '匹配', pattern: 'oa', desc: '名称或别名含 oa' },
            { group: '组合', pattern: 'oa，web', desc: '两个条件同时命中' },
          ],
        };
      case 'set_launcher_enabled': {
        const enabled = Boolean(args?.enabled);
        write('quick_launcher_enabled', String(enabled));
        return { registered: enabled, hint: enabled ? `已注册 ${shortcut}` : '已注销全局唤起' };
      }
      case 'set_launcher_shortcut': {
        shortcut = String(args?.accelerator ?? '');
        return { registered: true, hint: `已注册 ${shortcut}` };
      }
      case 'update_setting': {
        write(String(args?.key), String(args?.value));
        return null;
      }
      default:
        throw { code: 'NOT_FOUND', message: `桩没实现这条命令：${command}` };
    }
  },
};

document.documentElement.dataset.theme = new URLSearchParams(location.search).get('theme') ?? 'glass';
// 与主窗入口同一口径：没有这一档，--titlebar-inset 停在 0，红绿灯那条 28px 带不会被让出来。
document.documentElement.dataset.os = 'mac';

const { createRoot } = await import('react-dom/client');
const { StrictMode } = await import('react');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { LauncherSettingsPage } = await import('./pages/LauncherSettingsPage');

const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={qc}>
      <div className="app-root">
        <div className="bg-blobs" aria-hidden="true">
          <span className="blob blob-1" />
          <span className="blob blob-2" />
          <span className="blob blob-3" />
        </div>
        <div className="app-container">
          <div className="main-content">
            <div className="content-layout">
              <LauncherSettingsPage />
            </div>
          </div>
        </div>
      </div>
    </QueryClientProvider>
  </StrictMode>,
);
