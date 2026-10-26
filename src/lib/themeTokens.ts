/**
 * 自定义主题的 token 解析与把关。
 *
 * 用户可以从「界面外观」里粘一整段 CSS 变量（形如 `--t-primary: #4f46e5;`）来新增一套主题。
 * 这段文本最终会变成页面里的 CSS，所以按**输入不可信**处理：
 *  - 令牌名只认 `THEME_TOKEN_NAMES` 这一份白名单（它与 tokens.css 的 glass 块由 themeTokens.test.ts
 *    成对核过：缺失 0 且陈旧 0，所以这里不是手抄的第二份真相）；
 *  - 值逐枚按字面类型校验（颜色 / blur() / 阴影列表），不合规就整份拒，并给出行号与原因；
 *  - 生成 CSS 时由 `buildThemeRule` 自己拼片段，**从不**把原文塞进 style 标签。
 *
 * 为什么要**整套齐全**：`:root` 里没有这 32 枚的默认值（那里只有 radius / spacing / font 那几档），
 * 少一枚就意味着界面上某处引用取不到值，整站退回浏览器默认色——这正是 settings.rs 里
 * 「绝不让一个 tokens.css 里没有的名字进界面」那条注释要防的事。所以校验器不补默认值：
 * 缺哪几枚就点名哪几枚，把模板里那一行粘回来即可。
 *
 * 因此这份文件里不留第二套「出厂主题表」（原先那份 GLASS_TOKENS 已删）。只有 TOKEN_TEMPLATE 带着
 * 32 个示例值——模板要能改着看；而"那 32 个值与 tokens.css 的 glass 块逐枚相同"由
 * themeTokens.test.ts 钉住：它是被核过的派生物，不是没人管的第二份真相。
 */

/** 与 tokens.css 的 `[data-theme="glass"]` 块成对核过（见 themeTokens.test.ts）。 */
export const THEME_TOKEN_NAMES = [
  '--t-primary',
  '--t-primary-hover',
  '--t-primary-glow',
  '--t-text',
  '--t-text-body',
  '--t-text-muted',
  '--t-text-inverse',
  '--t-on-primary-muted',
  '--t-danger',
  '--t-success',
  '--t-success-soft',
  '--t-warning',
  '--t-star',
  '--t-accent',
  '--t-surface',
  '--t-surface-elevated',
  '--t-surface-sunken',
  '--t-border',
  '--t-border-subtle',
  '--t-border-strong',
  '--t-divider',
  '--row-hover',
  '--t-bg',
  '--blob-1',
  '--blob-2',
  '--blob-3',
  '--blur',
  '--blur-overlay',
  '--shadow-dropdown',
  '--shadow-btn',
  '--shadow-sm',
  '--glow-inset',
] as const satisfies readonly `--${string}`[];

export type TokenCategory = 'color' | 'blur' | 'shadow';

/** 令牌名到字面类型的归类：决定那一枚允许什么样的值。 */
export function categoryOf(name: string): TokenCategory {
  if (name === '--blur' || name === '--blur-overlay') return 'blur';
  if (name.startsWith('--shadow-') || name === '--glow-inset') return 'shadow';
  return 'color';
}

const NUM = '-?\\d*\\.?\\d+';
const LEN = `(?:${NUM}px|${NUM})`; // 四套主题里只出现 px 与无单位 0
const ALPHA = `(?:${NUM}|${NUM}%)`;
const HEX = '#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})';
const VAR = 'var\\(--[a-z0-9-]+\\)';
const COLOR_SRC = `(?:${HEX}|rgba?\\(\\s*${NUM}\\s*,\\s*${NUM}\\s*,\\s*${NUM}\\s*(?:,\\s*${ALPHA}\\s*)?\\)|transparent|${VAR})`;
const COLOR_RE = new RegExp(`^${COLOR_SRC}$`);

function isColor(v: string): boolean {
  if (!COLOR_RE.test(v)) return false;
  // var() 只许指向白名单里的令牌：否则等于给 CSS 塞一个取不到值的引用
  const m = /^var\((--[a-z0-9-]+)\)$/.exec(v);
  return m ? (THEME_TOKEN_NAMES as readonly string[]).includes(m[1]) : true;
}

