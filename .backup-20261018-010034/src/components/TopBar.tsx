import { useSession } from '../state/session';
import { useShell } from '../state/shell';
import { useShellSearch } from '../state/shellSearch';
import { ThemeMenu } from './ThemeMenu';
import { Button } from './ui/Button';
import { Icon } from './ui/Icon';

/**
 * 顶栏（工具条）：侧栏开合 / 台账搜索 / 锁定保险库 / 主题菜单 / 当前使用者。
 *
 * 页面标题不再挂在这里——各页用 PageHeader 自带。
 * 「快速查找」那颗按钮也没了：它原本只是导航到启动器设置页，而那个入口在侧栏「设置」分组里，
 * 真正的浮层唤起仍由系统级全局快捷键负责。稿在这里放的是搜索框，接的是台账 keyword 过滤。
 */
export function TopBar() {
  const nickname = useSession((s) => s.status?.nickname ?? '未知');
  const lock = useSession((s) => s.lock);
  const collapsed = useShell((s) => s.collapsed);
  const toggleCollapsed = useShell((s) => s.toggleCollapsed);
  const keyword = useShellSearch((s) => s.keyword);
  const setKeyword = useShellSearch((s) => s.setKeyword);

  return (
    <header className="topbar">
      <div className="topbar-left">
        <Button
          variant="ghost"
          aria-label={collapsed ? '展开侧栏' : '收起侧栏'}
          aria-expanded={!collapsed}
          aria-controls="app-sidebar"
          title={collapsed ? '展开侧栏' : '收起侧栏'}
          onClick={toggleCollapsed}
        >
          <Icon name="panel" />
        </Button>
      </div>

      <div className="topbar-right">
        {/* 展开靠 CSS :focus-within；有值时再挂一个 --filled，失焦也不缩回去——
            纯 CSS 读不到 value，清空前总得让关键字看得见。不学稿里那段 JS 改宽度。
            外层必须是 label：收起态这 36px 里输入框本体只剩 2px（图标 14px + 左右各 10px padding），
            div 的话鼠标点不到它，而展开靠 :focus-within——点不着就等于搜索框不能用。
            label 的原生激活行为把点框内任意一处换成聚焦，仍不需要 JS。 */}
        <label className={keyword ? 'topbar-search topbar-search--filled' : 'topbar-search'}>
          <span className="topbar-search-icon" aria-hidden>
            <Icon name="search" size={14} />
          </span>
          <input
            type="text"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="搜索系统、账号…"
            aria-label="搜索系统与账号台账"
          />
        </label>

        <Button variant="ghost" aria-label="锁定保险库" title="锁定保险库" onClick={() => void lock()}>
          <Icon name="lock" />
        </Button>

        <ThemeMenu />

        <span className="topbar-divider" aria-hidden />

        <div className="user-profile">
          {/* 这里只放昵称。「本软件用户 / 台账账号 / 主密码」这层身份区分由认证页的 TermHints
              与侧栏 brand-sub「本地凭据保险库」承担，不靠顶栏这半句话。 */}
          <span className="user-profile-name">{nickname}</span>
          {/* 首字符只是识别用的视觉标记，昵称本身仍以文字完整呈现 */}
          <span aria-hidden className="user-avatar">
            {nickname.slice(0, 1)}
          </span>
        </div>
      </div>
    </header>
  );
}
