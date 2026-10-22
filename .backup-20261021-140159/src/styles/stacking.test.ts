import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 模态层的层叠守卫。
 *
 * Radix 把 Overlay（遮罩）与 Content（面板）渲染成 body 下的**两个兄弟节点**，
 * 不再是 AD 之前手写版那种「面板是遮罩这个 flex 容器的子节点」。子节点天然画在父元素背景之上，
 * 兄弟节点没有这件事——那时 `.overlay-veil` 上残留的 z-index 40/50 就从"整层的抬高量"
 * 变成了"遮罩压在整层之上"。jsdom 不做层叠，所以这里比的是**规则与挂载顺序**，
 * 像素级那一遍走 .scratch 里的浏览器探针。
 */

const require = createRequire(import.meta.url);
const postcss = require('postcss');

const ROOT = resolve(process.cwd());
const css = readFileSync(join(ROOT, 'src/styles/global.css'), 'utf8');

/** 摊平 @layer 后按选择器逐字取 z-index；规则或声明不存在时给 null。 */
function zIndexOf(selector: string): number | null {
  let found: number | null = null;
  const walk = (node: { nodes?: unknown[] }) => {
    for (const child of (node.nodes ?? []) as Array<Record<string, unknown>>) {
      if (child.type === 'rule') {
        const sel = String(child.selector).replace(/\s+/g, ' ').trim();
        if (sel !== selector) continue;
        for (const decl of (child.nodes ?? []) as Array<Record<string, unknown>>) {
          if (decl.type === 'decl' && decl.prop === 'z-index') found = Number(String(decl.value).trim());
        }
      } else if (child.type === 'atrule' && String(child.name) !== 'media' && String(child.name) !== 'supports') {
        walk(child as never);
      }
    }
  };
  walk(postcss.parse(css));
  return found;
}

const VEIL_DRAWER = zIndexOf('.overlay-veil');
const VEIL_MODAL = zIndexOf('.overlay-veil--center');
const PANEL_DRAWER = zIndexOf('.overlay-dialog--drawer');
const PANEL_MODAL = zIndexOf('.overlay-dialog');
const MENU = zIndexOf('.popover-panel');

describe('模态层：遮罩必须在面板之下', () => {
  it('面板与它自己的遮罩同档，靠 DOM 顺序压在遮罩上（缺任何一档都是本轮那个坏法）', () => {
    // 同档而不是更高档：这是 shadcn 那套的做法（Overlay 与 Content 同为 z-50），
    // 谁后挂载谁在上。面板若比遮罩低就是本轮 bug；若更高，两层模态叠起来时
    // （详情抽屉上开编辑弹窗）下面那层的面板会顶穿上面那层的遮罩。
    expect(PANEL_MODAL, '`.overlay-dialog` 没有 z-index —— 它会落在兄弟遮罩之下').toBe(VEIL_MODAL);
    expect(PANEL_DRAWER).toBe(VEIL_DRAWER);
    expect(VEIL_MODAL).not.toBeNull();
    expect(VEIL_DRAWER).not.toBeNull();
    expect(VEIL_MODAL).toBeGreaterThan(VEIL_DRAWER!);
  });

  it('菜单档压在两层模态之上：弹窗里打开的下拉不能被自家遮罩或面板盖住', () => {
    expect(MENU).not.toBeNull();
    expect(MENU!).toBeGreaterThan(VEIL_MODAL!);
    expect(MENU!).toBeGreaterThan(PANEL_MODAL!);
  });

  it('抬高的那一枚 `.popover-panel` 真的挂在所有 portal 浮层上，否则这条规则够不到任何东西', () => {
    // 清单由被检对象推导：凡是 Radix 的 Content 落进 portal 的那几处，类名里都得有 popover-panel。
    const sources: Array<[string, string]> = [
      ['src/components/ui/select.tsx', 'SelectPrimitive.Content'],
      ['src/components/ui/dropdown-menu.tsx', 'DropdownMenuPrimitive.Content'],
    ];
    for (const [file, tag] of sources) {
      const src = readFileSync(join(ROOT, file), 'utf8');
      const line = src.split('\n').find((l) => l.includes(tag) && l.includes('className'));
      expect(line, `${file} 的 ${tag} 找不到带 className 的那一行`).toBeDefined();
      expect(line, `${file} 的浮层不再挂 .popover-panel —— 它会掉回遮罩之下`).toContain('popover-panel');
    }
  });

  it('遮罩先于面板挂载：同档时谁在后谁在上，顺序反了层叠就反了', () => {
    const pairs: Array<[string, string, string]> = [
      ['src/components/ui/Modal.tsx', '<DialogOverlay', '<DialogContent'],
      ['src/components/ui/sheet.tsx', '<DialogPrimitive.Overlay', '<DialogPrimitive.Content'],
    ];
    for (const [file, overlay, content] of pairs) {
      const src = readFileSync(join(ROOT, file), 'utf8');
      expect(src.indexOf(overlay), `${file} 里找不到 ${overlay}`).toBeGreaterThanOrEqual(0);
      expect(src.indexOf(overlay), `${file}：${overlay} 必须排在 ${content} 前面`).toBeLessThan(src.indexOf(content));
    }
  });
});