/** 值这一侧的兜底闸门：出现这些字符直接判死，不进任何正则。 */
const BANNED = /[{}<>;@\\/"'`()]/;

/** 只在括号外面切分：`rgba(0, 0, 0, .15)` 里那三个逗号不是阴影的分层符。 */
function splitTopLevel(value: string, sep: ',' | ' '): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of value) {
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    if (ch === sep && depth === 0) {
      out.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  out.push(current);
  return out.map((s) => s.trim()).filter(Boolean);
}

function validateValue(name: string, raw: string): string | null {
  const v = raw.trim();
  if (!v) return '值为空';
  const kind = categoryOf(name);
  if (kind === 'blur') {
    return new RegExp(`^blur\\(${LEN}\\)$`).test(v) ? null : '这一枚只接受 blur(<px>) 形状（如 blur(18px)）';
  }
  if (kind === 'shadow') {
    // 阴影允许括号里的颜色/var，所以只单独过一遍危险字符，再按顶层逗号逐层拆
    if (/[{}<>@\\/"'`]/.test(v)) return '阴影值里不允许出现这些字符';
    const layers = splitTopLevel(v, ',');
    if (!layers.length) return '阴影至少要有层';
    for (const layer of layers) {
      const parts = splitTopLevel(layer, ' ');
      const geom = parts[0] === 'inset' ? parts.slice(1) : parts;
      // 一层最多是「4 个长度 + 1 个颜色」5 段，最少「2 个长度」
      if (geom.length < 2 || geom.length > 5) return `阴影层的段数不对：${layer}（要 inset? 偏移 模糊 [扩散] [颜色]）`;
      const last = geom[geom.length - 1];
      const hasColor = isColor(last);
      const lengths = hasColor ? geom.slice(0, -1) : geom;
      if (lengths.length < 2 || lengths.length > 4) return `阴影层的数值个数不对：${layer}（2~4 个长度，颜色至多一个）`;
      if (!lengths.every((l) => new RegExp(`^${LEN}$`).test(l))) return `阴影层里有不是长度的项：${layer}`;
    }
    return null;
  }
  if (BANNED.test(v.replace(/rgba?\([^)]*\)|var\([^)]*\)/g, ''))) return '颜色值里出现了不允许的字符';
  return isColor(v) ? null : '不是合法颜色（#hex / rgb() / rgba() / transparent / var(--白名单令牌)）';
}

export type TokenParseResult =
  | { ok: true; tokens: Record<string, string> }
  | { ok: false; errors: Array<{ line: number; reason: string }> };

/**
 * 解析粘贴进来的 CSS 变量块。
 * 支持 `/* 注释 *\/`、`// 行注释`、空行与任意缩进；一行一条 `--名: 值;`。
 * 任何一行不合规 → 整份不收（不做"收下能认的那几行"，那会让半套主题进库）。
 */
export function parseThemeTokens(text: string): TokenParseResult {
  // 块注释按原样换行抹掉，保住后面的行号与用户看到的一致
  const normalized = text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  const errors: Array<{ line: number; reason: string }> = [];
  const tokens: Record<string, string> = {};
  const seen = new Set<string>();

  normalized.split('\n').forEach((rawLine, i) => {
    const line = i + 1;
    const body = rawLine.replace(/^\s*\/\/.*$/, '').replace(/\/\/.*$/, '').trim();
    if (!body) return;
    const m = /^(--[A-Za-z0-9-]+)\s*:\s*(.+?);?$/.exec(body);
    if (!m) {
      errors.push({ line, reason: '这一行不是 `--令牌名: 值;` 的形状' });
      return;
    }
    const [, name, value] = m;
    if (!(THEME_TOKEN_NAMES as readonly string[]).includes(name)) {
      errors.push({ line, reason: `${name} 不在这套主题的令牌表里` });
      return;
    }
    if (seen.has(name)) {
      errors.push({ line, reason: `${name} 重复声明了` });
      return;
    }
    seen.add(name);
    const bad = validateValue(name, value);
    if (bad) {
      errors.push({ line, reason: `${name}：${bad}` });
      return;
    }
    tokens[name] = value.trim();
  });

  // 整套齐全才算数（理由在文件头）。语法级错误先报完，缺枚这种"整体级"问题单独一条，
  // 免得 32 条缺枚把真正的坏行淹没。
  const missing = THEME_TOKEN_NAMES.filter((n) => !(n in tokens));
  if (missing.length && !errors.length) {
    errors.push({ line: 0, reason: `少了 ${missing.length} 枚：${missing.join('、')}——删掉的行请从模板粘回来` });
  }
  if (!Object.keys(tokens).length && !errors.length) {
    return { ok: false, errors: [{ line: 0, reason: '没读到任何一条令牌声明' }] };
  }
  return errors.length ? { ok: false, errors } : { ok: true, tokens };
}

/** 选择器用的 id 形状：它会拼进 [data-theme="…"]，所以只收小写字母、数字与连字符。 */
const SAFE_ID = /^[a-z0-9][a-z0-9-]{1,31}$/;

export function customThemeId(raw: string): string {
  return `custom-${raw}`;
}

/**
 * 生成运行时注入的那条规则。输出保证是**一行**、只有一对花括号，
 * 且每个值都是过过关的字面量——原文从不参与拼接。
 */
export function buildThemeRule(id: string, tokens: Record<string, string>): string {
  if (!SAFE_ID.test(id)) return '';
  // 齐全是硬条件：半套规则会让那一档下某些 var() 直接取不到值（比停在出厂档更糟），
  // 所以宁可不注入。写入侧（parseThemeTokens 与 Rust 的 normalize）都已要求整套，
  // 走到这里还缺枚，只可能是库被手工改过。
  if (THEME_TOKEN_NAMES.some((n) => typeof tokens[n] !== 'string' || !tokens[n])) return '';
  const decls = THEME_TOKEN_NAMES.map((n) => `${n}:${tokens[n]}`).join(';');
  return `[data-theme="custom-${id}"]{${decls}}`;
}

/** 模板：34 行里的 32 枚，逐枚注明管的是界面上哪一块；值取 glass，改哪枚看哪枚。 */
export const TOKEN_TEMPLATE = `/* 自定义主题模板
 * 一行一枚，形如 --令牌名: 值;   改不了的可以整行删掉——删掉的会落回出厂那套「极光液态」的值。
 * 颜色可写 #hex（3/4/6/8 位）、rgb()/rgba()、transparent，或 var(--另一枚令牌)。
 * --blur 两枚只写 blur(数字px)；--shadow-* / --glow-inset 写 inset? 偏移 模糊 [扩散] [颜色]。
 * 粘到「界面外观 → 新增主题」的框里，校验过了才会存下来。 */

/* —— 主色：按钮、选中态、聚焦线都从这三枚取 —— */
--t-primary: #4f46e5;
--t-primary-hover: #4338ca;
--t-primary-glow: rgba(79, 70, 229, 0.25);

/* —— 文字 —— */
--t-text: #111827;            /* 标题与正文 */
--t-text-body: #4b5563;       /* 次一级正文 */
--t-text-muted: #6b7280;      /* 说明、占位符 */
--t-text-inverse: #ffffff;    /* 实心主色按钮上的字 */
--t-on-primary-muted: rgba(255, 255, 255, 0.78);

/* —— 语义色 —— */
--t-danger: #e11d48;
--t-success: #10b981;
--t-success-soft: rgba(16, 185, 129, 0.1);
--t-warning: #f59e0b;
--t-star: #f59e0b;
--t-accent: var(--t-primary-hover);

/* —— 面：卡片、浮层、凹陷的输入行 —— */
--t-surface: rgba(255, 255, 255, 0.3);
--t-surface-elevated: rgba(255, 255, 255, 0.85);
--t-surface-sunken: rgba(255, 255, 255, 0.15);

/* —— 描边与分隔 —— */
--t-border: rgba(255, 255, 255, 0.6);
--t-border-subtle: rgba(255, 255, 255, 0.2);
--t-border-strong: rgba(255, 255, 255, 0.85);
--t-divider: rgba(0, 0, 0, 0.06);
--row-hover: rgba(255, 255, 255, 0.4);

/* —— 底色与那三团光斑 —— */
--t-bg: #f1ebf6;
--blob-1: rgba(253, 216, 215, 0.8);
--blob-2: rgba(196, 226, 255, 0.8);
--blob-3: rgba(235, 219, 250, 0.8);

/* —— 模糊档位：玻璃感有多重就看这两枚（纯平那套写 blur(0px)） —— */
--blur: blur(40px);
--blur-overlay: blur(8px);

/* —— 投影与面上沿高光 —— */
--shadow-dropdown: 0 12px 48px -8px rgba(0, 0, 0, 0.15);
--shadow-btn: 0 8px 24px -4px var(--t-primary-glow);
--shadow-sm: 0 2px 8px rgba(17, 24, 39, 0.06);
--glow-inset: inset 0 1px 0 rgba(255, 255, 255, 0.8);
`;
