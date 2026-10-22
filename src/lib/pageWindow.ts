/**
 * 页码窗口算法：总页数少就全列，多就固定两端 + 中间窗口，中间用省略号占位（与原型一致）。
 *
 * 放在 lib 而不是某个组件里，是因为它是**纯函数**且只有一处活的界面在用它
 * （账号中心的页码条）。审查 F16 清掉的那份 `components/accounts/Pagination.tsx`
 * 曾经自带一个没有任何生产页面渲染的分页条组件，窗口算法反倒被两处共用——
 * 现在算法在这里，形状在 `ui/pagination.tsx`，用它的地方只有 `pages/AccountsPage.tsx`。
 */
export function pageItems(current: number, totalPages: number): (number | 'gap')[] {
  if (totalPages <= 7) return range(1, totalPages);
  if (current <= 4) return [...range(1, 5), 'gap', totalPages];
  if (current >= totalPages - 3) return [1, 'gap', ...range(totalPages - 4, totalPages)];
  return [1, 'gap', current - 1, current, current + 1, 'gap', totalPages];
}

function range(from: number, to: number): number[] {
  const out: number[] = [];
  for (let i = from; i <= to; i++) out.push(i);
  return out;
}
