import type { ReactNode } from 'react';
import { CorpBrand } from './CorpBrand';
import { ThemeSwitch } from './ThemeSwitch';
import { TowerVisual } from './TowerVisual';

export interface AuthShellProps {
  children: ReactNode;
  /**
   * 左栏铁塔下面那一句：说清楚"此刻这台机器处在什么状态"。
   * 默认是首次装机那一句；解锁、密钥降级同意、启动失败各自传自己那条事实。
   */
  note?: string;
}

const DEFAULT_NOTE = '这台机器上要有只属于你的记录。先给它设一道口令——往后每次打开，都由它说了算。';

/**
 * 认证场景外壳：整套场景 + 左上企业标识 + 右上主题切换 + 左品牌栏（标题/铁塔/一句话）+ 右表单栏。
 *
 * 整套界面里只有这里允许"有性格"的视觉表达——这几页是使用者和这台机器唯一一次面对面的握手，
 * 之后的台账、设置、导入导出全部保持安静。底色、两束氛围光、噪点、下划线、滑块、CTA 与铁塔配色
 * 全部来自 tokens.css 的 --scene-*（由当前主题的 --t-* 派生，因此认证页跟着主题一起走；
 * 亮暗两档的染底方向与蒙版深浅各自一组档位，S 轮起没有独立的明暗模式与玻璃强度可调），
 * 并被 themeContrast.test.ts 的场景表逐主题压在 ≥4.5:1。
 *
 * 这一层不含任何判定：是不是首次、能不能建库，由 AuthGate 依据后端状态决定；组件里也不出现色值。
 */
export function AuthShell({ children, note = DEFAULT_NOTE }: AuthShellProps) {
  return (
    // 认证这六屏没有顶栏，而主窗是 titleBarStyle: Overlay（页面伸到标题栏底下）——拖拽区得自己给，
    // 否则首启那几屏连窗口都挪不动。deep 只接管空白处：表单控件、品牌条与右上角切换器都是可点元素，
    // drag.js 遇到它们会直接放弃拖拽。
    <div className="auth-scene" data-tauri-drag-region="deep">
      <div className="auth-bg" aria-hidden />
      <div className="auth-grain" aria-hidden />
      <CorpBrand />
      <ThemeSwitch />
      <div className="auth-layout">
        <section className="auth-hero">
          <h1 className="auth-hero__title">蒙电信产助手</h1>
          <div className="auth-hero__visual">
            <div className="auth-hero__glow" aria-hidden />
            <TowerVisual />
          </div>
          <p className="auth-hero__desc">{note}</p>
        </section>
        <div className="auth-panel">{children}</div>
      </div>
    </div>
  );
}
