import { useEffect, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { api } from '../../lib/api';
import type { WindowChrome } from '../../lib/types';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';

/** 预览/测试环境拿不到后端时按"没有窗口"处理：画三颗点了没反应的钮比不画更坏。 */
const NO_WINDOW: WindowChrome = { customControls: false, platform: 'web' };

/**
 * Windows / Linux 的窗口三颗钮。
 *
 * 为什么需要它：`titleBarStyle: Overlay` 与 `hiddenTitle` 只在 macOS 生效
 * （`tauri-runtime-wry-2.12.1/src/lib.rs:799` 那段套的是 `#[cfg(target_os = "macos")]`），
 * 所以另两端原先顶着系统标题栏，与自绘的 `.top-navbar` 叠成两条栏。后端现在在 setup 里
 * 运行时去框（见 `src-tauri/src/window_chrome.rs`），**去框后系统不再提供任何窗口按钮**，
 * 这三颗就必须由界面画——而"该不该画"只有后端知道，故走 `window_chrome` 这一枚查询。
 *
 * macOS 不渲染这一组：那边有原生红绿灯。
 */
export function WindowControls() {
  const [chrome, setChrome] = useState<WindowChrome>(NO_WINDOW);
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    let alive = true;
    // Promise.resolve().then 包一层：这样连"这一版后端还没有 window_chrome 命令"（旧 mock、
    // 旧构建）都能落到 catch，而不是在 effect 里同步抛出去把整棵顶栏带崩。
    void Promise.resolve()
      .then(() => api.windowChrome())
      .catch(() => NO_WINDOW)
      .then((next) => {
        if (alive) setChrome(next);
      });
    return () => {
      alive = false;
    };
  }, []);

  const { customControls } = chrome;

  useEffect(() => {
    if (!customControls) return;
    const win = getCurrentWindow();
    const read = () => void win.isMaximized().then(setMaximized).catch(() => undefined);
    read();
    let unlisten: (() => void) | undefined;
    // 最大化状态没有事件可直接给，用尺寸变化去回读：拖标题栏、双击、快捷键都必然改尺寸
    void win
      .onResized(read)
      .then((f) => {
        unlisten = f;
      })
      .catch(() => undefined);
    return () => unlisten?.();
  }, [customControls]);

  if (!customControls) return null;
  const win = getCurrentWindow();

  return (
    <div className="flex items-center gap-1" role="group" aria-label="窗口控制">
      <Button variant="bare" className="icon-btn" aria-label="最小化" title="最小化" onClick={() => void win.minimize().catch(() => undefined)}>
        <Icon name="windowMinimize" size={14} />
      </Button>
      <Button
        variant="bare"
        className="icon-btn"
        aria-label={maximized ? '还原' : '最大化'}
        title={maximized ? '还原' : '最大化'}
        onClick={() => void win.toggleMaximize().catch(() => undefined)}
      >
        <Icon name={maximized ? 'windowRestore' : 'windowMaximize'} size={14} />
      </Button>
      <Button variant="bare" className="icon-btn" aria-label="关闭窗口" title="关闭" onClick={() => void win.close().catch(() => undefined)}>
        <Icon name="close" size={14} />
      </Button>
    </div>
  );
}
