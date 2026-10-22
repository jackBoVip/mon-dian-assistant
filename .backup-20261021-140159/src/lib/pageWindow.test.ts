import { describe, expect, it } from 'vitest';
import { pageItems } from './pageWindow';

/**
 * 页码窗口的形状就是界面本身（原型那种 1…12 不该长出 12 个按钮）。
 * 审查 F16：这份算法原先住在一个没有任何生产页面渲染的组件文件里，
 * 测试跟着组件一起给人"这块界面有覆盖"的错觉；搬到 lib 之后，
 * 被测的就是 `pages/AccountsPage.tsx` 真正调用的那个函数。
 */
describe('pageItems 页码窗口', () => {
  it('总页数少时全列，不出现省略号', () => {
    expect(pageItems(1, 3)).toEqual([1, 2, 3]);
    expect(pageItems(7, 7)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('页数多时两端保留、中间开窗', () => {
    expect(pageItems(1, 12)).toEqual([1, 2, 3, 4, 5, 'gap', 12]);
    expect(pageItems(6, 12)).toEqual([1, 'gap', 5, 6, 7, 'gap', 12]);
    expect(pageItems(12, 12)).toEqual([1, 'gap', 8, 9, 10, 11, 12]);
  });

  it('边界不回绕、不越界：第 1 页与末页各自只往一个方向走', () => {
    // 两页时第 1 页与第 2 页的窗口形状相同（都全列，没有省略号）
    expect(pageItems(1, 2)).toEqual([1, 2]);
    expect(pageItems(2, 2)).toEqual([1, 2]);
    expect(pageItems(1, 1)).toEqual([1]);
    // 总页数为 0（空列表）时不该画出任何页码
    expect(pageItems(1, 0)).toEqual([]);
  });
});
