import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { App } from './App';
import { createQueryClient } from './lib/queryClient';
import { useTheme } from './state/theme';
// 令牌层与工具类层要分别引入：global.css 和组件全靠 var(--…) 取值，漏掉 tokens.css 不会报错，
// 只会让整套主题静默失效。浮层入口 launcher.tsx 引的是同一对文件。
import './styles/tokens.css';
import './styles/global.css';

const queryClient = createQueryClient();

// 平台标记：macOS 主窗的原生标题栏浮在内容之上（tauri.conf 的 titleBarStyle: Overlay），
// 样式侧靠这个属性把 --titlebar-inset 从 0 抬到 28px，给红绿灯让出那条原生拖动带。
// 只写在主窗入口——快捷启动器那扇窗本来就是无边的，不该有这一档。
if (/Macintosh|Mac OS X/.test(navigator.userAgent)) {
  document.documentElement.dataset.os = 'mac';
}

// 主题引导：在任何渲染前把 data-theme/data-reduce-motion 写入根元素，避免闪烁。
useTheme.getState().apply();

const container = document.getElementById('root');
if (!container) {
  throw new Error('缺少 #root 挂载点');
}

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
