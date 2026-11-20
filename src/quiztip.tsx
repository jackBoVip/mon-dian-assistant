import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QuizTipApp } from './quiztip/QuizTipApp';
import { useTheme } from './state/theme';
import { ErrorBoundary } from './components/ui/ErrorBoundary';
import './styles/tokens.css';
import './styles/global.css';
import './styles/quiztip.css';

useTheme.getState().apply();

const container = document.getElementById('quiztip-root');
if (!container) {
  throw new Error('缺少 #quiztip-root 挂载点');
}

createRoot(container).render(
  <ErrorBoundary>
    <StrictMode>
      <QuizTipApp />
    </StrictMode>
  </ErrorBoundary>,
);
