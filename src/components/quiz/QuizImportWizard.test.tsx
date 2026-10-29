import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi } from 'vitest';
import { QuizImportWizard } from './QuizImportWizard';
import type { QuizImportJobDetail, QuizImportRow, QuizLibraryRow } from '../../lib/types';
import { useNotify } from '../../state/notify';

const mocks = vi.hoisted(() => ({
  openFile: vi.fn(),
  saveTextFile: vi.fn(),
  quizImportParse: vi.fn(),
  quizImportJob: vi.fn(),
  quizImportTemplate: vi.fn(),
  quizImportUpdateRow: vi.fn(),
  quizImportBulkUpdate: vi.fn(),
  quizImportPublish: vi.fn(),
  quizImportDiscard: vi.fn(),
}));

vi.mock('../../lib/api', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../lib/api')>();
  return { ...mod, api: { ...mod.api, ...mocks } };
});

vi.mock('../../lib/dialogs', () => ({ openFile: mocks.openFile, saveTextFile: mocks.saveTextFile }));

function row(over: Partial<QuizImportRow> = {}): QuizImportRow {
  return {
    id: 'row-1',
    seq: 1,
    qtype: 'single',
    stem: '下列设备中属于一次设备的是',
    options: [
      { key: 'A', text: '变压器' },
      { key: 'B', text: '电流互感器' },
    ],
    answerDisplay: 'A',
    tags: [],
    confidence: 0.92,
    issues: [],
    sourceRef: '第 1 行',
    include: true,
    edited: false,
    ...over,
  };
}

function detail(rows: QuizImportRow[] = [row(), row({ id: 'row-2', seq: 2, qtype: 'true_false', stem: '断路器属于二次设备', answerDisplay: '错误', confidence: 0.55, issues: ['missing_answer'] })]): QuizImportJobDetail {
  return {
    job: {
      id: 'job-1',
      libraryName: '检修题库',
      sourceFormat: 'csv',
      sourceFilename: '检修.csv',
      status: 'review',
      totalRows: rows.length,
      includedRows: rows.filter((r) => r.include).length,
      issueRows: rows.filter((r) => r.issues.length > 0).length,
      errorCode: null,
      createdAt: '2026-10-27T08:00:00.000Z',
      updatedAt: '2026-10-27T08:00:00.000Z',
      publishedLibraryId: null,
    },
    rows,
    total: rows.length,
  };
}

function renderWizard(onClose = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(
    <QueryClientProvider client={qc}>
      <QuizImportWizard open onClose={onClose} />
    </QueryClientProvider>,
  );
  return onClose;
}

async function reachReview() {
  // 选文件这一步是一整块拖拽区（与账号中心的导入弹窗同一档），点它等同于点「选择文件」。
  fireEvent.click(screen.getByRole('button', { name: /选择题库文件/ }));
  await waitFor(() => expect(mocks.openFile).toHaveBeenCalled());
  await screen.findByText('检修.csv');
  fireEvent.click(screen.getByRole('button', { name: '解析并生成复核表' }));
  await screen.findByText('解析总行');
}

beforeEach(() => {
  for (const fn of Object.values(mocks)) fn.mockReset();
  mocks.openFile.mockResolvedValue('/tmp/检修.csv');
  mocks.saveTextFile.mockResolvedValue({ path: '/tmp/题库导入模板.csv', fileName: '题库导入模板.csv' });
  mocks.quizImportTemplate.mockResolvedValue({
    csv: '题型,题干,选项A,选项B,选项C,选项D,答案,标签\n',
    columns: ['题型', '题干', '选项A', '选项B', '选项C', '选项D', '答案', '标签'],
    note: '四行示例题覆盖单选 / 多选 / 判断 / 填空。',
  });
  mocks.quizImportParse.mockResolvedValue(detail().job);
  mocks.quizImportJob.mockResolvedValue(detail());
  mocks.quizImportUpdateRow.mockResolvedValue({ row: row({ include: false, issues: ['missing_answer'] }), job: detail().job });
  mocks.quizImportBulkUpdate.mockResolvedValue(detail().job);
  mocks.quizImportPublish.mockResolvedValue({
    id: 'lib-9',
    name: '检修题库',
    sourceFormat: 'csv',
    sourceFilename: '检修.csv',
    questionCount: 2,
    createdAt: '2026-10-27T08:10:00.000Z',
    updatedAt: '2026-10-27T08:10:00.000Z',
  } satisfies QuizLibraryRow);
  mocks.quizImportDiscard.mockResolvedValue(undefined);
  useNotify.setState({ items: [] });
});

