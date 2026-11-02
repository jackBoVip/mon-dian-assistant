import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi } from 'vitest';
import { QuizPage } from './QuizPage';
import type { QuizLibraryRow, QuizQuestionPage, QuizQuestionRow } from '../lib/types';
import { PERM } from '../lib/permissions';
import { useNotify } from '../state/notify';
import { useLauncherNav } from '../state/launcherNav';

const mocks = vi.hoisted(() => ({
  myPermissions: vi.fn(),
  quizLibraries: vi.fn(),
  quizRenameLibrary: vi.fn(),
  quizDeleteLibrary: vi.fn(),
  quizReindex: vi.fn(),
  quizLibraryQuestions: vi.fn(),
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


/** 一道题的最小可用形状：详情弹窗只读这几列。 */
function question(seq: number): QuizQuestionRow {
  return {
    id: `q-${seq}`,
    libraryId: 'lib-1',
    seq,
    qtype: 'single',
    stem: `第 ${seq} 道题的题干`,
    options: [],
    answerDisplay: 'A',
    tags: [],
    confidence: 1,
    issues: [],
    sourceRef: null,
  };
}

/** 按 offset/limit 出一页：后端那条 SQL 就是 `ORDER BY seq LIMIT/OFFSET`，测试要照同一个形状给。 */
function questionPage(offset: number, limit: number): QuizQuestionPage {
  const items = Array.from({ length: limit }, (_, k) => question(offset + k + 1));
  return { items, total: 60 };
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
  // 详情弹窗的逐题取数：默认给第 1 页那十条（只有点开题库的用例会走到这条查询）
  mocks.quizLibraryQuestions.mockImplementation((_lib: string, offset: number, limit: number) =>
    Promise.resolve(questionPage(offset, limit)),
  );
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

describe('浮层「打开这道题」的落点', () => {
  /**
   * 落在题号所在的那一页，而不是永远从第 1 页开始。
   *
   * 判据取发往后端的 offset：`library_questions` 是 `ORDER BY seq LIMIT ? OFFSET ?`，
   * 第 42 题的行下标是 41，10 条一页就是 offset 40。这个换算成立的前提是 seq 连续且没有单题删除，
   * 换算本身在 `QuizLibraryDetail.pageOfSeq` 里，那条注释写了它依赖哪两件事。
   */
  it('导航到第 42 题：按题号算出页偏移，并把那道题标出来', async () => {
    useLauncherNav.getState().clear();
    renderPage();
    await screen.findByText('2025 检修题库');

    useLauncherNav.getState().open({ page: 'quiz', libraryId: 'lib-1', questionId: 'q-42', seq: 42 });
    await waitFor(() => expect(mocks.quizLibraryQuestions).toHaveBeenCalledWith('lib-1', 40, 10));
    expect(await screen.findByText('（搜索命中的那道题）')).toBeInTheDocument();
    // 消费完必须清空：下一次手动打开题库不该还被这条旧导航拽到第 5 页
    expect(useLauncherNav.getState().pending).toBeNull();
  });

  /**
   * 反向那一半同样要紧：手动打开一份题库时 `detailFocus` 必须是 null。
   * 留着上一次导航的 focus，就会拿上一份题库的题号去算这一份的页码——
   * 界面停在第 5 页，而人以为它从第 1 页开始。
   */
  it('手动打开题库仍从第 1 页开始，不受刚才那次导航残留的影响', async () => {
    useLauncherNav.getState().clear();
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: '查看 2025 检修题库 的题目' }));
    await waitFor(() => expect(mocks.quizLibraryQuestions).toHaveBeenCalledWith('lib-1', 0, 10));
    expect(screen.queryByText('（搜索命中的那道题）')).toBeNull();

    // 先让浮层导航把第 5 页打开、再关掉，然后手动开：这次必须回到第 1 页
    mocks.quizLibraryQuestions.mockClear();
    useLauncherNav.getState().open({ page: 'quiz', libraryId: 'lib-1', questionId: 'q-42', seq: 42 });
    await waitFor(() => expect(mocks.quizLibraryQuestions).toHaveBeenCalledWith('lib-1', 40, 10));
    // 弹窗有关闭钮两枚（右上角图标与页脚那颗），点哪一枚都是同一条 onClose
    const closeButtons = within(screen.getByRole('dialog')).getAllByRole('button', { name: '关闭' });
    fireEvent.click(closeButtons[0]);

    mocks.quizLibraryQuestions.mockClear();
    fireEvent.click(screen.getByRole('button', { name: '查看 2025 检修题库 的题目' }));
    await waitFor(() => expect(mocks.quizLibraryQuestions).toHaveBeenCalledWith('lib-1', 0, 10));
    expect(screen.queryByText('（搜索命中的那道题）')).toBeNull();
  });

  /** 清单还是异步来的：导航到达时那份题库还没列出来，不能拿一个查不到的 libraryId 去开弹窗。 */
  it('题库清单未到齐时先攥着目标，到齐了再开', async () => {
    useLauncherNav.getState().clear();
    // 清单挂起：改 mock 让已 settled 的查询重新取数是做不到的，只能真的让它晚到
    let release: (rows: QuizLibraryRow[]) => void = () => {};
    mocks.quizLibraries.mockReturnValue(new Promise((resolve) => { release = resolve }));
    renderPage();
    await waitFor(() => expect(mocks.quizLibraries).toHaveBeenCalled());

    useLauncherNav.getState().open({ page: 'quiz', libraryId: 'lib-1', questionId: 'q-42', seq: 42 });
    await new Promise((r) => setTimeout(r, 0));
    expect(mocks.quizLibraryQuestions).not.toHaveBeenCalled();
    // 载荷已经消费了，但目标攥在页面里等清单——弹窗一帧都没开
    expect(useLauncherNav.getState().pending).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();

    act(() => release([library()]));
    await waitFor(() => expect(mocks.quizLibraryQuestions).toHaveBeenCalledWith('lib-1', 40, 10));
    expect(await screen.findByText('（搜索命中的那道题）')).toBeInTheDocument();
  });
});
