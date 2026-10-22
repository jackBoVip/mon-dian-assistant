import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditSection } from './AuditSection';
import type { AuditRow } from '../../lib/types';
import { chooseOption, selectValue } from '../../test/select';

const mocks = vi.hoisted(() => ({ audit: vi.fn() }));

vi.mock('../../lib/api', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../lib/api')>();
  return { ...mod, api: { ...mod.api, ...mocks } };
});

function row(i: number): AuditRow {
  return {
    id: `e-${i}`,
    ts: `2026-10-21T12:00:${String(i % 60).padStart(2, '0')}Z`,
    actorId: '01a15899',
    actorNickname: '周红波',
    action: `test.action.${i}`,
    targetType: 'app_user',
    targetId: `u-${i}`,
    result: 'success',
    errorCode: null,
    source: 'app',
  };
}

function rows(n: number): AuditRow[] {
  return Array.from({ length: n }, (_, i) => row(i + 1));
}

function renderSection() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={qc}>
      <AuditSection />
    </QueryClientProvider>,
  );
}

const table = () => screen.getByRole('table');

beforeEach(() => {
  mocks.audit.mockReset();
  mocks.audit.mockResolvedValue(rows(25));
});

describe('审计日志：分页表格 + 固定表头', () => {
  it('一次取满后端上限，首屏只渲染第一页；页顶不再有「显示条数」', async () => {
    renderSection();
    await screen.findByText('test.action.1');

    expect(mocks.audit).toHaveBeenCalledWith(1000);
    expect(screen.queryByText('显示条数')).toBeNull();
    // 交付方点名撤掉的那句说明不得再上屏（"只读追加"这件事改由后端能力保证，界面上不再陈述）
    expect(screen.queryByText(/审计日志为追加式记录/)).toBeNull();
    expect(selectValue('每页条数')).toBe('20 条/页');

    // 表头 1 行 + 第一页 20 行
    expect(within(table()).getAllByRole('row')).toHaveLength(21);
    expect(screen.getByText('test.action.20')).toBeInTheDocument();
    expect(screen.queryByText('test.action.21')).toBeNull();
    expect(screen.getByRole('status').textContent).toContain('共 25 条记录');
  });

  it('翻到第 2 页只渲染剩下 5 条，末页的下一页禁用、上一页可用', async () => {
    renderSection();
    await screen.findByText('test.action.1');

    fireEvent.click(screen.getByRole('button', { name: '下一页' }));

    expect(within(table()).getAllByRole('row')).toHaveLength(6);
    expect(screen.getByText('test.action.25')).toBeInTheDocument();
    expect(screen.queryByText('test.action.20')).toBeNull();
    expect(screen.getByRole('button', { name: '2' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('button', { name: '下一页' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '上一页' })).not.toBeDisabled();
  });

  it('每页条数在页脚里：改成 100 条/页后一页装下全部 25 条，页码只剩 1', async () => {
    renderSection();
    await screen.findByText('test.action.1');

    // 控件必须落在分页条里（原来是页顶那枚带标签的字段）
    const footer = screen.getByRole('status').parentElement;
    expect(footer).toHaveClass('table-pagination');
    expect(within(footer as HTMLElement).getByLabelText('每页条数')).toBeInTheDocument();

    chooseOption('每页条数', '100 条/页');

    expect(selectValue('每页条数')).toBe('100 条/页');
    expect(within(table()).getAllByRole('row')).toHaveLength(26);
    expect(screen.getByRole('button', { name: '1' })).toHaveAttribute('aria-current', 'page');
    expect(screen.queryByRole('button', { name: '下一页' })).toBeDisabled();
  });

  it('改每页条数后页码回到第 1 页，不会停在旧的越界页上', async () => {
    renderSection();
    await screen.findByText('test.action.1');
    fireEvent.click(screen.getByRole('button', { name: '下一页' }));
    expect(screen.getByText('test.action.25')).toBeInTheDocument();

    chooseOption('每页条数', '50 条/页');

    expect(within(table()).getAllByRole('row')).toHaveLength(26);
    expect(screen.getByText('test.action.1')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '1' })).toHaveAttribute('aria-current', 'page');
  });

  it('取满 1000 条时页脚如实说明「仅加载最近 1000 条」', async () => {
    mocks.audit.mockResolvedValue(rows(1000));
    renderSection();
    await screen.findByText('test.action.1');

    expect(screen.getByRole('status').textContent).toContain('共 1000 条记录（仅加载最近 1000 条）');
    expect(within(table()).getAllByRole('row')).toHaveLength(21);
  });

  it('表头在卡片自己的滚动区里吸顶', async () => {
    renderSection();
    await screen.findByText('test.action.1');

    const head = table();
    const scroll = head.parentElement as HTMLElement;
    // 三件事缺一不可：卡片撑满高度、卡片内自滚、<th> 落在自滚区内并吸顶
    expect(head).toHaveClass('table-sticky-head');
    expect(scroll).toHaveClass('audit-table-scroll');
    expect(scroll.parentElement).toHaveClass('table-wrap', 'audit-table');
    expect(within(scroll).getByRole('columnheader', { name: '时间' })).toBeInTheDocument();

    const css = readFileSync(resolve(process.cwd(), 'src/styles/global.css'), 'utf8');
    expect(css).toMatch(/\.audit-table-scroll\s*\{[^}]*overflow:\s*auto/);
    // AV 轮给选择器加了 thead 限定：菜单树用 `<th scope="row">` 画行名，不限定时整列行头也会吸顶。
    expect(css).toMatch(/\.table-sticky-head\s+thead\s+th\s*\{[^}]*position:\s*sticky/);
    // separate 是 WebKit 下吸顶单元格保住边框的前提，别为了"跟别的表一致"改回 collapse
    expect(css).toMatch(/\.table-sticky-head\s*\{[^}]*border-collapse:\s*separate/);
  });
});

