import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useLauncherNav } from '../state/launcherNav';
import { vi } from 'vitest';
import { HtmlPagesPage } from './HtmlPagesPage';
import type { HtmlPageRecord, HtmlPageSummary } from '../lib/types';

const mocks = vi.hoisted(() => ({
  myPermissions: vi.fn(),
  htmlPageList: vi.fn(),
  htmlPageGet: vi.fn(),
  htmlPageCreate: vi.fn(),
  htmlPageUpdate: vi.fn(),
  htmlPageDelete: vi.fn(),
  htmlPagePreviewUrl: vi.fn(),
  htmlPagePreviewOpen: vi.fn(),
  htmlPageEmbedOpen: vi.fn(),
  htmlPageEmbedSync: vi.fn(),
  htmlPageEmbedVisible: vi.fn(),
  htmlPageEmbedClose: vi.fn(),
}));

vi.mock('../lib/api', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../lib/api')>();
  return { ...mod, api: { ...mod.api, ...mocks } };
});

const ALL_PERMS = ['html.page.read', 'html.page.create', 'html.page.update', 'html.page.delete'];

function summary(id: string, title: string, updatedAt = '2026-10-30T06:02:00.000Z'): HtmlPageSummary {
  return { id, title, byteLen: 2048, createdAt: updatedAt, updatedAt };
}

function record(id: string, title: string, html = '<h1>你好</h1>'): HtmlPageRecord {
  return { id, title, html, byteLen: 2048, createdAt: '2026-10-30T06:02:00.000Z', updatedAt: '2026-10-30T06:02:00.000Z' };
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={qc}>
      <HtmlPagesPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  for (const fn of Object.values(mocks)) fn.mockReset();
  // 导航 store 是模块级的，上一条用例留下的那一条会把这一条的选中拽走
  useLauncherNav.getState().clear();
  mocks.myPermissions.mockResolvedValue(ALL_PERMS);
  mocks.htmlPageList.mockResolvedValue([summary('p-1', '公告页'), summary('p-2', '对账说明')]);
  mocks.htmlPageGet.mockResolvedValue(record('p-1', '公告页'));
  mocks.htmlPageCreate.mockResolvedValue(record('p-3', '测试页'));
  mocks.htmlPageUpdate.mockResolvedValue(record('p-1', '公告页（新）'));
  mocks.htmlPageDelete.mockResolvedValue(undefined);
  mocks.htmlPagePreviewUrl.mockResolvedValue('http://127.0.0.1:41234/s/tok/p-1');
  mocks.htmlPagePreviewOpen.mockResolvedValue(undefined);
  mocks.htmlPageEmbedOpen.mockResolvedValue(undefined);
  mocks.htmlPageEmbedSync.mockResolvedValue(undefined);
  mocks.htmlPageEmbedVisible.mockResolvedValue(undefined);
  mocks.htmlPageEmbedClose.mockResolvedValue(undefined);
});

