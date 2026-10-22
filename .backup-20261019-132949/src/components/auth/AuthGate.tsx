import type { ReactNode } from 'react';
import { useSession } from '../../state/session';
import { Loading, BackendUnavailable } from '../ui/StateBlocks';
import { InitScreen } from './InitScreen';
import { UnlockScreen } from './UnlockScreen';
import { DeviceKeyConsentScreen } from './DeviceKeyConsentScreen';
import { BootFailedScreen } from './BootFailedScreen';
import { ReauthPanel, SessionHaltPanel } from './SessionPanels';

/** 依据后端 status()/loginProfile() 与错误码渲染认证界面；未解锁前不渲染任何业务界面。 */
export function AuthGate({ children }: { children: ReactNode }) {
  const phase = useSession((s) => s.phase);
  const errorMessage = useSession((s) => s.errorMessage);
  const errorDetail = useSession((s) => s.errorDetail);

  switch (phase) {
    case 'boot':
      return <Loading label="正在检测本机保险库状态…" />;
    case 'bootFailed':
      return <BootFailedScreen />;
    case 'unavailable':
      return <BackendUnavailable message={errorMessage ?? '后端不可用。'} detail={errorDetail ?? undefined} />;
    case 'deviceKeyConsent':
      return <DeviceKeyConsentScreen />;
    case 'init':
      return <InitScreen />;
    case 'login':
      return <UnlockScreen />;
    case 'locked':
      return <SessionHaltPanel kind="locked" />;
    case 'expired':
      return <SessionHaltPanel kind="expired" />;
    case 'reauth':
      return <ReauthPanel />;
    case 'unlocked':
      return <>{children}</>;
    default:
      return <Loading />;
  }
}