describe('中文列与居中（交付方：表格列要居中、操作人不显示 UUID、动作与对象用中文）', () => {
  const ACTOR_ID = '01a15899-daa1-74a8-8cfe-6a5076eebb95';

  /** 一条已知动作 + 一条后端将来可能有的未知动作 + 一条带可读标识（文件名）的动作。 */
  function mixedRows(): AuditRow[] {
    return [
      {
        id: 'e-1',
        ts: '2026-10-22T08:45:41Z',
        actorId: ACTOR_ID,
        actorNickname: '周红波',
        action: 'auth.unlock',
        targetType: 'app_user',
        targetId: ACTOR_ID,
        result: 'success',
        errorCode: null,
        source: 'app',
      },
      {
        id: 'e-2',
        ts: '2026-10-22T08:46:41Z',
        actorId: 'u-legacy',
        actorNickname: null,
        action: 'legacy.thing',
        targetType: 'legacy_thing',
        targetId: null,
        result: 'success',
        errorCode: null,
        source: 'app',
      },
      {
        id: 'e-3',
        ts: '2026-10-22T08:47:41Z',
        actorId: ACTOR_ID,
        actorNickname: '周红波',
        action: 'accounts.export.with_secrets',
        targetType: 'file',
        targetId: '蒙电台账-2026-10-22.json.enc',
        result: 'success',
        errorCode: null,
        source: 'app',
      },
    ];
  }

  it('整张表挂 table-center（表头与单元格一起居中）', async () => {
    mocks.audit.mockResolvedValue(mixedRows());
    renderSection();
    await screen.findByText('解锁保险库');
    expect(table()).toHaveClass('table', 'table-center');
  });

  /** 第一行的七枚单元格：列序就是表头那七列，按位置取比按文本猜稳。 */
  async function firstRowCells() {
    mocks.audit.mockResolvedValue(mixedRows());
    renderSection();
    await screen.findByText('解锁保险库');
    return within(table()).getAllByRole('row')[1];
  }

  it('操作人只上昵称，那串 UUID 不再占两行', async () => {
    const cells = (await firstRowCells()).querySelectorAll('td');
    expect(cells[1].textContent).toBe('周红波');
    expect(cells[1].querySelector('.mono')).toBeNull();
  });

  it('没有昵称的历史行回落成 actorId，这一格不会空着', async () => {
    mocks.audit.mockResolvedValue(mixedRows());
    renderSection();
    expect(await screen.findByRole('cell', { name: 'u-legacy' })).toBeInTheDocument();
  });

  it('对象那一格：UUID 主键不上屏，但仍留在 title 里可查', async () => {
    const cells = (await firstRowCells()).querySelectorAll('td');
    expect(cells[2].textContent).toBe('解锁保险库');
    expect(cells[2]).toHaveAttribute('title', 'auth.unlock');
    expect(cells[3].textContent).toBe('使用者');
    expect(cells[3].querySelector('.mono')).toBeNull();
    expect(cells[3]).toHaveAttribute('title', `app_user ${ACTOR_ID}`);
  });

  it('可读标识不算 UUID，照样上屏：否则那一行指不到是哪个文件', async () => {
    mocks.audit.mockResolvedValue(mixedRows());
    renderSection();
    const action = await screen.findByText('导出（含秘密）');
    const object = action.nextElementSibling as HTMLElement;
    expect(object.textContent).toBe('文件蒙电台账-2026-10-22.json.enc');
    expect(object.querySelector('.mono')?.textContent).toBe('蒙电台账-2026-10-22.json.enc');
  });

  it('字典里没有的动作与对象原样显示标识，不显示空白', async () => {
    mocks.audit.mockResolvedValue(mixedRows());
    renderSection();
    expect(await screen.findByText('legacy.thing')).toBeInTheDocument();
    expect(screen.getByText('legacy_thing')).toBeInTheDocument();
  });
});
