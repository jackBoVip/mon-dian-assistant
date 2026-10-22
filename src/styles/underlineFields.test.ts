import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 全站表单字段的"下划线一档"守卫。
 *
 * 这一档原先只活在认证页（`.auth-panel .field` 那七条），业务页面仍是方框 + 沉底 + 聚焦内描边。
 * 本轮把它提到基础层，成为 `.field` 的唯一画法。jsdom 不做层叠，所以这里比的是**规则与配对**：
 *  1. 下划线与走满动画只有一套定义——`.auth-panel` 里不许再留第二份（两份迟早会漂）；
 *  2. 字段里的控件不得再有方框，而 `.field` 之外的行内选择框（`.select-auto` 那两枚）照旧有框——
 *     这两条成对出现才说明"撤框"是按范围做的，不是把 `.input` 整条改没了；
 *  3. 焦点指示只剩走满的下划线：这些控件上的 2px 焦点环必须摘掉，同时 `:focus-within` 必须真的把线走满；
 *  4. 报错与只读两档由组件挂属性、CSS 消费（本仓库不用 `:has()` 判定，见 global.css 里 .input-icon 那条）。
 */

const require = createRequire(import.meta.url);
const postcss = require('postcss');

const ROOT = resolve(process.cwd());
const css = readFileSync(join(ROOT, 'src/styles/global.css'), 'utf8');

interface FlatRule {
  selector: string;
  decls: Map<string, string>;
}

/** 摊平 @layer（它是分组，不改变规则本身），只保留普通规则。 */
function flatten(text: string): FlatRule[] {
  const out: FlatRule[] = [];
  const walk = (node: { nodes?: unknown[] }) => {
    for (const child of (node.nodes ?? []) as Array<Record<string, unknown>>) {
      if (child.type === 'rule') {
        const decls = new Map<string, string>();
        for (const d of (child.nodes ?? []) as Array<Record<string, unknown>>) {
          if (d.type === 'decl') decls.set(String(d.prop), String(d.value).replace(/\s+/g, ' ').trim());
        }
        out.push({ selector: String(child.selector).replace(/\s+/g, ' ').trim(), decls });
      } else if (child.type === 'atrule' && String(child.name) === 'layer') {
        walk(child as never);
      }
    }
  };
  walk(postcss.parse(text));
  return out;
}

const rules = flatten(css);
const bySelector = (sel: string) => rules.filter((r) => r.selector === sel);
const has = (sel: string, prop: string, value?: string) =>
  bySelector(sel).some((r) => r.decls.has(prop) && (value === undefined || r.decls.get(prop) === value));

