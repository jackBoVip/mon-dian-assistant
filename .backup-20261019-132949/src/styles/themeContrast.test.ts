import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { THEME_STYLES } from '../lib/theme';

/**
 * 主题对比度校验（需求 line 246「主题色和文字对比度满足可访问性基线」、§7「焦点可见」）。
 * 这里不渲染组件，直接对 tokens.css 里真正生效的令牌做算术：组件的配色全部来自这些变量，
 * 所以变量达标 = 界面达标，变量漂移 = 测试变红。
 *
 * 阈值取自 WCAG 2.1 AA：正文与 12px 徽标文字属普通文字（4.5:1），焦点环与描边属非文字对比（3:1）。
 *
 * S 轮起只有一条轴（选哪套主题），四套主题各自把明暗身份、模糊值、透明度钉在自己的
 * [data-theme] 块里，面全是解析后的实色，所以不再有"先按 --glass-alpha 合成到页面底色"那一步，
 * 也不再有模式与玻璃强度两层循环。
 *
 * 原型的次要文字色（--text-muted 那一档）按 2026-10-18 的使用者口径是**逐字照抄**的，
 * 它在中途几档面上到不了 4.5:1。这一档不由测试逼着改色，而是走下面的 PROTOTYPE_EXEMPT：
 * 豁免表把阈值降到实测值，同时钉住"不得比记录的那档更差"，并在配对已经自己达标时要求撤表。
 */

// vitest 的工作目录就是项目根（jsdom 下 import.meta.url 不是 file: 协议，不能拿来定位源文件）
const CSS_PATH = resolve(process.cwd(), 'src/styles/tokens.css');

type Rgb = [number, number, number];

interface Block {
  sel: string;
  /** null = 与主题无关的派生块（`:root { … }`），对所有主题合并 */
  theme: string | null;
  decls: Map<string, string>;
}

/**
 * 一块声明可以有多个选择器（认证那道五档渐变就是 `:root[data-theme="glass"], :root[data-theme="minimal"]`
 * 两档共用一组值），所以要按逗号拆开、每个主题各出一块。注释里可能带花括号，先整段剥掉。
 */
function parseBlocks(css: string): Block[] {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const blocks: Block[] = [];
  for (const m of stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const decls = new Map<string, string>();
    for (const line of m[2].split('\n')) {
      const d = line.match(/^\s*(--[\w-]+)\s*:\s*(.+?);/);
      if (d) decls.set(d[1], d[2].trim());
    }
    for (const sel of m[1].split(',')) {
      const one = sel.trim();
      // 认两种块：主题块 `[data-theme…]`（带不带 :root 前缀都算），和与主题无关的派生块 `:root`。
      if (!one.startsWith('[data-theme') && !one.startsWith(':root')) continue;
      const tm = one.match(/data-theme="([^"]+)"/);
      blocks.push({ sel: one, theme: tm ? tm[1] : null, decls: new Map(decls) });
    }
  }
  return blocks;
}

/** 按源码顺序合并：后写的块与前缀更具体的修正块都能覆盖前面的默认值。 */
function resolveTheme(blocks: Block[], theme: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const b of blocks) {
    if (b.theme && b.theme !== theme) continue;
    for (const [k, v] of b.decls) out.set(k, v);
  }
  return out;
}

function parseRgb(value: string): { rgb: Rgb; alpha: number } {
  const hex = value.match(/^#([0-9a-f]{6})$/i);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return { rgb: [(n >> 16) & 255, (n >> 8) & 255, n & 255], alpha: 1 };
  }
  const rgb = value.match(/rgba?\(([^)]+)\)/);
  if (rgb) {
    const parts = rgb[1].split(/[/\s,]+/).filter(Boolean).map(Number);
    return { rgb: [parts[0], parts[1], parts[2]], alpha: parts.length >= 4 ? parts[3] : 1 };
  }
  throw new Error(`无法解析颜色：${value}`);
}

function composite(fg: Rgb, alpha: number, bg: Rgb): Rgb {
  return [alpha * fg[0] + (1 - alpha) * bg[0], alpha * fg[1] + (1 - alpha) * bg[1], alpha * fg[2] + (1 - alpha) * bg[2]];
}

/**
 * color-mix(in srgb, A P%, B)：认证场景与壳层派生令牌大量是这一种形状，
 * 所以校验对象必须能算它，否则测试会静默跳过真正上屏的那层颜色。
 * 只支持这一种固定语法（两种分量 + 一个百分比 + 无色彩空间修饰），不做表达式求值。
 */
const MIX_RE = /^color-mix\(\s*in\s+srgb\s*,\s*(.+?)\s+(\d+(?:\.\d+)?)%\s*,\s*(.+?)\s*\)$/i;

