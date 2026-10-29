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
 *
 * 基线**显式钉死在 BASELINE_SNAPSHOT 这一枚目录名上**，并且下面有一条守卫校验它的 sha256。
 * 早期版本是"按目录名排序取最新的一份快照"，那是个能自我取消的陷阱：本项目原先用 `.backup-*`
 * 当版本控制，任何一次开工前快照都会变成新基线，对账随即退化成"新 vs 新"——
 * 门禁还在跑，但它已经不再比任何东西（2026-10-20 审查 F31 就是这条）。
 *
 * 2026-10-22 仓库改用 git 之后，`.backup-*` 快照被清理掉了，基线跟着整文件报错（那批快照是
 * 可以随时删的产物，不该当依赖）。所以基线搬进版本库里的固定目录 `baseline-css-20261019/`，
 * 内容与当初那枚快照逐字节相同（`BASELINE.css.sha256` 三条全部对得上），只是不再挂在快照目录上。
 */

import { createHash } from 'node:crypto';

const require = createRequire(import.meta.url);
const postcss = require('postcss');

const ROOT = resolve(process.cwd());
const NEW_PATH = join(ROOT, 'src/styles/global.css');

/** AD 轮（全局现代化）开工前的那一份基线；要换基线必须显式改这一行，并在交付文档记账。 */
const BASELINE_SNAPSHOT = 'baseline-css-20261019';
const BASELINE_DIR = join(ROOT, BASELINE_SNAPSHOT);

function findBaseline(): string {
  const p = join(BASELINE_DIR, 'src/styles/global.css');
  if (!existsSync(p)) {
    throw new Error(
      `基线 ${BASELINE_SNAPSHOT}/src/styles/global.css 不在。` +
        '本条对账的结论完全依赖这份文件，不许悄悄换一份或删掉——要么从 git 历史恢复它，要么显式改 BASELINE_SNAPSHOT 并在 docs/交付状态与验收.md 记一笔。',
    );
  }
  return p;
}

/** 读回基线目录里登记的 sha256（格式：`<hex>  <相对路径>`，逐行）。 */
function recordedHashes(): Map<string, string> {
  const f = join(BASELINE_DIR, 'BASELINE.css.sha256');
  if (!existsSync(f)) return new Map();
  const m = new Map<string, string>();
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    const g = /^([0-9a-f]{64})\s+(\S+)$/.exec(line.trim());
    if (g) m.set(g[2], g[1]);
  }
  return m;
}

