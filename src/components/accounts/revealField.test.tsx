import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { RevealField } from './RevealField';

/**
 * 「查看明文」的响应世代。审查 F6：这一格是复用组件（切换条目/字段时不重挂），
 * 而 reveal 是异步的 —— 没有世代守卫时，迟到的那一份明文会被写进**已经换掉的**那一格
 * 并重新起表，界面上显示的就是另一条凭据的秘密。组件自己的注释承诺"切换即清除"，
 * 这条测试就是把那句承诺钉住。
 */
const mocks = vi.hoisted(() => ({ revealSecret: vi.fn() }));

vi.mock('../../lib/api', () => ({
  api: { revealSecret: (id: string, field: string) => mocks.revealSecret(id, field) },
  ApiError: class ApiError extends Error {},
  isTauri: () => false,
}));

const HAS = { password: true, token: true, privateKey: false };

function renderAt(itemId: string): { rerender: (ui: ReactNode) => void } {
  return render(<RevealField itemId={itemId} has={HAS} />);
}

beforeEach(() => {
  mocks.revealSecret.mockReset();
});

describe('RevealField 的迟到响应', () => {
  it('请求在途时切到别的条目，旧明文不得落到新格子里', async () => {
    let settle!: (v: { value: string; visibleSeconds: number }) => void;
    mocks.revealSecret.mockReturnValue(
      new Promise((r) => {
        settle = r;
      }),
    );

    const view = renderAt('item-1');
    fireEvent.click(screen.getByRole('button', { name: /查看明文/ }));
    await waitFor(() => expect(mocks.revealSecret).toHaveBeenCalledTimes(1));

    // 换条目：clear() 应当顺手把在途的那次请求作废
    view.rerender(<RevealField itemId="item-2" has={HAS} />);

    settle({ value: 'SECRETPWD-of-item-1', visibleSeconds: 10 });
    await Promise.resolve();
    await Promise.resolve();

    expect(document.body.textContent).not.toContain('SECRETPWD-of-item-1');
    // 仍然是"没在显示明文"的那个形态：一颗可点的查看钮，而不是带倒计时的明文条
    expect(screen.getByRole('button', { name: /查看明文/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '立即隐藏' })).toBeNull();
  });

  it('同一条目、请求正常返回时照常显示明文并起表', async () => {
    mocks.revealSecret.mockResolvedValue({ value: 'p@ss', visibleSeconds: 10 });
    renderAt('item-1');
    fireEvent.click(screen.getByRole('button', { name: /查看明文/ }));
    expect(await screen.findByText('p@ss')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '立即隐藏' })).toBeInTheDocument();
  });

  it('reveal 失败后按钮必须可重试，不能永久禁用', async () => {
    // catch 里的 clear() 会推进 reqSeq；若 busy 复位只挂在 finally 的世代守卫上，
    // 失败一次后守卫恒不成立，按钮就再也点不动了（AUDIT-1026 新发现，不在 10-19 的 F 系列里）。
    mocks.revealSecret.mockRejectedValueOnce(
      Object.assign(new Error('需要二次认证'), { code: 'REAUTH_REQUIRED' }),
    );
    renderAt('item-1');

    fireEvent.click(screen.getByRole('button', { name: /查看明文/ }));
    await waitFor(() => expect(mocks.revealSecret).toHaveBeenCalledTimes(1));
    // busy 落盘要等微任务，findByRole 自带轮询；失败后若 busy 卡住，这里会超时
    expect(await screen.findByRole('button', { name: /查看明文/ })).toBeEnabled();

    mocks.revealSecret.mockResolvedValue({ value: 'p@ss2', visibleSeconds: 10 });
    const retry = screen.getByRole('button', { name: /查看明文/ });
    expect(retry).toBeEnabled();
    fireEvent.click(retry);
    expect(await screen.findByText('p@ss2')).toBeInTheDocument();
  });
});

async function waitFor(fn: () => void) {
  for (let i = 0; i < 20; i++) {
    try {
      fn();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  fn();
}
