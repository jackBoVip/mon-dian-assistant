import { useState, type FormEvent } from 'react';
import { useSession } from '../../state/session';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { PasswordField } from '../ui/PasswordField';
import { MasterPasswordHint } from '../auth/TermHints';
import { notify } from '../../state/notify';

export interface ChangePasswordModalProps {
  open: boolean;
  onClose: () => void;
}

/**
 * 修改密码（原型 #passwordModal）：改的是这台机器上的主密码，走后端 change_master_password。
 *
 * 标题与三栏名字照原型（`修改密码` / `当前密码` / `新密码` / `确认新密码`），
 * 「主」字不再出现在栏名里——那层身份区分由下面那句必说告知承担，它比栏名三个字更管用。
 * **没有任何强度要求**（交付方 2026-10-17 取消了主密码强度策略），所以原型占位符里的
 * "(至少 8 位)" 这一条不加回来：写上屏就是一条不会生效的假承诺。
 * 新密码非空由后端 policy::require_non_empty 判定；两栏不一致在提交前于本机比一下，
 * 免得把一次注定失败的请求发出去。
 */
export function ChangePasswordModal({ open, onClose }: ChangePasswordModalProps) {
  const change = useSession((s) => s.changeMasterPassword);
  const pending = useSession((s) => s.pending);
  const errorMessage = useSession((s) => s.errorMessage);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');

  function reset() {
    setCurrent('');
    setNext('');
    setConfirm('');
  }

  async function run() {
    if (!current || !next) {
      notify('warning', '当前密码与新密码都要填。');
      return;
    }
    if (next !== confirm) {
      notify('warning', '两次输入的新密码不一致。');
      return;
    }
    if (await change(current, next)) {
      reset();
      notify('success', '主密码已更换，当前会话已用新密码重新建立。');
      onClose();
    }
  }

  function close() {
    reset();
    onClose();
  }

  return (
    <Modal
      open={open}
      title="修改密码"
      onClose={close}
      footer={
        <>
          <Button onClick={close}>取消</Button>
          <Button variant="primary" onClick={() => void run()} disabled={pending}>
            {pending ? '提交中…' : '保存修改'}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          void run();
        }}
        className="flex flex-col gap-4"
      >
        <PasswordField
          label="当前密码"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          placeholder="输入当前密码"
          autoComplete="off"
        />
        <PasswordField
          label="新密码"
          value={next}
          onChange={(e) => setNext(e.target.value)}
          placeholder="输入新密码"
          autoComplete="off"
        />
        <PasswordField
          label="确认新密码"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          placeholder="再次输入新密码"
          autoComplete="off"
          error={confirm && confirm !== next ? '两次输入的新密码不一致。' : undefined}
        />
        <MasterPasswordHint />
        {errorMessage ? (
          <div className="auth-alert" role="alert">
            <span>{errorMessage}</span>
          </div>
        ) : null}
      </form>
    </Modal>
  );
}