describe('页面库：左列表 + 右栏可直接操作', () => {
  it('列表来自后端，右栏交给嵌入块：地址与选中页对得上，本身不再放 iframe', async () => {
    renderPage();
    await screen.findByRole('button', { name: /公告页/ });
    expect(screen.getByRole('button', { name: /对账说明/ })).toBeTruthy();

    const host = await screen.findByTestId('html-preview-host');
    expect(host).toBeTruthy();
    // jsdom 量不出真实尺寸，这里只认 id 与量尺寸这条通路；尺寸语义由 Rust 侧单测守。
    await waitFor(() =>
      expect(mocks.htmlPageEmbedOpen).toHaveBeenCalledWith(
        'p-1',
        '2026-10-30T06:02:00.000Z',
        expect.any(Number),
        expect.any(Number),
        expect.any(Number),
        expect.any(Number),
      ),
    );
    expect(mocks.htmlPagePreviewUrl).toHaveBeenCalledWith('p-1');
    expect(document.querySelector('iframe')).toBeNull();
  });

  it('新建：标题去空白后提交，成功后选中新页并把回执写在标题下', async () => {
    renderPage();
    await screen.findByRole('button', { name: /公告页/ });

    fireEvent.click(screen.getByRole('button', { name: '新建页面' }));
    fireEvent.change(screen.getByLabelText('标题'), { target: { value: '  测试页  ' } });
    fireEvent.change(screen.getByLabelText('HTML'), { target: { value: '<h1>你好</h1>' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(mocks.htmlPageCreate).toHaveBeenCalledWith('测试页', '<h1>你好</h1>'));
    // 回执不用全局 toast：右栏是原生层，右下角的 toast 会被压住半截。
    expect(await screen.findByText('已新建「测试页」')).toBeInTheDocument();
  });

  it('编辑：先取整页，弹窗预填标题与正文，保存走 update', async () => {
    renderPage();
    await screen.findByRole('button', { name: /公告页/ });

    fireEvent.click(screen.getByRole('button', { name: '编辑当前页面' }));
    await waitFor(() => expect(mocks.htmlPageGet).toHaveBeenCalledWith('p-1'));

    const title = await screen.findByLabelText('标题');
    await waitFor(() => expect((title as HTMLInputElement).value).toBe('公告页'));
    expect((screen.getByLabelText('HTML') as HTMLTextAreaElement).value).toBe('<h1>你好</h1>');

    fireEvent.change(title, { target: { value: '公告页（新）' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() =>
      expect(mocks.htmlPageUpdate).toHaveBeenCalledWith('p-1', '公告页（新）', '<h1>你好</h1>'),
    );
  });

  it('删除要二次确认，确认后调 delete', async () => {
    renderPage();
    await screen.findByRole('button', { name: /公告页/ });

    fireEvent.click(screen.getByRole('button', { name: '删除当前页面' }));
    expect(mocks.htmlPageDelete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }));

    await waitFor(() => expect(mocks.htmlPageDelete).toHaveBeenCalledWith('p-1'));
    expect(await screen.findByText('已删除这个页面')).toBeInTheDocument();
  });

  it('保存失败时把后端那句原话写在标题下，不装作成功', async () => {
    mocks.htmlPageCreate.mockRejectedValue({ code: 'DB_ERROR', message: '写入失败：磁盘只读' });
    renderPage();
    await screen.findByRole('button', { name: /公告页/ });

    fireEvent.click(screen.getByRole('button', { name: '新建页面' }));
    fireEvent.change(screen.getByLabelText('标题'), { target: { value: '测试页' } });
    fireEvent.change(screen.getByLabelText('HTML'), { target: { value: '<p>x</p>' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    expect(await screen.findByText('写入失败：磁盘只读')).toBeInTheDocument();
  });

  it('运行脚本：交给独立窗口，不在本页执行', async () => {
    renderPage();
    await screen.findByRole('button', { name: /公告页/ });

    fireEvent.click(screen.getByRole('button', { name: '运行脚本' }));
    await waitFor(() => expect(mocks.htmlPagePreviewOpen).toHaveBeenCalledWith('p-1'));
  });

  it('预览服务未起来时右栏如实报错，不假装有内容', async () => {
    mocks.htmlPagePreviewUrl.mockRejectedValue(new Error('预览服务未启动'));
    renderPage();
    await screen.findByRole('button', { name: /公告页/ });

    await screen.findByText(/预览服务这次没起来，重启应用再看日志/);
    expect(screen.queryByTestId('html-preview-host')).toBeNull();
    expect(mocks.htmlPageEmbedOpen).not.toHaveBeenCalled();
  });

  it('弹窗打开时收起原生预览块，关掉再放回', async () => {
    renderPage();
    await screen.findByTestId('html-preview-host');
    await waitFor(() => expect(mocks.htmlPageEmbedVisible).toHaveBeenCalledWith(true));

    fireEvent.click(screen.getByRole('button', { name: '编辑当前页面' }));
    await screen.findByLabelText('标题');
    await waitFor(() => expect(mocks.htmlPageEmbedVisible).toHaveBeenLastCalledWith(false));

    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    await waitFor(() => expect(mocks.htmlPageEmbedVisible).toHaveBeenLastCalledWith(true));
  });

  it('离开这一页要把原生预览块收掉：明文不留在窗口里', async () => {
    const view = renderPage();
    await screen.findByTestId('html-preview-host');
    await waitFor(() => expect(mocks.htmlPageEmbedOpen).toHaveBeenCalled());

    const before = mocks.htmlPageEmbedClose.mock.calls.length;
    view.unmount();
    await waitFor(() => expect(mocks.htmlPageEmbedClose.mock.calls.length).toBeGreaterThan(before));
  });

  it('窗口重新获得焦点时把预览按原版本放回去：收托盘回来右栏不空', async () => {
    renderPage();
    await screen.findByTestId('html-preview-host');
    await waitFor(() => expect(mocks.htmlPageEmbedOpen).toHaveBeenCalledTimes(1));

    fireEvent.focus(window);
    await waitFor(() => expect(mocks.htmlPageEmbedOpen).toHaveBeenCalledTimes(2));
    // 版本原样带回去，Rust 侧据此只摆位置、不重新导航（页面内状态不丢）。
    expect(mocks.htmlPageEmbedOpen).toHaveBeenLastCalledWith(
      'p-1',
      '2026-10-30T06:02:00.000Z',
      expect.any(Number),
      expect.any(Number),
      expect.any(Number),
      expect.any(Number),
    );
  });

  it('没有写权限的只读角色看不到编辑与删除', async () => {
    mocks.myPermissions.mockResolvedValue(['html.page.read']);
    renderPage();
    await screen.findByRole('button', { name: /公告页/ });

    expect(screen.queryByRole('button', { name: '编辑当前页面' })).toBeNull();
    expect(screen.queryByRole('button', { name: '删除当前页面' })).toBeNull();
    expect((screen.getByRole('button', { name: '新建页面' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('浮层「选中这一页」的落点', () => {
  /**
   * 左栏没有筛选框，所以这里只需要把选中项换过去。
   * 真正要守的是另一半：右栏的嵌入预览是跟着选中项走的，
   * 选中没换成功就是"浮层点了 A 页、主窗还在预览 B 页"。
   */
  it('把选中的那一页换成导航指的那一页', async () => {
    renderPage();
    await screen.findByRole('button', { name: /公告页/ });
    expect(screen.getByRole('button', { name: /公告页/ })).toHaveAttribute('aria-current', 'true');

    useLauncherNav.getState().open({ page: 'html', pageId: 'p-2' });
    await waitFor(() => expect(screen.getByRole('button', { name: /对账说明/ })).toHaveAttribute('aria-current', 'true'));
    expect(useLauncherNav.getState().pending).toBeNull();
  });

  /** 只认落点是本页的那一条：账号页那条凭据的导航若也被这里吃掉，主窗会亮着一页没人要的东西。 */
  it('别页的导航载荷不动本页', async () => {
    renderPage();
    await screen.findByRole('button', { name: /公告页/ });
    useLauncherNav.getState().open({ page: 'accounts', targetId: 't-1', itemId: 'i-1', keyword: '日常办公' });
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.getByRole('button', { name: /公告页/ })).toHaveAttribute('aria-current', 'true');
    expect(useLauncherNav.getState().pending).toEqual({ page: 'accounts', targetId: 't-1', itemId: 'i-1', keyword: '日常办公' });
  });
});