describe('表单字段的下划线一档', () => {
  it('底线与走满动画挂在控件那一行 `.field-line` 上，且全站只有一套定义', () => {
    // 线画在整块 `.field` 底下会被 hint/报错文字顶开，离输入内容太远（交付方 2026-10-20：
    // "下面的横线和输入的内容距离有点大了,看的有些割裂"），所以落点必须是控件那一行。
    expect(has('.field-line', 'border-bottom'), '`.field-line` 没有底线').toBe(true);
    expect(has('.field-line::after', 'background', 'var(--scene-focus)')).toBe(true);
    expect(has('.field-line::after', 'width', '0'), '静置时线宽必须是 0').toBe(true);
    expect(has('.field-line:focus-within::after', 'width', '100%'), '聚焦时必须把线走满').toBe(true);
    expect(has('.field:focus-within > label', 'color', 'var(--t-text)'), '标签要在聚焦时抬到正文色').toBe(true);
    // 反向：线只有一处定义，`.field` 外壳上不得再画一条
    expect(bySelector('.field::after'), '`.field` 上又画了一条线 → 两条线').toHaveLength(0);
    expect(bySelector('.field:focus-within::after'), '同上').toHaveLength(0);
    expect(
      bySelector('.field').some((r) => [...r.decls.keys()].some((p) => p === 'border-bottom')),
      '`.field` 外壳还在自己画底线',
    ).toBe(false);
    // 认证页那一份也不许留（两份定义迟早漂）
    expect(bySelector('.auth-panel .field::after'), '`.auth-panel .field::after` 与基础层重复').toHaveLength(0);
    expect(bySelector('.auth-panel .field:focus-within::after'), '同上').toHaveLength(0);
  });

  it('每一类字段控件都有 `.field-line` 这一行可挂：文本框、文本域、选择框、密码框', () => {
    const field = readFileSync(join(ROOT, 'src/components/ui/Field.tsx'), 'utf8');
    const pw = readFileSync(join(ROOT, 'src/components/ui/PasswordField.tsx'), 'utf8');
    expect(pw, 'PasswordField 得包在 .field-line 里').toContain('<div className="field-line">');
    // TextField 已有；TextAreaField 与 SelectField 原先直接把控件摊在 .field 下，没有这一行
    const lines = field.split('\n').filter((l) => l.includes('field-line'));
    expect(lines.length, 'TextAreaField 与 SelectField 也要各有一行').toBeGreaterThanOrEqual(3);
    expect(field).toMatch(/<FieldFrame[^>]*>\s*\n\s*<label[^>]*>\{label\}<\/label>\s*\n\s*<div className="field-line">/);
  });

  it('字段里的控件撤掉方框，`.field` 之外的行内选择框照旧有框', () => {
    const controlSel = '.field .input, .field .select';
    expect(has(controlSel, 'border', '0'), '字段里的控件还在画框').toBe(true);
    expect(has(controlSel, 'background', 'none')).toBe(true);
    expect(has(controlSel, 'box-shadow', 'none')).toBe(true);
    expect(has(controlSel, 'padding-left', '0'), '控件文字要与标签左沿对齐').toBe(true);
    // 基础那条必须还在：行内那两枚选择框（成员管理改角色、明文查看器字段选择器）不在 .field 里，仍是方框
    expect(has('.input, .select', 'border', '1px solid var(--t-border-strong)'), '基础方框被整条改没了，撤框超出了范围').toBe(true);
  });

  it('这些控件上的 2px 焦点环摘掉：焦点指示只留那条线，不再叠出第二圈', () => {
    const sel = '.field :is(.input, .select):focus-visible';
    expect(has(sel, 'outline', 'none'), '没摘焦点环 → 下划线外面还会套一个圆角方框').toBe(true);
    // `.auth-panel` 那份同样不许留（同一条判据只写一处）
    expect(bySelector('.auth-panel .input:focus-visible'), '认证页那一份重复定义').toHaveLength(0);
    expect(bySelector('.auth-panel .input:focus'), '认证页那一份重复定义').toHaveLength(0);
  });

  it('报错与只读两档：组件挂属性、CSS 消费（本仓库不用 :has() 判定）', () => {
    const frame = readFileSync(join(ROOT, 'src/components/ui/field-primitives.tsx'), 'utf8');
    expect(frame, 'FieldFrame 得能把 invalid/readonly 写成 data 属性').toMatch(/data-invalid=/);
    expect(frame).toMatch(/data-readonly=/);
    expect(has(".field[data-invalid='true'] .field-line", 'border-bottom-color', 'var(--t-danger)')).toBe(true);
    expect(has(".field[data-invalid='true'] .field-line::after", 'background', 'var(--t-danger)')).toBe(true);
    expect(has(".field[data-readonly='true'] .field-line::after", 'display', 'none'), '只读行的线不该跟着聚焦亮').toBe(true);

    const profile = readFileSync(join(ROOT, 'src/components/shell/ProfileModal.tsx'), 'utf8');
    expect(profile, '只读态改由 .field 上的属性表达，这枚修饰符整族撤了').not.toContain('input-underline');
    // 双向：CSS 里也不留死规则。注释允许引用被作废的旧话，所以先剥掉注释再查。
    expect(css.replace(/\/\*[\s\S]*?\*\//g, ''), '`.input-underline` 那三条规则还在').not.toContain('input-underline');
  });
});
