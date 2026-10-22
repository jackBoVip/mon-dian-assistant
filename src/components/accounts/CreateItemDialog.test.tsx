import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { CreateItemDialog } from './CreateItemDialog';
import { AppearanceSection } from '../system/AppearanceSection';
import { useNotify } from '../../state/notify';
import { useTheme } from '../../state/theme';

/**
 * 新增台账凭据的界面行为。锁的是需求 §9.1 里几条只有界面能违反的口径：
 * 首条自动设为默认、后加的不覆盖默认、账号名称必填否则不发请求、
 * 账号名称同时作为登录用户名提交，以及"切主题不丢表单状态"。秘密字段的原文不得进入任何提示文案。
 */

const mocks = vi.hoisted(() => ({
  createItem: vi.fn(),
  theme: vi.fn(),
  setTheme: vi.fn(),
}));

vi.mock('../../lib/api', () => ({
  api: {
    createItem: (input: unknown) => mocks.createItem(input),
    theme: () => mocks.theme(),
    setTheme: (style: string) => mocks.setTheme(style),
  },
  ApiError: class ApiError extends Error {},
  isTauri: () => false,
}));

function renderWithTheme(ui: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  useNotify.setState({ items: [] });
  mocks.createItem.mockReset().mockResolvedValue({ accountAlias: '运维账号' });
  mocks.theme.mockReset().mockResolvedValue({ style: 'glass', reduceMotion: false });
  mocks.setTheme.mockReset().mockResolvedValue(undefined);
  // setState 只改 store，DOM 上的 data-theme 由 apply() 写入——不 apply 就测不到"切主题"真的改了属性
  useTheme.setState({ style: 'glass', reduceMotion: false, loaded: true });
  useTheme.getState().apply();
});

function lastNotify() {
  return useNotify.getState().items.slice(-1)[0];
}

describe('CreateItemDialog 默认账号策略', () => {
  it('目标下还没有凭据时，新凭据预勾"设为默认"', () => {
    renderWithTheme(<CreateItemDialog open targetId="t1" hasExistingItems={false} onClose={vi.fn()} />);
    expect(screen.getByRole('checkbox', { name: /设为我的默认账号/ })).toBeChecked();
  });

  it('目标已有凭据时默认不勾', () => {
    renderWithTheme(<CreateItemDialog open targetId="t1" hasExistingItems onClose={vi.fn()} />);
    expect(screen.getByRole('checkbox', { name: /设为我的默认账号/ })).not.toBeChecked();
  });

  it('提交载荷携带别名、用户名与默认勾选，不夹带已撤掉的选项', async () => {
    renderWithTheme(<CreateItemDialog open targetId="t1" hasExistingItems onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('账号名称'), { target: { value: '  运维账号  ' } });
    fireEvent.click(screen.getByRole('button', { name: '保存账号' }));
    await waitFor(() => expect(mocks.createItem).toHaveBeenCalledTimes(1));
    const input = mocks.createItem.mock.calls[0][0] as Record<string, unknown>;
    expect(input.accountAlias).toBe('运维账号');
    expect(input.username).toBe('运维账号');
    expect(input.setAsDefault).toBe(false);
    expect(input.targetId).toBe('t1');
    expect(input).not.toHaveProperty('confirmBeforeFill');
    expect(input).not.toHaveProperty('token');
  });

  it('账号名称是必填：没填就不发任何请求，并给出可播报的提示', async () => {
    renderWithTheme(<CreateItemDialog open targetId="t1" hasExistingItems={false} onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('登录密码'), { target: { value: 'Sup3r#Secret' } });
    fireEvent.click(screen.getByRole('button', { name: '保存账号' }));
    /* 校验改由 react-hook-form 承担之后，handleSubmit 走的是异步校验，
     * 提示落在一个微任务之后（旧实现是在点击回调里同步发）。这里等到提示出现为止，
     * 而不是把断言放宽：不发请求、提示内容、可播报这三条一条都没少。 */
    await waitFor(() => expect(lastNotify()).toMatchObject({ kind: 'warning', text: '请填写账号名称。' }));
    expect(mocks.createItem).not.toHaveBeenCalled();
  });

  it('失败提示只回后端文案，口令输入框始终保持密态', async () => {
    mocks.createItem.mockRejectedValue(new Error('该目标已停用'));
    renderWithTheme(<CreateItemDialog open targetId="t1" hasExistingItems={false} onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('账号名称'), { target: { value: '运维账号' } });
    fireEvent.change(screen.getByLabelText('登录密码'), { target: { value: 'Sup3r#Secret' } });
    fireEvent.click(screen.getByRole('button', { name: '保存账号' }));
    await waitFor(() => expect(lastNotify()?.kind).toBe('danger'));
    expect(lastNotify()?.text).toBe('该目标已停用');
    expect(screen.getByLabelText('登录密码')).toHaveAttribute('type', 'password');
    // 界面上除了密码框本身（value 不属于 textContent），任何位置都不得出现口令原文
    expect(document.body.textContent).not.toContain('Sup3r#Secret');
  });

  it('保存中按钮进入待定态，成功后关闭对话框', async () => {
    let resolve: (v: unknown) => void = () => {};
    mocks.createItem.mockImplementation(() => new Promise((r) => (resolve = r)));
    const onClose = vi.fn();
    renderWithTheme(<CreateItemDialog open targetId="t1" hasExistingItems={false} onClose={onClose} />);
    fireEvent.change(screen.getByLabelText('账号名称'), { target: { value: '运维账号' } });
    fireEvent.click(screen.getByRole('button', { name: '保存账号' }));
    expect(await screen.findByRole('button', { name: '保存中…' })).toBeDisabled();
    resolve({ accountAlias: '运维账号' });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});

describe('CreateItemDialog 界面只保留必要内容', () => {
  it('只有账号名称、登录密码与默认账号三项', () => {
    renderWithTheme(<CreateItemDialog open targetId="t1" hasExistingItems={false} onClose={vi.fn()} />);
    expect(screen.getByLabelText('账号名称')).toBeInTheDocument();
    expect(screen.getByLabelText('登录密码')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /设为我的默认账号/ })).toBeInTheDocument();
    expect(screen.queryByText(/更多信息/)).toBeNull();
    expect(screen.queryByLabelText('外部系统用户名')).toBeNull();
    expect(screen.queryByRole('checkbox', { name: /每次自动填充前需要确认/ })).toBeNull();
    expect(screen.queryByText(/外部系统的台账账号/)).toBeNull();
    expect(screen.queryByText(/未单独填用户名/)).toBeNull();
    // 泄漏成正文的构建注释不得再出现
    expect(document.body.textContent).not.toContain('noValidate');
  });
});