function resolvePart(tokens: Map<string, string>, part: string, depth: number): { rgb: Rgb; alpha: number } {
  const p = part.trim();
  if (/^transparent$/i.test(p)) return { rgb: [0, 0, 0], alpha: 0 };
  const ref = p.match(/^var\(\s*(--[\w-]+)\s*(?:,[^)]*)?\)$/);
  if (ref) {
    const raw = tokens.get(ref[1]);
    if (!raw) throw new Error(`令牌 ${ref[1]} 未定义（被 ${p} 引用）`);
    return resolveValue(tokens, raw, depth + 1);
  }
  return parseRgb(p);
}

function resolveValue(tokens: Map<string, string>, value: string, depth = 0): { rgb: Rgb; alpha: number } {
  if (depth > 6) throw new Error(`令牌引用过深（>6 层）：${value}`);
  const mix = value.match(MIX_RE);
  if (mix) {
    const a = resolvePart(tokens, mix[1], depth);
    const b = resolvePart(tokens, mix[3], depth);
    const t = Number(mix[2]) / 100;
    // 预乘混合：browser 在 sRGB 里按 (颜色 × alpha) 插值后再除回 alpha
    const wa = a.alpha * t;
    const wb = b.alpha * (1 - t);
    const alpha = wa + wb;
    if (alpha === 0) return { rgb: [0, 0, 0], alpha: 0 };
    const rgb: Rgb = [
      (wa * a.rgb[0] + wb * b.rgb[0]) / alpha,
      (wa * a.rgb[1] + wb * b.rgb[1]) / alpha,
      (wa * a.rgb[2] + wb * b.rgb[2]) / alpha,
    ];
    return { rgb, alpha };
  }
  // 纯色值之外还可能是整枚 var() 别名（--nav-active 就是 elevated 的别名）
  if (/^var\(/.test(value)) return resolvePart(tokens, value, depth);
  return parseRgb(value);
}

/** 取令牌最终显示出来的颜色（半透明面先合成到它下面的页面底色）。 */
function colorOf(tokens: Map<string, string>, key: string, page: Rgb): Rgb {
  const raw = tokens.get(key);
  if (!raw) throw new Error(`令牌 ${key} 未定义`);
  const { rgb, alpha } = resolveValue(tokens, raw);
  return alpha >= 1 ? rgb : composite(rgb, alpha, page);
}

function channel(u: number): number {
  const s = u / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function luminance(c: Rgb): number {
  return 0.2126 * channel(c[0]) + 0.7152 * channel(c[1]) + 0.0722 * channel(c[2]);
}

function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * 原型字面值照抄所带来的豁免（使用者口径 2026-10-18：「逐字照抄字面值，改守卫」）。
 * key 是 `主题 / 前景令牌`，floor 是这一枚令牌在当前主题**全部承托面**上实测到的最低比值
 * （往下取整到 0.01），why 写清原型出处。语义：
 *   · 任何一面对它低于 floor 就变红——换皮可以，把原型的语义色改得更没对比不行；
 *   · 表里没有的令牌与配对一律按正常阈值走，新增的低对比面不会被静默放过；
 *   · 最后一条守卫要求每个条目都被用上过，原型色一旦调达标就得把条目撤掉。
 *
 * 这一批的根因都在原型自己的主题块里：`--text-muted` 四档分别是 #6b7280 / #a1a1aa / #71717a /
 * #475569，`--status-green` 与 `--star-color` 在亮档是 #10b981 / #f59e0b。原型 `.badge-status`
 * 就是 12px 的 `--status-green` 文字压在同色 10% 染底上，`--text-muted` 也直接当正文用
 * （`.action-icon-btn`、`.table-cell` 副行）。照抄的结果是这几档到不了 AA，全部记入交付文档。
 */
const PROTOTYPE_EXEMPT: Record<string, { floor: number; why: string }> = {
  'glass / --color-text-muted': { floor: 3.43, why: '原型 glass 的 --text-muted #6b7280；压在认证场景主色染底上最低' },
  'glass / --color-danger': { floor: 4.02, why: '原型 glass 的 --danger #e11d48，对 --app-bg #f1ebf6' },
  'glass / --color-success': { floor: 2.17, why: '原型 .badge-status：12px 的 --status-green #10b981 文字' },
  'glass / --color-warning': { floor: 1.84, why: '原型的 --star-color #f59e0b' },
  'minimal / --color-text-muted': { floor: 1.92, why: '原型 minimal 的 --text-muted #a1a1aa；纯白套里这一档本就不承重，认证场景那层主色染又把它压到 canvas 以下' },
  'minimal / --color-success': { floor: 2.43, why: '同上 --status-green #10b981' },
  'minimal / --color-warning': { floor: 2.06, why: '同上 --star-color #f59e0b' },
  'obsidian / --color-text-muted': { floor: 2.25, why: '原型 obsidian 的 --text-muted #71717a；认证场景右端按"左深右浅且加速"必须变亮，这枚暗灰压不到 4.5' },
  'cyber / --color-text-muted': { floor: 1.84, why: '原型 cyber 的 --text-muted #475569（霓虹套里最暗的一档）' },
};

/** 被上面那张表真正挡住过的条目，供最后那条"不许留空转豁免"的守卫核对。 */
const exemptHits = new Set<string>();

const TEXT_ON_BACKGROUNDS: Array<[string, string[], number, string]> = [
  // 前景令牌, 允许的背景令牌, 阈值, 这个配对来自界面哪里
  ['--color-text', ['--color-bg', '--color-surface', '--color-surface-elevated', '--color-surface-sunken'], 4.5, '正文/输入框文字（输入框底是 sunken）'],
  ['--color-text-muted', ['--color-bg', '--color-surface', '--color-surface-elevated', '--color-surface-sunken'], 4.5, '次要文字、字段标签、.sys-meta、.search-footer、.search-meta'],
  ['--color-success', ['--color-bg', '--color-surface', '--color-surface-elevated'], 4.5, '.badge-success 是 12px 文字'],
  ['--color-warning', ['--color-bg', '--color-surface', '--color-surface-elevated'], 4.5, '.badge-warning 同上'],
  ['--color-danger', ['--color-bg', '--color-surface', '--color-surface-elevated'], 4.5, '.badge-danger 与 .btn-danger 的文字'],
  ['--color-text-inverse', ['--color-primary', '--color-primary-hover'], 4.5, '.btn-primary 文字、页码当前档、.user-avatar 的字'],
  ['--color-on-primary-muted', ['--color-primary', '--color-primary-hover'], 4.5, '主色实心条上的副行与图标'],
  ['--color-text', ['--nav-active'], 4.5, '导航当前项与列表当前行的选中底（原型 --bg-glass-heavy 那一档）'],
  ['--color-primary', ['--color-bg', '--color-surface', '--color-surface-elevated', '--color-surface-sunken'], 4.5, '.parsed-result：导入结果那行是主色文字（原型 13.5px/500 直接照抄）'],
  ['--color-text-body', ['--color-bg', '--color-surface', '--color-surface-elevated', '--color-surface-sunken'], 4.5, '.template-action p、.checkbox-label 的说明文字'],
  ['--focus-ring', ['--color-bg', '--color-surface', '--color-surface-elevated', '--color-surface-sunken'], 3, ':focus-visible 的 2px 轮廓（非文字对比）'],
];

/**
 * 认证场景（--scene-*）：首次初始化 / 解锁 / 密钥同意 / 启动失败那几页共用的氛围层。
 *
 * 2026-10 照原型重绘时，这一层从「固定深色夜景板 + 照片 + 右卡」换成了**跟随当前主题**的
 * 染底，原来的 --hero-* 与它的 HERO_BACKDROP / HERO_TEXT_ON_BACKGROUNDS 整块删除。代价写在
 * 这里：右栏按原型是**裸字段**，没有卡面兜底，正文与次要文字直接压在
 *   页面底(--scene-canvas) → 染底(--scene-glow-a/-b，主色/强调色各 12%) → 噪点最坏档(--scene-veil)
 * 上，所以这张表就是那条基线本身，12% 这个数是解出来的（再高一档就有主题破 4.5）。
 * 噪点层用 overlay 混合，解析器算不出它的合成色，于是令牌里按「把反色往面上提 3%」记一档
 * 最坏值，文字一律按这一档验；CSS 里实际给的那档比它轻。
 * 报错文字只有落在 --scene-panel（接近实心的条）上才达标——染了 12% 的底上 --color-danger
 * 最紧只有 4.00:1，这一点是本轮实测的结论，不是猜的。
 * 阈值：文字 ≥4.5:1；下划线描边与聚焦线属非文字对比 ≥3:1。
 * --scene-switch-track/-thumb **不在**下面的承托面表里：切换器上只放 18px 色块名片，从不压正文，
 * 按 4.5 去要求它们会把名片逼成实色块，反而看不出四档的差别。
 */
const SCENE_SURFACES = ['--scene-canvas', '--scene-glow-a', '--scene-glow-b', '--scene-veil', '--scene-panel'];

const SCENE_BACKDROP: Record<string, string | null> = {
  '--scene-canvas': null,
  '--scene-glow-a': '--scene-canvas',
  '--scene-glow-b': '--scene-canvas',
  '--scene-veil': '--scene-glow-a',
  '--scene-panel': '--scene-glow-a',
  '--scene-line': '--scene-glow-a',
  '--scene-switch-track': '--scene-glow-a',
  '--scene-switch-thumb': '--scene-glow-a',
};

const SCENE_TEXT_ON_BACKGROUNDS: Array<[string, string[], number, string]> = [
  ['--color-text', SCENE_SURFACES, 4.5, '大标题、字段标签、输入内容（原型的右栏没有卡面）'],
  ['--color-text-muted', SCENE_SURFACES, 4.5, '副标题、场景说明、占位符'],
  ['--color-danger', ['--scene-panel'], 4.5, '报错条文字：只有这块接近实心的条承得住'],
  ['--scene-cta-ink', ['--scene-cta-bg'], 4.5, '主 CTA（开启助手 / 解锁）的文字压在这枚反相实心条上'],
  ['--scene-line', ['--scene-canvas', '--scene-glow-a', '--scene-glow-b', '--scene-veil'], 3, '下划线式输入框的静置描边（非文字对比基线）'],
  ['--scene-focus', ['--scene-canvas', '--scene-glow-a', '--scene-glow-b', '--scene-veil'], 3, '聚焦时从左边走满的那条下划线'],
];

/** 按 SCENE_BACKDROP 登记的层叠顺序合成到染底上，再取前景。实心令牌不受 page 影响。 */
function sceneColorOf(tokens: Map<string, string>, key: string, depth = 0): Rgb {
  if (depth > 4) throw new Error(`场景层叠过深（>4 层）：${key}`);
  const base = key in SCENE_BACKDROP ? SCENE_BACKDROP[key] : '--scene-glow-a';
  const page: Rgb = base === null ? [0, 0, 0] : sceneColorOf(tokens, base, depth + 1);
  return colorOf(tokens, key, page);
}

/* ---------------- 认证场景那道左深右浅的五档渐变 + 蒙版 ----------------
 * 下面这组常量与 global.css 里 .auth-bg 的五层 background-image 一一对应，改那一段必须同步这里
 * （颜色全在令牌里，这里只抄渐变几何：五个止点位置、径向蒙版的半径与中心、两档止点位置）：
 *   linear-gradient(90deg, ramp-1 0%, ramp-2 24%, ramp-3 54%, ramp-4 80%, ramp-5 100%)
 *   radial-gradient(125% 95% at 50% 48%, scrim-r 0%, scrim-m 60%, scrim-e 100%)
 *   linear-gradient(180deg, scrim-t 0%, scrim-c 42%, scrim-b 100%)
 * 90deg 是刻意的：只有正横向渐变的止点位置就等于 x 比例，取样不必做投影近似（带角度时
 * 连容器宽高比都会影响止点，测试与屏幕就对不上了）。
 */
const RAMP_POS = [0, 24, 54, 80, 100];
const RAMP_KEYS = ['--scene-ramp-1', '--scene-ramp-2', '--scene-ramp-3', '--scene-ramp-4', '--scene-ramp-5'];
const SCRIM_RADIAL_KEYS = ['--scene-scrim-r', '--scene-scrim-m', '--scene-scrim-e'];
const SCRIM_V_KEYS = ['--scene-scrim-t', '--scene-scrim-c', '--scene-scrim-b'];
const SCRIM_RADIAL_POS = [0, 0.6, 1];
const SCRIM_V_POS = [0, 0.42, 1];
const SCRIM_RADIAL = { rx: 1.25, ry: 0.95, cx: 0.5, cy: 0.48 };

function lerp(stops: Array<[number, number]>, u: number): number {
  if (u <= stops[0][0]) return stops[0][1];
  for (let i = 1; i < stops.length; i++) {
    if (u <= stops[i][0]) {
      const [p0, v0] = stops[i - 1];
      const [p1, v1] = stops[i];
      return v0 + ((u - p0) / (p1 - p0)) * (v1 - v0);
    }
  }
  return stops[stops.length - 1][1];
}

function mixRgb(a: Rgb, t: number, b: Rgb): Rgb {
  return [0, 1, 2].map((i) => a[i] * t + b[i] * (1 - t)) as Rgb;
}

/** 逐令牌解出颜色与 alpha（渐变层的透明度就写在 stop 颜色的 alpha 里）。 */
function rgbaOf(tokens: Map<string, string>, key: string, page: Rgb): { rgb: Rgb; alpha: number } {
  const raw = tokens.get(key);
  if (!raw) throw new Error(`令牌 ${key} 未定义`);
  const c = resolveValue(tokens, raw);
  return { rgb: c.alpha >= 1 ? c.rgb : (composite(c.rgb, c.alpha, page) as Rgb), alpha: c.alpha };
}

/** 椭圆径向渐变里任意点的进度：显式尺寸（如 125% 95%）下 100% 就是那两条半径本身。 */
function radialProgress(x: number, y: number, cx: number, cy: number, rx: number, ry: number): number {
  return Math.min(Math.hypot((x - cx) / rx, (y - cy) / ry), 1);
}

/** 画布上任意一点最终呈现的底：五档渐变 → 两束光 → 径向蒙版 → 竖向蒙版 → 噪点最坏档。 */
function scenePoint(tokens: Map<string, string>, x: number, y: number): Rgb {
  const canvas = sceneColorOf(tokens, '--scene-canvas');
  const ramp = RAMP_KEYS.map((k, i) => [RAMP_POS[i] / 100, colorOf(tokens, k, canvas)] as [number, Rgb]);
  let rgb = ramp[ramp.length - 1][1];
  if (x <= ramp[0][0]) rgb = ramp[0][1];
  else {
    for (let i = 1; i < ramp.length; i++) {
      if (x <= ramp[i][0]) {
        rgb = mixRgb(ramp[i][1], (x - ramp[i - 1][0]) / (ramp[i][0] - ramp[i - 1][0]), ramp[i - 1][1]);
        break;
      }
    }
  }
  // 两束光：色心不透明、到 fall 处褪到全透，所以落在中间的点是按 alpha 混上去的
  for (const [glowKey, gx, gy, rx, ry, fall] of [
    ['--scene-glow-a', 0.88, 0.06, 0.9, 0.72, 0.58] as const,
    ['--scene-glow-b', 0.06, 0.94, 0.85, 0.75, 0.62] as const,
  ]) {
    const glow = rgbaOf(tokens, glowKey, canvas);
    const t = glow.alpha * Math.max(0, 1 - radialProgress(x, y, gx, gy, rx, ry) / fall);
    if (t > 0) rgb = mixRgb(glow.rgb, t, rgb);
  }
  const scrim = rgbaOf(tokens, '--scene-scrim', canvas);
  const alphaAt = (keys: string[], pos: number[], u: number) =>
    lerp(pos.map((p, i) => [p, rgbaOf(tokens, keys[i], canvas).alpha] as [number, number]), u);
  const a = Math.min(1, 1 - (1 - alphaAt(SCRIM_RADIAL_KEYS, SCRIM_RADIAL_POS, radialProgress(x, y, SCRIM_RADIAL.cx, SCRIM_RADIAL.cy, SCRIM_RADIAL.rx, SCRIM_RADIAL.ry))) * (1 - alphaAt(SCRIM_V_KEYS, SCRIM_V_POS, y)));
  rgb = mixRgb(scrim.rgb, a * scrim.alpha, rgb);
  // 噪点那层是 overlay 混合，解析器算不出合成结果，按令牌记的最坏档（把反色往上提）验
  const grain = rgbaOf(tokens, '--scene-grain-worst', canvas);
  return mixRgb(grain.rgb, grain.alpha, rgb);
}

/**
 * 一对前景/背景该按哪条阈值判定：正常阈值优先，只有 PROTOTYPE_EXEMPT 里登记过的那枚前景令牌
 * 才降级到它的 floor（原型字面值那一档），并且要求"不得比记录的 floor 更差"。
 */
function judge(
  style: string,
  fgKey: string,
  bgKey: string,
  min: number,
  ratio: number,
  failures: string[],
  why: string,
): void {
  const exempt = PROTOTYPE_EXEMPT[`${style} / ${fgKey}`];
  if (!exempt) {
    if (ratio < min) failures.push(`${style} / ${fgKey} 对 ${bgKey} = ${ratio}:1，低于 ${min}:1 ← ${why}`);
    return;
  }
  exemptHits.add(`${style} / ${fgKey}`);
  if (ratio < exempt.floor) {
    failures.push(
      `${style} / ${fgKey} 对 ${bgKey} = ${ratio}:1，比原型字面值记录的那档 ${exempt.floor}:1 更差（出处：${exempt.why}）`,
    );
  }
}

const blocks = parseBlocks(readFileSync(CSS_PATH, 'utf8'));

describe('主题令牌的文字对比度（需求 line 246 / §7 焦点可见）', () => {
  it('tokens.css 覆盖到的主题与 THEME_STYLES 完全一致，新增风格不会漏过校验', () => {
    const inCss = new Set(blocks.filter((b) => b.theme).map((b) => b.theme as string));
    expect([...THEME_STYLES].sort()).toEqual([...inCss].sort());
  });

  for (const style of THEME_STYLES) {
    it(`${style}：通用令牌层逐面达标`, () => {
      const tokens = resolveTheme(blocks, style);
      if (!tokens.has('--color-bg')) {
        throw new Error(`${style} 没有解析到 --color-bg：主题块缺失`);
      }
      const failures: string[] = [];
      for (const [fgKey, bgKeys, min, why] of TEXT_ON_BACKGROUNDS) {
        if (!tokens.has(fgKey)) {
          failures.push(`缺令牌 ${fgKey}（${why}）`);
          continue;
        }
        const page = colorOf(tokens, '--color-bg', [0, 0, 0]);
        const fg = colorOf(tokens, fgKey, page);
        for (const bgKey of bgKeys) {
          if (!tokens.has(bgKey)) continue;
          const bg = colorOf(tokens, bgKey, page);
          judge(style, fgKey, bgKey, min, r2(contrast(fg, bg)), failures, why);
        }
      }
      expect(failures, style).toEqual([]);
    });
  }

  for (const style of THEME_STYLES) {
    it(`认证场景的 --scene-* 层（${style}）：裸字段压在这层染底上仍达标`, () => {
      const tokens = resolveTheme(blocks, style);
      const failures: string[] = [];
      for (const [fgKey, bgKeys, min, why] of SCENE_TEXT_ON_BACKGROUNDS) {
        if (!tokens.has(fgKey)) {
          failures.push(`缺令牌 ${fgKey}（${why}）`);
          continue;
        }
        const fg = sceneColorOf(tokens, fgKey);
        for (const bgKey of bgKeys) {
          if (!tokens.has(bgKey)) {
            failures.push(`缺令牌 ${bgKey}（${why}）`);
            continue;
          }
          const bg = sceneColorOf(tokens, bgKey);
          judge(style, fgKey, bgKey, min, r2(contrast(fg, bg)), failures, why);
        }
      }
      expect(failures, style).toEqual([]);
    });
  }

  for (const style of THEME_STYLES) {
    it(`认证场景那道左深右浅的五档渐变（${style}）：整幅取样点上的文字落点都达标`, () => {
      // 上面那张 --scene-* 表钉的是"染底 + 蒙版"这几枚平面令牌；这一条钉的是真正上屏的那幅画：
      // .auth-bg 的五档渐变（右端最亮的一档按主色染到 72%）本身**不是**安全面，安全是因为
      // 蒙版按位置把它压回去。所以要按位置取样，而不是逐个令牌查表。
      // 取样框取整幅（x 2%~98%、y 3%~97%）：正文与字段都在这块里，四边留一点余量给纯装饰的沿。
      const tokens = resolveTheme(blocks, style);
      const failures: string[] = [];
      const fgOf = (key: string): Rgb => sceneColorOf(tokens, key);
      const points: Array<[number, number]> = [];
      for (let xi = 0; xi <= 24; xi++) {
        for (let yi = 0; yi <= 16; yi++) {
          points.push([0.02 + (xi / 24) * 0.96, 0.03 + (yi / 16) * 0.94]);
        }
      }
      for (const [fgKey, min, why] of [
        ['--color-text', 4.5, '正文'],
        ['--color-text-muted', 4.5, '次要文字'],
        ['--scene-line', 3, '字段描边'],
        ['--scene-focus', 3, '聚焦下划线'],
      ] as Array<[string, number, string]>) {
        const fg = fgOf(fgKey);
        let worst = 999;
        let at: [number, number] = [0, 0];
        for (const [x, y] of points) {
          const ratio = r2(contrast(fg, scenePoint(tokens, x, y)));
          if (ratio < worst) {
            worst = ratio;
            at = [x, y];
          }
        }
        // 全幅 425 个取样点里对比最低的那块底就是最坏落点，只把它交给判定（一次退化只报一行）
        judge(style, fgKey, `x=${at[0].toFixed(2)} y=${at[1].toFixed(2)} 的底`, min, worst, failures, why);
      }
      expect(failures, style).toEqual([]);
    });
  }

  it('原型豁免表里没有空转条目', () => {
    // 每张条目都必须真的挡住过一次判定。原型色一旦调到达标（或那枚令牌被删掉），条目就留不住，
    // 免得豁免表越长越没人看——它是"照抄的代价"的台账，不是默认的降级通道。
    const idle = Object.keys(PROTOTYPE_EXEMPT).filter((k) => !exemptHits.has(k));
    expect(idle, `这些豁免条目没挡住任何一次判定：${idle.join('、')}`).toEqual([]);
  });

  it('五档渐变确实是左深右浅：逐主题的右端落点亮于左端', () => {
    // 这条是使用者提出的观感口径（"整个背景色主色应该是从左到右渐变的，变浅"），
    // 观感本来不进测试，但它一次退化就能悄悄发生（把止点写反、或蒙版压平），所以钉住。
    for (const style of THEME_STYLES) {
      const tokens = resolveTheme(blocks, style);
      const left = luminance(scenePoint(tokens, 0.06, 0.5));
      const right = luminance(scenePoint(tokens, 0.9, 0.5));
      expect(right, `${style} 右端应比左端亮（左 ${left.toFixed(3)} 右 ${right.toFixed(3)}）`).toBeGreaterThan(left);
    }
  });

  it('渐变是加速的：右端四分位的亮度增量至少是左端四分位的 3 倍', () => {
    // 使用者第二轮口径："越往右变化的幅度越大"。上一那条只钉方向，钉不出曲线形状——
    // 等比差的五档（30/21/13/6/0）方向对、观感却是"左边变化最猛、右边收住"。
    // 这里把整幅按 x 分成左右两个四分位，比较各自的实际亮度增量（含光晕与蒙版后的合成结果，
    // 也就是屏幕上真正看到的那幅），要求右边至少快 3 倍。左端增量允许为负（暗档左半几乎不动，
    // 亮档左半会被右上角光晕轻微压暗），所以只对右端增量要求"为正且够大"。
    for (const style of THEME_STYLES) {
      const tokens = resolveTheme(blocks, style);
      const at = (x: number) => luminance(scenePoint(tokens, x, 0.5));
      const leftGain = at(0.25) - at(0.02);
      const rightGain = at(0.98) - at(0.75);
      expect(rightGain, `${style} 右端必须在变亮（左 ${leftGain.toFixed(4)} 右 ${rightGain.toFixed(4)}）`).toBeGreaterThan(0);
      expect(
        rightGain,
        `${style} 变化幅度没有越往右越大：右四分位 ${rightGain.toFixed(4)} < 左四分位 ${leftGain.toFixed(4)} × 3`,
      ).toBeGreaterThanOrEqual(leftGain * 3);
    }
  });

  it('浮层选中行的徽标反相后仍然达标：主色字画在 text-inverse 底上', () => {
    // global.css 把 .launcher-row[aria-selected=true] .badge 改成 底=text-inverse / 字=primary，
    // 因为任何绿色在饱和蓝底上都到不了 4.5:1。这里守住替代方案本身。
    for (const style of THEME_STYLES) {
      const tokens = resolveTheme(blocks, style);
      const page = colorOf(tokens, '--color-bg', [0, 0, 0]);
      const fg = colorOf(tokens, '--color-primary', page);
      const bg = colorOf(tokens, '--color-text-inverse', page);
      expect(r2(contrast(fg, bg)), `${style} 徽标反相`).toBeGreaterThanOrEqual(4.5);
    }
  });
});

/**
 * 需求 line 246 的前半句：「主题实现必须基于统一 CSS Design Tokens，不得在每个组件中硬编码
 * 颜色」。对比度达标的前提是颜色真的来自令牌——组件里写死一个 #fff，换主题时它不会跟着变，
 * 上面那张表也就失去了意义。这里守住来源唯一，并顺手守住打字错误：
 * 引用一个不存在的令牌不会报错，只会静默失去颜色。
 */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(p, out);
    else if (/\.(tsx?|css)$/.test(entry.name) && !/\.(test|spec)\./.test(entry.name)) out.push(p);
  }
  return out;
}

