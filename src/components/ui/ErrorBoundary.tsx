import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Button } from './Button';
import { ErrorState } from './StateBlocks';

interface Props {
  children: ReactNode;
  /** 重新渲染一次（例如把出错的弹窗关掉再打开）时用它清状态。 */
  onReset?: () => void;
}

interface State {
  error: unknown;
}

/**
 * 根级错误边界。
 *
 * React 19 在没有边界时，任何一个组件在渲染期抛错都会把**整棵树**卸载，`#root` 变成空节点——
 * 用户看到的就是整页空白，而且没有任何线索说明是哪里坏了（2026-11-20「账号中心 → 修改目标系统」
 * 那起事故的第二层放大器：第一层是后端回来的字段名对不上，这一层让它可以只坏一格而不是坏整页）。
 *
 * 三个窗口入口（主窗 / 快捷启动浮层 / 答题浮层）各包一层；边界只负责"降级 + 留痕"，
 * 不猜原因、不伪造数据，文案完全交给 `ErrorState` 那套后端错误呈现口径。
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo) {
    // 抛错必须留下痕迹：白屏最难查的地方就是它什么都不说。
    console.error('[ErrorBoundary] 渲染期抛错', error, info?.componentStack);
  }

  private reset = () => {
    this.setState({ error: null });
    this.props.onReset?.();
  };

  override render() {
    if (this.state.error) {
      return (
        <div className="mx-auto mt-16 max-w-md p-4">
          <ErrorState raw={this.state.error} />
          <p className="mt-3 text-xs text-ink-muted">
            这一块的界面渲染中断了。其余功能不受影响；如果反复出现，请把这一段报错内容记下来反馈。
          </p>
          <div className="mt-3">
            <Button onClick={this.reset}>重试</Button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
