import { useState, type FormEvent } from 'react';
import { useSession } from '../../state/session';
import { AuthShell } from './AuthShell';
import { Button } from '../ui/Button';
import { PasswordField } from '../ui/PasswordField';
import { MasterPasswordHint } from './TermHints';

/** 会话被二次认证策略要求重新验证主密码（REAUTH_REQUIRED）。 */
export function ReauthPanel({ reason }: { reason?: string }) {
  const reauthenticate = useSession((s) => s.reauthenticate);
  const pending = useSession((s) => s.pending);
  const errorMessage = useSession((s) => s.errorMessage);
  const [password, setPassword] = useState('');

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!password) return;
    const ok = await reauthenticate(password);
    if (ok) setPassword('');
  }

  return (
    <AuthShell note="这一步动的是受保护的内容，麻烦你再确认一次主密码。">
      <form onSubmit={onSubmit} aria-label="重新认证">
      <h2 className="auth-title">再确认一次主密码</h2>
      <p className="auth-sub">{reason ?? '输入一次主密码，我们就接着往下做。'}</p>
      <div className="auth-stack">
        <PasswordField label="主密码" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" required />
        <MasterPasswordHint />
        {errorMessage ? (
          <div className="auth-alert" role="alert">
            <span>{errorMessage}</span>
          </div>
        ) : null}
        <Button type="submit" variant="primary" className="auth-submit" disabled={pending || !password}>
          {pending ? '验证中…' : '验证并继续'}
        </Button>
      </div>
      </form>
    </AuthShell>
  );
}

/** 会话锁定 / 过期面板：展示后端 message，并提供重新解锁入口。 */
export function SessionHaltPanel({ kind }: { kind: 'locked' | 'expired' }) {
  const errorMessage = useSession((s) => s.errorMessage);
  const errorDetail = useSession((s) => s.errorDetail);
  const bootstrap = useSession((s) => s.bootstrap);
  const isLocked = kind === 'locked';

  return (
    <AuthShell note="这扇门已经重新关上：锁定之前的结果与明文都没有留在界面上。">
      <div role="alert" aria-live="assertive">
      <h2 className="auth-title">{isLocked ? '会话已锁定' : '会话已过期'}</h2>
      <p className="auth-sub">
        <span className="mb-2 block text-sm text-ink">{errorMessage ?? (isLocked ? '刚才失败次数太多，保险库先把自己锁了一会儿。' : '这一会话放久了点，重新解锁就好。')}</span>
        {errorDetail ? <span className="mb-4 block text-xs text-ink-muted">{errorDetail}</span> : null}
        <span className="mb-4 block text-sm text-ink-muted">重新解锁后请再查一次——锁定前的结果和明文，界面上都没有留。</span>
      </p>
      <Button variant="primary" className="auth-submit" onClick={() => void bootstrap()}>
        返回解锁
      </Button>
      </div>
    </AuthShell>
  );
}
