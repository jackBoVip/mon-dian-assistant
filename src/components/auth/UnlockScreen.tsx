import { useMemo, useState, type FormEvent } from 'react';
import { useSession } from '../../state/session';
import type { LoginProfileUser } from '../../lib/types';
import { AuthShell } from './AuthShell';
import { Button } from '../ui/Button';
import { PasswordField } from '../ui/PasswordField';
import { MasterPasswordHint } from './TermHints';

function UserCard({
  user,
  selected,
  onSelect,
}: {
  user: LoginProfileUser;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className="auth-user"
    >
      <span className="font-medium">{user.nickname}</span>
      <span className="mono text-xs text-ink-muted" title="系统生成的内部标识，只用来看清是哪一位，不用你输入">
        {user.internalCode}
      </span>
    </button>
  );
}

/** 解锁页：单用户只显示密码；多用户先选昵称/头像（含内部标识以消歧），再输入主密码。 */
export function UnlockScreen() {
  const profile = useSession((s) => s.profile);
  const unlock = useSession((s) => s.unlock);
  const pending = useSession((s) => s.pending);
  const errorMessage = useSession((s) => s.errorMessage);
  const errorCode = useSession((s) => s.errorCode);
  const errorDetail = useSession((s) => s.errorDetail);

  const users = useMemo(() => profile?.users ?? [], [profile]);
  const single = users.length === 1 ? users[0] : null;
  const [selectedId, setSelectedId] = useState<string | null>(single?.id ?? null);
  const [password, setPassword] = useState('');

  const activeId = single ? single.id : selectedId;
  const lockout = profile?.lockout ?? null;
  /**
   * 锁定条只在"真有一件事要说"时出现：
   * ① 一次都没失败过时不显示（`lockout` 恒非空，否则界面一进来就写"刚才 0 次没对上"）；
   * ② 倒计时只在后端确实给了秒数时说，`max_failed_login_attempts=0`（不启用锁定）那一格
   *    后端现在报 `locked:false`，所以不会再出现"请在 0 秒后重试"。
   */
  const lockoutLine =
    lockout === null || lockout.failedCount === 0
      ? null
      : lockout.locked && lockout.secondsRemaining > 0
        ? `刚才失败得多了点，请在约 ${lockout.secondsRemaining} 秒后重试。别担心，重试不会弄坏数据（计时与次数都由后端给出）`
        : `刚才 ${lockout.failedCount} 次没对上，还剩 ${lockout.attemptsRemaining} 次。别着急，输错不会弄坏数据`;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!activeId || !password) return;
    await unlock(activeId, password);
  }

  return (
    <AuthShell note="保险库一直在本机等你。解锁只认主密码，数据从不出这台机器。">
      <h2 className="auth-title">{single ? `又见面了，${single.nickname}` : '这台机器上有几位使用者，先选一位。'}</h2>

        {!single ? (
          <div className="auth-users" role="radiogroup" aria-label="选择使用者">
            {users.map((u) => (
              <UserCard key={u.id} user={u} selected={selectedId === u.id} onSelect={() => setSelectedId(u.id)} />
            ))}
            {users.length === 0 ? <p className="col-span-2 text-sm text-ink-muted">没有可用的启用使用者。</p> : null}
          </div>
        ) : (
          <p className="mono mb-4 text-xs text-ink-muted" title="系统生成的内部标识，只用来看清是哪一位，不用你输入">
            {single.nickname} · {single.internalCode}
          </p>
        )}

        {lockoutLine ? (
          <p className="mb-4 text-sm text-warning" role="status" aria-live="polite">
            {lockoutLine}
          </p>
        ) : null}

        <form onSubmit={onSubmit} className="auth-stack">
          <PasswordField
            label="主密码"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="off"
            disabled={!activeId}
            required
          />
          <MasterPasswordHint />
          {/* L 轮：这里原本有一行"后端策略提示：至少 N 位、需包含多类字符"。
              主密码已无任何强度要求，那一行显示的是只有导出容器口令才会生效的值，故撤除。 */}

          {errorMessage ? (
            <div className="auth-alert" role="alert">
              <span>
                {errorMessage}
                {errorCode ? `（${errorCode}）` : ''}
              </span>
              {errorDetail ? <span className="auth-alert-detail">{errorDetail}</span> : null}
            </div>
          ) : null}

          <Button type="submit" variant="primary" className="auth-submit" disabled={pending || !activeId || !password}>
            {pending ? '解锁中…' : '解锁'}
          </Button>
        </form>
    </AuthShell>
  );
}
