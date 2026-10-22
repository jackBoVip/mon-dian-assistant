import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { LauncherApp } from './launcher/LauncherApp';
import { createQueryClient } from './lib/queryClient';
import { useTheme } from './state/theme';
import './styles/tokens.css';
import './styles/global.css';

const queryClient = createQueryClient();
useTheme.getState().apply();

const container = document.getElementById('launcher-root');
if (!container) {
  throw new Error('缺少 #launcher-root 挂载点');
}

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <LauncherApp />
    </QueryClientProvider>
  </StrictMode>,
);
