import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { THEME_STYLES } from '../lib/theme';

/**
 * 主题对比度校验（需求 line 246「主题色和文字对比度满足可访问性基线」、line 243 的高对比度
 * 无障碍主题、§7「焦点可见」）。这里不渲染组件，直接对 tokens.css 里真正生效的令牌做算术：
 * 组件的配色全部来自这些变量，所以变量达标 = 界面达标，变量漂移 = 测试变红。
 *
 * 阈值取自 WCAG 2.1 AA：正文与 12px 徽标文字属普通文字（4.5:1），焦点环属非文字对比（3:1）。
 * 玻璃主题的半透明面要先按 --glass-alpha 合成到页面底色上再算，否则算的是"看不见的颜色"。
 */

// vitest 的工作目录就是项目根（jsdom 下 import.meta.url 不是 file: 协议，不能拿来定位源文件）
const CSS_PATH = resolve(process.cwd(), 'src/styles/tokens.css');
const GLASS_SIZES = [0, 0.62, 1];

type Rgb = [number, number, number];

interface Block {
  sel: string;
  /** null = 与主题无关的派生块（`:root…`），对所有主题合并 */
  theme: string | null;
  mode: string | null;
  decls: Map<string, string>;
}

function parseBlocks(css: string): Block[] {
  const blocks: Block[] = [];
  const re = /\n([^\n{]+)\{([^}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css))) {
    const sel = m[1].trim();
    // 认两种块：主题块 `[data-theme…]`，和与主题无关的派生块 `:root…`（情绪面、悬浮几何
    // 这些都声明在这里，值由 var() 引用当前主题的令牌，用的时候才展开）。
    // `[data-glass="off"][data-theme=…]` 那类回退块写的仍是 var() 间接引用，继续排除在外。
    if (!sel.startsWith('[data-theme') && !sel.startsWith(':root')) continue;
    const tm = sel.match(/data-theme="([^"]+)"/);
    const mm = sel.match(/data-mode="([^"]+)"/);
    const decls = new Map<string, string>();
    for (const line of m[2].split('\n')) {
      const d = line.match(/^\s*(--[\w-]+)\s*:\s*(.+?);/);
      if (d) decls.set(d[1], d[2].trim());
    }
    blocks.push({ sel, theme: tm ? tm[1] : null, mode: mm ? mm[1] : null, decls });
  }
  return blocks;
}

/** 按源码顺序合并：后写的块与前缀更具体的修正块都能覆盖前面的默认值。 */
function resolveTheme(blocks: Block[], theme: string, mode: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const b of blocks) {
    if (b.theme && b.theme !== theme) continue;
    if (b.mode && b.mode !== mode) continue;
    for (const [k, v] of b.decls) out.set(k, v);
  }
  return out;
}

/**
 * 只算「数字 × 数字 ± 数字」这一种形状的算术，不做通用表达式求值，也不 eval。
 * 之所以要支持 +/- ：悬浮蓝栏的底色透明度写成 `calc(0.86 + var(--glass-alpha) * 0.14)`，
 * 有一个下限（玻璃强度拉到 0 时栏面仍然要是实的），纯乘法形状表达不出下限。
 */
function evalCalc(expr: string): number {
  let total = 0;
  for (const term of expr.split(/(?=[+-])/)) {
    const trimmed = term.trim();
    if (trimmed.length === 0) continue;
    const sign = trimmed.startsWith('-') ? -1 : 1;
    const factors = trimmed
      .replace(/^[+-]/, '')
      .split('*')
      .map((f) => Number(f.trim()));
    if (factors.some((n) => Number.isNaN(n))) throw new Error(`calc() 里出现非数字项：${expr}`);
    total += sign * factors.reduce((a, b) => a * b, 1);
  }
  return total;
}

/** 展开 var(--glass-alpha) 与 calc()，然后解析 #rrggbb / rgb(...) / rgba(… / a)。 */
function normalize(value: string, glassAlpha: number): string {
  let v = value.replace(/var\(--glass-alpha\)/g, String(glassAlpha));
  for (let i = 0; i < 4 && v.includes('calc('); i++) {
    v = v.replace(/calc\(([^()]*)\)/, (_, e) => evalCalc(e).toFixed(6));
  }
  return v;
}

