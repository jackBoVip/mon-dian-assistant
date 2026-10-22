import { useEffect, useId, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useSession } from '../../state/session';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { Form, FormShell } from '../ui/form';
import { TextField } from '../ui/Field';
import { notify } from '../../state/notify';

export interface ProfileModalProps {
  open: boolean;
  onClose: () => void;
}

/** 与 Rust 侧 `auth::users::NICKNAME_MAX_CHARS` 同一档：输入框按这个数封顶，
 * 免得打出去一条注定被后端拒掉的请求。真超了仍由后端判定，这里只是第一道。 */
const NICKNAME_MAX_CHARS = 40;

/**
 * 只把"非空"这一条交给 zod（提示文案与重构前逐字相同）。
 * 上限 40 故意**不进 schema**：maxLength 已经在 DOM 层挡住输入与粘贴，schema 里那条永远走不到，
 * 为它配一句界面提示等于许诺一条不会生效的话；真超了由后端判定。
 * 判空口径与重构前一致，只是换了地方：原来是 `draft.trim()` 后手工比空，
 * 现在 `.trim()` 去首尾空白再 `.min(1)` 拦——纯空格同样发不出请求，
 * 且 resolver 交出来的已是去空白的值，提交路径不需要第二道 trim。
 */
const schema = z.object({ nickname: z.string().trim().min(1, '昵称不能为空。') });

type FormValues = z.input<typeof schema>;

/**
 * 个人信息（原型 #profileModal）：一栏昵称，右上角一支铅笔。
 *
 * 铅笔点下去进编辑态（图标换成对勾、可及名换成「保存昵称」、下划线那档摘掉），
 * 再点一次提交——原型底部没有保存按钮，所以这里也不放第二颗。
 * 存上之后后端回的是整份 AppStatus，顶栏头像首字与使用者下拉第一行读同一个昵称，
 * 所以改完立刻在那两处跟着换，不需要重开窗口。
 *
 * 只读 ⇄ 编辑这台状态机、以及"没存上就停在编辑态"仍归本组件，不是表单层的关注点。
 */
export function ProfileModal({ open, onClose }: ProfileModalProps) {
  const nickname = useSession((s) => s.status?.nickname ?? '');
  const pending = useSession((s) => s.pending);
  const update = useSession((s) => s.updateNickname);
  const [editing, setEditing] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const formId = useId();
  const form = useForm<FormValues>({ resolver: zodResolver(schema), defaultValues: { nickname: '' } });

  // 每次打开都从"只读 + 当前昵称"起步：上次没保存的草稿不该留下一次来
  useEffect(() => {
    if (!open) return;
    setEditing(false);
    form.reset({ nickname });
  }, [open, nickname, form]);

  useEffect(() => {
    if (editing) input.current?.focus();
  }, [editing]);

  const save = form.handleSubmit(
    async (v) => {
      if (await update(v.nickname)) {
        setEditing(false);
        notify('success', '昵称已更新。');
        return;
      }
      // 没存上就停在编辑态：弹回只读会让人以为已经保存了
      notify('danger', useSession.getState().errorMessage ?? '昵称没有保存成功。');
    },
    () => notify('warning', '昵称不能为空。'),
  );

  /** 铅笔一颗钮两件事：非编辑态是"进入编辑"，编辑态才是"提交"。
   *  只靠 type=submit + form 关联触发这一个入口，不再叠 onClick——
   *  否则点一次会走两遍（点击回调 + 原生提交）。 */
  function toggle() {
    if (!editing) {
      setEditing(true);
      return;
    }
    void save();
  }

  const nicknameField = form.register('nickname');

  return (
    <Modal
      open={open}
      title="个人信息"
      onClose={onClose}
      headerActions={
        <Button
          variant="ghost"
          className="btn-icon-action"
          data-editing={editing || undefined}
          type="submit"
          form={formId}
          aria-label={editing ? '保存昵称' : '编辑昵称'}
          title={editing ? '保存' : '编辑'}
          disabled={pending}
        >
          <Icon name={editing ? 'check' : 'edit'} size={16} />
        </Button>
      }
    >
      <Form form={form}>
        <FormShell id={formId} noValidate onSubmit={toggle}>
          <TextField
            label="昵称"
            readOnly={!editing}
            aria-readonly={editing ? undefined : true}
            maxLength={NICKNAME_MAX_CHARS}
            {...nicknameField}
            ref={(el) => {
              // register 也要这个节点（RHF 靠它读值），这里只是额外留一份给"进编辑态就聚焦"
              input.current = el;
              nicknameField.ref(el);
            }}
          />
        </FormShell>
      </Form>
    </Modal>
  );
}
