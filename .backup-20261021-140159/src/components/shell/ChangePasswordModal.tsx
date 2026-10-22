import { useId } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useSession } from '../../state/session';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { Form, FormShell } from '../ui/form';
import { PasswordField } from '../ui/PasswordField';
import { MasterPasswordHint } from '../auth/TermHints';
import { notify } from '../../state/notify';

export interface ChangePasswordModalProps {
  open: boolean;
  onClose: () => void;
}

/**
 * 两条闸门交给 zod：必填与"两次输入一致"这条交叉规则（原先是手写的 === 比较）。
 * 文案与重构前逐字相同。
 */
const schema = z
  .object({
    current: z.string().min(1, '当前密码与新密码都要填。'),
    next: z.string().min(1, '当前密码与新密码都要填。'),
    confirm: z.string(),
  })
  .refine((v) => v.next === v.confirm, {
    message: '两次输入的新密码不一致。',
    path: ['confirm'],
  });

type FormValues = z.input<typeof schema>;

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
  const formId = useId();
  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { current: '', next: '', confirm: '' },
  });
  /* 确认栏那条"边打字边比"的实时错误要保住：zod 只在提交时判定，所以这一档仍由 watch 的值现算，
   * 不是由 formState.errors 给（后者在 mode=onSubmit 下要点过提交才亮）。 */
  const [watchedNext, watchedConfirm] = useWatch({ control: form.control, name: ['next', 'confirm'] });

  const run = form.handleSubmit(
    async (v) => {
      if (await change(v.current, v.next)) {
        form.reset();
        notify('success', '主密码已更换，当前会话已用新密码重新建立。');
        onClose();
      }
    },
    (errors) => {
      const first = Object.values(errors)[0];
      notify('warning', typeof first?.message === 'string' ? first.message : '请检查填写内容。');
    },
  );

  function close() {
    form.reset();
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
          <Button type="submit" form={formId} variant="primary" disabled={pending}>
            {pending ? '提交中…' : '保存修改'}
          </Button>
        </>
      }
    >
      <Form form={form}>
        <FormShell id={formId} noValidate onSubmit={() => void run()} className="flex flex-col gap-4">
          <PasswordField label="当前密码" placeholder="输入当前密码" autoComplete="off" {...form.register('current')} />
          <PasswordField label="新密码" placeholder="输入新密码" autoComplete="off" {...form.register('next')} />
          <PasswordField
            label="确认新密码"
            placeholder="再次输入新密码"
            autoComplete="off"
            error={watchedConfirm && watchedConfirm !== watchedNext ? '两次输入的新密码不一致。' : undefined}
            {...form.register('confirm')}
          />
          <MasterPasswordHint />
          {errorMessage ? (
            <div className="auth-alert" role="alert">
              <span>{errorMessage}</span>
            </div>
          ) : null}
        </FormShell>
      </Form>
    </Modal>
  );
}
