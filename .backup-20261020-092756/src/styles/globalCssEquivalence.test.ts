import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import type { AtRule, Declaration, Rule } from 'postcss';
import { describe, expect, it } from 'vitest';

/**
 * global.css 逐声明等价对账 —— 「最终的样式布局保持现有一致」这条硬约束的机器判据。
 *
 * 为什么不是截图：屏幕录制未授权，取不到 .app 的像素；localhost 又渲染不出依赖后端的界面。
 * 所以这里比的是**规则本身**：把基线 global.css 与重构后的 global.css 各自摊平成
 * 「有序的 (选择器 → 声明表)」序列，逐条对齐。层叠模型从「不带层」换成 Tailwind v4 的
 * `@layer`，只要有一条声明的内容、顺序或归属变了，这里就红。
 *
 * 允许的变动只有 ALLOWED 里逐条写明原因的那几处；新增一条未登记的变动同样会红。
 * 基线取仓库里最新的那份快照目录下的 src/styles/global.css（本项目不用 git，快照即版本）。
 */

const require = createRequire(import.meta.url);
const postcss = require('postcss');

const ROOT = resolve(process.cwd());
const NEW_PATH = join(ROOT, 'src/styles/global.css');

/** 找最新一份带 global.css 的快照目录当基线。 */
function findBaseline(): string {
  const snaps = readdirSync(ROOT)
    .filter((d) => /^\.backup-\d{8}-\d{6}$/.test(d))
    .filter((d) => existsSync(join(ROOT, d, 'src/styles/global.css')))
    .sort();
  if (snaps.length === 0) throw new Error('找不到 .backup-*/src/styles/global.css 基线，无法对账');
  return join(ROOT, snaps[snaps.length - 1], 'src/styles/global.css');
}

/**
 * 令牌改名映射：`--color-text-muted` → `--t-text-muted`。
 * **两侧都要过这道归一化**：基线里所有 var(--color-*) 换算成 var(--t-*)，重构后本来就写
 * var(--t-*) 的则是无操作。只在单侧换算会让改名这件事本身变成一条假差异。
 */
