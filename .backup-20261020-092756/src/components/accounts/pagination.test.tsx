import { chooseOption, selectValue } from '../../test/select';
import { fireEvent, render, screen } from '@testing-library/react';
import { vi } from 'vitest';
import { Pagination, pageItems } from './Pagination';

function props(total: number, page: number, pageSize = 20) {
  return {
    total,
    page,
    pageSize,
    onPage: vi.fn(),
    onPageSize: vi.fn(),
  };
}

describe('pageItems 页码窗口', () => {
  it('总页数少时全列，不出现省略号', () => {
    expect(pageItems(1, 3)).toEqual([1, 2, 3]);
    expect(pageItems(7, 7)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('页数多时两端保留、中间开窗，原型那种 1…12 不会出现 12 个按钮', () => {
    expect(pageItems(1, 12)).toEqual([1, 2, 3, 4, 5, 'gap', 12]);
    expect(pageItems(6, 12)).toEqual([1, 'gap', 5, 6, 7, 'gap', 12]);
    expect(pageItems(12, 12)).toEqual([1, 'gap', 8, 9, 10, 11, 12]);
  });
});

describe('Pagination 的可达性与状态', () => {
  it('当前页用 aria-current 标出，总数与页码读得出来', () => {
    render(<Pagination {...props(245, 6)} />);
    expect(screen.getByText(/共 245 条/)).toBeInTheDocument();
    expect(screen.getByText(/第 6 \/ 13 页/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '6' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('button', { name: '13' })).toBeInTheDocument();
    expect(screen.getAllByText('…')).toHaveLength(2);
  });

  it('两端边界真正禁用，点击把页码原样交出去', () => {
    const p = props(45, 2);
    const view = render(<Pagination {...p} />);
    expect(screen.getByRole('button', { name: '上一页' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: '上一页' }));
    expect(p.onPage).toHaveBeenCalledWith(1);

    fireEvent.click(screen.getByRole('button', { name: '3' }));
    expect(p.onPage).toHaveBeenLastCalledWith(3);
    view.unmount();

    const last = props(45, 3);
    render(<Pagination {...last} />);
    expect(screen.getByRole('button', { name: '下一页' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '上一页' })).toBeEnabled();
  });

  it('每页条数选择只给 10/20/50/100，改动交回后端上限内的值', async () => {
    const p = props(45, 1);
    render(<Pagination {...p} />);
    expect(selectValue('每页条数')).toBe('20');
    await chooseOption('每页条数', '100');
    expect(p.onPageSize).toHaveBeenCalledWith(100);
  });

  it('总数 0 也至少有一页，页码不会出现 0', () => {
    render(<Pagination {...props(0, 1)} />);
    expect(screen.getByText(/共 0 条/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '1' })).toBeInTheDocument();
  });
});