function parseRgb(value: string, glassAlpha: number): { rgb: Rgb; alpha: number } {
  const v = normalize(value, glassAlpha);
  const hex = v.match(/^#([0-9a-f]{6})$/i);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return { rgb: [(n >> 16) & 255, (n >> 8) & 255, n & 255], alpha: 1 };
  }
  const rgb = v.match(/rgba?\(([^)]+)\)/);
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
 * color-mix(in srgb, A P%, B)：情绪面令牌（--state-*）与壳层派生令牌就是这一种形状，
 * 所以校验对象必须能算它，否则测试会静默跳过真正上屏的那层颜色。
 * 只支持这一种固定语法（两种分量 + 一个百分比 + 无色彩空间修饰），不做表达式求值。
 */
const MIX_RE = /^color-mix\(\s*in\s+srgb\s*,\s*(.+?)\s+(\d+(?:\.\d+)?)%\s*,\s*(.+?)\s*\)$/i;

function resolvePart(
  tokens: Map<string, string>,
  part: string,
  glassAlpha: number,
  depth: number,
): { rgb: Rgb; alpha: number } {
  const p = part.trim();
  if (/^transparent$/i.test(p)) return { rgb: [0, 0, 0], alpha: 0 };
  const ref = p.match(/^var\(\s*(--[\w-]+)\s*(?:,[^)]*)?\)$/);
  if (ref) {
    const raw = tokens.get(ref[1]);
    if (!raw) throw new Error(`令牌 ${ref[1]} 未定义（被 ${p} 引用）`);
    return resolveValue(tokens, raw, glassAlpha, depth + 1);
  }
  return parseRgb(p, glassAlpha);
}

