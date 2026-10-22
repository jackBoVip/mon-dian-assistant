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

// 主题引导：在任何渲染前把 data-theme/data-mode/data-glass 写入根元素，避免闪烁。
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
