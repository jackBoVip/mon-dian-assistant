import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 笔记编辑区的高度链守卫。
 *
 * jsdom 不做层叠与布局，这条链断了不会有任何测试变红，只会让界面在真机上坏得很明显：
 * `.notes-prose` 上写着 `overflow-y: auto`，但它的父级是 `EditorContent` 那层**自动高度**的 div——
 * 不把它也变成有界的一列，那档 overflow 就是死的，长正文（例如格式化后一下子多到四十行的代码块）
 * 会直接顶穿编辑卡片，把标题行与工具栏挤没。交付方 2026-10-31 那张照片就是这个。
 */
const css = readFileSync(resolve(process.cwd(), 'src/styles/notesEditor.css'), 'utf8');

function block(selector: string): string {
  const at = css.indexOf(`${selector} {`);
  expect(at, `notesEditor.css 里找不到 ${selector} 这一档`).toBeGreaterThanOrEqual(0);
  return css.slice(at, css.indexOf('}', at));
}

describe('编辑区的高度链必须是有界的', () => {
  it('正文那一格的父层（EditorContent 的 div）自己必须是列向 flex 且 min-height:0', () => {
    const own = block('.note-body > *');
    expect(own).toMatch(/display:\s*flex/);
    expect(own).toMatch(/flex-direction:\s*column/);
    expect(own).toMatch(/min-height:\s*0/);
  });

  it('滚动确实挂在正文上，而不是挂在一个自动高度的盒子上', () => {
    const prose = block('.notes-prose');
    expect(prose).toMatch(/overflow-y:\s*auto/);
    expect(prose).toMatch(/min-height:\s*0/);
  });

  it('标题行与工具栏钉死不缩：正文再长也不该把它们挤出视野', () => {
    expect(block('.note-editor__head')).toMatch(/flex-shrink:\s*0/);
    expect(block('.note-toolbar')).toMatch(/flex:\s*0 0 auto/);
  });
});
