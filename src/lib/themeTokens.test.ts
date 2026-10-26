import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { THEME_TOKEN_NAMES, buildThemeRule, parseThemeTokens } from './themeTokens';

/**
 * 主题 token 的解析与把关。
 *
 * 这一份文本会变成页面里的 CSS，所以它按**输入不可信**处理：只认白名单里的令牌名，
 * 值逐枚按字面类型校验，任何一行不合规就整份拒并指名行号；生成 CSS 永远由我们自己拼片段，
 * 绝不把用户原文塞进 style 标签。
 *
 * 这里的"一整套合法值"不手抄，全部从 tokens.css 的 glass 块现取（`glassBlock()`）：
 * 名单、合法样本、模板示例值三样都对着同一份既有事实，测试不会变成第二真相。
 */

const ROOT = resolve(process.cwd());
const tokensCss = readFileSync(join(ROOT, 'src/styles/tokens.css'), 'utf8');

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

/** 一整套合法的粘贴内容（可覆盖其中几枚），用来走"应当通过"那条路。 */
function fullPaste(overrides: Record<string, string> = {}): string {
  const merged = new Map(glassBlock());
  for (const [k, v] of Object.entries(overrides)) merged.set(k, v);
  return [...merged].map(([k, v]) => `${k}: ${v};`).join('\n');
}

describe('白名单本身', () => {
  it('令牌名与 tokens.css 的 glass 块成对：缺失 0 且陈旧 0', () => {
    const real = [...glassBlock().keys()];
    expect((THEME_TOKEN_NAMES as readonly string[]).filter((n) => !real.includes(n)), '有名单里没有的令牌名（陈旧）').toEqual([]);
    expect(real.filter((n) => !(THEME_TOKEN_NAMES as readonly string[]).includes(n)), 'tokens.css 里有、名单里没有（缺失）').toEqual([]);
    expect(THEME_TOKEN_NAMES.length).toBe(real.length);
    expect(THEME_TOKEN_NAMES.length).toBeGreaterThanOrEqual(30);
  });
});

describe('parseThemeTokens', () => {
  it('一整套原样粘进来：通过，且逐枚等于 tokens.css 的那一份', () => {
    const res = parseThemeTokens(fullPaste());
    expect(res.ok, JSON.stringify(res.ok ? [] : res.errors)).toBe(true);
    if (!res.ok) return;
    expect(Object.keys(res.tokens).length).toBe(THEME_TOKEN_NAMES.length);
    for (const [k, v] of glassBlock()) expect(res.tokens[k]).toBe(v);
  });

  it('整套之上改两枚：通过，改的那两枚按用户给的值收', () => {
    const res = parseThemeTokens(fullPaste({ '--t-primary': '#0e6ba8', '--t-bg': '#eef4f8' }));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.tokens['--t-primary']).toBe('#0e6ba8');
      expect(res.tokens['--t-bg']).toBe('#eef4f8');
    }
  });

  it('缺枚就整份不收，并把缺的点名（半套规则进界面比不进去更糟）', () => {
    const body = [...glassBlock()].slice(0, 20).map(([k, v]) => `${k}: ${v};`).join('\n');
    const res = parseThemeTokens(body);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0].reason).toContain('少了 12 枚');
    expect(res.errors[0].reason).toContain('--glow-inset');
  });

  it('注释、空行、缩进、行尾分号有无这些排版噪音都能读（模板里就带着它们）', () => {
    const res = parseThemeTokens(fullPaste().replace('--t-primary:', '  /* 主色 */\n  --t-primary:'));
    expect(res.ok, JSON.stringify(res.ok ? [] : res.errors)).toBe(true);
    expect(parseThemeTokens(fullPaste().replace(/;$/gm, '')).ok).toBe(true);
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
    ['阴影层看不懂', '--shadow-sm: 0 2px 8 var(--t-primary) x;'],
    ['var() 只能指向白名单里的令牌', '--t-accent: var(--t-unknown);'],
    ['值里带闭合大括号', '--t-primary: }body{display:none'],
    ['值里带尖括号', '--t-primary: <img src=x>;'],
    ['重复声明同一枚', '--t-primary: #fff;\n--t-primary: #000;'],
  ];
  it.each(bad)('拒掉：%s', (_why, line) => {
    // 其余各枚都用合法值补齐，这样"被拒"只可能因为追加的这几行本身
    const res = parseThemeTokens(fullPaste() + '\n' + line);
    expect(res.ok, `这几行本该被拒：${line}`).toBe(false);
    if (res.ok) return;
    expect(res.errors.length).toBeGreaterThan(0);
    expect(res.errors.some((e) => e.line > 0)).toBe(true);
  });

  it('一次报全所有坏行，不是撞到第一条就返回', () => {
    const res = parseThemeTokens('--t-primary: #zzz;\n--t-bg: #0b1020;\n--t-danger: nope;');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors.map((e) => e.line)).toEqual([1, 3]);
  });

  it('空文本、全是注释的文本都不算通过', () => {
    expect(parseThemeTokens('').ok).toBe(false);
    expect(parseThemeTokens('/* 什么都没写 */\n\n').ok).toBe(false);
  });

  it('出厂那份模板原样粘回来必须过，且它的示例值与 tokens.css 逐枚相同（模板不许漂）', async () => {
    const { TOKEN_TEMPLATE } = await import('./themeTokens');
    const res = parseThemeTokens(TOKEN_TEMPLATE);
    expect(res.ok, JSON.stringify(res.ok ? [] : res.errors)).toBe(true);
    if (!res.ok) return;
    for (const [k, v] of glassBlock()) expect(res.tokens[k], `${k} 的模板值与 tokens.css 不一致`).toBe(v);
  });
});

describe('buildThemeRule', () => {
  it('生成的规则只含白名单令牌，且不含任何注入形状', () => {
    const css = buildThemeRule('a1b2c3', Object.fromEntries(glassBlock().set('--t-primary', '#7c9ed4')));
    expect(css.startsWith('[data-theme="custom-a1b2c3"]{')).toBe(true);
    expect(css).toContain('--t-primary:#7c9ed4;');
    expect(THEME_TOKEN_NAMES.every((n) => css.includes(`${n}:`))).toBe(true);
    // 反向：注入面用得着的字符一个都不许出现。整份输出必须是一行、只有一对花括号。
    for (const danger of ['<', '>', '@', '\\', 'url(', 'expression(']) {
      expect(css.includes(danger), `生成结果里出现了 ${danger}`).toBe(false);
    }
    expect(css.split('\n')).toHaveLength(1);
    expect(css.match(/\{/g)).toHaveLength(1);
    expect(css.match(/\}/g)).toHaveLength(1);
  });

  it('id 形状不对，或缺任何一枚令牌：整条不注入（宁可不给，也不给半套）', () => {
    const full = Object.fromEntries(glassBlock());
    expect(buildThemeRule('a1b2c3', full)).not.toBe('');
    expect(buildThemeRule('../x', full)).toBe('');
    expect(buildThemeRule('a b', full)).toBe('');
    expect(buildThemeRule('a"b', full)).toBe('');
    const partial = { ...full } as Record<string, string>;
    delete partial['--t-danger'];
    expect(buildThemeRule('a1b2c3', partial)).toBe('');
  });
});
