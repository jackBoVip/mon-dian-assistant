import { useSession } from '../state/session';
import { Button } from './ui/Button';

export interface TopBarProps {
  title: string;
  onOpenLauncher: () => void;
}

/** 顶栏：产品名/当前页/当前使用者/锁定入口。全局快速查找由系统级快捷键唤起独立窗口。 */
export function TopBar({ title, onOpenLauncher }: TopBarProps) {
  const status = useSession((s) => s.status);
  const lock = useSession((s) => s.lock);

  const nickname = status?.nickname ?? '未知';

  return (
    <header className="topbar">
      <h1 className="topbar-title">{title}</h1>
      <div className="topbar-tools">
        <Button variant="ghost" onClick={onOpenLauncher} aria-label="快速启动器设置">
          快速查找
        </Button>
        <span className="user-chip">
          {/* 首字符只是识别用的视觉标记，昵称本身仍以文字完整呈现 */}
          <span aria-hidden className="user-avatar">
            {nickname.slice(0, 1)}
          </span>
          本软件用户：
          <strong>{nickname}</strong>
        </span>
        <Button onClick={() => void lock()}>锁定保险库</Button>
      </div>
    </header>
  );
}
