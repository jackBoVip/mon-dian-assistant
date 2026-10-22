import { useEffect, useRef, useState } from 'react';
import { useSession } from '../../state/session';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
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
 * 个人信息（原型 #profileModal）：一栏昵称，右上角一支铅笔。
 *
 * 铅笔点下去进编辑态（图标换成对勾、可及名换成「保存昵称」、下划线那档摘掉），
 * 再点一次提交——原型底部没有保存按钮，所以这里也不放第二颗。
 * 存上之后后端回的是整份 AppStatus，顶栏头像首字与使用者下拉第一行读同一个昵称，
 * 所以改完立刻在那两处跟着换，不需要重开窗口。
 */
export function ProfileModal({ open, onClose }: ProfileModalProps) {
  const nickname = useSession((s) => s.status?.nickname ?? '');
  const pending = useSession((s) => s.pending);
  const update = useSession((s) => s.updateNickname);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(nickname);
  const input = useRef<HTMLInputElement>(null);

  // 每次打开都从"只读 + 当前昵称"起步：上次没保存的草稿不该留下一次来
  useEffect(() => {
    if (!open) return;
    setEditing(false);
    setDraft(nickname);
  }, [open, nickname]);

  useEffect(() => {
    if (editing) input.current?.focus();
  }, [editing]);

  async function toggle() {
    if (!editing) {
      setEditing(true);
      return;
    }
    const next = draft.trim();
    if (!next) {
      notify('warning', '昵称不能为空。');
      return;
    }
    if (await update(next)) {
      setEditing(false);
      notify('success', '昵称已更新。');
      return;
    }
    // 没存上就停在编辑态：弹回只读会让人以为已经保存了
    notify('danger', useSession.getState().errorMessage ?? '昵称没有保存成功。');
  }

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
          aria-label={editing ? '保存昵称' : '编辑昵称'}
          title={editing ? '保存' : '编辑'}
          disabled={pending}
          onClick={() => void toggle()}
        >
          <Icon name={editing ? 'check' : 'edit'} size={16} />
        </Button>
      }
    >
      <TextField
        ref={input}
        label="昵称"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        readOnly={!editing}
        aria-readonly={editing ? undefined : true}
        maxLength={NICKNAME_MAX_CHARS}
        className={editing ? undefined : 'input-underline'}
      />
    </Modal>
  );
}
