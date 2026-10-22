import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useSession } from '../../state/session';
import { Button } from '../ui/Button';
import { PasswordField } from '../ui/PasswordField';

/**
 * 首次装机的设置密码表单：设置密码 + 确认密码，两栏，别的什么都没有。
 *
 * 三条口径：
 * ① 位数与字符类别都不在屏幕上预告，也**不再由后端判定**：交付方 2026-10-17 取消了主密码强度策略，
 *    任意非空口令都能建库（前端只挡空值与两次不一致，后端 require_non_empty 再挡一次空/纯空格）。
 * ② 昵称不出现在界面上：内部账号标识与显示名由 Rust 侧在创建时按设备名生成并写入本机。
 * ③ 真正的创建、密钥派生与建库全在 Rust 侧；成功与否一律以后端返回为准，
 *    后端没答应"建好了"，界面就不会显示"已创建"。
 */
export function VaultCreateForm() {
  const initialize = useSession((s) => s.initialize);
  const pending = useSession((s) => s.pending);
  const errorMessage = useSession((s) => s.errorMessage);
  const errorDetail = useSession((s) => s.errorDetail);
  const errorCode = useSession((s) => s.errorCode);

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [passwordError, setPasswordError] = useState<string | undefined>();
  const [confirmError, setConfirmError] = useState<string | undefined>();

  const passwordRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLInputElement>(null);
  const alertRef = useRef<HTMLDivElement>(null);
  /** 只在"本组件发起过一次提交且它失败了"之后把焦点交给错误摘要。
   *  直接写在 await 后面不行：React 18 会把 store 的那次 set 批到下一个微任务，
   *  那时 alertRef 还是 null，焦点会静默丢掉。挂载时就带着错误也不抢焦点。 */
  const submitFailedRef = useRef(false);

  useEffect(() => {
    if (errorMessage && submitFailedRef.current) {
      submitFailedRef.current = false;
      alertRef.current?.focus();
    }
  }, [errorMessage]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    // 提交中不再进第二次：按钮同时 disabled，双保险防重复建库
    if (pending) return;

    const nextPasswordError = password ? undefined : '请输入主密码。';
    const nextConfirmError = password === confirm ? undefined : '两次输入的密码不一致，再核对一下。';
    setPasswordError(nextPasswordError);
    setConfirmError(nextConfirmError);
    if (nextPasswordError) {
      passwordRef.current?.focus();
      return;
    }
    if (nextConfirmError) {
      confirmRef.current?.focus();
      return;
    }

    submitFailedRef.current = true;
    const ok = await initialize('', password);
    if (ok) submitFailedRef.current = false;
  }

  return (
    <form className="auth-form" onSubmit={onSubmit} aria-label="设置主密码">
      <PasswordField
        ref={passwordRef}
        label="设置密码"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        placeholder="输入密码"
        error={passwordError}
        autoComplete="new-password"
      />

      <PasswordField
        ref={confirmRef}
        label="确认密码"
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
        placeholder="再次输入密码"
        error={confirmError}
        autoComplete="new-password"
      />

      {errorMessage ? (
        <div ref={alertRef} className="auth-alert" role="alert" tabIndex={-1}>
          <span>
            {errorMessage}
            {errorCode ? `（${errorCode}）` : ''}
          </span>
          {errorDetail ? <span className="auth-alert-detail">{errorDetail}</span> : null}
          <span className="auth-alert-detail">改一下上面任一项再提交就行，不用刷新，也不用重来。</span>
        </div>
      ) : null}

      <Button type="submit" variant="primary" className="auth-submit" disabled={pending}>
        {pending ? '开启中…' : '开启助手'}
      </Button>
    </form>
  );
}