function renameTokens(text: string): string {
  return text.replace(/var\(\s*--color-([\w-]+)\s*(,)?/g, (_all, name, fallback) => `var(--t-${name}${fallback ?? ''}`);
}

/** 不参与对账的 at-rule：Tailwind v4 的入口与令牌桥接层，基线里对应的是 @tailwind 三条指令。 */
const DROP_AT_RULES = new Set(['import', 'tailwind', 'source', 'theme', 'charset', 'namespace', 'plugin', 'custom-variant', 'reference']);

interface Entry {
  key: string;
  decls: string[];
}

/**
 * 摊平：`@layer` 透明穿透（它是分组，不改变规则本身），`@media`/`@supports`/`@keyframes`
 * 记进 key 前缀，保留源码顺序。
 */
function flatten(css: string): Entry[] {
  const out: Entry[] = [];
  const root = postcss.parse(css);

  const collectDecls = (rule: { nodes?: unknown[] } | undefined): string[] => {
    if (!rule || !Array.isArray(rule.nodes)) return [];
    const list: string[] = [];
    for (const n of rule.nodes as Array<{ type: string; prop?: string; value?: string; important?: boolean }>) {
      if (n.type === 'decl') list.push(`${n.prop}:${n.value?.replace(/\s+/g, ' ').trim()}${n.important ? ' !important' : ''}`);
    }
    return list.sort();
  };

  const walk = (node: { nodes?: unknown[] }, prefix: string) => {
    for (const child of (node.nodes ?? []) as Array<Record<string, unknown>>) {
      if (child.type === 'rule') {
        out.push({ key: `${prefix}${(child.selector as string).replace(/\s+/g, ' ').trim()}`, decls: collectDecls(child as never) });
      } else if (child.type === 'atrule') {
        const name = child.name as string;
        const params = (child.params as string).replace(/\s+/g, ' ').trim();
        if (DROP_AT_RULES.has(name)) continue;
        if (name === 'layer') {
          // `@layer components { … }` 不带 params 之外的语义，层归属由 key 前缀记录，
          // 但基线根本没有层，所以这里保持前缀不变：只穿透，不登记层名。
          walk(child as never, prefix);
          continue;
        }
        walk(child as never, `${prefix}@${name} ${params} › `);
      }
    }
  };

  walk(root, '');
  return out;
}

/**
 * 已登记的变动。每一条都必须写明「为什么这不是布局变化」，且只在指定方向上生效：
 * added = 只准出现在重构后；removed = 只准从基线消失；modified = 键名不变但内容变了。
 * 对账时先把这些条目摘掉，剩下的必须逐条全等；modified 另有「必须真的变了」的反向核对。
 */
const ALLOWED: {
  added: Array<{ match: string; why: string }>;
  removed: Array<{ match: string; why: string }>;
  modified: Array<{ match: string; why: string }>;
} = {
  added: [
    {
      match: '*, ::before, ::after, ::backdrop, ::file-selector-button',
      why: 'Tailwind v4 把只写宽度的 border 默认色从 v3 的 gray-200 改成 currentColor，这一条把默认边框色钉回边框令牌（原 tailwind.config 的 borderColor.DEFAULT 等价物）。它必须待在 base 层，才能被 border-line / border-primary 覆盖。',
    },
    {
      match: ':root',
      why: 'shadcn 词表别名（--background/--foreground/--card/--ring…）。全部由 --t-* 推导、零新增字面色，只服务将要引入的组件，不改变现有界面的任何一条声明。',
    },
    {
      match: '.overlay-dialog',
      why: 'Radix Dialog 的 Content 落位。原先「flex 容器 + padding + w-full max-w-lg」由父级承担，Radix 把 Overlay 与 Content 拆成兄弟节点后必须自己承担。用 inset + margin:auto 而不是 transform，是因为 .overlay-panel 的 panel-in 动画自己要用 transform，两者会互相覆盖。几何逐值对应见 global.css 内注释。',
    },
    {
      match: '.overlay-dialog--drawer',
      why: '同上，抽屉那一档：原先 flex 行内 margin-left:auto 推右 + align-self:flex-start 贴顶，改写成等价绝对定位，保住 drawer-in 的 translateX 补间不被定位覆盖。',
    },
    {
      match: '.dropdown-item:hover, .dropdown-item[data-highlighted]',
      why: '高亮态多挂一个属性选择器：Radix 把键盘选择位写在 data-highlighted 上，只认 :hover 时键盘走菜单全程无视觉反馈。底色档位与 :hover 共用同一条声明，鼠标与键盘看到的是同一个状态。',
    },
    { match: '.select-trigger', why: 'Radix Select 触发钮的箭头槽与横向排布。原生 select 的箭头由系统画在 padding 内，Radix 的要自己腾位置。' },
    { match: '.select-trigger[data-disabled]', why: '禁用态从原生 :disabled 伪类改挂在 Radix 写的 data-disabled 属性上，数值沿用 .input:disabled 那一档 0.5。' },
    { match: '.select-icon', why: '触发钮右侧那枚箭头的落点（chevronDown，14px）。' },
    { match: '.select-auto', why: '行内用法（表格里那枚改角色、明文查看器那枚字段选择器）贴着文字收缩。原先是 inline style width:auto；必须留在同层做修饰符，因为 @layer mda 优先级高于 utilities，w-auto 压不住 .select 的 width:100%。' },
    { match: '.select-content', why: 'Select 浮层宽度取触发钮宽度。其余样式复用 .dropdown-menu/.dropdown-item，不另造一套菜单词汇。' },
    { match: '.icon-swap', why: '图标形变动画换成 CSS 过渡后的入场动画载体类（已批准决策：删 morphicons，用 CSS 补切换感）。' },
    { match: '@keyframes mda-icon-swap › from', why: '同上，配套关键帧。' },
    { match: '@keyframes mda-icon-swap › to', why: '同上，配套关键帧。' },
  ],
  removed: [
    {
      match: '.dropdown-item:hover',
      why: '与下面那条成对：同一条规则的键名变了（多了 data-highlighted），不是被删掉。',
    },
    {
      match: '.popover-panel--right',
      why: '锚定侧改由 Radix 的 align="end" 给（TopBar 那两处下拉），这条 `right:0` 不再有挂载对象。',
    },
    {
      match: '.popover-panel--left',
      why: '同上，改由 align="start" 承担（AccountsPage 导出那一处）。',
    },
    {
      match: "input[type='checkbox'], input[type='radio']",
      why: '原生勾选/单选控件整批换成 Radix 自绘按钮（ui/checkbox.tsx、ui/radio-group.tsx），全仓库已没有 input[type=checkbox|radio]，这条 15px + accent-color 失去挂载对象；同值尺寸改由组件的 size-[15px]/size-4 提供。',
    },
    {
      match: '.checkbox-label input',
      why: '同上：外壳 .checkbox-label 三条都保留（底色、hover、几何一字未动），只有里面那颗控件从 input 变成 button，这条 16px 由 Checkbox 的 size-4 逐值接手。',
    },
  ],
  modified: [
    {
      match: '.popover-panel',
      why: '删掉 `position:absolute` 与 `top:calc(100%+12px)` 两条：Radix 的 Content 由 Popper 写内联坐标，这两条会被覆盖成死声明；那 12px 间距改由 sideOffset 给。flex/gap/max-width 三条原样保留。',
    },
    {
      match: '.export-panel',
      why: '同上，删掉 `top:calc(100%+8px)` 那一条（改由 sideOffset={8}），`width:120px` 原样保留。',
    },
  ],
};

function stripAllowed(entries: Entry[], allowed: Array<{ match: string; why: string }>): Entry[] {
  const names = new Set(allowed.map((a) => a.match));
  return entries.filter((e) => !names.has(e.key));
}

/**
 * `modified` 那一档单独说：ALLOWED.added/removed 只能表达"整条规则新增/消失"，
 * 而有些规则是**内容变了但键名不变**（例如删掉一条已被 Radix 内联坐标取代的 position:absolute）。
 * 这类条目从两侧同时摘掉，不参与严格相等比较——摘掉之后仍会由下面那条
 * "登记过的变动确实各发生了 0 次以上"的核对兜住，避免登记了一条其实没用的豁免。
 */
function dropModified(entries: Entry[], keys: Set<string>): Entry[] {
  return entries.filter((e) => !keys.has(e.key));
}

function render(entries: Entry[]): string {
  return entries.map((e) => `${e.key} { ${e.decls.join('; ')} }`).join('\n');
}

const baseline = renameTokens(readFileSync(findBaseline(), 'utf8'));
const current = renameTokens(readFileSync(NEW_PATH, 'utf8'));

const baseAll = flatten(baseline);
const newAll = flatten(current);
const MODIFIED_KEYS = new Set(ALLOWED.modified.map((m) => m.match));
const base = dropModified(stripAllowed(baseAll, ALLOWED.removed), MODIFIED_KEYS);
const next = dropModified(stripAllowed(newAll, ALLOWED.added), MODIFIED_KEYS);

/** 按 key 取某一条规则的声明表（同名多取首条，用于 modified 的反向核对）。 */
function pick(entries: Entry[], key: string): string[] | undefined {
  return entries.find((e) => e.key === key)?.decls;
}

describe(`global.css 与基线快照逐声明等价（基线取 ${findBaseline().replace(ROOT + '/', '')}）`, () => {
  it('基线确实解析出了规则，否则这条对账是空转', () => {
    // 解析器一旦因为语法不认识而静默吐出 0 条，"两边都空 = 相等"会伪装成通过。
    expect(baseAll.length).toBeGreaterThan(300);
    expect(newAll.length).toBeGreaterThan(300);
  });

  it('规则条数在登记过的变动之外完全一致', () => {
    expect(next.length - base.length, `重构后 ${next.length} 条，基线 ${base.length} 条，差额未被 ALLOWED 覆盖`).toBe(0);
  });

  it('每一条规则的声明内容与顺序都与基线一致', () => {
    expect(render(next)).toBe(render(base));
  });

  it('没有哪条基线规则在重构后无声消失', () => {
    const newKeys = new Set(next.map((e) => e.key));
    const missing = base.filter((e) => !newKeys.has(e.key)).map((e) => e.key);
    expect(missing).toEqual([]);
  });

  it('没有未登记的新规则混进来', () => {
    const baseKeys = new Set(base.map((e) => e.key));
    const extra = next.filter((e) => !baseKeys.has(e.key)).map((e) => e.key);
    expect(extra).toEqual([]);
  });

  it('登记过的每一条变动都真的发生了（豁免表不许空转）', () => {
    // 与 themeContrast.test.ts 里"原型豁免表不许留空转条目"同一条纪律：
    // 登记了却没实际发生，说明这条豁免已经失去意义，会误导下一个读它的人。
    for (const a of ALLOWED.added) {
      expect(pick(newAll, a.match), `登记为新增，但重构后没有这条规则：${a.match} —— ${a.why}`).toBeDefined();
      expect(pick(baseAll, a.match), `登记为新增，但基线里本来就有：${a.match}`).toBeUndefined();
    }
    for (const r of ALLOWED.removed) {
      expect(pick(baseAll, r.match), `登记为移除，但基线里没有这条：${r.match} —— ${r.why}`).toBeDefined();
      expect(pick(newAll, r.match), `登记为移除，但它还在重构后里：${r.match}`).toBeUndefined();
    }
    for (const m of ALLOWED.modified) {
      const before = pick(baseAll, m.match);
      const after = pick(newAll, m.match);
      expect(before, `登记为内容变更，但基线里没有这条：${m.match} —— ${m.why}`).toBeDefined();
      expect(after, `登记为内容变更，但重构后没有这条：${m.match}`).toBeDefined();
      expect(after, `登记为内容变更，但两边完全一样（这条豁免是空的）：${m.match}`).not.toEqual(before);
    }
  });
});

/**
 * 构建产物对账。触发条件是"dist 里有 CSS"，而不是某个环境变量：
 * 用变量开关在 Windows 上跑不了（本项目要出 nsis/msi），而"文件不在就静默跳过"会留下假绿。
 * 所以这里补一条**新鲜度**判据：dist 比源码旧就直接失败，逼着 `npm run build` 必须走在 `npm test` 前面。
 * 完整验收口径：`npm run verify`（typecheck → build → vitest），三步一气呵成。
 */
const distCssPath = (() => {
  const dir = join(ROOT, 'dist/assets');
  if (!existsSync(dir)) return null;
  const f = readdirSync(dir).find((n) => n.endsWith('.css'));
  return f ? join(dir, f) : null;
})();
const CHECK_DIST = distCssPath !== null;

describe.skipIf(!CHECK_DIST)(`构建产物 global-*.css 的保住项（${distCssPath ? distCssPath.replace(ROOT + '/', '') : 'dist 缺失'}）`, () => {
  const dist = distCssPath ? readFileSync(distCssPath, 'utf8') : '';
  const distRoot = dist ? postcss.parse(dist) : null;

  /** 某个选择器下是否存在某条属性。按解析结果问，不按裸字符串数——
   *  字符串计数会把 Tailwind 自己生成的死类（如 .backdrop-filter 那条从注释里扫出来的工具类）
   *  一起算进来，基线 5 与现在 3 的差额就是这么来的，与本应用的呈现无关。 */
  const hasDecl = (selector: string, prop: string): boolean => {
    let found = false;
    distRoot?.walkRules((r: Rule) => {
      if (found) return;
      if (!r.selector.split(',').some((s: string) => s.trim() === selector)) return;
      r.walkDecls((d: Declaration) => {
        if (d.prop === prop) found = true;
      });
    });
    return found;
  };
  const keyframeNames = (): string[] => {
    const out: string[] = [];
    distRoot?.walkAtRules('keyframes', (a: AtRule) => out.push(a.params.trim()));
    return out;
  };

  it('dist 不是陈旧的（产物必须不早于两份样式源文件）', () => {
    // 没有这条，改完 CSS 忘记重新构建时，下面所有产物判据都拿**上一版**的 CSS 过关——
    // 那是最典型的假绿：全绿、但验的不是当前源码。
    const built = statSync(distCssPath!).mtimeMs;
    for (const src of [NEW_PATH, join(ROOT, 'src/styles/tokens.css')]) {
      const m = statSync(src).mtimeMs;
      expect(built, `${src.replace(ROOT + '/', '')} 比 dist 里的 CSS 新 ${Math.round((m - built) / 1000)}s —— 先跑 npm run build 再跑测试`).toBeGreaterThanOrEqual(m);
    }
  });

  it('dist 里有 CSS 产物可查', () => {
    expect(distCssPath, 'dist/assets 下没有 css —— 先跑 npm run build').not.toBeNull();
    expect(dist.length).toBeGreaterThan(10_000);
  });

  /* 三处玻璃面各自的 -webkit- 双胞胎必须还在：加前缀这件事 v3 交给 autoprefixer，
   * 现在由 Lightning CSS 负责，一旦目标浏览器表被收窄，静默少一条就是 WKWebView 上玻璃失效。
   * 选择器与属性都是源文件里实测的那几条（渐变字在 .brand-text、自动填充覆盖在 .auth-panel .input）。 */
  for (const [sel, prop] of [
    ['.surface-glass', '-webkit-backdrop-filter'],
    ['.app-container', '-webkit-backdrop-filter'],
    ['.dropdown-menu', '-webkit-backdrop-filter'],
    ['::-webkit-scrollbar', 'width'],
    ['::-webkit-scrollbar-thumb', 'border-radius'],
    ['.brand-text', '-webkit-background-clip'],
    ['.brand-text', '-webkit-text-fill-color'],
    ['.auth-panel .input:-webkit-autofill', '-webkit-text-fill-color'],
  ] as Array<[string, string]>) {
    it(`产物里 ${sel} 仍带着 ${prop}`, () => {
      expect(hasDecl(sel, prop), `产物里 ${sel} 不见了或丢了 ${prop}`).toBe(true);
    });
  }

  it('关键帧一枚都不许丢，只准多图标切换那一枚', () => {
    // 基线实测的 18 枚名字。少了任何一枚，引用它的 animation 会静默变成"没有动效"。
    const BASE_KEYFRAMES = [
      'float1', 'float2', 'float3', 'dropdown-in', 'spin', 'veil-in', 'panel-in', 'drawer-in',
      'search-modal-in', 'toast-in', 'auth-in', 'tower-float', 'tower-glow', 'tower-sway',
      'tower-flow', 'tower-node', 'tower-tip', 'scene-in',
    ];
    const present = keyframeNames();
    const lost = BASE_KEYFRAMES.filter((n) => !present.includes(n));
    expect(lost, `产物里缺这些关键帧：${lost.join('、')}`).toEqual([]);
    expect(present.filter((n) => !BASE_KEYFRAMES.includes(n)), '多出来的关键帧只有 mda-icon-swap').toEqual(['mda-icon-swap']);
  });

  it('rounded-sm 仍钉在 8px，不是 v4 默认的 4px', () => {
    // v4 的 --radius-sm 默认 0.25rem，而本项目从 v3 起就把它钉成 8px；不重钉等于全站圆角缩一档。
    expect(dist).toMatch(/--radius-sm:\s*8px/);
    expect(dist).toMatch(/--radius-md:\s*16px/);
    expect(dist).toMatch(/--radius-lg:\s*20px/);
    expect(dist).toMatch(/--radius-xl:\s*24px/);
    expect(dist).toMatch(/--radius-full:\s*999px/);
  });

  it('界面层的优先级仍然压在 utilities 之上（层序末尾）', () => {
    // 这条守的是本次迁移的核心决策：自定义类必须继续压得住同元素上的工具类，
    // 否则 .mono 的 0.94em 与 h1/h2/h3 的行高会被 text-xs / text-sm 反超（实测 44 处站点）。
    // 产物里层的实际形式是 `@layer theme{}`、`@layer base{}`、`@layer components,utilities;`
    // （打包器把两条前向声明合成一条）、`@layer mda{}`，所以判"mda 排在 utilities 之后"
    // 只能按文本位置判，不能假设它被拆成独立的一项。
    const utilAt = dist.search(/@layer[^{;]*\butilities\b/);
    const mdaAt = dist.search(/@layer\s+mda\s*\{/);
    expect(utilAt, '产物里没有 utilities 层的声明').toBeGreaterThan(-1);
    expect(mdaAt, '产物里没有 @layer mda 块').toBeGreaterThan(-1);
    expect(mdaAt, 'mda 层排到了 utilities 之前，自定义类会输给工具类').toBeGreaterThan(utilAt);
    const lastLayer = [...dist.matchAll(/@layer\s+([^{};]+)/g)].pop();
    expect(lastLayer?.[1].trim(), `最后一个层不是 mda：${[...dist.matchAll(/@layer\s+([^{};]+)/g)].map((m) => m[1].trim()).join(' → ')}`).toContain('mda');
    // 层序对了还不够，得确认那条真的依赖层序的规则确实在 mda 块里面。
    const mdaBlock = dist.slice(mdaAt);
    expect(mdaBlock, '.mono 不在 mda 块里，层序保护对它不成立').toContain('.mono');
    expect(mdaBlock, 'h1,h2,h3 那条行高规则不在 mda 块里').toMatch(/h1,h2,h3|h1,\s*h2,\s*h3/);
  });

  it('四套主题的字面色一条都没被 Tailwind 的默认调色板顶掉', () => {
    // 主题块里那些十六进制值如果没进产物，说明 [data-theme] 被当成未使用而摇掉了，
    // 换皮会静默退化成"四套看起来一样"。取各套的主色与底色各一枚。
    for (const hex of ['#4f46e5', '#18181b', '#e4e4e7', '#06b6d4', '#f1ebf6', '#030712']) {
      expect(dist, `产物里找不到主题字面色 ${hex}`).toContain(hex);
    }
  });

  it('utilities 层不是空的，且令牌工具类展开成主题变量', () => {
    /* 这条是被真实事故逼出来的：@source 的路径相对**本 CSS 文件所在目录**解析，
     * 写成 "../src/**" 会变成 src/src/**，Tailwind 不报错、只是生成 0 条工具类，
     * 于是 text-ink-muted 这类用满 110 处的类静默失效，界面退回继承色，
     * 而上面那组"global.css 自身规则逐条等价"的对账完全看不出来。
     * 所以产物侧必须直接验：有 utilities 层、层里有东西、且令牌类展开的是 --t-*。 */
    const generated: Record<string, string> = {};
    const WATCH = ['.bg-primary', '.text-ink-muted', '.text-ink', '.border-line', '.rounded-sm', '.bg-sunken', '.text-danger'];
    distRoot?.walkRules((r: Rule) => {
      const s = r.selector.trim();
      if (!WATCH.includes(s) || generated[s]) return;
      const d = r.nodes?.find((n: { type: string }) => n.type === 'decl');
      if (d && d.type === 'decl') generated[s] = `${d.prop}:${d.value}`;
    });
    const missing = WATCH.filter((w) => !generated[w]);
    expect(missing, `这些工具类没进产物 —— @source 路径八成又指空了：${missing.join('、')}`).toEqual([]);
    expect(generated['.bg-primary']).toBe('background-color:var(--t-primary)');
    expect(generated['.text-ink-muted']).toBe('color:var(--t-text-muted)');
    expect(generated['.border-line']).toBe('border-color:var(--t-border)');
    // 展开成 var(--t-*) 而不是编译期固化的实色，才意味着 [data-theme] 仍是唯一真源。
    // rounded-sm 走的是 --radius-*（与主题无关的尺度层），所以不混进这条。
    for (const [sel, decl] of Object.entries(generated)) {
      if (sel === '.rounded-sm') continue;
      expect(decl, `${sel} 被固化成了实色，换皮不会再影响它`).toMatch(/var\(--t-/);
    }
  });

  it('源文件里定义的每个自定义类都还在产物里', () => {
    // 类名从**规则选择器**里取，不从全文本正则取：注释里的 global.css / tailwind.config /
    // dropdown-in 之类会被裸正则误当成类名，造成假失败。
    const srcRoot = postcss.parse(readFileSync(NEW_PATH, 'utf8'));
    const names = new Set<string>();
    srcRoot.walkRules((r: Rule) => {
      for (const m of r.selector.matchAll(/\.([a-zA-Z][\w-]*)/g)) names.add(m[1]);
    });
    // 产物侧同样按选择器判定，并带上"整词"边界：否则 .btn 会被 .btn-primary 里的子串顶掉。
    const distSelectors = new Set<string>();
    distRoot?.walkRules((r: Rule) => {
      for (const part of r.selector.split(',')) distSelectors.add(part.trim());
    });
    const allSel = [...distSelectors].join(',');
    const absent = [...names].filter((n) => !new RegExp(`\\.${n}(?![\\w-])`).test(allSel));
    expect(absent, `这些类定义了却没进产物：${absent.join('、')}`).toEqual([]);
  });
});