describe('导入向导：解析 → 复核 → 发布', () => {
  it('选文件这一步是拖拽区，文案列出 97-2003 与 OOXML 两种扩展名', async () => {
    renderWizard();
    const dropZone = screen.getByRole('button', { name: /选择题库文件，或把文件拖到这里/ });
    expect(dropZone).toHaveClass('drop-zone');
    expect(screen.getByText('支持 DOC / DOCX · XLS / XLSX · TXT / CSV')).toBeInTheDocument();
    expect(screen.getByText(/XLS \/ XLSX \/ TXT \/ CSV，单文件 ≤ 32MiB/)).toBeInTheDocument();
  });

  it('选到不支持的扩展名时当场报出，不进入解析', async () => {
    mocks.openFile.mockResolvedValue('/tmp/题库.pdf');
    renderWizard();
    fireEvent.click(screen.getByRole('button', { name: /选择题库文件/ }));
    await waitFor(() =>
      expect(useNotify.getState().items.map((i) => i.text).join(' ')).toContain('不支持的文件格式'),
    );
    expect(screen.queryByText('题库.pdf')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '解析并生成复核表' })).toBeDisabled();
    expect(mocks.quizImportParse).not.toHaveBeenCalled();
  });

  /// 模板内容由后端给（解析层 `grid::template_csv()`），界面只负责把那份文本交给系统下载通道；
  /// 写出与取消这两条回执都要说清，不能让人以为点了没反应。
  it('下载模板把后端给的 CSV 原样交给下载通道', async () => {
    renderWizard();
    fireEvent.click(await screen.findByRole('button', { name: /下载模板/ }));
    await waitFor(() => expect(mocks.quizImportTemplate).toHaveBeenCalled());
    await waitFor(() =>
      expect(mocks.saveTextFile).toHaveBeenCalledWith(
        expect.objectContaining({ defaultPath: '题库导入模板.csv' }),
        '题型,题干,选项A,选项B,选项C,选项D,答案,标签\n',
      ),
    );
    await waitFor(() =>
      expect(useNotify.getState().items.map((i) => i.text).join(' ')).toContain('题库导入模板.csv'),
    );
  });

  it('取消保存模板时说清没有写出文件', async () => {
    mocks.saveTextFile.mockResolvedValue(null);
    renderWizard();
    fireEvent.click(await screen.findByRole('button', { name: /下载模板/ }));
    await waitFor(() =>
      expect(useNotify.getState().items.map((i) => i.text).join(' ')).toContain('已取消模板保存'),
    );
  });

  it('选文件后解析，复核表列出摘要与每一行的问题码', async () => {
    renderWizard();
    await reachReview();
    expect(mocks.quizImportParse).toHaveBeenCalledWith('/tmp/检修.csv');
    expect(await screen.findByText('下列设备中属于一次设备的是')).toBeInTheDocument();
    expect(screen.getByText('缺答案')).toBeInTheDocument();
    expect(screen.getByText('55%')).toBeInTheDocument();
    // 有问题的行默认仍然纳入，是否排除由人决定
    expect(screen.getByRole('checkbox', { name: '第 2 题纳入发布' })).toBeChecked();
  });

  /// 改一行只替换缓存里的那一行：翻页不会带走它，也不必为一次勾选重取一页。
  it('单行「纳入」开关直接提交补丁，不重取当前页', async () => {
    const updated = row({
      id: 'row-2',
      seq: 2,
      qtype: 'true_false',
      stem: '断路器属于二次设备',
      answerDisplay: '错误',
      confidence: 0.55,
      issues: ['missing_answer'],
      include: false,
    });
    mocks.quizImportUpdateRow.mockResolvedValue({ row: updated, job: { ...detail().job, includedRows: 1 } });
    renderWizard();
    await reachReview();
    const fetches = mocks.quizImportJob.mock.calls.length;
    fireEvent.click(await screen.findByRole('checkbox', { name: '第 2 题纳入发布' }));
    await waitFor(() =>
      expect(mocks.quizImportUpdateRow).toHaveBeenCalledWith('job-1', 'row-2', { include: false }),
    );
    await waitFor(() =>
      expect(screen.getByRole('checkbox', { name: '第 2 题纳入发布' })).not.toBeChecked(),
    );
    expect(mocks.quizImportJob.mock.calls.length).toBe(fetches);
  });

  /// 4,341 行的任务整表铺开要几秒一帧：复核表按页取，默认只列有问题的那一档。
  it('复核表按页取行，默认只看有问题', async () => {
    mocks.quizImportJob.mockResolvedValue({ ...detail(), total: 120 });
    renderWizard();
    await reachReview();
    await waitFor(() => expect(mocks.quizImportJob).toHaveBeenCalledWith('job-1', 0, 50, true));
    expect(await screen.findByRole('navigation', { name: '复核表分页' })).toBeInTheDocument();
    expect(screen.getByText('共 120 行 · 第 1/3 页')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '第 2 页' }));
    await waitFor(() => expect(mocks.quizImportJob).toHaveBeenCalledWith('job-1', 50, 50, true));
    expect(screen.getByText('共 120 行 · 第 2/3 页')).toBeInTheDocument();
  });

  it('取消「只看有问题」后改取全部行', async () => {
    renderWizard();
    await reachReview();
    fireEvent.click(screen.getByRole('checkbox', { name: '只看有问题' }));
    await waitFor(() => expect(mocks.quizImportJob).toHaveBeenCalledWith('job-1', 0, 50, false));
  });

  it('勾选一行后「排除所选」只作用于选中的 id', async () => {
    renderWizard();
    await reachReview();
    fireEvent.click(await screen.findByRole('checkbox', { name: '选择第 1 题' }));
    fireEvent.click(screen.getByRole('button', { name: '排除所选' }));
    await waitFor(() =>
      expect(mocks.quizImportBulkUpdate).toHaveBeenCalledWith('job-1', {
        op: 'set_include',
        include: false,
        ids: ['row-1'],
      }),
    );
  });

  /// 全选只覆盖当前页：看不见的行不该被一次点击带上。
  it('全选本页只作用于当前页的行', async () => {
    renderWizard();
    await reachReview();
    expect(screen.getByText('全选本页')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: '全选本页' }));
    fireEvent.click(screen.getByRole('button', { name: '纳入所选' }));
    await waitFor(() =>
      expect(mocks.quizImportBulkUpdate).toHaveBeenCalledWith('job-1', {
        op: 'set_include',
        include: true,
        ids: ['row-1', 'row-2'],
      }),
    );
  });

  /// 题库名不在复核步骤里占一条固定带：点「发布为题库」才出现，正文留给行本身。
  it('发布要二次确认，并把题库名交给后端', async () => {
    const onClose = renderWizard();
    await reachReview();
    expect(screen.queryByLabelText('发布后的题库名称')).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: '发布为题库' }));
    expect(await screen.findByLabelText('发布后的题库名称')).toHaveValue('检修题库');
    expect(mocks.quizImportPublish).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '确认发布' }));
    await waitFor(() => expect(mocks.quizImportPublish).toHaveBeenCalledWith('job-1', '检修题库'));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('没有勾选任何行时发布钮是禁用的', async () => {
    mocks.quizImportParse.mockResolvedValue(detail([row({ include: false })]).job);
    mocks.quizImportJob.mockResolvedValue(detail([row({ include: false })]));
    renderWizard();
    await reachReview();
    expect(screen.getByRole('button', { name: '发布为题库' })).toBeDisabled();
  });

  it('放弃任务要二次确认，确认后调丢弃命令', async () => {
    renderWizard();
    await reachReview();
    fireEvent.click(screen.getByRole('button', { name: '放弃任务' }));
    fireEvent.click(screen.getByRole('button', { name: '确认放弃' }));
    await waitFor(() => expect(mocks.quizImportDiscard).toHaveBeenCalledWith('job-1'));
  });
});
