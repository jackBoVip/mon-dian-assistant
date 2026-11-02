export type CodeFormatResult = { ok: true; text: string } | { ok: false; reason: string };

/**
 * 代码块格式化：按块上标的那门语言分派，认不出的只做通用整理。
 *
 * 两门引擎（js-beautify / sql-formatter）都走**动态 import**：它们合计约 368 KB（min），
 * 打进启动那一块不划算——不点「格式化」的人一辈子不会用到它。vite 因此把它们切成懒加载分片，
 * 首次点击才拉进内存。JSON 用内置解析，零成本。
 *
 * 认不出的语言绝不"猜语法"重排：把 Python 按 JS 规则排一遍会把用户的代码排坏。
 * 那一档只做不改变语义的整理（见 normalizeCode）。
 */
const JS_LANGUAGES = new Set(['javascript', 'js', 'jsx', 'mjs', 'cjs', 'typescript', 'ts', 'tsx']);
const CSS_LANGUAGES = new Set(['css']);
const HTML_LANGUAGES = new Set(['html', 'xml', 'svg', 'vue']);
const SQL_LANGUAGES = new Set(['sql']);

const BEAUTIFY_OPTIONS = { indent_size: 2, end_with_newline: false } as const;

function finished(text: string): CodeFormatResult {
  return { ok: true, text: text.replace(/\s+$/, '') };
}

function reasonOf(raw: unknown): string {
  return raw instanceof Error ? raw.message : String(raw);
}

/**
 * 通用整理：只动空白，绝不动语法。
 * CRLF 归一成 LF、Tab 换两空格、去行尾空格、连续空行压成一行、去掉首尾空行。
 */
export function normalizeCode(source: string): string {
  const lines = source
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, '').replace(/\t/g, '  '));
  const kept: string[] = [];
  for (const line of lines) {
    if (line === '' && (kept.length === 0 || kept[kept.length - 1] === '')) continue;
    kept.push(line);
  }
  while (kept.length > 0 && kept[kept.length - 1] === '') kept.pop();
  return kept.join('\n');
}

export async function formatCode(language: string | null | undefined, source: string): Promise<CodeFormatResult> {
  const lang = (language ?? '').trim().toLowerCase();
  const code = source.replace(/\r\n?/g, '\n');
  if (code.trim() === '') return { ok: true, text: '' };

  if (lang === 'json') {
    try {
      return finished(JSON.stringify(JSON.parse(code), null, 2));
    } catch (raw) {
      return { ok: false, reason: `这段 JSON 解析不过：${reasonOf(raw)}` };
    }
  }

  if (JS_LANGUAGES.has(lang)) {
    const { default: beautify } = await import('js-beautify');
    return finished(beautify.js_beautify(code, BEAUTIFY_OPTIONS));
  }

  if (CSS_LANGUAGES.has(lang)) {
    const { default: beautify } = await import('js-beautify');
    return finished(beautify.css_beautify(code, BEAUTIFY_OPTIONS));
  }

  if (HTML_LANGUAGES.has(lang)) {
    const { default: beautify } = await import('js-beautify');
    return finished(beautify.html_beautify(code, BEAUTIFY_OPTIONS));
  }

  if (SQL_LANGUAGES.has(lang)) {
    const { format } = await import('sql-formatter');
    try {
      return finished(format(code, { language: 'sql', keywordCase: 'upper' }));
    } catch (raw) {
      return { ok: false, reason: `这段 SQL 解析不过：${reasonOf(raw)}` };
    }
  }

  return finished(normalizeCode(code));
}

/** 界面 tooltip 用：这一档点了会真重排，那一档只是整理空白，别说同一条话。 */
export function formatHint(language: string | null | undefined): string {
  const lang = (language ?? '').trim().toLowerCase();
  if (lang === 'json' || JS_LANGUAGES.has(lang) || CSS_LANGUAGES.has(lang) || HTML_LANGUAGES.has(lang) || SQL_LANGUAGES.has(lang)) {
    return `按 ${lang.toUpperCase()} 的规则重排这段代码`;
  }
  return '整理空白（去行尾空格、Tab 换两空格、压连续空行）；这门语言没有接重排引擎，不动语法';
}
