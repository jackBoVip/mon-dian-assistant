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
 * 首条自动设为默认、后加的不覆盖默认、填充前确认出厂为开、账号名称必填否则不发请求，
 * 以及"切主题不丢表单状态"。秘密字段的原文不得进入任何提示文案。
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

describe('CreateItemDialog 默认账号与确认策略', () => {
  it('目标下还没有凭据时，新凭据预勾"设为默认"', () => {
    renderWithTheme(<CreateItemDialog open targetId="t1" hasExistingItems={false} onClose={vi.fn()} />);
    expect(screen.getByRole('checkbox', { name: /设为我的默认账号/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /每次自动填充前需要确认/ })).toBeChecked();
    expect(screen.queryByText(/不会覆盖/)).toBeNull();
  });

  it('目标已有凭据时默认不勾，并说明不会覆盖现有默认账号', () => {
    renderWithTheme(<CreateItemDialog open targetId="t1" hasExistingItems onClose={vi.fn()} />);
    expect(screen.getByRole('checkbox', { name: /设为我的默认账号/ })).not.toBeChecked();
    expect(screen.getByText(/不会覆盖/)).toBeInTheDocument();
  });

  it('提交载荷如实携带两个勾选状态：默认关闭确认必须显式取消勾选', async () => {
    renderWithTheme(<CreateItemDialog open targetId="t1" hasExistingItems onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('账号名称'), { target: { value: '  运维账号  ' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /每次自动填充前需要确认/ }));
    fireEvent.click(screen.getByRole('button', { name: '保存账号' }));
    await waitFor(() => expect(mocks.createItem).toHaveBeenCalledTimes(1));
    const input = mocks.createItem.mock.calls[0][0] as Record<string, unknown>;
    expect(input.accountAlias).toBe('运维账号');
    // 只有显式取消勾选才允许免确认填充
    expect(input.confirmBeforeFill).toBe(false);
    expect(input.setAsDefault).toBe(false);
    expect(input.targetId).toBe('t1');
  });

  it('账号名称是必填：没填就不发任何请求，并给出可播报的提示', () => {
    renderWithTheme(<CreateItemDialog open targetId="t1" hasExistingItems={false} onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('登录密码'), { target: { value: 'Sup3r#Secret' } });
    fireEvent.click(screen.getByRole('button', { name: '保存账号' }));
    expect(mocks.createItem).not.toHaveBeenCalled();
    expect(lastNotify()).toMatchObject({ kind: 'warning', text: '请填写账号名称。' });
  });

  it('账号名称在未展开「更多信息」时也照样提交为用户名：填充链路拿的是 payload.username', async () => {
    renderWithTheme(<CreateItemDialog open targetId="t1" hasExistingItems={false} onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('账号名称'), { target: { value: 'zhangsan' } });
    fireEvent.change(screen.getByLabelText('登录密码'), { target: { value: 'Sup3r#Secret' } });
    fireEvent.click(screen.getByRole('button', { name: '保存账号' }));
    await waitFor(() => expect(mocks.createItem).toHaveBeenCalledTimes(1));
    const input = mocks.createItem.mock.calls[0][0] as Record<string, unknown>;
    expect(input.accountAlias).toBe('zhangsan');
    expect(input.username).toBe('zhangsan');
  });

  it('「更多信息」里填了用户名时以它为准，账号名称只作别名', async () => {
    renderWithTheme(<CreateItemDialog open targetId="t1" hasExistingItems={false} onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('账号名称'), { target: { value: '只读账号' } });
    fireEvent.change(screen.getByLabelText('外部系统用户名'), { target: { value: 'readonly' } });
    fireEvent.click(screen.getByRole('button', { name: '保存账号' }));
    await waitFor(() => expect(mocks.createItem).toHaveBeenCalledTimes(1));
    const input = mocks.createItem.mock.calls[0][0] as Record<string, unknown>;
    expect(input.accountAlias).toBe('只读账号');
    expect(input.username).toBe('readonly');
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

describe('CreateItemDialog 模态可访问性', () => {
  it('对话框有 dialog 角色、aria-modal 与可及名称', () => {
    renderWithTheme(<CreateItemDialog open targetId="t1" hasExistingItems={false} onClose={vi.fn()} />);
    const dialog = screen.getByRole('dialog', { name: '添加账号' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByRole('button', { name: '关闭' })).toBeInTheDocument();
  });

  it('Esc 关闭由 onClose 驱动，而不是组件自己吞掉事件', () => {
    const onClose = vi.fn();
    renderWithTheme(<CreateItemDialog open targetId="t1" hasExistingItems={false} onClose={onClose} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('台账账号与本软件身份在界面上明确分开', () => {
    renderWithTheme(<CreateItemDialog open targetId="t1" hasExistingItems={false} onClose={vi.fn()} />);
    expect(screen.getByText(/外部系统的台账账号/)).toBeInTheDocument();
    expect(screen.getByLabelText('外部系统用户名')).toBeInTheDocument();
    // 不出现"主密码"字样，避免把台账口令误当成本机解锁密码
    expect(screen.queryByLabelText(/主密码/)).toBeNull();
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
    fireEvent.change(screen.getByLabelText('外部系统用户名'), { target: { value: 'root' } });
    fireEvent.change(screen.getByLabelText('登录密码'), { target: { value: 'Sup3r#Secret' } });
    fireEvent.change(screen.getByLabelText('标签（逗号分隔）'), { target: { value: '内网,生产' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /每次自动填充前需要确认/ }));

    expect(document.documentElement).toHaveAttribute('data-theme', 'glass');
    fireEvent.click(screen.getByRole('button', { name: '曜石暗夜' }));
    expect(document.documentElement).toHaveAttribute('data-theme', 'obsidian');

    expect(screen.getByLabelText('账号名称')).toHaveValue('运维账号');
    expect(screen.getByLabelText('外部系统用户名')).toHaveValue('root');
    expect(screen.getByLabelText('登录密码')).toHaveValue('Sup3r#Secret');
    expect(screen.getByLabelText('标签（逗号分隔）')).toHaveValue('内网,生产');
    expect(screen.getByRole('checkbox', { name: /每次自动填充前需要确认/ })).not.toBeChecked();
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
    fireEvent.click(screen.getByRole('checkbox', { name: '减少动态效果' }));
    expect(document.documentElement).toHaveAttribute('data-reduce-motion', 'true');
    // S 轮起没有 data-mode 这条轴：切到暗夜主题由主题自己带，界面不再单独调明暗
    expect(document.documentElement.hasAttribute('data-mode')).toBe(false);
    expect(screen.getByLabelText('账号名称')).toHaveValue('只读');
  });
});
