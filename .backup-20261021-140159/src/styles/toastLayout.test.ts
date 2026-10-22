import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 提示条的槽位顺序（2026-10-21，交付方一句「右下角的消息弹窗,内容布局都割裂了不够高级」）。
 *
 * sonner 的 `<li>` 里 DOM 顺序是「关闭 → 图标 → 文案」（node_modules/sonner/dist/index.mjs），
 * 而 `.toast` 原来带着 `justify-content: space-between`——三块被摊到三个角上，就是照片里
 * 「× 在左、✓ 在中、文案贴右」。修法只能是 CSS 的 order：DOM 顺序改不动。
 * jsdom 不算布局，所以这里读规则本身；像素级那一遍归装机。
 */

const require = createRequire(import.meta.url);
// createRequire 的返回值是 any；这里补回 postcss 自带声明的类型，walkRules/walkDecls 的回调参数
// 才不会退化成隐式 any（tsc 的 noImplicitAny 会直接拒收）。
const postcss = require('postcss') as typeof import('postcss');

const css = readFileSync(join(resolve(process.cwd()), 'src/styles/global.css'), 'utf8');
const root = postcss.parse(css);

/** 取某选择器的全部声明（穿透 @layer；同名规则出现多次时合并，后者覆盖前者）。 */
function declsOf(selector: string): Record<string, string> {
  const out: Record<string, string> = {};
  root.walkRules((rule) => {
    if (rule.selector.replace(/\s+/g, ' ').trim() !== selector) return;
    rule.walkDecls((d) => {
      out[d.prop] = d.value.replace(/\s+/g, ' ').trim();
    });
  });
  return out;
}

describe('提示条：图标 → 文案 → 关闭', () => {
  it('三个槽位各给一条 order，且不再用 space-between 把 DOM 顺序摊到三个角上', () => {
    const toast = declsOf('.toast');
    expect(toast['justify-content'], '`space-between` 会把 sonner 的 关闭/图标/文案 摊到三个角上').toBeUndefined();
    expect(declsOf('.toast [data-icon]').order).toBe('0');
    expect(declsOf('.toast [data-content]').order).toBe('1');
    expect(declsOf('.toast-dismiss').order).toBe('2');
  });

  it('图标槽撑一条行高并在里面居中，多行文案时对齐第一行', () => {
    const icon = declsOf('.toast [data-icon]');
    expect(icon['height']).toBe('20px');
    expect(icon['display']).toBe('flex');
    expect(icon['align-items']).toBe('center');
  });

  it('文案吃掉剩余宽度，长串不撑破 320px', () => {
    const content = declsOf('.toast [data-content]');
    expect(content['flex']).toMatch(/^1\b/);
    expect(content['min-width']).toBe('0');
    expect(content['overflow-wrap']).toBe('anywhere');
  });

  it('语气只染图标：四条各指各的令牌', () => {
    expect(declsOf('.toast-tone-info [data-icon]').color).toBe('var(--t-text-muted)');
    expect(declsOf('.toast-tone-success [data-icon]').color).toBe('var(--t-success)');
    expect(declsOf('.toast-tone-warning [data-icon]').color).toBe('var(--t-warning)');
    expect(declsOf('.toast-tone-danger [data-icon]').color).toBe('var(--t-danger)');
    // 正文色归提示条自己给，不再从语气类继承
    expect(declsOf('.toast').color).toBe('var(--t-text)');
  });
});
