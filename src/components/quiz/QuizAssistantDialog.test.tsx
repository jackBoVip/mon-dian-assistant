import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi } from 'vitest';
import { QuizAssistantDialog } from './QuizAssistantDialog';
import type { QuizAssistantStatus } from '../../lib/types';
import { useNotify } from '../../state/notify';

const mocks = vi.hoisted(() => ({
  quizAssistantStatus: vi.fn(),
  quizLibraries: vi.fn(),
  quizAssistantStart: vi.fn(),
  quizAssistantStop: vi.fn(),
  quizAssistantSetPreferences: vi.fn(),
  quizRequestScreenPermission: vi.fn(),
  quizLookupAtCursor: vi.fn(),
  quizMatchText: vi.fn(),
}));

vi.mock('../../lib/api', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../lib/api')>();
  return { ...mod, api: { ...mod.api, ...mocks } };
});

function status(over: Partial<QuizAssistantStatus> = {}): QuizAssistantStatus {
  return {
    running: false,
    preferences: {
      enabled: false,
      scopeMode: 'all',
      dwellMs: 520,
      hotkey: 'Cmd+Alt+Q',
      showOptions: true,
      libraryIds: [],
    },
    ocr: { state: 'idle', detail: null, modelDir: null },
    screen: { supported: true, permission: 'granted', detail: null },
    detail: null,
    ...over,
  };
}

function renderDialog(onClose = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(
    <QueryClientProvider client={qc}>
      <QuizAssistantDialog onClose={onClose} />
    </QueryClientProvider>,
  );
  return onClose;
}

const notifications = () => useNotify.getState().items.map((i) => i.text).join(' ');

/** 状态没读回来之前开关是空的（快捷键框还是空的）：等它填上再点，才是在点一份真实的开关。 */
async function readySwitch() {
  await screen.findByDisplayValue('Cmd+Alt+Q');
  return screen.findByRole('switch', { name: '启用悬停自动识别' });
}

beforeEach(() => {
  for (const fn of Object.values(mocks)) fn.mockReset();
  mocks.quizAssistantStatus.mockResolvedValue(status());
  mocks.quizLibraries.mockResolvedValue([]);
  mocks.quizAssistantStart.mockResolvedValue(status({ running: true }));
  mocks.quizAssistantStop.mockResolvedValue(status());
  mocks.quizAssistantSetPreferences.mockResolvedValue(status().preferences);
  mocks.quizRequestScreenPermission.mockResolvedValue({ supported: true, permission: 'denied', detail: null });
  useNotify.setState({ items: [] });
});

describe('答题助手弹窗：启用那颗开关', () => {
  /// 原来这里是一枚「未启用」徽标：它不表达可点，交付方因此找不到开关（2026-10-29 的意见）。
  it('头部是开关本身，文字写在开关里，不再摆一枚只读的「未启用」徽标', async () => {
    renderDialog();
    const sw = await readySwitch();
    expect(sw).toHaveAttribute('aria-checked', 'false');
    expect(sw).toHaveTextContent('关闭');
    expect(screen.queryByText('未启用')).not.toBeInTheDocument();
  });

  it('已授权时拨到启用真的去起悬停线程', async () => {
    renderDialog();
    fireEvent.click(await readySwitch());
    await waitFor(() => expect(mocks.quizAssistantStart).toHaveBeenCalled());
    expect(mocks.quizRequestScreenPermission).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByRole('switch', { name: '启用悬停自动识别' })).toHaveAttribute('aria-checked', 'true'),
    );
    expect(screen.getByRole('switch', { name: '启用悬停自动识别' })).toHaveTextContent('启用');
  });

  /// 权限没给时不再把开关禁掉：拨它就去向系统申请，并把「重启才生效」这句一起说清。
  it('未授权时拨开关直接向系统申请权限，不去起线程', async () => {
    mocks.quizAssistantStatus.mockResolvedValue(
      status({ screen: { supported: true, permission: 'denied', detail: null } }),
    );
    renderDialog();
    fireEvent.click(await readySwitch());
    await waitFor(() => expect(mocks.quizRequestScreenPermission).toHaveBeenCalled());
    expect(mocks.quizAssistantStart).not.toHaveBeenCalled();
    await waitFor(() => expect(notifications()).toContain('屏幕录制'));
    expect(notifications()).toContain('重开');
  });

  it('运行中拨回关闭调停用命令', async () => {
    mocks.quizAssistantStatus.mockResolvedValue(status({ running: true }));
    renderDialog();
    const sw = await readySwitch();
    expect(sw).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(sw);
    await waitFor(() => expect(mocks.quizAssistantStop).toHaveBeenCalled());
  });

  /// 引擎不可用也不静默吞掉：把后端那句诊断原样回话，并重新取一次状态。
  it('引擎不可用时拨动不开启，只把原因说出来', async () => {
    mocks.quizAssistantStatus.mockResolvedValue(
      status({ ocr: { state: 'failed', detail: '模型文件缺失', modelDir: null } }),
    );
    renderDialog();
    fireEvent.click(await readySwitch());
    await waitFor(() => expect(notifications()).toContain('模型文件缺失'));
    expect(mocks.quizAssistantStart).not.toHaveBeenCalled();
  });
});
