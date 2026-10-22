import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useSession } from './state/session';
import { useTheme } from './state/theme';
import { AuthGate } from './components/auth/AuthGate';
import { AppShell } from './components/AppShell';
import { useVaultLocked } from './lib/vaultEvents';
import { notify } from './state/notify';

export function App() {
  const bootstrap = useSession((s) => s.bootstrap);
  const queryClient = useQueryClient();

  useEffect(() => {
    // 先按本地默认把外观刷上（只动 DOM，不发请求）；读库的 get_theme 由 bootstrap 在确认
    // 后端已装配之后再发——装配之前那条命令无从应答，历史版本在这里并发调用导致进程 abort。
    useTheme.getState().apply();
    void bootstrap();
  }, [bootstrap]);

  // 后端锁定（含空闲超时）后：丢弃缓存里上一次解密出来的数据，界面回到解锁页。
  useVaultLocked(() => {
    queryClient.clear();
    void useSession.getState().markLocked();
    notify('warning', '保险库已锁定，请重新解锁后继续');
  });

  return (
    <AuthGate>
      <AppShell />
    </AuthGate>
  );
}
