import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { syncCustomThemeStyles } from './theme';
import type { CustomTheme } from './types';

/**
 * 自定义主题的运行时注入。
 *
 * 这一层是"用户粘的东西最终变成页面 CSS"的唯一落点，所以四件事必须成立：
 *  1. 整站只有**一枚** style 标签，每次全量重建（留量最容易漏的是"删掉的主题还在生效"）；
 *  2. 坏数据不会把整块带崩——某一档的 tokens 读不出来，只跳过那一档；
 *  3. 半套令牌不注入：缺一枚就意味着那一档下某个 var() 取不到值，比停在出厂档更糟；
 *  4. 列表空了标签必须消失，否则删掉最后一档的人，页面上还留着那条规则。
 *
 * 这里的"一整套合法令牌"从 tokens.css 现取，测试不另抄一份色值。
 */

function fullTokens(overrides: Record<string, string> = {}): Record<string, string> {
  const css = readFileSync(join(resolve(process.cwd()), 'src/styles/tokens.css'), 'utf8');
  const block = css.match(/\[data-theme="glass"\]\s*\{([\s\S]*?)\n\}/)?.[1] ?? '';
  const out: Record<string, string> = {};
  for (const line of block.split('\n')) {
    const g = /^\s*(--[\w-]+):\s*(.+?);\s*$/.exec(line);
    if (g) out[g[1]] = g[2];
  }
  return { ...out, ...overrides };
}

function theme(id: string, name: string, tokens: Record<string, string>): CustomTheme {
  return { id, name, tokens: JSON.stringify(tokens) };
}

describe('syncCustomThemeStyles', () => {
  it('注入一枚标签，规则按 custom-<id> 选择器成对出现', () => {
    const doc = document.implementation.createHTMLDocument('t');
    syncCustomThemeStyles(doc, [theme('sea', '海盐蓝', fullTokens({ '--t-primary': '#0e6ba8' }))]);
    const tag = doc.getElementById('mda-custom-themes');
    expect(tag).not.toBeNull();
    expect(tag?.textContent).toContain('[data-theme="custom-sea"]{');
    expect(tag?.textContent).toContain('--t-primary:#0e6ba8');
  });

  it('两档一起注入，各占一条规则；重复调用不累加标签', () => {
    const doc = document.implementation.createHTMLDocument('t');
    const list = [theme('sea', '海盐蓝', fullTokens({ '--t-primary': '#0e6ba8' })), theme('sand', '沙金', fullTokens({ '--t-bg': '#f5efe6' }))];
    syncCustomThemeStyles(doc, list);
    syncCustomThemeStyles(doc, list);
    expect(doc.querySelectorAll('style#mda-custom-themes')).toHaveLength(1);
    expect(doc.getElementById('mda-custom-themes')?.textContent).toContain('custom-sand');
  });

  it('某一档的 tokens 不是合法 JSON：只跳过那一档，其余照常注入且不抛错', () => {
    const doc = document.implementation.createHTMLDocument('t');
    syncCustomThemeStyles(doc, [
      { id: 'broken', name: '坏数据', tokens: '{不是 JSON' },
      theme('sea', '海盐蓝', fullTokens()),
    ]);
    const text = doc.getElementById('mda-custom-themes')?.textContent ?? '';
    expect(text).not.toContain('custom-broken');
    expect(text).toContain('custom-sea');
  });

  it('半套令牌不注入：库被手改坏的那一档宁可没有 CSS，也不给半套', () => {
    const doc = document.implementation.createHTMLDocument('t');
    syncCustomThemeStyles(doc, [theme('half', '缺枚', { '--t-primary': '#0e6ba8' })]);
    expect(doc.getElementById('mda-custom-themes')?.textContent ?? '').not.toContain('custom-half');
  });

  it('列表清空后标签必须撤掉', () => {
    const doc = document.implementation.createHTMLDocument('t');
    syncCustomThemeStyles(doc, [theme('sea', '海盐蓝', fullTokens())]);
    expect(doc.getElementById('mda-custom-themes')).not.toBeNull();
    syncCustomThemeStyles(doc, []);
    expect(doc.getElementById('mda-custom-themes')).toBeNull();
  });

  it('id 形状不对的档不会生成选择器（它会直接拼进 [data-theme=…]）', () => {
    const doc = document.implementation.createHTMLDocument('t');
    syncCustomThemeStyles(doc, [theme('../evil', '越界', fullTokens())]);
    expect(doc.getElementById('mda-custom-themes')?.textContent ?? '').not.toContain('evil');
  });
});
