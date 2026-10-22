import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { TargetFormDialog } from './TargetFormDialog';
import { useNotify } from '../../state/notify';
import type { TargetDetail } from '../../lib/types';

/**
 * 新增 / 编辑系统弹窗的版式与字段口径（交付方 2026-10-18：类型只留网页·终端·数据库，字段默认和 Chrome / Edge 一样；
 * 2026-10-19：系统要能改名称与全部字段，编辑复用这张表，初值取自 target_detail）。
 * 正反两向都锁：正向钉原型字面文案，反向钉"被撤掉的那几栏不许悄悄长回来"。
 * 相似地址检查是需求 §8 的防重复入口，原型没画但必须留着，也在这里锁一条。
 */

const mocks = vi.hoisted(() => ({
  createTarget: vi.fn(),
  updateTarget: vi.fn(),
  targetDetail: vi.fn(),
  listGroups: vi.fn(),
  similarTargets: vi.fn(),
}));

vi.mock('../../lib/api', () => ({
  api: {
    createTarget: (input: unknown) => mocks.createTarget(input),
    updateTarget: (targetId: string, input: unknown) => mocks.updateTarget(targetId, input),
    targetDetail: (targetId: string) => mocks.targetDetail(targetId),
    listGroups: () => mocks.listGroups(),
    similarTargets: (address: string) => mocks.similarTargets(address),
  },
  ApiError: class ApiError extends Error {},
  isTauri: () => false,
}));

