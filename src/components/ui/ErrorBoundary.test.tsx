import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { ErrorBoundary } from './ErrorBoundary';

/** 渲染期抛错的子树：与"effect 里抛错"不同，只有渲染期的抛错会走到边界这条路上。 */
function Boom({ message = '炸了' }: { message?: string }): ReactElement {
  throw new TypeError(`Cannot read properties of undefined (reading 'trim')：${message}`);
}

afterEach(() => vi.restoreAllMocks());

describe('根级错误边界（2026-11-20 白屏事故的第二层）', () => {
  it('子树渲染抛错时降级成错误块，而不是把整棵树卸载成空白', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { container } = render(
      <ErrorBoundary>
        <div>
          <span>旁边的正常内容</span>
          <Boom />
        </div>
      </ErrorBoundary>,
    );

    // 白屏的定义就是容器里什么都不剩
    expect(container.textContent ?? '', '兜底 UI 必须落在 DOM 里').not.toBe('');
    expect(screen.getByRole('button', { name: '重试' })).toBeTruthy();
    expect(container.textContent).toContain('渲染中断');
    expect(spy, '抛错要留下痕迹，否则现场无从可查').toHaveBeenCalled();
  });

  it('没有抛错时一个字节都不额外渲染，children 原样透过', () => {
    render(
      <ErrorBoundary>
        <p>正常内容</p>
      </ErrorBoundary>,
    );
    expect(screen.getByText('正常内容')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '重试' })).toBeNull();
  });

  it('边界只兜它下面的子树：外层内容不受影响', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <div>
        <span>外层还在</span>
        <ErrorBoundary>
          <Boom />
        </ErrorBoundary>
      </div>,
    );
    expect(screen.getByText('外层还在')).toBeTruthy();
  });
});
