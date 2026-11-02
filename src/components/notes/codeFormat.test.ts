import { describe, expect, it } from 'vitest';
import { formatCode, normalizeCode } from './codeFormat';

/**
 * 代码块格式化的分派与兜底。
 *
 * 三条口径：① 按**代码块上标的那门语言**分派，标了 SQL 却拿 JSON 规则去排是错的；
 * ② 认不出的语言只做通用整理，绝不"猜一门语法"去重排——排坏了用户的代码比不排更糟；
 * ③ 引擎报语法错时把原因原样交回界面，不能假装格式化成功。
 */
describe('按语言分派', () => {
  it('JSON：两空格缩进重排', async () => {
    const result = await formatCode('json', '{"sadf":1,"list":[1,2]}');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toBe('{\n  "sadf": 1,\n  "list": [\n    1,\n    2\n  ]\n}');
  });

  it('JSON 语法不过：报的是这段错，不返回半成品', async () => {
    const result = await formatCode('json', '{"sadf" 1}');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('JSON');
  });

  it('JavaScript：换行并补缩进', async () => {
    const result = await formatCode('javascript', 'function f(){return 1}');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 重排器只动空白，不替用户补分号（补了就是改代码，不是格式化）
    expect(result.text).toBe('function f() {\n  return 1\n}');
  });

  it('CSS 与 HTML 各走自己那一档', async () => {
    const css = await formatCode('css', 'a{color:red;padding:0}');
    expect(css.ok).toBe(true);
    if (!css.ok) return;
    expect(css.text).toContain('\n');
    expect(css.text).toMatch(/color: red/);

    const html = await formatCode('html', '<div><p>x</p></div>');
    expect(html.ok).toBe(true);
    if (!html.ok) return;
    expect(html.text).toContain('\n');
  });

  it('SQL：关键字换行成多行', async () => {
    const result = await formatCode('sql', 'select a,b from t where a=1');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toContain('\n');
    expect(result.text).toMatch(/\bFROM\b/);
  });
});

describe('认不出的语言走通用整理', () => {
  it('未标语言：去行尾空格、Tab 换两空格、连续空行压一行、末尾空行去掉', () => {
    expect(normalizeCode('\t\n\na   \n\n\n\nb  \n\n')).toBe('a\n\nb');
  });

  it('通用整理是幂等的（再排一次不该变）', () => {
    const once = normalizeCode('  x\t \n\n\n  y');
    expect(normalizeCode(once)).toBe(once);
  });

  it('python / go / bash 这些没接引擎的：只做通用整理，不动语法', async () => {
    for (const lang of ['python', 'go', 'bash', 'dockerfile', '']) {
      const result = await formatCode(lang, 'def f():\n\treturn 1   \n\n\n');
      expect(result.ok, lang).toBe(true);
      if (!result.ok) continue;
      expect(result.text, lang).toBe('def f():\n  return 1');
    }
  });

  it('空代码块格式化后还是空的，不冒出一行换行', async () => {
    const result = await formatCode('json', '   \n  ');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.text).toBe('');
  });
});
