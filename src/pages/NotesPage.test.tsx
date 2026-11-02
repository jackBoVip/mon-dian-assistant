import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { pointerTap } from '../test/pointer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { NotesPage } from './NotesPage';
import { PERM } from '../lib/permissions';
import { useLauncherNav } from '../state/launcherNav';
import type { NoteDetail, NoteRecord, NoteSummary } from '../lib/types';

/**
 * 笔记页的判据只有两类：**入口按权限裁剪**与**自动保存真的发生**。
 * 其中"切走前先落库"那条是这台编辑器最容易出事的地方——
 * 防抖窗口里换篇，改动不丢才算对，丢了没有任何构建门禁会红。
 */
const mocks = vi.hoisted(() => ({
  myPermissions: vi.fn(),
  notesList: vi.fn(),
  notesGet: vi.fn(),
  notesCreate: vi.fn(),
  notesUpdate: vi.fn(),
  notesDelete: vi.fn(),
}));

vi.mock('../lib/api', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../lib/api')>();
  return { ...mod, api: { ...mod.api, ...mocks } };
});

function summary(over: Partial<NoteSummary> = {}): NoteSummary {
  return {
    id: 'n-1',
    title: '主变巡检记录',
    snippet: '1 号主变油温正常',
    createdAt: '2026-10-29T01:00:00.000Z',
    updatedAt: '2026-10-29T02:00:00.000Z',
    ...over,
  };
}

function detail(over: Partial<NoteRecord> = {}): NoteDetail {
  return {
    note: {
      id: 'n-1',
      title: '主变巡检记录',
      contentHtml: '<p>1 号主变油温正常</p>',
      createdAt: '2026-10-29T01:00:00.000Z',
      updatedAt: '2026-10-29T02:00:00.000Z',
      ...over,
    },
    assets: [],
  };
}

function record(over: Partial<NoteRecord> = {}): NoteRecord {
  return { ...detail().note, ...over };
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={qc}>
      <NotesPage />
    </QueryClientProvider>,
  );
}

const WRITE_PERMS = [PERM.MENU_TOP_NOTES, PERM.NOTES_READ, PERM.NOTES_WRITE];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  Object.values(mocks).forEach((fn) => fn.mockReset());
  mocks.myPermissions.mockResolvedValue(WRITE_PERMS);
  mocks.notesList.mockResolvedValue([summary()]);
  mocks.notesGet.mockResolvedValue(detail());
  mocks.notesCreate.mockResolvedValue(detail({ id: 'n-2', title: '无标题笔记', contentHtml: '' }));
  mocks.notesUpdate.mockImplementation(async (_id: string, title: string, html: string) =>
    record({ id: _id, title, contentHtml: html, updatedAt: '2026-10-29T03:00:00.000Z' }),
  );
  mocks.notesDelete.mockResolvedValue(undefined);
  // 导航 store 是模块级的：上一条用例留下的那一条会把这一条的选中拽走
  useLauncherNav.getState().clear();
});

afterEach(() => {
  vi.useRealTimers();
});

/**
 * 把防抖与 promise 队列一起推进到"已经发完请求"的那一帧。
 * 必须一小段一小段地推：一次推完 900ms 时，选中态变化之后才发出的详情请求
 * 会在 act 收尾的下一个微任务里才落回 React，测试就永远看不到它的数据。
 */
async function settle(totalMs = 900) {
  for (let elapsed = 0; elapsed < totalMs; elapsed += 20) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20);
    });
  }
}

describe('列表与选中', () => {
  it('列表到货后默认选中第一条，编辑器标题就是它', async () => {
    renderPage();
    await settle();
    const item = screen.getByRole('button', { name: /^主变巡检记录/ });
    expect(item).toHaveAttribute('aria-current', 'true');
    expect(screen.getByRole('textbox', { name: '笔记标题' })).toHaveValue('主变巡检记录');
  });

  it('一篇都没有时给空状态，不渲染编辑器', async () => {
    mocks.notesList.mockResolvedValue([]);
    renderPage();
    await settle();
    expect(screen.getByText('还没有写过笔记')).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: '笔记标题' })).toBeNull();
  });

  it('搜索词经防抖后进 notesList，摘要为空的那篇显示「（空白笔记）」', async () => {
    mocks.notesList.mockImplementation((q: string | null) =>
      Promise.resolve(q === null ? [summary()] : [summary({ id: 'n-9', title: '油务', snippet: '' })]),
    );
    renderPage();
    await settle();
    fireEvent.change(screen.getByRole('textbox', { name: '搜索笔记' }), { target: { value: '油务' } });
    await settle(400);
    expect(mocks.notesList).toHaveBeenLastCalledWith('油务');
    expect(screen.getByText('空白笔记')).toBeInTheDocument();
  });
});

