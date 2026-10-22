import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  GLASS_TOKENS,
  THEME_TOKEN_NAMES,
  buildThemeRule,
  parseThemeTokens,
  resolveThemeTokens,
} from './themeTokens';

/**
 * 主题 token 的解析与把关。
 *
 * 这一份文本会变成页面里的 CSS，所以它按**输入不可信**处理：只认白名单里的令牌名，
 * 值逐枚按字面类型校验，任何一行不合规就整份拒掉并指名行号；生成 CSS 时永远由我们自己
 * 拼接片段，绝不把用户原文塞进 style 标签。
 */

const ROOT = resolve(process.cwd());
const tokensCss = readFileSync(join(ROOT, 'src/styles/tokens.css'), 'utf8');

/** 从 tokens.css 的 glass 块里现取令牌表——白名单不许是手抄的第二份真相。 */
function glassBlock(): Map<string, string> {
  const m = new Map<string, string>();
  const block = tokensCss.match(/\[data-theme="glass"\]\s*\{([\s\S]*?)\n\}/);
  if (!block) throw new Error('tokens.css 里找不到 [data-theme="glass"] 块');
  for (const line of block[1].split('\n')) {
    const g = /^\s*(--[\w-]+):\s*(.+?);\s*$/.exec(line);
    if (g) m.set(g[1], g[2]);
  }
  return m;
}

describe('白名单本身', () => {
  it('令牌名与 tokens.css 的 glass 块成对：缺失 0 且陈旧 0', () => {
    const real = [...glassBlock().keys()];
    expect(THEME_TOKEN_NAMES.filter((n) => !real.includes(n)), '有名单里没有的令牌名（陈旧）').toEqual([]);
    expect(real.filter((n) => !THEME_TOKEN_NAMES.includes(n)), 'tokens.css 里有、名单里没有（缺失）').toEqual([]);
    expect(THEME_TOKEN_NAMES.length).toBe(real.length);
    expect(THEME_TOKEN_NAMES.length).toBeGreaterThanOrEqual(30);
  });

  it('GLASS_TOKENS 的逐枚取值与 tokens.css 完全一致（兜底值不能漂）', () => {
    const real = glassBlock();
    for (const [name, value] of real) {
      expect(GLASS_TOKENS[name], `${name} 的兜底值与 tokens.css 不一致`).toBe(value);
    }
    expect(Object.keys(GLASS_TOKENS).sort()).toEqual([...real.keys()].sort());
  });
});

describe('parseThemeTokens', () => {
  it('一整套 32 枚原样粘进来：通过，且逐枚等于 tokens.css 的那一份', () => {
    const text = [...glassBlock()].map(([k, v]) => `${k}: ${v};`).join('\n');
    const res = parseThemeTokens(text);
    expect(res.ok).toBe(true);
    if (res.ok) expect(Object.keys(res.tokens).length).toBe(THEME_TOKEN_NAMES.length);
  });

  it('只给一部分也收：没给的由 resolveThemeTokens 用 glass 兜底，凑齐整套', () => {
    const res = parseThemeTokens('--t-primary: #7c9ed4;\n--t-bg: #0b1020;');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const full = resolveThemeTokens(res.tokens);
    expect(full['--t-primary']).toBe('#7c9ed4');
    expect(full['--t-bg']).toBe('#0b1020');
    // 没提的必须逐项落回 glass，而不是留空——留空等于整站 var() 取不到值
    expect(full['--t-text']).toBe(glassBlock().get('--t-text'));
    expect(Object.keys(full).sort()).toEqual([...THEME_TOKEN_NAMES].sort());
  });

  it('注释、空行、`--t-x: v` 之外的排版噪音都能读（模板里带注释）', () => {
    const res = parseThemeTokens('/* 主色 */\n\n  --t-primary:   #4f46e5  ;\n// 行注释\n--t-danger: #e11d48;');
    expect(res.ok, JSON.stringify(res.ok ? [] : res.errors)).toBe(true);
  });

  const bad: Array<[string, string]> = [
    ['未知令牌名', '--t-nonsense: #fff;'],
    ['少了前缀', 't-primary: #fff;'],
    ['颜色位数不对', '--t-primary: #4f46e;'],
    ['颜色里有非法字符', '--t-primary: #4f46e5;;'],
    ['rgb 参数个数不对', '--t-surface: rgb(1,2);'],
    ['url() 一律不收', '--t-bg: url("http://x/y.png");'],
    ['expression() 不收', '--t-bg: expression(alert(1));'],
    ['blur 只能是 blur(<len>)', '--blur: 40px;'],
    ['blur 的单位不收 em', '--blur: blur(2em);'],
    ['阴影不接受关键字颜色之外的函数', '--shadow-sm: 0 2px 8 var(--t-primary) x;'],
    ['var() 只能指向白名单里的令牌', '--t-accent: var(--t-unknown);'],
    ['值里带闭合大括号', '--t-primary: }body{display:none'],
    ['值里带尖括号', '--t-primary: <img src=x>;'],
    ['重复声明同一枚', '--t-primary: #fff;\n--t-primary: #000;'],
  ];
  it.each(bad)('拒掉：%s', (_why, text) => {
    const res = parseThemeTokens(text);
    expect(res.ok, `这行本该被拒：${text}`).toBe(false);
    if (res.ok) return;
    expect(res.errors.length).toBeGreaterThan(0);
    expect(res.errors[0].line).toBeGreaterThan(0);
    expect(res.errors[0].reason.length).toBeGreaterThan(0);
  });

  it('一次报全所有错行，不是撞到第一条就返回', () => {
    const res = parseThemeTokens('--t-primary: #zzz;\n--t-bg: #0b1020;\n--t-danger: nope;');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors.map((e) => e.line)).toEqual([1, 3]);
  });

  it('空文本、全是注释的文本都不算通过', () => {
    expect(parseThemeTokens('').ok).toBe(false);
    expect(parseThemeTokens('/* 什么都没写 */\n\n').ok).toBe(false);
  });
});

describe('buildThemeRule', () => {
  it('生成的规则只含白名单令牌，且不含任何注入形状', () => {
    const tokens = resolveThemeTokens({ '--t-primary': '#7c9ed4' });
    const css = buildThemeRule('a1b2c3', tokens);
    expect(css.startsWith('[data-theme="custom-a1b2c3"]{')).toBe(true);
    expect(css).toContain('--t-primary:#7c9ed4;');
    expect(THEME_TOKEN_NAMES.every((n) => css.includes(`${n}:`))).toBe(true);
    // 反向：注入面用得着的字符一个都不许出现。整份输出必须是**一行**、只有一对花括号。
    for (const danger of ['<', '>', '@', '\\', 'url(', 'expression(']) {
      expect(css.includes(danger), `生成结果里出现了 ${danger}`).toBe(false);
    }
    expect(css.split('\n')).toHaveLength(1);
    expect(css.match(/\{/g)).toHaveLength(1);
    expect(css.match(/\}/g)).toHaveLength(1);
  });

  it('id 只接受 [a-z0-9-] 的形状，别的直接给空串（它会进选择器）', () => {
    const full = resolveThemeTokens({});
    expect(buildThemeRule('a1b2c3', full)).not.toBe('');
    expect(buildThemeRule('../x', full)).toBe('');
    expect(buildThemeRule('a b', full)).toBe('');
    expect(buildThemeRule('a"b', full)).toBe('');
  });
});