function renderWithClient(ui: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

/** 编辑形态的初值来源（target_detail）。蒙电OA 这条：地址带路径，所以 url != allowedOrigin。 */
function detail(over: Partial<TargetDetail> = {}): TargetDetail {
  return {
    target: {
      id: 't-9',
      targetType: 'web',
      displayName: '蒙电OA',
      groupId: 'g1',
      status: 'active',
      createdAt: '2026-10-01T02:00:00Z',
      updatedAt: '2026-10-11T02:00:00Z',
      credentialCount: 2,
    },
    meta: {
      url: 'https://oa.example.cn/login',
      allowedOrigin: 'https://oa.example.cn',
      host: 'oa.example.cn',
      port: '',
      databaseName: '',
      tenant: '租户A',
      vendor: '',
      protocol: 'https',
      extra: {},
    },
    items: [],
    insecureProtocol: false,
    fillAvailable: true,
    ...over,
  };
}

beforeEach(() => {
  useNotify.setState({ items: [] });
  mocks.createTarget.mockReset().mockResolvedValue({ id: 't-new', displayName: '蒙电OA' });
  mocks.updateTarget.mockReset().mockResolvedValue({ id: 't-9', displayName: '蒙电OA' });
  mocks.targetDetail.mockReset().mockResolvedValue(detail());
  mocks.listGroups.mockReset().mockResolvedValue([{ id: 'g1', name: '办公系统', targetCount: 3 }]);
  mocks.similarTargets.mockReset().mockResolvedValue([]);
});

function lastNotify() {
  return useNotify.getState().items.slice(-1)[0];
}

function options(label: string): string[] {
  const select = screen.getByLabelText(label) as HTMLSelectElement;
  return Array.from(select.options).map((o) => o.textContent ?? '');
}

function fill(name: string, type: string, addressLabel: string, address: string) {
  fireEvent.change(screen.getByLabelText('系统名称'), { target: { value: name } });
  if (type !== 'web') fireEvent.change(screen.getByLabelText('系统类型'), { target: { value: type } });
  fireEvent.change(screen.getByLabelText(addressLabel), { target: { value: address } });
}

describe('TargetFormDialog 版式（原型 948-1004）', () => {
  it('标题与按钮逐字照原型：新增系统 / 取消 / 保存系统', () => {
    renderWithClient(<TargetFormDialog open onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.getByRole('dialog', { name: '新增系统' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '保存系统' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '取消' })).toBeInTheDocument();
  });

  it('系统类型只有网页·终端·数据库三档，被撤掉的五档不出现在新建下拉里', () => {
    renderWithClient(<TargetFormDialog open onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(options('系统类型')).toEqual(['网页', '终端', '数据库']);
    for (const gone of ['网络设备', '云平台', '文件传输', '应用账号', '其他秘密']) {
      expect(screen.queryByRole('option', { name: gone })).toBeNull();
    }
  });

  it('分组下拉第一项是未分组，其余来自后端真实分组（原型那三项是写死的示例）', async () => {
    renderWithClient(<TargetFormDialog open onClose={vi.fn()} onSaved={vi.fn()} />);
    await waitFor(() => expect(options('分组')).toEqual(['未分组', '办公系统']));
    expect(mocks.listGroups).toHaveBeenCalled();
  });

  it('一栏地址随类型换 label 与占位，逐字照原型 1352-1361', () => {
    renderWithClient(<TargetFormDialog open onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.getByLabelText('登录地址 (URL)')).toHaveAttribute('placeholder', 'https://oa.example.cn');
    fireEvent.change(screen.getByLabelText('系统类型'), { target: { value: 'terminal' } });
    expect(screen.getByLabelText('连接地址 (IP:Port)')).toHaveAttribute('placeholder', '例如: 192.168.1.100:22');
    fireEvent.change(screen.getByLabelText('系统类型'), { target: { value: 'database' } });
    expect(screen.getByLabelText('连接字符串')).toHaveAttribute('placeholder', 'jdbc:mysql://127.0.0.1:3306/db');
  });

  it('Chrome/Edge 之外的那几栏不再出现，旧的叫法也不留着', () => {
    renderWithClient(<TargetFormDialog open onClose={vi.fn()} onSaved={vi.fn()} />);
    for (const gone of [
      '允许自动填充的精确 Origin（可选）',
      '端口（可选）',
      '协议（可选，如 ssh/sftp）',
      '租户/项目（可选）',
      '厂商/型号（可选）',
      '数据库/实例（可选）',
      '目标类型',
      '目标 / 系统名称',
      '主机 / 地址',
    ]) {
      expect(screen.queryByLabelText(gone)).toBeNull();
    }
  });
});

describe('TargetFormDialog 提交', () => {
  it('终端类只填 IP:Port 也把主机与端口拆给后端，连接终端不断链', async () => {
    renderWithClient(<TargetFormDialog open onClose={vi.fn()} onSaved={vi.fn()} />);
    fill('机房终端B', 'terminal', '连接地址 (IP:Port)', '10.0.0.9:22');
    fireEvent.click(screen.getByRole('button', { name: '保存系统' }));
    await waitFor(() => expect(mocks.createTarget).toHaveBeenCalledTimes(1));
    expect(lastPayload()).toMatchObject({
      displayName: '机房终端B',
      targetType: 'terminal',
      host: '10.0.0.9',
      port: '22',
      protocol: 'ssh',
    });
  });

  it('名称或地址缺一律不发请求，并说明缺的是哪一栏', () => {
    renderWithClient(<TargetFormDialog open onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '保存系统' }));
    expect(mocks.createTarget).not.toHaveBeenCalled();
    expect(lastNotify()).toMatchObject({ kind: 'warning', text: '请填写系统名称。' });

    fireEvent.change(screen.getByLabelText('系统名称'), { target: { value: '蒙电OA' } });
    fireEvent.click(screen.getByRole('button', { name: '保存系统' }));
    expect(mocks.createTarget).not.toHaveBeenCalled();
    expect(lastNotify()).toMatchObject({ kind: 'warning', text: '请填写登录地址 (URL)。没有地址无法打开或填充。' });
  });

  it('地址填够三位才做相似检查，命中时提示改为在已有系统下加账号', async () => {
    mocks.similarTargets.mockResolvedValue([{ id: 't1', displayName: '蒙电OA', targetType: 'web', credentialCount: 2 }]);
    renderWithClient(<TargetFormDialog open onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('登录地址 (URL)'), { target: { value: 'https://oa.example.cn' } });
    expect(await screen.findByText(/发现 1 个地址相近的已有系统/)).toBeInTheDocument();
    expect(screen.getByText('蒙电OA · 网页 · 已有 2 个账号')).toBeInTheDocument();
    await waitFor(() => expect(mocks.similarTargets).toHaveBeenCalledWith('https://oa.example.cn'));
  });

  it('成功后把新建系统的 id 交回调用方，由页面选中它', async () => {
    const onSaved = vi.fn();
    renderWithClient(<TargetFormDialog open onClose={vi.fn()} onSaved={onSaved} />);
    fill('蒙电OA', 'web', '登录地址 (URL)', 'https://oa.example.cn');
    fireEvent.click(screen.getByRole('button', { name: '保存系统' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith('t-new'));
  });
});

describe('TargetFormDialog 与后端命令的字段契约', () => {
  it('数据库连接串拆出主机、端口、库名，被界面撤掉的栏位发空串而不是缺键', async () => {
    renderWithClient(<TargetFormDialog open onClose={vi.fn()} onSaved={vi.fn()} />);
    fill('报表库C', 'database', '连接字符串', 'jdbc:mysql://127.0.0.1:3306/orcl');
    fireEvent.click(screen.getByRole('button', { name: '保存系统' }));
    await waitFor(() => expect(mocks.createTarget).toHaveBeenCalledTimes(1));
    expect(lastPayload()).toEqual({
      displayName: '报表库C',
      targetType: 'database',
      url: 'jdbc:mysql://127.0.0.1:3306/orcl',
      allowedOrigin: '',
      host: '127.0.0.1',
      port: '3306',
      databaseName: 'orcl',
      tenant: '',
      vendor: '',
      protocol: 'mysql',
      groupId: null,
    });
  });

  it('网页类带路径的深链派生出精确 Origin：填充按 origin 逐字比对，留空等于这条链是死的', async () => {
    renderWithClient(<TargetFormDialog open onClose={vi.fn()} onSaved={vi.fn()} />);
    fill('蒙电OA', 'web', '登录地址 (URL)', 'https://oa.example.cn/login');
    fireEvent.click(screen.getByRole('button', { name: '保存系统' }));
    await waitFor(() => expect(mocks.createTarget).toHaveBeenCalledTimes(1));
    expect(lastPayload()).toMatchObject({ allowedOrigin: 'https://oa.example.cn', host: 'oa.example.cn' });
  });

  it('解析结果实时回显，端口写错在界面上就能看见', () => {
    renderWithClient(<TargetFormDialog open onClose={vi.fn()} onSaved={vi.fn()} />);
    fill('机房终端B', 'terminal', '连接地址 (IP:Port)', '10.0.0.9:22');
    expect(screen.getByText(/主机 10\.0\.0\.9 · 端口 22 · 协议 ssh/)).toBeInTheDocument();
  });
});

function lastPayload() {
  return mocks.createTarget.mock.calls[0][0] as Record<string, unknown>;
}

function lastUpdate(): [string, Record<string, unknown>] {
  const call = mocks.updateTarget.mock.calls[0];
  return [call[0] as string, call[1] as Record<string, unknown>];
}

describe('TargetFormDialog 编辑形态（交付方 2026-10-19：系统要能改名称与全部字段）', () => {
  it('初值取自 target_detail：名称、类型、分组与那一栏地址都回显，按钮叫「保存修改」', async () => {
    renderWithClient(<TargetFormDialog open targetId="t-9" onClose={vi.fn()} onSaved={vi.fn()} />);
    await screen.findByLabelText('系统名称');

    expect(screen.getByRole('dialog', { name: '编辑系统' })).toBeInTheDocument();
    expect(mocks.targetDetail).toHaveBeenCalledWith('t-9');
    expect(screen.getByLabelText('系统名称')).toHaveValue('蒙电OA');
    expect(screen.getByLabelText('登录地址 (URL)')).toHaveValue('https://oa.example.cn/login');
    expect((screen.getByLabelText('系统类型') as HTMLSelectElement).value).toBe('web');
    // 分组那一档要等 list_groups 回来才有对应 option：在那之前 select.value 只能是空串
    await screen.findByRole('option', { name: '办公系统' });
    expect((screen.getByLabelText('分组') as HTMLSelectElement).value).toBe('g1');
    // 新建走的那条路径在编辑形态里一次都不该被碰
    expect(mocks.createTarget).not.toHaveBeenCalled();
  });

  it('一个字没改也保存得回去：分栏按原地址重新派生，tenant/vendor 带后端原值而不是被清成空串', async () => {
    renderWithClient(<TargetFormDialog open targetId="t-9" onClose={vi.fn()} onSaved={vi.fn()} />);
    await screen.findByLabelText('系统名称');

    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));
    await waitFor(() => expect(mocks.updateTarget).toHaveBeenCalledTimes(1));
    expect(lastUpdate()[0]).toBe('t-9');
    expect(lastUpdate()[1]).toEqual({
      displayName: '蒙电OA',
      targetType: 'web',
      url: 'https://oa.example.cn/login',
      allowedOrigin: 'https://oa.example.cn',
      host: 'oa.example.cn',
      port: '',
      databaseName: '',
      tenant: '租户A',
      vendor: '',
      protocol: 'https',
      groupId: 'g1',
    });
  });

  it('改了名称与地址就按新值派生分栏，Origin 跟着地址走', async () => {
    renderWithClient(<TargetFormDialog open targetId="t-9" onClose={vi.fn()} onSaved={vi.fn()} />);
    await screen.findByLabelText('系统名称');

    fireEvent.change(screen.getByLabelText('系统名称'), { target: { value: '蒙电OA（新）' } });
    fireEvent.change(screen.getByLabelText('登录地址 (URL)'), { target: { value: 'http://oa.internal.cn' } });
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));

    await waitFor(() => expect(mocks.updateTarget).toHaveBeenCalledTimes(1));
    expect(lastUpdate()[1]).toMatchObject({
      displayName: '蒙电OA（新）',
      url: 'http://oa.internal.cn',
      allowedOrigin: 'http://oa.internal.cn',
      host: 'oa.internal.cn',
      protocol: 'http',
    });
  });

  it('导入来的系统只有分列的 host/port 时按类型拼回那一栏：打开是空地址，等于一保存就抹掉主机', async () => {
    mocks.targetDetail.mockResolvedValue(
      detail({
        target: { ...detail().target, targetType: 'terminal', displayName: '机房终端B' },
        meta: { ...detail().meta, url: '', host: '10.0.0.9', port: '22', protocol: 'ssh', allowedOrigin: '', tenant: '' },
      }),
    );
    renderWithClient(<TargetFormDialog open targetId="t-9" onClose={vi.fn()} onSaved={vi.fn()} />);
    await screen.findByLabelText('系统名称');

    expect(screen.getByLabelText('连接地址 (IP:Port)')).toHaveValue('10.0.0.9:22');
    expect((screen.getByLabelText('系统类型') as HTMLSelectElement).value).toBe('terminal');
    expect(screen.getByText(/主机 10\.0\.0\.9 · 端口 22 · 协议 ssh/)).toBeInTheDocument();
  });

  it('编辑的那条若不是三档类型，下拉保留它的原值：否则初值落不进下拉，一保存就把类型改成了网页', async () => {
    mocks.targetDetail.mockResolvedValue(detail({ target: { ...detail().target, targetType: 'network_device' } }));
    renderWithClient(<TargetFormDialog open targetId="t-9" onClose={vi.fn()} onSaved={vi.fn()} />);
    await screen.findByLabelText('系统名称');

    expect(options('系统类型')).toEqual(['网络设备', '网页', '终端', '数据库']);
    expect((screen.getByLabelText('系统类型') as HTMLSelectElement).value).toBe('network_device');
  });

  it('分组列表认不出后端那条分组时下拉保住原值：否则一保存就把系统移出了它原本的分组', async () => {
    mocks.listGroups.mockResolvedValue([]);
    renderWithClient(<TargetFormDialog open targetId="t-9" onClose={vi.fn()} onSaved={vi.fn()} />);
    await screen.findByLabelText('系统名称');

    const select = screen.getByLabelText('分组') as HTMLSelectElement;
    expect(select.value).toBe('g1');
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual(['未分组', '当前分组（后端原值）']);

    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));
    await waitFor(() => expect(mocks.updateTarget).toHaveBeenCalledTimes(1));
    expect(lastUpdate()[1].groupId).toBe('g1');
  });

  it('相似检查不把正在编辑的这条算成重复', async () => {
    mocks.similarTargets.mockResolvedValue([
      { id: 't-9', displayName: '蒙电OA', targetType: 'web', credentialCount: 2 },
    ]);
    renderWithClient(<TargetFormDialog open targetId="t-9" onClose={vi.fn()} onSaved={vi.fn()} />);

    expect(await screen.findByText('未发现地址相近的已有系统。')).toBeInTheDocument();
    expect(screen.queryByText(/个地址相近的已有系统/)).toBeNull();
  });

  it('保存成功把 id 交回调用方，播报说的是"已保存"而不是"已创建"', async () => {
    const onSaved = vi.fn();
    renderWithClient(<TargetFormDialog open targetId="t-9" onClose={vi.fn()} onSaved={onSaved} />);
    await screen.findByLabelText('系统名称');

    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith('t-9'));
    expect(lastNotify()?.text).toBe('已保存系统：蒙电OA');
  });

  it('后端初值读不到时不给表单：这时候点保存等于把地址栏清空', async () => {
    mocks.targetDetail.mockRejectedValue(new Error('目标不存在'));
    renderWithClient(<TargetFormDialog open targetId="t-9" onClose={vi.fn()} onSaved={vi.fn()} />);

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '保存修改' })).toBeNull();
    // 表单根本没建：拿不到原值时连"看起来能填"的输入框都不给
    expect(screen.queryByLabelText('系统名称')).toBeNull();

    // 弹窗自己那颗关闭钮与页脚那颗都做同一件事：退出这条编辑，不提交任何东西
    fireEvent.click(screen.getAllByRole('button', { name: '关闭' })[0]);
    expect(mocks.updateTarget).not.toHaveBeenCalled();
  });
});