const TOKEN_SOURCE = 'src/styles/tokens.css';
const files = sourceFiles(resolve(process.cwd(), 'src'));

describe('配色来源唯一（需求 line 246「不得在每个组件中硬编码颜色」）', () => {
  it('除 tokens.css 外，任何源文件都不出现字面色值', () => {
    const literal = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\(/;
    const hits: string[] = [];
    for (const f of files) {
      if (f.endsWith(TOKEN_SOURCE)) continue;
      readFileSync(f, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (literal.test(line)) hits.push(`${f}:${i + 1}`);
        });
    }
    expect(hits).toEqual([]);
  });

  it('组件与 global.css 引用的每个令牌都已在 tokens.css 里声明', () => {
    const declared = new Set<string>();
    for (const m of readFileSync(resolve(process.cwd(), TOKEN_SOURCE), 'utf8').matchAll(/(--[\w-]+)\s*:/g)) {
      declared.add(m[1]);
    }
    // 带兜底值的 var(--x, 8px) 是刻意的降级写法，不算悬空引用
    const dangling = new Set<string>();
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      for (const m of text.matchAll(/var\(\s*(--[\w-]+)\s*(,)?/g)) {
        if (!declared.has(m[1]) && !m[2]) dangling.add(`${m[1]} ← ${f}`);
      }
    }
    expect([...dangling]).toEqual([]);
  });

  it('两个入口都真的引入了令牌层，否则整套主题静默失效', () => {
    // 这条守卫是早前补的：tokens.css 曾经谁都没 import，构建产物里一个 --color-* 声明都没有，
    // 而按 label 查 DOM 的 jsdom 测试照样全绿——因为 jsdom 根本不做层叠与取色。
    // 引入关系漏了不会报错，只会让界面退回浏览器默认颜色，所以必须显式守住。
    for (const entry of ['src/main.tsx', 'src/launcher.tsx']) {
      const text = readFileSync(resolve(process.cwd(), entry), 'utf8');
      expect(text, `${entry} 没有引入 tokens.css`).toMatch(/import\s+['"][^'"]*styles\/tokens\.css['"]/);
      expect(text, `${entry} 没有引入 global.css`).toMatch(/import\s+['"][^'"]*styles\/global\.css['"]/);
    }
  });

  it('滑块与名片的位移动效不被换皮那一帧的颜色抑制罩住', () => {
    // lib/theme.ts 的 applyTheme 在改 data-theme/data-reduce-motion 那一帧注入 `*{transition:none!important}`
    // （满屏同时补间颜色会糊成一片）。切换器的位移与名片缩放也在那一帧里变，若不排除，
    // 点下去只会看到滑块"瞬移"——原型的弹性滑动就没了。这里守住豁免本身。
    const css = readFileSync(resolve(process.cwd(), 'src/styles/global.css'), 'utf8');
    for (const sel of ['\\.theme-switch__slider', '\\.theme-btn \\.theme-preview']) {
      const block = css.match(new RegExp(`${sel}\\s*\\{[^}]*\\}`));
      expect(block, `global.css 里找不到 ${sel} 的规则块`).not.toBeNull();
      expect(block![0], `${sel} 的 transform 过渡必须带 !important 才能盖住那一帧的抑制`).toMatch(/transition:[^;]*transform[^;]*!important/);
    }
  });

  it('认证页的下划线字段不再套那圈焦点环：聚焦只认走满的下划线', () => {
    // 使用者 2026-10-17 指出的问题：点一下输入框，外面套出一个圆角方框，原型里没有这一圈。
    // 方框来自文件开头那条全站 :where(…) 焦点环，而 .auth-panel .input 是透明无边框字段，
    // 两套聚焦语言同时出现反而看不清焦点在哪。这条守住"摘掉方框"这个决定本身。
    const css = readFileSync(resolve(process.cwd(), 'src/styles/global.css'), 'utf8');
    expect(css).toMatch(/\.auth-panel \.input:focus-visible\s*\{\s*outline:\s*none\s*;?\s*\}/);
    // 同时守住没被一起摘掉的那处：切换器按钮的键盘焦点环仍走全站那一档
    // （S 轮起没有高对比度档了，那一档加粗的聚焦线随主题集合一起撤下，冲突记在交付文档）。
    expect(css).toMatch(/\.theme-btn:focus-visible\s*\{[^}]*outline:\s*var\(--focus-ring-width\)/);
  });

  it('危险色只用在报错、不可逆与被拒绝这三类语境', () => {
    // 需求 line 246「危险色只表达危险状态」。语义没法自动判定，但引用点有限，逐处看住：
    // 出现新文件或换了文案，这条会红，逼着人来确认那次改动是不是真的危险状态。
    const ctx = /role=['"]alert['"]|错误|失败|不可逆|无权限|警告|危险/;
    const danger = /--color-danger|\b(?:text|badge|btn|border)-danger\b/;
    // 变体映射表里的 `danger: 'btn btn-danger'` 是在定义这套词汇，不是在使用它，跳过；
    // 真正要保证的是所有"用"它的地方都带着危险语义。
    const variantMapEntry = /^\s*danger\s*:\s*['"][\w -]+['"],?\s*$/;
    const checked: string[] = [];
    for (const f of files.filter((p) => !p.endsWith(TOKEN_SOURCE))) {
      const lines = readFileSync(f, 'utf8').split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (!danger.test(lines[i]) || variantMapEntry.test(lines[i])) continue;
        const around = lines.slice(Math.max(0, i - 2), Math.min(lines.length, i + 3)).join('\n');
        expect(ctx.test(around) || f.endsWith('global.css'), `${f}:${i + 1} 引用了危险色但上下文看不出危险语义`).toBe(true);
        checked.push(`${f}:${i + 1}`);
      }
    }
    expect(checked.length, '一处危险色引用都没扫到，说明引用方式变了，本条守卫需要重写').toBeGreaterThan(0);
  });

  it('Tailwind 里"只写宽度的 border"钉在令牌上，源码也不用任何 Tailwind 调色板类', () => {
    // 补这条的原因：`border` / `border-b` 这类只写宽度的工具取的是 borderColor.DEFAULT，
    // Tailwind v3 的默认值是 gray-200（一个与主题无关的字面色）。漏写一处 border-line
    // 不会报错，只会让那条边框在 4 套主题里都是同一个浅灰——正是需求 line 246 要避免的事。
    const cfg = readFileSync(resolve(process.cwd(), 'tailwind.config.ts'), 'utf8');
    expect(cfg).toMatch(/borderColor:\s*\{\s*DEFAULT:\s*'var\(--color-border\)'\s*\}/);
    const palette =
      /\b(?:text|bg|border|ring|fill|stroke|from|to)-(?:gray|slate|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}\b/;
    const hits: string[] = [];
    for (const f of files) {
      readFileSync(f, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (palette.test(line)) hits.push(`${f}:${i + 1}`);
        });
    }
    expect(hits).toEqual([]);
  });
});
