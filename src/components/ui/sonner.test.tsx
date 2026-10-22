import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { NotifyHost } from './sonner';
import { useNotify } from '../../state/notify';

/**
 * 提示条的结构契约（2026-10-21：交付方截图点名「右下角的消息弹窗,内容布局都割裂了不够高级」）。
 *
 * 那次的根因不在颜色，在**槽位**：sonner 的 `<li>` 里 DOM 顺序是「关闭 → 图标 → 文案」，
 * 我们那条 `.toast` 又带着 `justify-content: space-between`，三块被摊到三个角上。
 * jsdom 不算层叠也不算布局，所以这里守的是"槽位各自存在、语气只挂在提示条自己身上"；
 * 视觉顺序由 src/styles/toastLayout.test.ts 读 CSS 的 order 三条来守。
 */
afterEach(() => {
  // sonner 的 Toaster 订阅着这份 store，直接 setState 会在 act 之外触发它内部更新
  act(() => useNotify.setState({ items: [] }));
});

describe('提示条', () => {
  it('文案、图标、关闭钮三块都在，语气类挂在提示条自己身上而不是文案', async () => {
    render(<NotifyHost />);
    // 先挂载再入队：NotifyHost 的 effect 只镜像一次，sonner 的 Toaster 已经就位
    act(() => useNotify.getState().push('success', '用户名已复制到剪贴板'));

    const text = await screen.findByText('用户名已复制到剪贴板');
    const toast = text.closest('[data-sonner-toast]');
    expect(toast).not.toBeNull();
    expect(toast).toHaveClass('toast', 'toast-tone-success', 'surface-glass');
    // 徽标那套类会把整句文字染色（.badge-success 就一条 color），提示条只该染图标
    expect(toast).not.toHaveClass('badge-success');

    expect(toast!.querySelector('[data-icon]')).not.toBeNull();
    expect(text.closest('[data-content]')).not.toBeNull();
    const close = toast!.querySelector('[data-close-button]');
    expect(close).not.toBeNull();
    // 关闭钮用本仓库的 X（14px），不是 sonner 自带的 12px 细线版
    expect(close!.querySelector('svg')?.getAttribute('width')).toBe('14');
    // 朗读文案默认是英文（Close toast / Notifications），这一屏是中文
    expect(close!.getAttribute('aria-label')).toBe('关闭提示');
    // 容器名 sonner 会自己接上快捷键提示（"提示 alt+T"），只核前缀是不是中文这一份
    expect(toast!.closest('section')?.getAttribute('aria-label')).toContain('提示');
  });

  it('四档语气各挂各的类，info 不再借用徽标那套', async () => {
    render(<NotifyHost />);
    act(() =>
      useNotify.setState({
        items: [
          { id: 1, kind: 'info', text: '信息' },
          { id: 2, kind: 'warning', text: '警告' },
          { id: 3, kind: 'danger', text: '错误' },
        ],
      }),
    );

    const kinds: Array<[string, string]> = [
      ['信息', 'toast-tone-info'],
      ['警告', 'toast-tone-warning'],
      ['错误', 'toast-tone-danger'],
    ];
    for (const [text, cls] of kinds) {
      const toast = (await screen.findByText(text)).closest('[data-sonner-toast]');
      expect(toast, `${text} 那条没渲染出来`).not.toBeNull();
      expect(toast).toHaveClass(cls);
    }
  });

  it('点关闭钮真的会关掉这条（dismissible:false 会把 onClick 换成空函数）', async () => {
    render(<NotifyHost />);
    act(() => useNotify.getState().push('success', '菜单已启用'));

    const close = (await screen.findByText('菜单已启用'))
      .closest('[data-sonner-toast]')!
      .querySelector<HTMLButtonElement>('[data-close-button]');
    expect(close).not.toBeNull();
    expect(close).toHaveAttribute('aria-label', '关闭提示');

    fireEvent.click(close!);

    // 关闭钮只认 store 这一份真源：删了才算关，DOM 里那截离场动画不归断言管
    expect(useNotify.getState().items).toHaveLength(0);
  });
});
