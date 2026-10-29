import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi } from 'vitest';
import { QuizPage } from './QuizPage';
import type { QuizLibraryRow } from '../lib/types';
import { PERM } from '../lib/permissions';
import { useNotify } from '../state/notify';

const mocks = vi.hoisted(() => ({
  myPermissions: vi.fn(),
  quizLibraries: vi.fn(),
  quizRenameLibrary: vi.fn(),
  quizDeleteLibrary: vi.fn(),
  quizReindex: vi.fn(),
  quizAssistantStatus: vi.fn(),
  quizScreenPermission: vi.fn(),
}));

vi.mock('../lib/api', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../lib/api')>();
  return { ...mod, api: { ...mod.api, ...mocks } };
});

function library(over: Partial<QuizLibraryRow> = {}): QuizLibraryRow {
  return {
    id: 'lib-1',
    name: '2025 检修题库',
    sourceFormat: 'csv',
    sourceFilename: '检修.csv',
    questionCount: 128,
    createdAt: '2026-10-20T08:00:00.000Z',
    updatedAt: '2026-10-21T09:30:00.000Z',
    ...over,
  };
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={qc}>
      <QuizPage />
    </QueryClientProvider>,
  );
}

const ALL_PERMS = [
  PERM.MENU_TOP_QUIZ,
  PERM.QUIZ_LIBRARY_READ,
  PERM.QUIZ_LIBRARY_IMPORT,
  PERM.QUIZ_LIBRARY_MANAGE,
  PERM.QUIZ_ASSISTANT_USE,
];

function assistantStatus() {
  return {
    running: false,
    preferences: {
      enabled: true,
      scopeMode: 'all' as const,
      dwellMs: 520,
      hotkey: 'Cmd+Alt+Q',
      showOptions: true,
      libraryIds: [],
    },
    ocr: { state: 'ready' as const, detail: null, modelDir: null },
    screen: { supported: true, permission: 'granted' as const, detail: null },
    detail: null,
  };
}

beforeEach(() => {
  for (const fn of Object.values(mocks)) fn.mockReset();
  mocks.myPermissions.mockResolvedValue(ALL_PERMS);
  mocks.quizLibraries.mockResolvedValue([library()]);
  mocks.quizRenameLibrary.mockResolvedValue(library({ name: '2026 检修题库' }));
  mocks.quizDeleteLibrary.mockResolvedValue(undefined);
  mocks.quizReindex.mockResolvedValue(128);
  mocks.quizAssistantStatus.mockResolvedValue(assistantStatus());
  mocks.quizScreenPermission.mockResolvedValue({ supported: true, permission: 'granted', detail: null });
  useNotify.setState({ items: [] });
});

describe('题库页的台账与权限裁剪', () => {
  it('整屏一枚 h1；题库行显示名称、格式、题数与来源文件', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { level: 1, name: '题库' })).toBeInTheDocument();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(await screen.findByText('2025 检修题库')).toBeInTheDocument();
    expect(screen.getByText('CSV')).toBeInTheDocument();
    expect(screen.getByText('128')).toBeInTheDocument();
    expect(screen.getByText('检修.csv')).toBeInTheDocument();
  });

  it('有导入权限时页头出现主操作', async () => {
    renderPage();
    expect(await screen.findByRole('button', { name: '导入题库' })).toBeInTheDocument();
  });

  /// 交付方 2026-10-29：页头两颗字钮改成纯图标。图标没有可见文字，所以 aria-label 与 title
  /// 必须都在——读屏与鼠标悬停各靠一个。
  it('页头动作是纯图标：无可见文字，但 aria-label 与 title 都在', async () => {
    renderPage();
    const importBtn = await screen.findByRole('button', { name: '导入题库' });
    expect(importBtn).toHaveTextContent('');
    expect(importBtn).toHaveClass('icon-btn');
    expect(importBtn).toHaveAttribute('title', expect.stringContaining('导入题库'));

    const reindexBtn = screen.getByRole('button', { name: '重建检索索引' });
    expect(reindexBtn).toHaveTextContent('');
    expect(reindexBtn).toHaveClass('icon-btn');
    expect(reindexBtn).toHaveAttribute('title', expect.stringContaining('重建检索索引'));
  });

  /// 答题助手原来常驻在题库表下方；现在页头只留一枚图标，内容在弹窗里。
  it('答题助手由图标开弹窗，关掉后内容随之卸载', async () => {
    renderPage();
    await screen.findByText('2025 检修题库');
    expect(screen.queryByText('悬停自动识别')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '答题助手' }));
    const dialog = await screen.findByRole('dialog', { name: '答题助手' });
    expect(dialog).toBeInTheDocument();
    expect(await screen.findByText('悬停自动识别')).toBeInTheDocument();
    expect(mocks.quizAssistantStatus).toHaveBeenCalled();

    // 标题栏那颗 X 与页脚那颗都叫「关闭」，取页脚那一颗（DOM 里在后）。
    const closes = screen.getAllByRole('button', { name: '关闭' });
    fireEvent.click(closes[closes.length - 1]);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '答题助手' })).not.toBeInTheDocument());
  });

  it('没有答题助手权限时页头没有这枚图标', async () => {
    mocks.myPermissions.mockResolvedValue([PERM.MENU_TOP_QUIZ, PERM.QUIZ_LIBRARY_READ]);
    renderPage();
    await screen.findByText('2025 检修题库');
    expect(screen.queryByRole('button', { name: '答题助手' })).not.toBeInTheDocument();
  });

  it('没有导入权限时换成说明，而不是留一颗点了必然被拒的钮', async () => {
    mocks.myPermissions.mockResolvedValue([PERM.MENU_TOP_QUIZ, PERM.QUIZ_LIBRARY_READ]);
    renderPage();
    await screen.findByText('2025 检修题库');
    expect(screen.queryByRole('button', { name: '导入题库' })).not.toBeInTheDocument();
    expect(screen.getByText(/quiz\.library\.import/)).toBeInTheDocument();
  });

  it('重命名走命令并带上新名字', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: '重命名 2025 检修题库' }));
    const input = await screen.findByLabelText('题库名称');
    fireEvent.change(input, { target: { value: '2026 检修题库' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(mocks.quizRenameLibrary).toHaveBeenCalledWith('lib-1', '2026 检修题库'));
    await waitFor(() => expect(screen.queryByRole('heading', { name: '重命名题库' })).not.toBeInTheDocument());
  });

  it('删除先弹确认，确认后才真的删', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: '删除 2025 检修题库' }));
    expect(await screen.findByRole('heading', { name: '删除题库' })).toBeInTheDocument();
    expect(mocks.quizDeleteLibrary).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }));
    await waitFor(() => expect(mocks.quizDeleteLibrary).toHaveBeenCalledWith('lib-1'));
  });

  it('重建索引把题数如实回显', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: '重建检索索引' }));
    await waitFor(() => expect(mocks.quizReindex).toHaveBeenCalled());
    await waitFor(() => {
      const items = useNotify.getState().items;
      expect(items[items.length - 1]?.text).toContain('128');
    });
  });
});