describe('自动保存', () => {
  it('改标题后停手一秒发一次 notes_update，且只发一次', async () => {
    renderPage();
    await settle();
    fireEvent.change(screen.getByRole('textbox', { name: '笔记标题' }), { target: { value: '主变巡检（改）' } });
    await settle();
    expect(mocks.notesUpdate).toHaveBeenCalledTimes(1);
    expect(mocks.notesUpdate.mock.calls[0][0]).toBe('n-1');
    expect(mocks.notesUpdate.mock.calls[0][1]).toBe('主变巡检（改）');
    await settle();
    expect(mocks.notesUpdate).toHaveBeenCalledTimes(1);
  });

  it('保存状态写的是"上次修改发生在…"，不是"已同步"这种本机做不到的话', async () => {
    renderPage();
    await settle();
    fireEvent.change(screen.getByRole('textbox', { name: '笔记标题' }), { target: { value: 'X' } });
    await settle();
    await settle();
    expect(screen.getByText(/^上次修改发生在/)).toBeInTheDocument();
  });

  it('页头那枚「保存」按下去立刻落库，不等 700ms 防抖', async () => {
    renderPage();
    await settle();
    fireEvent.change(screen.getByRole('textbox', { name: '笔记标题' }), { target: { value: '立刻走' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await settle();
    expect(mocks.notesUpdate).toHaveBeenCalledTimes(1);
    expect(mocks.notesUpdate.mock.calls[0][1]).toBe('立刻走');
  });

  it('切到另一篇前先把上一篇的改动落库，id 用的是上一篇的', async () => {
    mocks.notesList.mockResolvedValue([summary(), summary({ id: 'n-2', title: '配电室巡视', snippet: '无' })]);
    mocks.notesGet.mockImplementation((id: string) =>
      Promise.resolve(id === 'n-2' ? detail({ id: 'n-2', title: '配电室巡视', contentHtml: '<p>无</p>' }) : detail()),
    );
    renderPage();
    await settle();
    fireEvent.change(screen.getByRole('textbox', { name: '笔记标题' }), { target: { value: '写完就走' } });
    // 防抖还没到点就切篇
    fireEvent.click(screen.getByRole('button', { name: /^配电室巡视/ }));
    await settle();
    const savedToFirst = mocks.notesUpdate.mock.calls.filter(([id, title]) => id === 'n-1' && title === '写完就走');
    expect(savedToFirst).toHaveLength(1);
    expect(screen.getByRole('textbox', { name: '笔记标题' })).toHaveValue('配电室巡视');
  });

  it('只读权限下不发保存请求，页头说明缺哪枚权限', async () => {
    mocks.myPermissions.mockResolvedValue([PERM.MENU_TOP_NOTES, PERM.NOTES_READ]);
    renderPage();
    await settle();
    expect(screen.getByText(/notes\.read/)).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: '笔记标题' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: '新建笔记' })).toBeNull();
    fireEvent.change(screen.getByRole('textbox', { name: '笔记标题' }), { target: { value: '不该被保存' } });
    await settle();
    expect(mocks.notesUpdate).not.toHaveBeenCalled();
  });
});