function resolveValue(
  tokens: Map<string, string>,
  value: string,
  glassAlpha: number,
  depth = 0,
): { rgb: Rgb; alpha: number } {
  if (depth > 6) throw new Error(`令牌引用过深（>6 层）：${value}`);
  const v = normalize(value, glassAlpha);
  const mix = v.match(MIX_RE);
  if (mix) {
    const a = resolvePart(tokens, mix[1], glassAlpha, depth);
    const b = resolvePart(tokens, mix[3], glassAlpha, depth);
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
  // 纯色值之外还可能是整枚 var() 别名（高对比主题把 --color-surface 直接指向 elevated）
  if (/^var\(/.test(v)) return resolvePart(tokens, v, glassAlpha, depth);
  return parseRgb(v, glassAlpha);
}

/** 取令牌最终显示出来的颜色（半透明面先合成到它下面的页面底色）。 */
function colorOf(tokens: Map<string, string>, key: string, page: Rgb, glassAlpha: number): Rgb {
  const raw = tokens.get(key);
  if (!raw) throw new Error(`令牌 ${key} 未定义`);
  const { rgb, alpha } = resolveValue(tokens, raw, glassAlpha);
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

const TEXT_ON_BACKGROUNDS: Array<[string, string[], number, string]> = [
  // 前景令牌, 允许的背景令牌, 阈值, 这个配对来自界面哪里
  ['--color-text', ['--color-bg', '--color-surface', '--color-surface-elevated', '--color-surface-sunken'], 4.5, '正文/输入框文字（输入框底是 sunken）'],
  ['--color-text-muted', ['--color-bg', '--color-surface', '--color-surface-elevated', '--color-surface-sunken'], 4.5, '次要文字、字段标签、.launcher-hints'],
  ['--color-success', ['--color-bg', '--color-surface', '--color-surface-elevated'], 4.5, '.badge-success 是 12px 文字'],
  ['--color-warning', ['--color-bg', '--color-surface', '--color-surface-elevated'], 4.5, '.badge-warning 同上'],
  ['--color-danger', ['--color-bg', '--color-surface', '--color-surface-elevated'], 4.5, '.badge-danger 与 .btn-danger 的文字'],
  ['--color-text-inverse', ['--color-primary', '--color-primary-hover'], 4.5, '.btn-primary 文字、页码当前档、.user-avatar 的字'],
  ['--color-on-primary-muted', ['--color-primary', '--color-primary-hover'], 4.5, '认证页反相条上的副行与图标'],
  ['--color-text', ['--nav-active'], 4.5, '侧栏当前项（主色染面，壳层贴边后侧栏唯一的选中底）'],
  ['--focus-ring', ['--color-bg', '--color-surface', '--color-surface-elevated', '--color-surface-sunken'], 3, ':focus-visible 的 2px 轮廓（非文字对比）'],
];

/**
 * 情绪色（--state-*）是本轮换皮新加的一层：详情抽屉头部带与常驻面板展开态把
 * 「当前状态」染到面上，文字仍用 --color-text / --color-text-muted。
 * 它是 color-mix 派生令牌，所以必须等上面那套解析支持混合之后再验——
 * 16~18% 的染色足以把亮色主题的面上亮度抬高，也能把暗色主题的压暗。
 */
const STATE_BACKGROUNDS = ['--state-neutral', '--state-ok', '--state-warn', '--state-bad', '--state-idle'];
for (const [fg, , min, why] of TEXT_ON_BACKGROUNDS.slice(0, 2)) {
  TEXT_ON_BACKGROUNDS.push([fg, STATE_BACKGROUNDS, min, `情绪面（${why}）`]);
}

/**
 * 认证场景（--scene-*）：首次启动 / 解锁 / 密钥同意 / 启动失败那四页共用的氛围层。
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
 * 阈值：文字 ≥4.5:1；下划线描边与切换器图标属非文字对比 ≥3:1。
 * --scene-switch-track/-thumb **不在**下面的承托面表里：切换器上只放 15px 图标笔画，从不压正文，
 * 按 4.5 去要求它们会把可用的三档图标色逼成实色块，反而看不清哪一档被选中；它们走 3:1 那两行。
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
  ['--color-text-muted', SCENE_SURFACES, 4.5, '副标题、场景说明、占位符、切换器未选中图标'],
  ['--color-danger', ['--scene-panel'], 4.5, '报错条文字：只有这块接近实心的条承得住'],
  ['--scene-cta-ink', ['--scene-cta-bg'], 4.5, '主 CTA（开启助手 / 解锁）的文字压在这枚反相实心条上'],
  ['--scene-line', ['--scene-canvas', '--scene-glow-a', '--scene-glow-b', '--scene-veil'], 3, '下划线式输入框的静置描边（非文字对比基线）'],
  ['--scene-focus', ['--scene-canvas', '--scene-glow-a', '--scene-glow-b', '--scene-veil'], 3, '聚焦时从左边走满的那条下划线'],
  ['--scene-switch-icon', ['--scene-switch-track'], 3, '切换器里未选中两档的图标笔画'],
  ['--scene-switch-icon-on', ['--scene-switch-thumb'], 3, '滑块上那枚选中图标'],
];

/** 按 SCENE_BACKDROP 登记的层叠顺序合成到染底上，再取前景。实心令牌不受 page 影响。 */
function sceneColorOf(tokens: Map<string, string>, key: string, glassAlpha: number, depth = 0): Rgb {
  if (depth > 4) throw new Error(`场景层叠过深（>4 层）：${key}`);
  const base = key in SCENE_BACKDROP ? SCENE_BACKDROP[key] : '--scene-glow-a';
  const page: Rgb = base === null ? [0, 0, 0] : sceneColorOf(tokens, base, glassAlpha, depth + 1);
  return colorOf(tokens, key, page, glassAlpha);
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
function rgbaOf(tokens: Map<string, string>, key: string, page: Rgb, glassAlpha: number): { rgb: Rgb; alpha: number } {
  const raw = tokens.get(key);
  if (!raw) throw new Error(`令牌 ${key} 未定义`);
  const c = resolveValue(tokens, raw, glassAlpha);
  return { rgb: c.alpha >= 1 ? c.rgb : (composite(c.rgb, c.alpha, page) as Rgb), alpha: c.alpha };
}

/** 椭圆径向渐变里任意点的进度：显式尺寸（如 125% 95%）下 100% 就是那两条半径本身。 */
function radialProgress(x: number, y: number, cx: number, cy: number, rx: number, ry: number): number {
  return Math.min(Math.hypot((x - cx) / rx, (y - cy) / ry), 1);
}

/** 画布上任意一点最终呈现的底：五档渐变 → 两束光 → 径向蒙版 → 竖向蒙版 → 噪点最坏档。 */
function scenePoint(tokens: Map<string, string>, x: number, y: number, glassAlpha: number): Rgb {
  const canvas = sceneColorOf(tokens, '--scene-canvas', glassAlpha);
  const ramp = RAMP_KEYS.map((k, i) => [RAMP_POS[i] / 100, colorOf(tokens, k, canvas, glassAlpha)] as [number, Rgb]);
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
    const glow = rgbaOf(tokens, glowKey, canvas, glassAlpha);
    const t = glow.alpha * Math.max(0, 1 - radialProgress(x, y, gx, gy, rx, ry) / fall);
    if (t > 0) rgb = mixRgb(glow.rgb, t, rgb);
  }
  const scrim = rgbaOf(tokens, '--scene-scrim', canvas, glassAlpha);
  const alphaAt = (keys: string[], pos: number[], u: number) =>
    lerp(pos.map((p, i) => [p, rgbaOf(tokens, keys[i], canvas, glassAlpha).alpha] as [number, number]), u);
  const a = Math.min(1, 1 - (1 - alphaAt(SCRIM_RADIAL_KEYS, SCRIM_RADIAL_POS, radialProgress(x, y, SCRIM_RADIAL.cx, SCRIM_RADIAL.cy, SCRIM_RADIAL.rx, SCRIM_RADIAL.ry))) * (1 - alphaAt(SCRIM_V_KEYS, SCRIM_V_POS, y)));
  rgb = mixRgb(scrim.rgb, a * scrim.alpha, rgb);
  // 噪点那层是 overlay 混合，解析器算不出合成结果，按令牌记的最坏档（把反色往上提）验
  const grain = rgbaOf(tokens, '--scene-grain-worst', canvas, glassAlpha);
  return mixRgb(grain.rgb, grain.alpha, rgb);
}

const blocks = parseBlocks(readFileSync(CSS_PATH, 'utf8'));

describe('主题令牌的文字对比度（需求 line 246 / §7 焦点可见）', () => {
  it('tokens.css 覆盖到的主题与 THEME_STYLES 完全一致，新增风格不会漏过校验', () => {
    const inCss = new Set(blocks.filter((b) => b.theme).map((b) => b.theme as string));
    expect([...THEME_STYLES].sort()).toEqual([...inCss].sort());
  });

  for (const style of THEME_STYLES) {
    for (const mode of ['light', 'dark'] as const) {
      for (const glassAlpha of GLASS_SIZES) {
        const label = `${style} / ${mode} / 玻璃强度 ${glassAlpha}`;
        it(label, () => {
          const tokens = resolveTheme(blocks, style, mode);
          if (!tokens.has('--color-bg')) {
            throw new Error(`${style}/${mode} 没有解析到 --color-bg：主题块或模式块缺失`);
          }
          const failures: string[] = [];
          for (const [fgKey, bgKeys, min, why] of TEXT_ON_BACKGROUNDS) {
            if (!tokens.has(fgKey)) {
              failures.push(`缺令牌 ${fgKey}（${why}）`);
              continue;
            }
            const page = colorOf(tokens, '--color-bg', [0, 0, 0], glassAlpha);
            const fg = colorOf(tokens, fgKey, page, glassAlpha);
            for (const bgKey of bgKeys) {
              if (!tokens.has(bgKey)) continue;
              const bg = colorOf(tokens, bgKey, page, glassAlpha);
              const ratio = r2(contrast(fg, bg));
              if (ratio < min) failures.push(`${fgKey}(${fg.map(Math.round)}) 对 ${bgKey}(${bg.map(Math.round)}) = ${ratio}:1，低于 ${min}:1 ← ${why}`);
            }
          }
          expect(failures, label).toEqual([]);
        });
      }
    }
  }

  it('认证场景的 --scene-* 层：裸字段压在这层染底上仍逐主题逐模式逐玻璃强度达标', () => {
    for (const style of THEME_STYLES) {
      for (const mode of ['light', 'dark'] as const) {
        for (const glassAlpha of GLASS_SIZES) {
          const tokens = resolveTheme(blocks, style, mode);
          const failures: string[] = [];
          for (const [fgKey, bgKeys, min, why] of SCENE_TEXT_ON_BACKGROUNDS) {
            if (!tokens.has(fgKey)) {
              failures.push(`缺令牌 ${fgKey}（${why}）`);
              continue;
            }
            const fg = sceneColorOf(tokens, fgKey, glassAlpha);
            for (const bgKey of bgKeys) {
              if (!tokens.has(bgKey)) {
                failures.push(`缺令牌 ${bgKey}（${why}）`);
                continue;
              }
              const bg = sceneColorOf(tokens, bgKey, glassAlpha);
              const ratio = r2(contrast(fg, bg));
              if (ratio < min) failures.push(`${fgKey}(${fg.map(Math.round)}) 对 ${bgKey}(${bg.map(Math.round)}) = ${ratio}:1，低于 ${min}:1 ← ${why}`);
            }
          }
          expect(failures, `${style} / ${mode} / 玻璃强度 ${glassAlpha}`).toEqual([]);
        }
      }
    }
  });

  it('认证场景那道左深右浅的五档渐变：整幅取样点上的文字落点都达标', () => {
    // 上面那张 --scene-* 表钉的是"染底 + 蒙版"这几枚平面令牌；这一条钉的是真正上屏的那幅画：
    // .auth-bg 的五档渐变（右端最亮的一档按主色染到 72%）本身**不是**安全面，安全是因为
    // 蒙版按位置把它压回去。所以要按位置取样，而不是逐个令牌查表。
    // 取样框取整幅（x 2%~98%、y 3%~97%）：正文与字段都在这块里，四边留一点余量给纯装饰的沿。
    for (const style of THEME_STYLES) {
      for (const mode of ['light', 'dark'] as const) {
        for (const glassAlpha of GLASS_SIZES) {
          const tokens = resolveTheme(blocks, style, mode);
          const failures: string[] = [];
          const fgOf = (key: string): Rgb => sceneColorOf(tokens, key, glassAlpha);
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
            for (const [x, y] of points) {
              const ratio = r2(contrast(fg, scenePoint(tokens, x, y, glassAlpha)));
              if (ratio < min) {
                failures.push(`${fgKey}（${why}）在 x=${x.toFixed(2)} y=${y.toFixed(2)} 的底上只有 ${ratio}:1，低于 ${min}:1`);
                break;
              }
            }
          }
          expect(failures, `${style} / ${mode} / 玻璃强度 ${glassAlpha}`).toEqual([]);
        }
      }
    }
  });

  it('五档渐变确实是左深右浅：逐主题逐模式的右端落点亮于左端', () => {
    // 这条是使用者提出的观感口径（"整个背景色主色应该是从左到右渐变的，变浅"），
    // 观感本来不进测试，但它一次退化就能悄悄发生（把止点写反、或蒙版压平），所以钉住。
    // high-contrast 例外：它按需求 5.4 的定位把氛围层整块撤平成实心 bg，本来就不该有渐变，
    // 这一套由上面那条取样守卫负责验"整幅都是同一块底、文字照样达标"。
    for (const style of THEME_STYLES.filter((s) => s !== 'high-contrast')) {
      for (const mode of ['light', 'dark'] as const) {
        const tokens = resolveTheme(blocks, style, mode);
        for (const glassAlpha of GLASS_SIZES) {
          const left = luminance(scenePoint(tokens, 0.06, 0.5, glassAlpha));
          const right = luminance(scenePoint(tokens, 0.9, 0.5, glassAlpha));
          expect(right, `${style}/${mode} 右端应比左端亮（左 ${left.toFixed(3)} 右 ${right.toFixed(3)}）`).toBeGreaterThan(left);
        }
      }
    }
  });

  it('渐变是加速的：右端四分位的亮度增量至少是左端四分位的 3 倍', () => {
    // 使用者第二轮口径："越往右变化的幅度越大"。上一那条只钉方向，钉不出曲线形状——
    // 等比差的五档（30/21/13/6/0）方向对、观感却是"左边变化最猛、右边收住"。
    // 这里把整幅按 x 分成左右两个四分位，比较各自的实际亮度增量（含光晕与蒙版后的合成结果，
    // 也就是屏幕上真正看到的那幅），要求右边至少快 3 倍。左端增量允许为负（暗档左半几乎不动，
    // 亮档左半会被右上角光晕轻微压暗），所以只对右端增量要求"为正且够大"。
    // high-contrast 同上一条一起豁免：它的氛围层整块撤平，没有曲线可言。
    for (const style of THEME_STYLES.filter((s) => s !== 'high-contrast')) {
      for (const mode of ['light', 'dark'] as const) {
        const tokens = resolveTheme(blocks, style, mode);
        for (const glassAlpha of GLASS_SIZES) {
          const at = (x: number) => luminance(scenePoint(tokens, x, 0.5, glassAlpha));
          const leftGain = at(0.25) - at(0.02);
          const rightGain = at(0.98) - at(0.75);
          expect(rightGain, `${style}/${mode}/玻璃 ${glassAlpha} 右端必须在变亮（左 ${leftGain.toFixed(4)} 右 ${rightGain.toFixed(4)}）`).toBeGreaterThan(0);
          expect(
            rightGain,
            `${style}/${mode}/玻璃 ${glassAlpha} 变化幅度没有越往右越大：右四分位 ${rightGain.toFixed(4)} < 左四分位 ${leftGain.toFixed(4)} × 3`,
          ).toBeGreaterThanOrEqual(leftGain * 3);
        }
      }
    }
  });

  it('浮层选中行的徽标反相后仍然达标：主色字画在 text-inverse 底上', () => {
    // global.css 把 .launcher-row[aria-selected=true] .badge 改成 底=text-inverse / 字=primary，
    // 因为任何绿色在饱和蓝底上都到不了 4.5:1。这里守住替代方案本身。
    for (const style of THEME_STYLES) {
      for (const mode of ['light', 'dark'] as const) {
        const tokens = resolveTheme(blocks, style, mode);
        const page = colorOf(tokens, '--color-bg', [0, 0, 0], 0.62);
        const fg = colorOf(tokens, '--color-primary', page, 0.62);
        const bg = colorOf(tokens, '--color-text-inverse', page, 0.62);
        expect(r2(contrast(fg, bg)), `${style}/${mode} 徽标反相`).toBeGreaterThanOrEqual(4.5);
      }
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
    // 这条守卫是本轮补的：tokens.css 曾经谁都没 import，构建产物里一个 --color-* 声明都没有，
    // 而按 label 查 DOM 的 jsdom 测试照样全绿——因为 jsdom 根本不做层叠与取色。
    // 引入关系漏了不会报错，只会让界面退回浏览器默认颜色，所以必须显式守住。
    for (const entry of ['src/main.tsx', 'src/launcher.tsx']) {
      const text = readFileSync(resolve(process.cwd(), entry), 'utf8');
      expect(text, `${entry} 没有引入 tokens.css`).toMatch(/import\s+['"][^'"]*styles\/tokens\.css['"]/);
      expect(text, `${entry} 没有引入 global.css`).toMatch(/import\s+['"][^'"]*styles\/global\.css['"]/);
    }
  });

  it('滑块与图标的位移动效不被换皮那一帧的颜色抑制罩住', () => {
    // lib/theme.ts 的 applyTheme 在改 data-theme/data-mode 那一帧注入 `*{transition:none!important}`
    // （满屏同时补间颜色会糊成一片）。切换器的位移与缩放也在那一帧里变，若不排除，
    // 点下去只会看到滑块"瞬移"——原型的弹性滑动就没了。这里守住豁免本身。
    const css = readFileSync(resolve(process.cwd(), 'src/styles/global.css'), 'utf8');
    for (const sel of ['.theme-switch__slider', '.theme-btn svg']) {
      const block = css.match(new RegExp(`\\${sel}\\s*\\{[^}]*\\}`));
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
    // 同时守住没有一起被摘掉的两处：切换器那三枚按钮、以及高对比度档里加粗的聚焦线
    // （那一档静置线与聚焦线同色，只能靠粗细差别说明"焦点在这里"）。
    expect(css).toMatch(/\.theme-btn:focus-visible\s*\{[^}]*outline:\s*var\(--focus-ring-width\)/);
    expect(css).toMatch(/data-theme='high-contrast'\] \.auth-panel \.field:focus-within::after\s*\{[^}]*height:\s*2px/);
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
    // 不会报错，只会让那条边框在 7 套主题里都是同一个浅灰——正是需求 line 246 要避免的事。
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