function sha256(absPath: string): string {
  return createHash('sha256').update(readFileSync(absPath)).digest('hex');
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
      why: 'shadcn 词表别名。本轮（审查 F20）按实测收口成一枚 --input：其余 26 枚没有任何组件引用，留着就是改了不生效的惰性等式。全部由 --t-* 推导、零新增字面色，不改变现有界面的任何一条声明。',
    },
    {
      match: '.overlay-dialog',
      why: 'Radix Dialog 的 Content 落位。原先「flex 容器 + padding + w-full max-w-lg」由父级承担，Radix 把 Overlay 与 Content 拆成兄弟节点后必须自己承担。用 inset + margin:auto 而不是 transform，是因为 .overlay-panel 的 panel-in 动画自己要用 transform，两者会互相覆盖。几何逐值对应见 global.css 内注释。AK 二批（2026-10-20）补上 `z-index: 50`：兄弟节点不再天然压在父元素背景之上，遮罩那档 50 残留成了"盖在面板上面"，同档 + 挂载顺序才是 Radix 这套结构下的正确解法（.overlay-dialog--drawer 同一条理由取 40，与抽屉那档遮罩同档）。',
    },
    {
      match: '.overlay-dialog--drawer',
      why: '同上，抽屉那一档：原先 flex 行内 margin-left:auto 推右 + align-self:flex-start 贴顶，改写成等价绝对定位，保住 drawer-in 的 translateX 补间不被定位覆盖。',
    },
    {
      match: '.overlay-dialog--wide',
      why: '导入题库的复核表要一行放下序号/题型/置信度/问题码/题干/答案/右侧勾选框，答题助手弹窗要放下两列下拉与题库勾选清单，32rem 会把内容压成两三行、右侧控件溢出；只把 max-width 提到 48rem，定位、内边距、遮罩与入场动画全部沿用 .overlay-dialog。48rem 在最小窗 960px 下两侧仍各留一档 --spacing-4。',
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
    /* AF 轮（2026-10-20）：交付方点名「优化这些描述,不够高级美观」。浮层说明区从"单行居中灰字 +
     * 手写十行 —— 清单"换成"两行式状态块 + 后端下发的对照表"。八条新规则全是这一处的两块，
     * 输入行 / 命中摘要 / 内容区上限 / 页脚四档字面值一条没动（由 launcherApp.test.tsx 的几何守卫钉着）。 */
    { match: '.search-lead', why: '空态与锁库共用的两行式状态块容器：上下留白、与语法表同一条左沿，取代 .search-empty 的单行居中版式。' },
    { match: '.search-lead-title', why: '状态块第一行（该做什么 / 现在是什么状态）：--t-text 14px 600，比原来整句 13.5px 弱化字多出一档层级。' },
    { match: '.search-lead-sub', why: '状态块第二行（一句限定）：--t-text-body 12.5px。不用 --t-text-muted 是因为那一档对 .search-modal 的面在三套主题里只有 1.84~2.25（PROTOTYPE_EXEMPT 记着），页脚图例担得起，要人读的句子担不起。' },
    { match: '.search-help', why: '后端 syntax_help() 下发的对照表：两列基线网格，左列 max-content 让字段名的冒号对齐。' },
    { match: '.search-help-group', why: '组名一行横跨两列（grid-column 1/-1），所以三组共用同一套列宽。' },
    { match: '.search-help-pattern', why: '可照抄的写法列：--font-mono 12px + --t-text，不换行。' },
    { match: '.search-help-desc', why: '说明列：--t-text-muted 12px，min-width:0 保证长句在网格里能换行而不是撑破右列。' },
    { match: '.search-help-note', why: '读不到设置时那一句人话的落位；原来的"后端未就绪或未返回 syntax 字段"是实现口径，不上界面。' },
    /* AG 轮（2026-10-20）：交付方真机照片点名"搜索后的结果选中的样式布局等存在问题,包括系统名称显示,
     * 和一些提示,都不够高级…看起来太乱"。根因是 .launcher-row 的 `1fr auto` 两列里，右列塞着一句
     * max-content 实测 507px 的长提示（行内可用只有 558px），把左列挤到只剩 43px——系统名称直接
     * 看不见，提示本身也冲出本体右沿。下面这批新规则就是"整行单列三档 + 操作条只在选中行"这一版画法。 */
    { match: '.launcher-row-title', why: '名称那一行：徽标跟在名称后面，整行 min-width:0 让名称自己截断而不是被邻列挤掉。' },
    { match: '.launcher-row-name', why: '名称本体（600 字重 + 省略号截断），取代原先挂在元素上的 truncate/font-medium 工具类。' },
    { match: '.launcher-row-meta', why: '元信息那一行（别名 · 用户名 · 地址）：独立成行所以拿得到整幅宽度；配色走 --t-text-body，理由同 .search-lead-sub。' },
    { match: '.launcher-row-actions', why: '操作条：提示句在左、按钮组在右，允许换行；只在选中的那一行渲染。' },
    { match: '.launcher-row-hint', why: '提示句那一档（12px，跟随行内文字色）；不再重列五个动作名，只报"当前 Enter 执行哪一枚 + 共几项"。' },
    { match: '.launcher-row-chips', why: '按钮组靠右排、可换行，margin-left:auto 让它始终贴到行尾。' },
    { match: '.launcher-chip', why: '操作按钮：描边与字色跟着 currentColor 走（color-mix 42%），四套主题里永远与所在行文字同色系，不再为某一版底色另写一套反相。' },
    { match: ".launcher-chip[aria-pressed='true']", why: 'Enter 要执行的那一枚是整条链路上唯一用实心主色的地方，与 .chip-toggle[aria-selected] / 页码条当前页同一条"实心主色 + 反相字"口径。' },
    { match: '.launcher-row-hint kbd', why: '行内两枚键名芯片：全局 kbd 是"画在浅面上"的那套（浅底 + 下沿粗边 + 投影），落在染色面上会多出一块不相关的白，换成与 .launcher-chip 同一条 currentColor 描边。' },
    { match: '.launcher-row[aria-selected=\'true\']:hover', why: 'AG 二批（2026-10-20）：选中档换成"圆角 + 主色染色面 + 主色描边"之后，划过选中行要在染色面上再加一档深度；实心主色那一版没有这一档。' },
    { match: '.launcher-note', why: '回执与报错共用的整幅说明带（底色=行悬停那一档）；只给几何与底色，颜色留给调用处的工具类，避免层序压掉 text-danger/text-warning。' },
    { match: '.launcher-reply', why: '回执那一档的字色（--t-text-body），与 .launcher-note 分开是因为底色要能被颜色类覆盖。' },
    /* BF 轮（2026-10-23）：自定义主题（粘贴设计令牌新增一档）+ 界面外观页重排。
     * 这十五条全是那一屏自己的东西：主题卡、卡内小样、已有列表行、校验错误带、粘贴框。
     * 一条色面值都不写——小样靠把 data-theme 挂在它自己身上来吃那一套的令牌，
     * 所以"预览"与"实装"之间没有第二份真相（详见 global.css 里「界面外观页」那段）。 */
    { match: '.theme-card', why: '主题卡外壳：面 + 描边 + 圆角 + 小投影，全部取当前主题的令牌。' },
    { match: '.theme-card:hover', why: '划过只把描边提到 strong 一档，不换底色——换底会和选中档的染色面打架。' },
    { match: '.theme-card.is-active', why: '选中档：主色描边 + 主色 14% 染色面，与浮层结果行选中档（AG 二批）同一条口径，不为某一版底色另写反相。' },
    { match: '.theme-face', why: '卡内小样的底板。它自己带 data-theme，于是这一小块吃的是"被预览那一套"的令牌，而不是当前主题的。' },
    { match: '.theme-face--wide', why: '卡片里的小样比列表行里的高一档（要看得出层次），只差高度。' },
    { match: '.theme-face-bar', why: '小样顶部那条"顶栏"，用 surface-elevated——四套里它都和底板分得开。' },
    { match: '.theme-face-line', why: '小样里的"一行正文"：文字色 32% 的透明档，不引入新令牌。' },
    { match: '.theme-face-line--short', why: '第二行短一档，让小样读起来像内容而不是一条色带。' },
    { match: '.theme-face-cta', why: '小样右下角那枚"实心主色按钮"，与全站唯一用实心主色的地方同一条语言。' },
    { match: '.theme-row', why: '已有自定义主题那一行的行壳（色块 + 名字 + 两颗动作）。' },
    { match: '.theme-row.is-active', why: '正在使用的那一行只把描边提到主色，不铺底色——底色的重量留给卡片本身。' },
    { match: '.theme-face--chip', why: '小样的芯片档（38×24，不抢行宽）：用在「当前主题」那枚指标与已有列表每一行。不写这一档的话小样按 width:100% 铺满，会把旁边的名字挤成省略号。' },
    { match: '.theme-errors', why: '令牌校验结果的滚动带：危险色描边 + 沉底面，逐行报行号与原因（这一处是报错语境，危险色合规）。' },
    { match: '.theme-errors li', why: '一条错误一行：行号与原因并排，min-width:0 让长句能换行不撑破右沿。' },
    { match: '.theme-tokens', why: '粘贴框：等宽、可纵向拉伸、字号比正文小一档（一屏要看得下十几行令牌）。' },
    { match: '.launcher-conditions', why: '多条件回显那一行：只给内缩与小字，不铺底色带——它是实时说明，不是会消失的结果。' },
    /* AL 二批（2026-10-20）：交付方点名「所有表单类输入框和选择框等等要求使用登录页面那样的下面只有一条
     * 横线以及横线的动画效果」，另先报了一条「所有输入框选中居然有 2 个边框线」。下面这十条就是那一档
     * 从 `.auth-panel` 提到基础层的落点。成对的另一半在 removed（认证页那七条里的重复部分整块撤）与
     * modified（`.field`、`.auth-panel .field`、`.auth-panel .field > label`、`.auth-panel .input`）。
     * 判据与逐套对比度见 stacking/underlineFields 两份守卫与交付文档 §1-AL 二批。 */
    { match: '.field:focus-within > label', why: '聚焦时标签从 muted 抬到正文色：这是从认证页搬过来的那一份，摘掉焦点环之后它是焦点可见性的两半之一。' },
    { match: '.field-line::after', why: '走满动画的载体（静置 width:0，颜色 --scene-focus）。原先挂在 `.auth-panel .field::after`，现在全站字段共用一条，且落点是控件那一行而不是整块字段底部。' },
    { match: '.field-line:focus-within::after', why: '聚焦把那条线从左走到 100%——交付方点名的"横线的动画效果"。' },
    { match: ".field[data-invalid='true'] .field-line", why: '报错时底线转 danger。CSS 够不着父元素，本仓库也不引 :has()（同 .input-icon 那条口径），所以由 FieldFrame 写 data-invalid。' },
    { match: ".field[data-invalid='true'] .field-line::after", why: '同上：走满的那条线在报错态也转 danger，不然报错只剩文字、字段本身看不出来。' },
    { match: ".field[data-readonly='true'] .field-line::after", why: '只读行的线不跟着聚焦亮。原先这一格由 `.input-underline` 那枚修饰符表达（个人信息页昵称的只读态），撤框之后它没有框可撤了，改由外壳属性承担。' },
    { match: ".field[data-readonly='true'] .input", why: '只读态光标保持 default——原先由 `.input-underline` 给的那一条，随那枚修饰符一起搬过来。' },
    { match: '.field .input, .field .select', why: '字段里的控件撤框：border 归 0、沉底面与内阴影一并撤、左内边距归 0 让文字与标签左沿对齐。`.field` 之外的行内选择框（.select-auto 那两枚）不受这条影响，仍是方框。' },
    { match: '.field .input:focus, .field .select:focus', why: '聚焦不再画内描边。特异度 (0,3,0) 压得住基础那条 `.input:focus`，不靠源码顺序碰运气。' },
    { match: '.field :is(.input, .select):focus-visible', why: '摘掉文件开头那条通用 2px 焦点环——它与下划线叠成两圈，就是交付方照片里那"两条边框线"的第二条。按钮类（显示/隐藏、铅笔、CTA）不在此列，它们没有下划线可依赖。' },
    /* 账号中心补删除入口（删除系统 / 删除账号）：只加一条悬停态，把既有的圆钮/行内图标钮切到危险色。
     * 静置的几何、描边、底色全部沿用 .filter-btn / .action-icon-btn，不产生布局变化。 */
    { match: '.filter-btn.is-danger:hover:not(:disabled)', why: '右栏「删除当前系统」的悬停态：沿用既有 38px 圆钮的几何，只在悬停时把描边/字色切到 --t-danger、底纹取同一枚色 10% 淡染。' },
    { match: '.action-icon-btn.is-danger:hover:not(:disabled)', why: '账号行内「删除」的悬停态：沿用既有 28px 图标钮的几何，只在悬停时切危险色。表里静置时不出现第二套红图标。' },
    /* 交付方 2026-10-21：「操作列新增复制密码/复制用户名，账号列改为双击复制用户名（不再拉抽屉）」。
     * 名称格从按钮换成一段文字，双击的动作不该顺手选中文字——只加一条 user-select，几何不动。 */
    { match: '.cell-title-text', why: '账号名称本体（原来是 .cell-title-btn 按钮里的文字）：只加 user-select:none，让双击复制时文字不闪出选中高亮；字号/字重/颜色仍由 .table-cell.title 给。' },
    /* 2026-10-21：七颗行内钮在窄窗放不下，<=1024px 这一档把 28px 收成 24px、间距 8→4。
     * 只在窄窗生效；默认 1280px 窗口一条都不触发。 */
    { match: '@media (max-width: 1024px) › .table-actions', why: '窄窗操作列不足 244px：行内钮间距从 8px 收到 4px，7×28+6×4=220px，配合下面两条的 24px 钮降到 192px。' },
    { match: '@media (max-width: 1024px) › .action-icon-btn', why: '同上：28px 钮在窄窗收成 24px（WCAG 2.2 的最小目标尺寸），高宽同比。' },
    { match: '@media (max-width: 1024px) › .action-icon-btn svg', why: '同上：图标随钮从 16px 收到 14px，保持图标与钮的留白比例。' },
    /* 2026-10-21：交付方点名「右下角的消息弹窗,内容布局都割裂了不够高级」。根因是 sonner 的
     * `<li>` 里 DOM 顺序为「关闭 → 图标 → 文案」，而 .toast 上有 space-between——三块被摊到三个角上
     * （照片里 × 在左、✓ 在中、文案贴右）。下面七条只做「槽位归位 + 语气只落在图标上」：
     * 宽度 320px、圆角、边框、阴影一条没动。 */
    { match: '.toast [data-icon]', why: '图标槽位归到最左（order:0）、禁止被挤压，并撑到一条行高（20px）里居中——多行文案时对齐第一行；颜色由下面四条语气规则给。' },
    { match: '.toast-tone-info [data-icon]', why: '信息档的图标取 --t-text-muted；不再复用 .badge-muted——徽标那套是"文字自己染色"，套到提示条上会把整句染灰。' },
    { match: '.toast-tone-success [data-icon]', why: '成功档图标取 --t-success。语气从"整句绿字"收到图标上：一句 13px 全绿读起来像状态徽标，不像回执。' },
    { match: '.toast-tone-warning [data-icon]', why: '警告档图标取 --t-warning，同上。' },
    { match: '.toast-tone-danger [data-icon]', why: '危险档图标取 --t-danger，同上。' },
    { match: '.toast [data-content]', why: '文案槽位归到中间并吃掉剩余宽度（flex:1 + min-width:0）；overflow-wrap 是给导出路径那类无空格长串的，避免撑破 320px。' },
    { match: '.toast [data-title]', why: '文案字重 500：13px 正文在玻璃面上偏轻，提示条又是短句，加半档即可，不改字号与行高。' },
    /* 2026-10-21：顶部新增「系统管理」一级菜单，其二级导航改为应用左侧竖排图标栏（用户点名"类似一级菜单
     * 等布局,只不够放到应用左侧竖起来的"）。下面六条只给这条新的导航容器与按钮，不碰任何既有页面；
     * 胶囊本身的几何与配色仍由 .nav-item 那一套原样承担。 */
    { match: '.admin-shell', why: '系统管理五页的两栏外壳：左栏导航 + 右栏内容，间距沿用全站的 --content-gap；原来是 SystemPage 单列，新增这一层只为摆下竖向导航。' },
    { match: '.admin-sidebar', why: '左侧竖排图标栏本体：96px 胶囊（圆角/描边/沉底/内阴影取既有令牌），贴顶不拉伸，内容再长也不把栏撑高。' },
    { match: '.admin-nav-item', why: '二级导航按钮：图标在上、文字在下，12px 字重 500；几何与过渡节奏跟 .nav-item 同一档，只是方向转成竖排。' },
    { match: '.admin-nav-item:hover', why: '悬停态沿用 .nav-item:hover 的同一枚行高亮底与正文色，不另造颜色。' },
    { match: ".admin-nav-item[aria-current='page']", why: '当前页与一级胶囊的选中态同口径：抬升底 + 正文色 + 700 字重 + 小阴影，让"现在在哪一页"在两种形态里读起来是同一种信号。' },
    { match: '.admin-nav-item svg', why: '图标 20×20、描边 1.8，与 .icon-btn svg 同一档视觉重量。' },
    { match: '.icon-btn.is-active', why: '齿轮所在的设置/工具页被打开时给触发钮一枚激活态（抬升底 + 正文色 + 小阴影）；不打开时外观与其余图标钮完全一致，未新增任何常驻视觉元素。' },
    /* 2026-10-21：交付方要求用户管理、角色管理两张表与账号中心同一口径——列居中。只给这两张表
     * 挂 .table-center 修饰符，审核日志/菜单矩阵等其余 .table 的排版一条不动。 */
    { match: '.table.table-center th, .table.table-center td', why: '用户管理、角色管理两张台账的表头与单元格居中；只作用于显式挂 .table-center 的表，不影响其它 .table。' },
    /* AT 轮（2026-10-21）：交付方点名「调整角色」弹窗「太丑了,布局不合理,是不是卡片更好点」。
     * 版式、字号、间距与目标条走 UsersSection 的工具类；global.css 只新增下面五条需要主题令牌
     * 与交互态的规则：头像底、角色卡的描边/沉底面、悬停、选中、选中悬停。 */
    { match: '.role-picker-avatar', why: '目标条里的头像只改底色：几何与字重沿用顶栏 .user-avatar，但那一枚是沉底，落在同样沉底的目标条上会看不见，这里换成 --t-surface-elevated。' },
    { match: '.role-option', why: '角色卡本体：1px 边框 + 16px 圆角 + 沉底面，cursor 让整行读得出可点。选中态由 React 写 data-selected（本仓库不引 :has()，口径同 .field 那条）。' },
    { match: '.role-option:hover', why: '未选中卡的悬停：边框抬到 --t-border-strong、底换成行悬停色；选中档的规则特异度相同且写在后面，不会被这一条压回去。' },
    { match: ".role-option[data-selected='true']", why: '选中：主色边框 + 8% 主色淡染 + 1px inset 主色环，叠成 2px 选中边而不改盒子尺寸；勾选框同时给出非颜色的状态，选中不靠颜色单独表达。' },
    { match: ".role-option[data-selected='true']:hover", why: '选中且悬停：淡染从 8% 提到 12%，边框保持主色，避免悬停把选中态压回去。' },
    /* AU 轮（2026-10-21）：交付方要求审计日志「下面的表格使用分页表格,固定表头,当前的显示条数改为分页下能力」。
     * 页面结构（自滚卡片 + 固定页脚）走下面四条；「每页条数」那枚 Select 收窄成与 .page-btn 同高的两条在后。 */
    { match: '.audit-section', why: '审计分区撑满二级页剩余高度（flex:1 + min-height:0），表格卡片才能把页脚钉在视口底部；原来是内容自然高度，页脚会随行数掉到屏幕外。' },
    { match: '.audit-table', why: '卡片本身变成纵向 flex 容器并撑满剩余高度；min-height:240px 是窗口很矮时的下限，低于它由外层 .system-page-body 去滚，而不是把表格压成一条缝。' },
    { match: '.audit-table-scroll', why: '卡片内自己的滚动区（flex:1 + overflow:auto + overscroll-behavior:contain）。表头吸顶必须有这层——页面级滚动时 <th> 会先滚走。' },
    { match: '.table-sticky-head', why: '只给挂了这一档的表把 border-collapse 换成 separate + 0 间距：collapse 下 WebKit 的吸顶单元格会丢边框（Safari 已知行为）。行与行只画一条底线，换完之后不会叠成双线。' },
    { match: '.table-sticky-head thead th', why: '表头 <th> 吸顶（position:sticky + top:0）。吸顶层必须不透光：--t-surface-sunken 在玻璃/曜石/赛博三套只有 .15/.02/.05 的透明层，行从底下滚过时字会叠在表头上（Chrome 实测第一次就是这样），所以用不透明的 --t-bg 打底、把卡片面与 sunken 两层按图片叠上去，合成结果与卡片上的表头一致。AV 轮把限定加上 `thead`：菜单树的行名是 `<th scope="row">`（表格树要标出行头），不限定就会让整列行名也 sticky 到顶部、滚起来叠在表头上面。审计那张表只有 thead 里有 th，所以这层限定对它逐字等价。' },
    { match: '.page-controls .page-size-select', why: '页脚里的「每页条数」：原先是页顶带标签的字段，现在缩进分页条。几何跟 .page-btn 对齐（4px 内边距 + 12.5px 字 + 同款圆角），透明底与 .page-btn 一致，因为页脚本身就是沉底面。特异度 (0,2,0) 压得住 .select 的 width:100%/padding，不靠源码顺序碰运气。' },
    { match: '.page-controls .page-size-select:hover:not([data-disabled])', why: '同上：悬停态沿用 .page-btn 的 --row-hover + 正文色，展开前的触发钮与旁边的页码钮读起来是同一组控件。' },
    /* AX 轮（2026-10-22）：权限清单改成滚动面板里的卡片，未选灰面 / 选中主色染面。
     * 两条面都由 --t-text-muted / --t-primary 派生，四套主题只换令牌、不换选择器。 */
    { match: '.perm-card', why: '权限卡片未选中的中性灰面。用 --t-text-muted 的 7% 而不是 --t-surface-sunken：后者在玻璃主题是 15% 白、压在卡片上几乎看不出灰面，分不出"未选"；正文令牌四套主题都是各自背景上的中灰，派生出的面才一直可见。二批（仪表盘版式）把过渡也收进这条，让选中细轨与面色一起补间。' },
    { match: ".perm-card:hover:not([data-selected='true']):not([data-disabled='true'])", why: '未选卡片悬停再深一档（7% → 12%）；选中与禁用两种状态不参与，避免悬停把"已选"的主色面盖成灰面。' },
    { match: ".perm-card[data-selected='true']", why: '选中面：主色 11% 淡染 + 45% 主色描边 + 左侧 2px 主色细轨。二批把面积从整行收成面板里的一格后，同样一档染色不再糊成一片；细轨给"已选"一个不依赖大色块的形状信号。' },
    /* AX 二批（2026-10-22）：权限页改成仪表盘版式——顶部角色卡 + 三枚统计卡 + 两块权限面板。
     * 下面十二条只新增这一屏的容器与统计条，主题色仍全部由 --t-primary / --t-text-muted 派生。 */
    { match: '.perm-kpi', why: '统计卡外壳：--t-surface 面 + 细边 + 内高光，几何与 .panel 同一档；只比面板矮一档（8/12 内边距），让四枚卡在 640 高窗口里不抢滚动区的空间。' },
    { match: '.perm-kpi--role', why: '角色卡：主色 6% 与 surface 混底、120° 主色淡染、22% 主色描边——整条仪表盘里唯一带主色氛围的一块，用来把"当前在改哪个角色"从三枚纯数字卡里区分出来。' },
    { match: '.perm-kpi-icon', why: '角色卡右上的盾形图标落点：绝对定位、主色 32% 透明度、不吃鼠标事件；纯装饰，标题与角色名已经说明了它是什么。' },
    { match: '.perm-kpi-label', why: '统计卡标签（菜单入口 / 操作权限 / 授权覆盖率）：10px 600 + 0.06em 字距，比正文低一档，让 19px 的数字先被读到。' },
    { match: '.perm-kpi-value', why: '统计数值：19px/700 + 等宽数字。数值随勾选实时变化，等宽保证 1→11→19 变化时整行数字不左右跳。' },
    { match: '.perm-kpi-total', why: '分母（/ 14）与百分号：10.5px muted，与数值同基线；分母不跟随 19px 字号，避免"已选几个"被总数抢走。' },
    { match: '.perm-kpi-role-name', why: '角色名：14.5px/700，单行省略；tab 与统计卡同时出现角色名，这一处承担"当前角色"的身份行。' },
    { match: '.perm-kpi-role-meta', why: '角色代码 + 描述那一行：10.5px muted、flex + min-width:0，描述过长时由子元素截断而不是把角色卡撑破。' },
    { match: '.perm-meter', why: '统计条轨道：3px 全圆角、muted 16% 底；只做比例的视觉补充，数值本身仍是文本，读屏不依赖它。' },
    { match: '.perm-meter > span', why: '统计条填充：主色 55% → 实心主色渐变，宽度由 React 按真实比例写内联；暗色主题里这枚渐变自带一点辉光，亮色主题里只是更实的一段。' },
    { match: '.perm-root', why: '一级菜单的分组壳：只给 border-subtle 细边与 16px 圆角，不铺底——里面每张卡自己的灰面/主色面才是状态信号，壳只负责把"这一组二级属于谁"框出来。' },
    { match: '.perm-roots', why: '一级菜单分组的瀑布容器：四组的二级数量是 0/5/4/2，按网格行对齐会在短组下面留出整块空白。两栏多列按内容高度配平，1280 宽下每组仍有约 500px、960 宽下约 360px。' },
    { match: '.perm-roots > *', why: '同上：单个一级分组不许跨栏断开，块间 10px 间距由 margin 承担（多列布局没有 row-gap）。' },
    { match: '.perm-root-kids', why: '一级下的二级卡片网格：固定两列 + 6px 间距 + 一条 divider 顶线。960 窗口下根组占满面板（每格约 330px），1280 窗口下根组两列（每格约 230px），两档都放得下二级的权限键。' },
    /* BC 轮（2026-10-22）：交付方点名快速启动器设置页「页面太丑了,重新布局」。三条只给顶部概览条的
     * 外壳与两档字，值本身（kbd / Badge / 数字）用既有元素与工具类；两张卡与三行设置行整段复用
     * 安全策略页的 .surface + 工具类版式，所以本轮 global.css 只多这三条。 */
    { match: '.launcher-kpi', why: '概览条一格的外壳：--t-surface 面 + 细边 + 内高光，与 .perm-kpi 同一档材质。没有借用 .perm-kpi 那三枚：那组名字属于权限页仪表盘，跨页借名会让"改权限卡顺手改坏启动器页"。' },
    { match: '.launcher-kpi-label', why: '格子的标签行（当前全局快捷键 / 默认快捷键 / 全局唤起 / 结果条数上限）：10.5px 600 + 0.04em 字距。颜色取 --t-text-body 而不是 --t-text-muted：Chrome 实测这枚标签压在概览卡面上，muted 档四套主题是 4.48 / 2.56 / 2.74 / 1.84，后三套连 12px 正文的 4.5 门槛都不到；换成 body 档是 7.01 / 7.73 / 5.17 / 5.45。层级仍靠字号差（10.5 对 15）与数值那一档更重的字色拉开。' },
    { match: '.launcher-kpi-value', why: '值那一行：15px/600 的 flex 容器，用来让 kbd 芯片、徽标与"20 条"这类"值 + 单位"混排时同基线；键名芯片自身仍由全局 kbd 规则画，这里不覆盖它。' },
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
    {
      match: '.search-empty',
      why: 'AF 轮（2026-10-20）：交付方点名优化浮层说明文案与观感，原型那枚单行居中灰字空态由 .search-lead 两行式状态块顶掉（同时给锁库态复用）。这是主动的版式变更，不是布局漂移；全仓库已无 .search-empty 引用。',
    },
    {
      match: '.launcher-row[aria-selected=\'true\'] .text-ink-muted',
      why: 'AG 轮（2026-10-20）：与新增那条 .launcher-row-meta 成对——同一个意思换了挂载对象（行内不再有 .text-ink-muted 这枚工具类），不是把反相删掉。',
    },
    {
      match: '.launcher-row[aria-selected=\'true\'] .badge',
      why: 'AG 二批（2026-10-20）：徽标反相随"实心主色选中行"一起下线——选中档改成染色面之后，徽标本来就画在浅面上，不需要再翻一次。',
    },
    {
      match: '.launcher-row:last-child',
      why: 'AG 二批（2026-10-20）：行与行之间的分隔线撤掉，换成每行自己的圆角 + 内缩留白；`border-bottom` 与圆角同时存在会在两个下转角处露出断口。',
    },
    /* AL 二批（2026-10-20）：下划线一档提到基础层之后，下面这八条都失去了挂载对象——
     * 前三条是那枚 `.input-underline` 修饰符（全仓库已无引用，组件测试里也没有），
     * 后五条是认证页那七条里与基础层重复的部分，同一件事只留一份定义。 */
    { match: '.input.input-underline', why: '字段现在整块就是一条底线，"把框收成下划线"这件事没有对象了。只读态那两格（线不跟着亮、光标 default）改由 `.field[data-readonly]` 那两条接手。' },
    { match: '.input.input-underline:hover:not(:disabled)', why: '同上：控件已无边框，hover 改 border-color 不再有任何可见效果。' },
    { match: '.input.input-underline:focus', why: '同上：聚焦态由 `.field :is(.input,.select):focus-visible` 那一条统一摘环，这一档不再有存在意义。' },
    { match: '.auth-panel .field:focus-within > label', why: '与新增的 `.field:focus-within > label` 成对：同一条搬去基础层，不是把标签抬色删掉。' },
    { match: '.auth-panel .field::after', why: '与新增的 `.field::after` 成对，逐条声明原样搬过去（width/height/left/bottom/background/transition 一条没改）。' },
    { match: '.cell-title-btn', why: '2026-10-21 账号名称不再点开抽屉、改为双击复制用户名，那枚"看起来像文字"的按钮整个换成 .cell-title-text 的普通文字；全仓库已无 .cell-title-btn 引用。' },
    { match: '.cell-title-btn:hover', why: '同上：按钮没了，悬停变色也没有挂载对象。' },
    { match: '.auth-panel .field:focus-within::after', why: '与新增的 `.field:focus-within::after` 成对。' },
    { match: '.auth-panel .input:focus-visible', why: '与新增的 `.field :is(.input,.select):focus-visible` 成对。这两份在轮次之间已经漂过一次：认证页摘了环、业务页没摘，于是同一枚输入框在两个地方长得不一样。' },
    { match: '.auth-panel .input:focus', why: '与新增的 `.field .input:focus, .field .select:focus` 成对。' },
  ],
  modified: [
    {
      match: '.surface, .surface-elevated',
      why: '审查 F35：这条与后面那条 `.surface-elevated` 同名重叠，它写的 box-shadow(--shadow-sm) 永远被后写的 --shadow-dropdown 覆盖，属于死声明。删掉的那条不改变任何计算值，留着的 border/radius 与第二条的 background/box-shadow 原样保留。',
    },
    {
      match: '.popover-panel',
      why: '删掉 `position:absolute` 与 `top:calc(100%+12px)` 两条：Radix 的 Content 由 Popper 写内联坐标，这两条会被覆盖成死声明；那 12px 间距改由 sideOffset 给。flex/gap/max-width 三条原样保留。AK 二批（2026-10-20）又动了 `z-index`：基线那档 30 在「菜单永远开在没有遮罩的页面上」这个前提下成立，Radix 之后弹窗里也有下拉（编辑凭据、新建系统两处 SelectField），而菜单 Content 与遮罩、面板同为 body 下的兄弟，30 会被自家遮罩(50)与面板(50)双双压住——抬到 60，两层模态之上、sonner 提示条（999999999）之下。判据与逐点命中实测见 stacking.test.ts 与交付文档 §1-AK 二批。',
    },
    {
      match: '.launcher-row[aria-selected=\'true\']',
      why: 'AG 二批（2026-10-20）：实心主色 + 反相字 换成 主色 14% 染色面 + 主色描边，文字与徽标一律交还给主题自己的颜色。四套主题逐套截图核过（obsidian/cyber 的主色本身是浅色/霓虹色，实心铺满时整行糊成一片是这一版被点名的直接原因）。',
    },
    {
      match: '.export-panel',
      why: '同上，删掉 `top:calc(100%+8px)` 那一条（改由 sideOffset={8}），`width:120px` 原样保留。',
    },
    {
      match: '.launcher-row',
      why: 'AG 轮（2026-10-20）：`display:grid; grid-template-columns:1fr auto; gap:8px` 换成 `flex-direction:column; gap:2px`。交付方真机照片上系统名称被挤成一两个字、那句长提示冲出本体右沿——根因就是那个 auto 列按 max-content（实测 507px 的提示句，行内可用只有 558px）取宽。padding 与字面数值没改，改的是列模型。AG 二批又把它换成 `border:1px solid transparent` + `border-radius:var(--radius-sm)`（原来那条 `border-bottom` 分隔线随之删），因为直角实心带贴在 16px 圆角的玻璃卡里不是这套主题的东西。',
    },
    {
      match: '.overlay-panel',
      why: 'AM 轮（2026-10-20）：交付方截图点名"所有弹窗的下面 2 个角不是圆角"。补一条 `overflow:hidden`，让面板的 --radius-outer 裁住子面——.modal-foot 的 --t-surface-sunken 底色是直角矩形，会盖掉下面两个转角。位置与 border-radius 同条规则（圆角与裁剪必须同处，否则换个挂载点就漏）。抽屉那一档（.overlay-panel--drawer）基线本来就自带 overflow:hidden，所以只有弹窗露馅；这一条对它是同值重复，不是行为改变。几何、边框、阴影四条一字未动。',
    },
    {
      match: '.field-line',
      why: 'AL 二批（2026-10-20）：加两条（底线 `border-bottom: 1px solid var(--scene-line)` 与它的 `border-color` 过渡）。这一行本来就是控件的容器（position:relative + flex），现在兼任那条静置底线的落点。为什么不是整块 `.field`：字段下面还挂着 hint 与报错两行小字，线画在整块底部会被它们顶开，离输入的内容太远（交付方原话"距离有点大了,看的有些割裂"）。position/display/align-items 三条原样。',
    },
    {
      match: '.auth-panel .field',
      why: 'AL 二批（2026-10-20）：只剩认证页真正特有的两档（行距与 28px 段距）。position/border-bottom/transition 三条搬去基础层（不是把线删了——见 `.field-line` 那条 modified）；padding-bottom:10px 一并撤，它是给"线画在整块底部"留的呼吸位，线挪到控件那一行之后只剩线以下的空档。',
    },
    {
      match: '.auth-panel .field > label',
      why: '同上：font-size 与 color 两条与基础层 `.field > label` 完全重复，只剩认证页特有的 letter-spacing 一条。',
    },
    {
      match: '.auth-panel .input',
      why: '同上：border/border-radius/background/box-shadow 四条与基础层 `.field .input, .field .select` 重复，只剩认证页特有的 min-height、padding:0、16px 字号与两处文字色。',
    },
    {
      match: '.table-header',
      why: '交付方 2026-10-21 点名"表头居中"：补一条 `text-align:center`。四个列名落在各自列宽的中线上；表体在同一轮里跟着居中（见下两条），不是只把表头挪歪。',
    },
    {
      match: '.table-cell',
      why: '同一次点名"表格中的列也需要居中"：补一条 `justify-content:center`。四栏的数据都落在表头那条中线上（预览页逐栏量过，四个中点的偏差都是 0px）；display/align-items/字号/颜色原样。',
    },
    {
      match: '.table-actions',
      why: '同上：`justify-content:flex-end` 改为 `center`。操作列的表头已居中，七颗钮若仍贴右就和列名分属两条中线；gap 与 width:100% 未动。',
    },
    {
      match: '.table-header, .table-row',
      why: '2026-10-21 操作列补了复制用户名/密码两颗钮，满编七颗要 244px；最小窗口 960px 下旧份数只剩约 159px。四栏份数从 2/1.1/1.6/2 调成 1.6/0.8/1.65/2.75（总份数 6.7→6.8），只改列宽分配，行高、内边距、分隔线一条未动。实测默认 1280px 窗口操作列 345px、更新时间一行；窄窗另由 @media 1024px 那三条收钮兜住。',
    },
    {
      match: '.toast',
      why: '2026-10-21：交付方截图点名"右下角消息弹窗内容布局割裂"。撤掉 `justify-content: space-between`（它把 sonner 的"关闭→图标→文案"三个 DOM 孩子摊到三个角上，槽位归位交给新增的 order 三条），padding 8/12 改 10（三行等距），gap 走同一条 10px 字面值，另加 `color: var(--t-text)` 与 line-height:20px——正文字号 13px 不变。宽度 320、圆角、边框、阴影四条一字未动。',
    },
    {
      match: '.toast-dismiss',
      why: '同上：补 order:2 把它排到最右；margin 从 -2 改成 -1，是因为文案行高已钉成 20px、关闭钮 22px，-1 之后三者的视觉中线才落在同一条（10+16/2+2 = 10+22/2-1 = 20）。22px 点击区、悬停、按压五条原样。',
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

  it('基线文件与它登记的 sha256 对得上（主门禁不许被静默换掉）', () => {
    // 基线目录是仓库里的一份固定副本，不参与日常构建产物；它一旦漂到"改动之后的那一份"，
    // 下面那几条对账会立刻变成新 vs 新，全绿但不再比任何东西。
    const recorded = recordedHashes();
    expect(recorded.size, `${BASELINE_SNAPSHOT}/BASELINE.css.sha256 缺失或格式不对，无法校验基线完整性`).toBeGreaterThan(0);
    for (const [rel, hex] of recorded) {
      const abs = join(BASELINE_DIR, rel);
      if (!existsSync(abs)) continue; // 那份登记里也可能有本轮之后才存在的文件，跳过而不是造假
      expect(sha256(abs), `基线 ${BASELINE_SNAPSHOT}/${rel} 被改过：内容与登记的 sha256 不一致`).toBe(hex);
    }
  });

  it('基线不是当前工作树自己（防"新 vs 新"的空转）', () => {
    expect(sha256(findBaseline()), '基线与 src/styles/global.css 内容相同 → 对账已失效，请把 BASELINE_SNAPSHOT 指回改动前那一份')
      .not.toBe(sha256(NEW_PATH));
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

/** 递归收 src 下所有 ts/tsx：新那条守卫要用"源码里真的用了哪些令牌类"来推导检查清单。
 *  与 @source 的扫描范围保持一致：@source 也吃 .ts/.tsx，测试文件里的类同样会进产物。 */
const sourceFiles: string[] = (() => {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else if (/\.(ts|tsx)$/.test(e.name)) out.push(abs);
    }
  };
  walk(join(ROOT, 'src'));
  return out;
})();

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
    const WATCH = ['.border-primary', '.text-ink-muted', '.text-ink', '.border-line', '.rounded-sm', '.bg-sunken', '.text-danger'];
    distRoot?.walkRules((r: Rule) => {
      const s = r.selector.trim();
      if (!WATCH.includes(s) || generated[s]) return;
      const d = r.nodes?.find((n: { type: string }) => n.type === 'decl');
      if (d && d.type === 'decl') generated[s] = `${d.prop}:${d.value}`;
    });
    const missing = WATCH.filter((w) => !generated[w]);
    expect(missing, `这些工具类没进产物 —— @source 路径八成又指空了：${missing.join('、')}`).toEqual([]);
    expect(generated['.border-primary']).toBe('border-color:var(--t-primary)');
    expect(generated['.text-ink-muted']).toBe('color:var(--t-text-muted)');
    expect(generated['.border-line']).toBe('border-color:var(--t-border)');
    // 展开成 var(--t-*) 而不是编译期固化的实色，才意味着 [data-theme] 仍是唯一真源。
    // rounded-sm 走的是 --radius-*（与主题无关的尺度层），所以不混进这条。
    for (const [sel, decl] of Object.entries(generated)) {
      if (sel === '.rounded-sm') continue;
      expect(decl, `${sel} 被固化成了实色，换皮不会再影响它`).toMatch(/var\(--t-/);
    }
  });

  it('源码里用到的每一枚令牌工具类，都必须真的出现在产物里（防 @theme 块被静默截断）', () => {
    /**
     * 这条是被本轮自己踩到的坑逼出来的：我在 `@theme inline` 块里写的一段注释，
     * 正文中出现了"星号紧跟斜杠"那两个字符，CSS 注释因此提前闭合，
     * 排在那之后的 `--color-input` 等键被当成块外垃圾丢掉 —— `border-input` 从产物里消失了，
     * 而源码侧那组逐声明对账完全看不出来（它比的是 global.css 自己的规则，不含生成的工具类），
     * 上面那条 WATCH 抽查也没点到这一枚。所以这里改成**从源码用量推导**要验哪些类。
     */
    const css = readFileSync(NEW_PATH, 'utf8');
    const themeBlock = css.slice(css.indexOf('@theme inline'), css.indexOf('\n}', css.indexOf('@theme inline')));
    const colorKeys = [...themeBlock.matchAll(/--color-([a-z0-9-]+)\s*:/g)].map((m) => m[1]);
    expect(colorKeys.length, '@theme inline 里一个颜色键都没有，桥接层被写坏了').toBeGreaterThan(0);

    const PREFIXES = ['bg', 'text', 'border', 'ring', 'fill', 'stroke', 'outline', 'from', 'to', 'caret', 'accent', 'decoration', 'shadow'];
    const used = new Set<string>();
    for (const f of sourceFiles) {
      const src = readFileSync(f, 'utf8');
      for (const key of colorKeys) {
        const rx = new RegExp(`(?<![:\\w-])(?:${PREFIXES.join('|')})-${key}(?![\\w-])`, 'g');
        for (const m of src.matchAll(rx)) {
          // 带变体前缀的（hover:、data-[state=...]：那些）选择器形态不同，这里只钉裸类
          const before = src.slice(Math.max(0, (m.index ?? 0) - 1), m.index);
          if (before !== ':' && before !== '-') used.add(key);
        }
      }
    }
    const distText = distCssPath ? readFileSync(distCssPath, 'utf8') : '';
    const missing = [...used].filter((k) => !PREFIXES.some((p) => distText.includes(`.${p}-${k}{`) || distText.includes(`.${p}-${k},`)));
    expect(
      missing,
      `这些令牌类在源码里被用了，却没进产物（@theme 块被截断／键被写坏的典型症状）：${missing.join('、')}`,
    ).toEqual([]);
    expect(used.size, '一枚令牌类都没从源码里扫到，说明这条守卫自己失效了').toBeGreaterThan(0);
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