describe('新建与删除', () => {
  it('新建走 notes_create 并立刻切过去', async () => {
    renderPage();
    await settle();
    fireEvent.click(screen.getByRole('button', { name: '新建笔记' }));
    await settle();
    expect(mocks.notesCreate).toHaveBeenCalledTimes(1);
    expect(mocks.notesGet).toHaveBeenCalledWith('n-2');
  });

  it('删除先弹确认，文案说清不可恢复；确认才发请求', async () => {
    renderPage();
    await settle();
    fireEvent.click(screen.getByRole('button', { name: '删除笔记 主变巡检记录' }));
    await settle();
    const dialog = screen.getByRole('dialog', { name: '删除这篇笔记' });
    expect(within(dialog).getByText(/不可撤销/)).toBeInTheDocument();
    expect(mocks.notesDelete).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: '确认删除' }));
    await settle();
    expect(mocks.notesDelete).toHaveBeenCalledWith('n-1');
  });

  it('取消确认则什么都不发', async () => {
    renderPage();
    await settle();
    fireEvent.click(screen.getByRole('button', { name: '删除笔记 主变巡检记录' }));
    await settle();
    const dialog = screen.getByRole('dialog', { name: '删除这篇笔记' });
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }));
    await settle();
    expect(mocks.notesDelete).not.toHaveBeenCalled();
  });
});

describe('导入与导出下拉', () => {
  /** 页头只留一枚下拉 + 一枚新建：下拉里四行都得在，否则就是枚按了没反应的死控件。 */
  async function openExportMenu() {
    renderPage();
    await settle();
    pointerTap(screen.getByRole('button', { name: '导入与导出' }));
    return screen.getByRole('menu', { name: '导入与导出' });
  }

  it('可写时四行都在：两枚导入、两枚导出', async () => {
    const menu = await openExportMenu();
    expect(within(menu).getByRole('menuitem', { name: /导入 Markdown/ })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: /导入 zip 备份/ })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: /导出本篇为 \.md/ })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: /导出全部为 zip/ })).toBeInTheDocument();
  });

  it('只读时导入那两行不出现，导出仍可用（自己的笔记本来就能导走）', async () => {
    mocks.myPermissions.mockResolvedValue([PERM.MENU_TOP_NOTES, PERM.NOTES_READ]);
    const menu = await openExportMenu();
    expect(within(menu).queryByRole('menuitem', { name: /导入/ })).toBeNull();
    expect(within(menu).getByRole('menuitem', { name: /导出全部为 zip/ })).toBeInTheDocument();
  });
});

describe('浮层「打开这篇笔记」的落点', () => {
  /**
   * 页内筛选框留着关键字时，导航指的那一篇多半不在筛选结果里。
   * 而本页有一条"选中项不在列表就落第一行"的规则会把它抢走——所以导航必须先把筛选撤干净。
   * 只置选中不撤筛选，界面上留下的就是"筛着 主变，选中的却是 油务台账"这种自相矛盾。
   */
  it('带着旧筛选到达时：撤掉筛选并选中那一篇', async () => {
    mocks.notesList.mockImplementation((q: string | null) =>
      Promise.resolve(q === null ? [summary(), summary({ id: 'n-3', title: '油务台账' })] : [summary()]),
    );
    renderPage();
    await settle();
    fireEvent.change(screen.getByRole('textbox', { name: '搜索笔记' }), { target: { value: '主变' } });
    await settle(400);
    expect(mocks.notesList).toHaveBeenLastCalledWith('主变');
    // 此刻列表里只有 n-1，选中的也是 n-1
    expect(screen.getByRole('button', { name: /^主变巡检记录/ })).toHaveAttribute('aria-current', 'true');

    useLauncherNav.getState().open({ page: 'notes', noteId: 'n-3' });
    await settle();

    expect(screen.getByRole('button', { name: /^油务台账/ })).toHaveAttribute('aria-current', 'true');
    // 筛选是真的撤了，不是只在心里撤：输入框空着，取数也回到无关键字那一档
    expect(screen.getByRole('textbox', { name: '搜索笔记' })).toHaveValue('');
    expect(mocks.notesList).toHaveBeenLastCalledWith(null);
    expect(useLauncherNav.getState().pending).toBeNull();
  });

  /** 本页只认落点是 notes 的那一条：别的页的导航不该改动这里的选中与筛选。 */
  it('别页的导航载荷不动本页', async () => {
    renderPage();
    await settle();
    useLauncherNav.getState().open({ page: 'html', pageId: 'p-9' });
    await settle();
    expect(screen.getByRole('textbox', { name: '搜索笔记' })).toHaveValue('');
    expect(useLauncherNav.getState().pending).toEqual({ page: 'html', pageId: 'p-9' });
  });
});
