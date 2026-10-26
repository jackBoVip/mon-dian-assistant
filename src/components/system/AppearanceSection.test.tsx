import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppearanceSection } from './AppearanceSection';
import { useTheme } from '../../state/theme';
import { useNotify } from '../../state/notify';
import type { CustomTheme } from '../../lib/types';

/**
 * 界面外观页：粘贴新增主题这条流。
 *
 * 这一屏最要紧的三件事，逐条钉住：
 *  1. **校验没过就不给存**，且要把不合规的行号与原因逐条列出来（只报"格式错误"等于让人猜）；
 *  2. 存下去的必须是**解析后的令牌对象**，不是用户那串原文（原文里可以有会破坏 CSS 形状的东西）；
 *  3. 删除是两步：第一次点只把「确认删除」问出来，不直接发请求。
 */

const mocks = vi.hoisted(() => ({
  theme: vi.fn(),
  customThemes: vi.fn(),
  addCustomTheme: vi.fn(),
  deleteCustomTheme: vi.fn(),
  setTheme: vi.fn(),
  setReduceMotion: vi.fn(),
}));

vi.mock('../../lib/api', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../lib/api')>();
  return { ...mod, api: { ...mod.api, ...mocks } };
});

/** 一整套合法令牌：从 tokens.css 现取，测试不另抄一份色值。 */
function fullPaste(overrides: Record<string, string> = {}): string {
  const css = readFileSync(join(resolve(process.cwd()), 'src/styles/tokens.css'), 'utf8');
  const block = css.match(/\[data-theme="glass"\]\s*\{([\s\S]*?)\n\}/)?.[1] ?? '';
  const out: Record<string, string> = {};
  for (const line of block.split('\n')) {
    const g = /^\s*(--[\w-]+):\s*(.+?);\s*$/.exec(line);
    if (g) out[g[1]] = g[2];
  }
  return Object.entries({ ...out, ...overrides }).map(([k, v]) => `${k}: ${v};`).join('\n');
}

const SEA: CustomTheme = { id: 'sea', name: '海盐蓝', tokens: JSON.stringify({ '--t-primary': '#0e6ba8', '--t-bg': '#eef4f8' }) };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.theme.mockResolvedValue({ style: 'glass', reduceMotion: false });
  mocks.customThemes.mockResolvedValue([SEA]);
  mocks.addCustomTheme.mockResolvedValue(undefined);
  mocks.deleteCustomTheme.mockResolvedValue(undefined);
  mocks.setTheme.mockResolvedValue(undefined);
  mocks.setReduceMotion.mockResolvedValue(undefined);
  useTheme.setState({ style: 'glass', reduceMotion: false, loaded: true, custom: [SEA] });
  useNotify.setState({ items: [] });
});

function tokensBox() {
  return screen.getByRole('textbox', { name: '设计令牌' });
}

describe('界面外观 · 粘贴新增主题', () => {
  it('不合规的粘贴：逐行报出行号与原因，保存那颗是禁的', () => {
    render(<AppearanceSection />);
    fireEvent.change(screen.getByLabelText('主题名称'), { target: { value: '试一档' } });
    fireEvent.change(tokensBox(), { target: { value: '--t-primary: #0e6ba8;\n--t-nonsense: #fff;\n--t-bg: url(http://x);' } });

    const errors = screen.getByRole('alert', { name: '令牌校验结果' });
    expect(within(errors).getByText(/第 2 行/)).toBeInTheDocument();
    expect(within(errors).getByText(/第 3 行/)).toBeInTheDocument();
    expect(errors.textContent).toContain('不在这套主题的令牌表里');
    expect(screen.getByRole('button', { name: '保存为新主题' })).toBeDisabled();
    expect(mocks.addCustomTheme).not.toHaveBeenCalled();
  });

  it('合规的粘贴：存的是解析后的令牌对象，不是那串原文；存完清空输入并刷新列表', async () => {
    render(<AppearanceSection />);
    fireEvent.change(screen.getByLabelText('主题名称'), { target: { value: '海盐蓝 2' } });
    fireEvent.change(tokensBox(), { target: { value: fullPaste({ '--t-primary': '#0e6ba8', '--t-bg': '#eef4f8' }) } });

    const save = screen.getByRole('button', { name: '保存为新主题' });
    await waitFor(() => expect(save).toBeEnabled());
    fireEvent.click(save);

    await waitFor(() => expect(mocks.addCustomTheme).toHaveBeenCalledTimes(1));
    const [id, name, tokensJson] = mocks.addCustomTheme.mock.calls[0];
    expect(name).toBe('海盐蓝 2');
    expect(String(id)).toMatch(/^t[a-z0-9]{2,}$/);
    const sent = JSON.parse(String(tokensJson)) as Record<string, string>;
    expect(Object.keys(sent)).toHaveLength(32);
    expect(sent['--t-primary']).toBe('#0e6ba8');
    expect(sent['--t-bg']).toBe('#eef4f8');
    // 原文里那些注释、空行、分号都不该被原样带进后端
    expect(String(tokensJson)).not.toContain(';');
    await waitFor(() => expect(tokensBox()).toHaveValue(''));
    expect(mocks.customThemes).toHaveBeenCalledTimes(1); // 只有保存后那一次刷新：这一屏自己不 load（get_theme 归 bootstrap 发）
  });

  it('令牌合规但没起名字：不给存（存进去就是一档叫不出名字的主题）', async () => {
    render(<AppearanceSection />);
    fireEvent.change(tokensBox(), { target: { value: fullPaste({ '--t-primary': '#0e6ba8' }) } });
    const save = screen.getByRole('button', { name: '保存为新主题' });
    expect(save).toBeDisabled();
    expect(mocks.addCustomTheme).not.toHaveBeenCalled();
  });

  it('自定义档与内置四套并排出现在选择区；点它就 set_theme 到 custom-<id>', async () => {
    render(<AppearanceSection />);
    const card = await screen.findByRole('button', { name: /^海盐蓝/ });
    fireEvent.click(card);
    await waitFor(() => expect(mocks.setTheme).toHaveBeenCalledWith('custom-sea'));
  });

  it('删除走两步：第一次只把「确认删除」问出来，第二次才发请求', async () => {
    render(<AppearanceSection />);
    fireEvent.click(await screen.findByRole('button', { name: '删除 海盐蓝' }));
    expect(mocks.deleteCustomTheme).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '确认删除' }));
    await waitFor(() => expect(mocks.deleteCustomTheme).toHaveBeenCalledWith('sea'));
  });

  it('正在用的那档被删掉后回到出厂档，不停在一个没有 CSS 的名字上', async () => {
    useTheme.setState({ style: 'custom-sea' });
    render(<AppearanceSection />);
    fireEvent.click(await screen.findByRole('button', { name: '删除 海盐蓝' }));
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }));
    await waitFor(() => expect(mocks.deleteCustomTheme).toHaveBeenCalled());
    await waitFor(() => expect(useTheme.getState().style).toBe('glass'));
  });
});