describe('CreateItemDialog 模态可访问性', () => {
  it('对话框有 dialog 角色、模态语义与可及名称', () => {
    renderWithTheme(<CreateItemDialog open targetId="t1" hasExistingItems={false} onClose={vi.fn()} />);
    const dialog = screen.getByRole('dialog', { name: '添加账号' });
    /**
     * 旧版手写模态自己写了 aria-modal="true"。Radix 换了更强的机制：不把背景标记成
     * aria-modal，而是把背景整棵子树真正 **移出辅助技术树并禁用指针**——
     * 既挡住读屏读到背景，也挡住 tab 走进背景（旧版两处都漏）。
     * 所以这里断言的是"模态"这个事实本身，而不是某一枚属性名。
     */
    expect(dialog).toHaveAttribute('role', 'dialog');
    const hiddenBackground = document.querySelector('body > div[aria-hidden="true"]');
    expect(hiddenBackground, '模态开着时背景必须对辅助技术隐藏').not.toBeNull();
    expect(document.body).toHaveAttribute('data-scroll-locked', '1');
    expect(screen.getByRole('button', { name: '关闭' })).toBeInTheDocument();
  });

  it('Esc 关闭由 onClose 驱动，而不是组件自己吞掉事件', () => {
    const onClose = vi.fn();
    renderWithTheme(<CreateItemDialog open targetId="t1" hasExistingItems={false} onClose={onClose} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('切主题不丢表单状态（§9.1）', () => {
  it('填了内容的表单在切换主题风格后保持全部输入', () => {
    renderWithTheme(
      <>
        <AppearanceSection />
        <CreateItemDialog open targetId="t1" hasExistingItems={false} onClose={vi.fn()} />
      </>,
    );
    fireEvent.change(screen.getByLabelText('账号名称'), { target: { value: '运维账号' } });
    fireEvent.change(screen.getByLabelText('登录密码'), { target: { value: 'Sup3r#Secret' } });

    expect(document.documentElement).toHaveAttribute('data-theme', 'glass');
    /**
     * 原先这里是 `fireEvent.click(getByRole('button', {name:'曜石暗夜'}))`——那颗钮在 AppearanceSection 里，
     * 而模态开着时整片背景被 Radix 移出无障碍树，查不到也点不到（真实浏览器里本来也点不到，遮罩盖着）。
     * 这里改走那颗钮背后的同一个 action：AppearanceSection 的 onClick 就是
     * `useTheme.getState().setStyle(s)`，只改本窗口 + applyTheme，不发 set_theme。
     * 被验的契约（§9.1 切主题不丢表单状态、且切换不顺手落库）一字未减。
     */
    useTheme.getState().setStyle('obsidian');
    expect(document.documentElement).toHaveAttribute('data-theme', 'obsidian');

    expect(screen.getByLabelText('账号名称')).toHaveValue('运维账号');
    expect(screen.getByLabelText('登录密码')).toHaveValue('Sup3r#Secret');
    // 主题切换只改 DOM 属性，不该顺手把选择发到后端（persist 是显式动作）
    expect(mocks.setTheme).not.toHaveBeenCalled();
  });

  it('动效开关同样不动表单内容（明暗第三轴撤了，这条现在走 reduceMotion）', () => {
    renderWithTheme(
      <>
        <AppearanceSection />
        <CreateItemDialog open targetId="t1" hasExistingItems={false} onClose={vi.fn()} />
      </>,
    );
    fireEvent.change(screen.getByLabelText('账号名称'), { target: { value: '只读' } });
    // 同上一条：那颗「减少动态效果」复选框在背景里，模态开着时不可达；走它背后的同一个 action。
    useTheme.getState().setReduceMotion(true);
    expect(document.documentElement).toHaveAttribute('data-reduce-motion', 'true');
    // S 轮起没有 data-mode 这条轴：切到暗夜主题由主题自己带，界面不再单独调明暗
    expect(document.documentElement.hasAttribute('data-mode')).toBe(false);
    expect(screen.getByLabelText('账号名称')).toHaveValue('只读');
  });
});
