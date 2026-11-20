import { vi } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { invalidateTargetLists, queryKeys } from './queryClient';
import { QueryClient } from '@tanstack/react-query';

/**
 * 桌面端的三条**静态契约**。它们不参与渲染，所以走不了组件测试那条路，
 * 但它们要挡的是"类型检查与组件测试都全绿、真机上却是坏的"那三类事故
 * （代码质量审查 2026-10-19 的 F29 / F32 / F33 / F5）。
 */

const ROOT = resolve(process.cwd());
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

describe('IPC 契约：前端包装的命令必须都注册过（F29）', () => {
  const api = read('src/lib/api.ts');
  const lib = read('src-tauri/src/lib.rs');
  const called = new Set([...api.matchAll(/call(?:Async)?<[^>]*>\(\s*'([a-z0-9_]+)'/g)].map((m) => m[1]));
  const registered = new Set([...lib.matchAll(/commands::[a-z_]+::([a-z0-9_]+)/g)].map((m) => m[1]));

  it('api.ts 里至少扫得到命令（扫不到就是 call 的写法变了，本条守卫要重写）', () => {
    expect(called.size).toBeGreaterThan(50);
  });

  it('每一个前端调用的命令名都在 generate_handler 注册表里', () => {
    const missing = [...called].filter((c) => !registered.has(c));
    expect(missing, `这些命令前端会调、后端没注册：${missing.join('、')}`).toEqual([]);
  });

  // 反方向（注册了但没有任何界面会调到）本轮手工核过一次：只剩回收站那一对
  // `list_deleted_items` / `restore_item`——api.ts 的包装在、面板也在，只是没有任何生产页面挂载
  // （审查 F8）。那一维要靠"谁 import 了哪个组件"的源扫描才量得准，与这里的 api↔registry
  // 契约不同轴，所以记在 docs/交付状态与验收.md §9，不写成今天会误报的断言。
});

describe('CSP 三处声明必须一致（F32）', () => {
  const conf = JSON.parse(read('src-tauri/tauri.conf.json')) as { app: { security: { csp?: string } } };
  const confCsp = conf.app.security.csp ?? '';
  const HTML_ENTRIES = ['index.html', 'launcher.html', 'quiztip.html'];
  const metas = HTML_ENTRIES
    .map((f) => /Content-Security-Policy" content="([^"]+)"/.exec(read(f))?.[1])
    .filter((x): x is string => Boolean(x));

  it('各窗口的 HTML meta 与 tauri.conf 的 csp 都在，且逐项对齐（frame-ancestors 只能待在 conf 里）', () => {
    expect(metas).toHaveLength(HTML_ENTRIES.length);
    const strip = (s: string) =>
      s
        .split(';')
        .map((x) => x.trim())
        .filter((x) => x && !x.startsWith('frame-ancestors'))
        .join('; ');
    for (const m of metas) {
      expect(strip(m), 'meta 与 conf 的策略漂移了：改一处不会带着另一处改').toBe(strip(confCsp));
    }
    // frame-ancestors 在 meta 里按规范无效，只该出现在 conf
    expect(confCsp).toContain("frame-ancestors 'none'");
    for (const m of metas) expect(m).not.toContain('frame-ancestors');
  });
});

describe('Sidecar 与打包声明（F33）', () => {
  const conf = JSON.parse(read('src-tauri/tauri.conf.json')) as { bundle: { externalBin?: string[] } };
  const list = conf.bundle.externalBin ?? [];

  it('externalBin 指向的宿主在当前构建目标上要存在，否则 tauri build 会硬失败', () => {
    expect(list.length).toBeGreaterThan(0);
    const dir = join(ROOT, 'src-tauri/binaries');
    const files = existsSync(dir) ? readdirSync(dir) : [];
    // 只做"有至少一枚带后缀的宿主"这一条可移植的断言：具体 triple 由构建环境决定，
    // 缺对应平台的宿主属于打包链事实，本机不能替 Windows/Linux 断言。
    expect(files.some((f) => /^mda_fill_host-.+-.+-.+$/.test(f)), 'binaries/ 里没有任何带 target triple 的宿主').toBe(true);
    expect(list.every((b) => !b.includes('*')), `externalBin 不许用通配：${list.join('、')}`).toBe(true);
  });
});

describe('台账列表的作废必须覆盖两族取数键（F5）', () => {
  it('invalidateTargetLists 同时打 targets 与 targetsPaged 两个前缀', () => {
    const qc = new QueryClient();
    const seen: string[][] = [];
    const spy = vi.spyOn(qc, 'invalidateQueries');
    invalidateTargetLists(qc);
    for (const call of spy.mock.calls) {
      const key = (call[0] as { queryKey?: readonly unknown[] }).queryKey;
      if (key) seen.push(key.map(String));
    }
    expect(seen).toEqual(expect.arrayContaining([['targets'], ['targetsPaged']]));
    expect(queryKeys.targetsPagedAll[0]).toBe('targetsPaged');
    spy.mockRestore();
  });
});

/**
 * 浮层「查看详情」必须真的把主窗拉到前台并打开那一条（交付方 2026-10-20：
 * 「搜出的结果中查看详情没有调到应用」）。
 *
 * 根因不是权限、不是取数：`commands/launcher.rs` 的 ViewDetail 分支当年只是把 `target_detail()`
 * 调一遍、**把返回值丢掉**，再回一句"详情已加载"——界面当然什么都没有。这类"跨窗口的动作"
 * 最容易坏在两侧各写各的：Rust 发的事件名与前端听的名字差一个字符，命令全绿、点了没反应。
 * 所以这里比的是**两端的字面量是否同源**，而不是某一端"看起来有写"。
 */
describe('浮层 → 主窗的导航事件两侧同源', () => {
  const rust = read('src-tauri/src/commands/launcher.rs');
  const shell = read('src/components/AppShell.tsx');
  const nav = read('src/state/launcherNav.ts');
  const EVENT = 'launcher://open-detail';

  it('事件名这一枚字面量在 Rust 与主窗两侧都出现（差一个字符就是点了没反应）', () => {
    expect(rust, `Rust 侧没有发 ${EVENT}`).toContain(EVENT);
    expect(shell, `主窗侧没有听 ${EVENT}`).toContain(EVENT);
  });

  it('载荷键名两侧同一套 camelCase：落点名 + 各页自己的坐标', () => {
    for (const key of [
      'page',
      'targetId',
      'itemId',
      'keyword',
      'noteId',
      'pageId',
      'libraryId',
      'questionId',
      'seq',
      'taskKey',
      'env',
    ]) {
      expect(rust, `Rust 侧的载荷里没有 "${key}"`).toContain(`"${key}"`);
      expect(nav, `前端 LauncherNavPayload 里没有 ${key}`).toContain(key);
    }
  });

  /**
   * `page` 的五个取值是这次扩展最容易坏的一处：Rust 写 `"page": "tools"` 而前端认 `'html'`
   * 这种漂法，命令照样返回全绿、审计照样落一条，主窗只是把载荷咽下去不动——
   * 报出来长成"点了没反应"，跟权限、跟取数都没关系。
   * 所以这里把五个落点名逐个比两侧同源，而不是只比事件名。
   */
  it('page 的五个落点名两侧一一对应', () => {
    for (const p of ['accounts', 'notes', 'quiz', 'html', 'tasks']) {
      expect(rust, `Rust 侧没有发过 "page": "${p}"`).toContain(`"page": "${p}"`);
      expect(nav, `前端 LauncherNavPayload 里没有 page: '${p}'`).toContain(`'${p}'`);
    }
  });

  it('ViewDetail 分支必须做三件事：收起浮层、把主窗带到前台、发导航事件', () => {
    const branch = /QuickAction::ViewDetail => \{([\s\S]*?)\n        \}/.exec(rust);
    expect(branch, '找不到 ViewDetail 分支（写法变了就要重写这条正则）').not.toBeNull();
    // 三件事收在 reveal_in_main + focus_main 两枚 helper 里（分支只负责判权限 + 调它 + 回一句真话）。
    // focus_main 是 2026-11-20 抽出来的：动作收尾也要把主窗带上来，同一段代码不该写两遍。
    const helper = /fn reveal_in_main[\s\S]*?\n\}/.exec(rust);
    const focus = /fn focus_main[\s\S]*?\n\}/.exec(rust);
    expect(helper, '导航动作没有被收进一个可核对的地方（既不在分支里，也没有 reveal_in_main）').not.toBeNull();
    expect(focus, 'reveal_in_main 里的"把主窗带到前台"被内联回去了：收尾那条路径就再也复用它不了').not.toBeNull();
    const script = `${branch![1]}\n${helper![0]}\n${focus![0]}`;
    // 反向断言只看代码行：注释里可以引用那句被作废的话（本轮的注释就在解释它为什么被撤）。
    const code = branch![1]
      .split('\n')
      .filter((l) => !l.trim().startsWith('//'))
      .join('\n');
    expect(script, '浮层没收起来：详情开了它还压在桌面上').toMatch(/show_or_hide\([\s\S]{0,40}false\)/);
    expect(script, '主窗没被带到前台').toMatch(/\.show\(\)/);
    expect(script, '没有发出导航事件').toMatch(/emit\(/);
    expect(code, '还在回那句"详情已加载"——它承诺的比代码做到的多').not.toContain('详情已加载');
  });

  /**
   * 交付方 2026-11-20：「选中某条目、点了它的能力（打开浏览器、复制等）之后，自动关闭启动器页面」。
   * 判据收在 Rust 的 `follow_up` 一支纯函数里（三档取舍由 `commands/launcher.rs` 的 Rust 单测钉住），
   * 这里守的是**它真的被接在 quick_action 末尾**——纯函数测得再绿，没接上就等于没做。
   */
  it('quick_action 末尾必须按回执收尾：收浮层，必要时带主窗并把回执转呈', () => {
    const fn = /pub fn quick_action[\s\S]*?\n\}\n\n/.exec(rust);
    expect(fn, 'quick_action 的写法变了（结尾不再以空行分隔），本条守卫要重写').not.toBeNull();
    const body = fn![0];
    expect(body, '回执算出来了却没按它收尾：浮层仍会压在刚打开的应用上面').toMatch(/match follow_up\(&reply\)/);
    expect(body).toMatch(/FollowUp::Hide => \{\s*crate::launcher::show_or_hide\(&app, false\)\?;/);
    expect(body, '哪儿也没去的动作收了浮层却没把主窗带上来，提示会掉进虚空').toMatch(/focus_main\(&app\)\?;/);
    expect(body, '主窗带上来却没把那句回执转过去').toMatch(/emit_action_note\(&app, &reply\)/);
  });

  it('动作回执转呈事件两侧同源：Rust 发、主窗订阅（发了没人听等于提示丢进虚空）', () => {
    const shell = read('src/components/AppShell.tsx');
    expect(rust).toContain('pub const ACTION_NOTE_EVENT: &str = "launcher://action-note"');
    expect(shell, '主窗没订阅 launcher://action-note').toContain("'launcher://action-note'");
    expect(shell).toMatch(/useBackendEventPayload<[^>]*>\(\s*'launcher:\/\/action-note'/);
    expect(shell, '订阅了却没走 notify 通道：话收到了但没人呈现').toMatch(/notify\(/);
  });
});

/**
 * 窗口边框与拖拽区必须成对（交付方 2026-10-20「发现一个问题,桌面用户无法拖拽整个应用移动」）。
 *
 * AB 轮把主窗改成 `titleBarStyle: Overlay` 时，我在交付文档里写过一句"那条带子仍是原生
 * NSTitlebarContainerView：能拖、但不吃点击"——**那是假设，没验过**，今天被真机证伪。
 * 本地包里的判据（`node_modules/@tauri-apps/api/window.d.ts` 的 setTitleBarStyle 注释）说的是：
 * overlay 下"页面伸到标题栏底下、只剩红绿灯"，所以要**自己配一块可拖区**（startDragging / 拖拽区属性）。
 * 而 tauri 的 `src/window/scripts/drag.js` 是无条件注入的，它只认 `data-tauri-drag-region`：
 * 全站一处都没有 ⇒ 永远不会有 `plugin:window|start_dragging` 这一次调用 ⇒ 窗口拖不动。
 *
 * 这条守卫要挡的就是"配置动了一层、实现那一层没人跟"——所以它读的是 conf 与源文件的**配对**，
 * 而不是把拖拽区当一条审美要求写死。
 */
describe('Overlay 标题栏必须配一块拖拽区（AB 轮那句"能拖"是没验的假设）', () => {
  type Win = { label?: string; titleBarStyle?: string; decorations?: boolean };
  const conf = JSON.parse(read('src-tauri/tauri.conf.json')) as { app?: { windows?: Win[] } };
  const windows = conf.app?.windows ?? [];
  const overlay = windows.filter((w) => w.titleBarStyle === 'Overlay' || w.decorations === false);

  /** 拖拽区语义（drag.js 实测读出来的）：裸值/`true` 只有直接点中那个元素才拖，`deep` 才是整棵子树。 */
  const DRAG = /data-tauri-drag-region(?:=(?:"deep"|'deep'|null))?\b/;

  it('主窗确实是 Overlay / 无边框（若哪天改回原生标题栏，本条与下面两条要一起撤）', () => {
    expect(overlay.map((w) => w.label)).toContain('main');
  });

  it('顶栏与认证场景这两处都挂了拖拽区', () => {
    for (const f of ['src/components/TopBar.tsx', 'src/components/auth/AuthShell.tsx']) {
      expect(read(f), `${f} 没有 data-tauri-drag-region：${overlay.length} 扇无边框窗在这一屏拖不动`).toMatch(DRAG);
    }
  });

  it('全站至少有一枚拖拽区（枚数掉了说明被重构顺手删了）', () => {
    const hits = ['src/components/TopBar.tsx', 'src/components/auth/AuthShell.tsx'].filter((f) => DRAG.test(read(f)));
    expect(hits.length).toBeGreaterThanOrEqual(2);
  });
});


/**
 * 答题浮层的跨端契约（P6）。
 *
 * 悬停线程在 Rust 里算完命中，只发一条事件给浮层；两侧的字面量差一个字符，
 * 命令与线程全绿、鼠标停半天也不会出答案，而且日志里没有任何异常——只有真机才看得见。
 * 所以这里比的是两端**同一枚字面量**，不是"某一端看起来有写"。
 */
describe('答题浮层的事件名与窗口登记两侧同源', () => {
  const rustMod = read('src-tauri/src/quiz/mod.rs');
  const rustTip = read('src-tauri/src/quiz/tip.rs');
  const app = read('src/quiztip/QuizTipApp.tsx');
  const EVENT = 'quiz://tip';

  it('事件名在 Rust 侧发行处与浮层监听处都出现', () => {
    expect(rustMod, `Rust 侧没有定义 ${EVENT}`).toContain(EVENT);
    expect(app, `浮层没有监听 ${EVENT}`).toContain(EVENT);
  });

  it('浮层窗口在 capabilities 里登记过，否则 listen 这一步会被权限拒掉', () => {
    const caps = JSON.parse(read('src-tauri/capabilities/default.json')) as { windows: string[] };
    expect(caps.windows).toContain('quiztip');
    expect(rustTip, 'tip.rs 里的窗口 label 与 capabilities 对不上').toContain('pub const TIP_LABEL: &str = "quiztip"');
  });

  it('载荷字段两侧一一对应：Rust 用 snake_case，序列化成前端那套 camelCase', () => {
    // Rust 侧字段名是 snake_case，穿越 IPC 之后由 serde 转成 camelCase——两层都要对得上，
    // 少一条 rename 就会让前端拿到 `show_options` 而读不到 `showOptions`（答案里少一截选项）。
    expect(rustTip, 'tip.rs 的载荷没有 serde camelCase').toMatch(/#\[serde\(rename_all = "camelCase"\)\]/);
    for (const [rust, ts] of [
      ['visible', 'visible'],
      ['hit', 'hit'],
      ['show_options', 'showOptions'],
      ['at', 'at'],
    ]) {
      expect(rustTip, `Rust 侧载荷里没有 ${rust}`).toMatch(new RegExp(`pub ${rust}:`));
      expect(app, `浮层 TipPayload 里没有 ${ts}`).toContain(`${ts}:`);
    }
  });
});

/**
 * 页面预览独立窗口的全部安全性就靠这两条反向断言：
 * 窗口不在 capability 名单里 → 命令调用被 ACL 拒；不开 dangerousRemoteDomainIpcAccess
 * → 远程内容拿不到任何 IPC 通道。后来人"顺手"把 label 加进 windows 名单，
 * 或者为了调试打开那个开关，其他守卫一条都不会红，只有这里挡得住。
 */
describe('页面预览窗口拿不到 IPC（独立窗口能跑脚本的前提）', () => {
  const rustPreview = read('src-tauri/src/preview/mod.rs');
  const conf = read('src-tauri/tauri.conf.json');

  it('窗口 label 与 Rust 侧同源，但不在 capabilities 的 windows 名单里', () => {
    expect(rustPreview, 'preview/mod.rs 的窗口 label 变了，本条守卫要跟着改').toContain(
      'pub const WINDOW_LABEL: &str = "page-preview"',
    );
    const caps = JSON.parse(read('src-tauri/capabilities/default.json')) as { windows: string[] };
    expect(caps.windows).not.toContain('page-preview');
  });

  it('不开 dangerousRemoteDomainIpcAccess', () => {
    expect(conf).not.toContain('dangerousRemoteDomainIpcAccess');
  });
});

/**
 * 右栏嵌入块跑的是同一份用户 HTML。它的隔离依据不是窗口 label，而是**来源**：
 * 内容由 127.0.0.1 回环服务供出，对 Tauri 来说不是 local origin，所以
 * `Webview::on_message` 在没有显式 `remote` capability 时直接拒绝所有自定义命令。
 * 以下三条任何一条被改掉，页面内容就重新摸得到本应用命令：
 * 打开方式必须是 External（app 源会被当成 local）、capability 不许出现 remote 段、
 * label 也不许被顺手加进 windows 名单。
 */
describe('右栏嵌入块同样拿不到 IPC（右栏能直接操作的前提）', () => {
  const rustEmbed = read('src-tauri/src/preview/embed.rs');

  it('嵌入块是子 webview，只打开 External 地址（回环服务），绝不落到 app 源', () => {
    expect(rustEmbed, 'embed.rs 的 label 变了，本条守卫要跟着改').toContain(
      'pub const LABEL: &str = "page-pane"',
    );
    expect(rustEmbed).toContain('.add_child(');
    expect(rustEmbed).toContain('WebviewUrl::External(parsed)');
    expect(rustEmbed).not.toContain('WebviewUrl::App');
  });

  it('capability 里没有 remote 段，嵌入块的 label 也不在 windows 名单里', () => {
    const raw = read('src-tauri/capabilities/default.json');
    expect(raw, 'capability 一旦写 remote，回环页面就能拿到命令').not.toContain('"remote"');
    const caps = JSON.parse(raw) as { windows: string[]; remote?: unknown };
    expect(caps.remote).toBeUndefined();
    expect(caps.windows).not.toContain('page-pane');
  });
});

/**
 * 2026-11-20「修改目标系统整页空白」复盘立下的三条守卫。
 *
 * 那次事故的形状是：响应结构体 `TargetDetail` 带了 `rename_all = "camelCase"`，
 * 但它嵌套的 `meta` 用的是存储结构体 `TargetSecretPayload`（snake_case），而 **serde 的
 * rename_all 不传导到嵌套结构体**。前端 `types.ts` 把这些键声明成必填非可选 → 运行时
 * undefined → 渲染期 `.trim()` 抛错；又因为没有根级错误边界，整棵树被卸载成白屏。
 * 875 条前端测试全绿没拦住，因为组件测试的 mock 是照着 `types.ts` 那句**错误注释**写的。
 *
 * 所以这里的清单一律**由被检对象推导**（扫源码，不手写文件名），并配一枚探针证明扫得到。
 */
describe('响应序列化契约：嵌套结构体不许漏掉 camelCase', () => {
  interface RsStruct {
    file: string;
    name: string;
    serialize: boolean;
    camel: boolean;
    body: string;
    multiWordFields: string[];
  }

  /** 从一份 Rust 源码里扫出所有 pub struct 及其紧邻属性块。 */
  const scanStructs = (src: string, file: string): RsStruct[] => {
    const out: RsStruct[] = [];
    for (const m of src.matchAll(/pub struct ([A-Z][A-Za-z0-9_]*)\s*\{([\s\S]*?)\n\}/g)) {
      const attrs: string[] = [];
      const lines = src.slice(0, m.index).split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        const l = lines[i].trim();
        if (l === '' || l.startsWith('//') || l.startsWith('/*') || l.startsWith('*')) continue;
        if (l.startsWith('#[')) {
          attrs.unshift(l);
          continue;
        }
        break;
      }
      const attrText = attrs.join(' ');
      out.push({
        file,
        name: m[1],
        serialize: /derive\([^)]*\bSerialize\b/.test(attrText),
        camel: attrText.includes('rename_all = "camelCase"'),
        body: m[2],
        multiWordFields: [...m[2].matchAll(/^\s*pub ([a-z][a-z0-9_]*_[a-z0-9_]*)\s*:/gm)].map((x) => x[1]),
      });
    }
    return out;
  };

  const walk = (dir: string): string[] =>
    readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
    );
  const rustFiles = walk('src-tauri/src').filter((f) => f.endsWith('.rs'));
  const all = rustFiles.flatMap((f) => scanStructs(read(f), f));
  const serializable = all.filter((s) => s.serialize);

  /**
   * 存储侧结构体：JSON 键同时是**加密落库格式**（seal_json / open_json），
   * 改名会让已存库全部命中 `#[serde(default)]` 静默读空，所以它们必须保持 snake_case。
   * 正因为它们是例外，下面第二条要求它们**永远不许直接出现在任何响应结构体里**。
   */
  const STORAGE_ONLY = ['TargetSecretPayload', 'CredentialPayload'];

  const violations = serializable
    .filter((s) => s.multiWordFields.length > 0 && !s.camel)
    .filter((s) => !STORAGE_ONLY.includes(s.name))
    .map((s) => `${s.file} :: ${s.name}`);

  it('扫描本身有效：合成样本里的漏网结构必须被抓到（探针）', () => {
    const fixture = [
      '#[derive(Serialize)]',
      '#[serde(rename_all = "camelCase")]',
      'pub struct Outer {',
      '    pub id: String,',
      '    pub inner: Inner,',
      '}',
      '#[derive(Serialize)]',
      'pub struct Inner {',
      '    pub allowed_origin: String,',
      '}',
    ].join('\n');
    const found = scanStructs(fixture, 'fixture.rs');
    expect(found.map((s) => s.name)).toEqual(['Outer', 'Inner']);
    expect(found.find((s) => s.name === 'Inner')?.camel).toBe(false);
    expect(found.find((s) => s.name === 'Inner')?.multiWordFields).toEqual(['allowed_origin']);
    // 同样的判据用在样本上必须报出 Inner
    const bad = found.filter(
      (s) => s.serialize && s.multiWordFields.length > 0 && !s.camel && !STORAGE_ONLY.includes(s.name),
    );
    expect(bad.map((s) => s.name)).toEqual(['Inner']);
  });

  it('扫描面不为空：至少扫到 100 个可序列化结构体与 300 个多词字段（掉下来说明扫法变了）', () => {
    expect(serializable.length, `只扫到 ${serializable.length} 个 derive(Serialize) 结构体`).toBeGreaterThanOrEqual(100);
    const words = serializable.reduce((n, s) => n + s.multiWordFields.length, 0);
    expect(words, `只扫到 ${words} 个多词字段`).toBeGreaterThanOrEqual(300);
  });

  it('除存储侧两个结构体外，所有可序列化结构体的多词字段都必须走 camelCase', () => {
    expect(violations, '这些结构体有线上键名风险：' + violations.join('、')).toEqual([]);
  });

  it('存储侧结构体仍在（例外表不许过期），且不许出现在任何命令返回类型的可达集里', () => {
    for (const name of STORAGE_ONLY) {
      const s = all.find((x) => x.name === name);
      expect(s, `${name} 不在了：例外表要一起删，否则这条守卫会假绿`).toBeTruthy();
      expect(s!.camel, `${name} 被加了 rename_all：会改变加密落库的 JSON 键，旧库将静默读空`).toBe(false);
    }

    // 响应根 = 命令函数的返回类型名（Result<T> / Result<Vec<T>> / Result<Option<T>>）
    const cmdSrc = walk('src-tauri/src/commands')
      .filter((f) => f.endsWith('.rs'))
      .map(read)
      .join('\n');
    const roots = new Set<string>();
    for (const m of cmdSrc.matchAll(/->\s*Result<\s*(?:Vec<|Option<)?\s*([A-Z][A-Za-z0-9_]*)/g)) roots.add(m[1]);
    expect(roots.size, '一条命令返回类型都没扫到，本条守卫要重写').toBeGreaterThan(20);

    // 沿字段类型做可达闭包（含 repo:: 前缀与泛型实参）
    const byName = new Map<string, string>();
    for (const s of all) if (!byName.has(s.name)) byName.set(s.name, s.body);
    const seen = new Set<string>();
    const queue = [...roots];
    while (queue.length) {
      const n = queue.pop()!;
      if (seen.has(n)) continue;
      seen.add(n);
      const body = byName.get(n);
      if (!body) continue;
      for (const m of body.matchAll(/:\s*(?:(?:Vec|Option)<\s*)?(?:[a-z_]+::)*([A-Z][A-Za-z0-9_]*)/g)) {
        if (!seen.has(m[1])) queue.push(m[1]);
      }
    }
    const leaked = STORAGE_ONLY.filter((name) => seen.has(name));
    expect(
      leaked,
      '存储结构体直接进了响应可达集，需要一层 camelCase 视图（2026-11-20 白屏的成因）：' + leaked.join('、'),
    ).toEqual([]);
  });
});

describe('两条查询卫生：详情取单行、翻页有次级键', () => {
  const repo = read('src-tauri/src/db/repo.rs');

  it('get_target_row 不许走 list_targets（打开一条系统详情 = 全表扫 + 每行一个 COUNT）', () => {
    const body = repo.match(/pub fn get_target_row[\s\S]*?\n\}/)?.[0] ?? '';
    expect(body, 'get_target_row 没找到，本条守卫要重写').not.toBe('');
    expect(body, '取一条主体却把全表连同行数子查询都算了一遍').not.toMatch(/list_targets\s*\(/);
    expect(body).toMatch(/WHERE t\.id\s*=\s*\?1/);
  });

  it('分页排序必须有唯一次级键（updated_at 同秒并列会让翻页丢行或重行）', () => {
    const paged = repo.match(/ORDER BY t\.updated_at DESC[^"]*/)?.[0] ?? '';
    expect(paged, '分页那句 ORDER BY 找不到了，本条守卫要重写').not.toBe('');
    expect(paged, '只按 updated_at 排，同值并列时 OFFSET 翻页会漏行/重行').toMatch(/,\s*t\.id\s+DESC/);
  });
});

describe('三个窗口入口都必须套根级错误边界', () => {
  const ENTRIES = ['src/main.tsx', 'src/launcher.tsx', 'src/quiztip.tsx'];

  for (const entry of ENTRIES) {
    it(`${entry}：createRoot(...).render 的最外层是 ErrorBoundary`, () => {
      const src = read(entry);
      expect(src, `${entry} 没引 ErrorBoundary`).toContain("from './components/ui/ErrorBoundary'");
      // 边界必须在 createRoot 那一层之外：包在 App 里面就兜不住入口自身抛错。
      // 先摘掉注释行，否则"因为写了注释而判红"这种假阳性会把守卫磨成人人想删的东西。
      const after = src.match(/createRoot\(container\)\.render\(\s*([\s\S]{0,240})/)?.[1] ?? '';
      const root = after
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l !== '' && !l.startsWith('//'))
        .join('\n');
      expect(root, `${entry} 的 render 根节点不是 ErrorBoundary（拆掉它就回到整页空白那个形状）`).toMatch(
        /^<ErrorBoundary>/,
      );
    });
  }

  it('入口清单由"谁真的调了 createRoot"推导，新开一扇窗漏包会在这里红', () => {
    const entryFiles = readdirSync(join(ROOT, 'src'))
      .filter((f) => f.endsWith('.tsx'))
      .map((f) => `src/${f}`)
      .filter((p) => read(p).includes('createRoot('));
    expect(entryFiles.sort(), `扫到的入口是 ${entryFiles.join('、')}，与守卫里那张表不一致：要么漏包，要么该把新入口加进来`).toEqual(
      [...ENTRIES].sort(),
    );
  });
});

describe('导入改写元数据后，详情缓存要一起作废', () => {
  const sysio = read('src/components/accounts/SystemIODialog.tsx');

  it('importCommit 成功路径同时作废列表族与 targetDetail 族', () => {
    const ok = sysio.match(/onSuccess: \(res\) => \{[\s\S]*?\n    \}/)?.[0] ?? '';
    expect(ok, '找不到导入提交的成功分支，本条守卫要重写').not.toBe('');
    expect(ok).toContain('invalidateTargetLists(qc)');
    // 导入的 Origin 自愈会改写库里已有主体的 meta；详情缓存 staleTime 15s，
    // 不作废就会让"打开编辑 → 保存"把刚补好的值又写回旧值。
    expect(ok, '导入改了主体元数据却没作废详情缓存').toContain('invalidateTargetDetails(qc)');
  });

  it('作废函数确实打到 targetDetail 前缀，而不是只有名字像', () => {
    const qc = read('src/lib/queryClient.ts');
    const body = qc.match(/export function invalidateTargetDetails[\s\S]*?\n\}/)?.[0] ?? '';
    expect(body, 'invalidateTargetDetails 没找到，本条守卫要重写').not.toBe('');
    expect(body).toMatch(/queryKeys\.targetDetailAll|queryKeys\.targetDetail\b/);
    expect(qc).toMatch(/targetDetailAll: \['targetDetail'\]/);
  });
});

/**
 * Windows 运行时分发的口径必须三处同源（2026-11-20 交付方定的两件事：随包分发离线安装器、
 * 把 Chromium ≥ 111 写成装机条件）。
 *
 * 为什么要有这条：`tauri.conf.json` 里那两档 bootstrapper 模式，源码注释自己写着
 * `Requires an internet connection`——内网装机在安装阶段就失败，而这句话在配置、
 * 发布说明模板、界面提示三个地方各写一遍，改配置的人不会想起去改模板。
 * Release 正文由工作流的 heredoc 固定生成，所以它也必须被扫。
 */
describe('Windows WebView2 分发与装机下限三处同源', () => {
  const conf = JSON.parse(read('src-tauri/tauri.conf.json')) as {
    bundle: { windows?: { webviewInstallMode?: { type?: string } } };
  };
  const workflow = read('.github/workflows/release.yml');
  const probe = read('src/components/system/SecuritySection.tsx');

  it('安装模式必须是离线那一档，不许退回需要联网的两档', () => {
    const type = conf.bundle.windows?.webviewInstallMode?.type ?? '';
    expect(type).toBe('offlineInstaller');
    expect(['downloadBootstrapper', 'embedBootstrapper']).not.toContain(type);
  });

  it('发布说明模板里不许再出现"走 downloadBootstrapper"那类旧口径', () => {
    expect(workflow).not.toMatch(/`\\?downloadBootstrapper`?，内网/);
    expect(workflow, 'Release 正文没写清离线分发这一件事，装机的人会以为要联网').toContain('offlineInstaller');
  });

  it('Chromium 111 这个下限在模板与界面提示里都得在（只有一个数会漂）', () => {
    expect(workflow).toContain('Chromium 111');
    expect(probe).toContain('Chromium 111');
  });

  it('界面自检必须真的去读 color-mix（下限能不能满足，用它判，不读 UA 字符串里的号）', () => {
    // 实际写法是经一层 supports() 包装再调 CSS.supports（为了在非浏览器环境下不炸），
    // 所以两条都要在：既证它问的是引擎能力，也证问的确实是 color-mix
    expect(probe).toMatch(/CSS\.supports\s*\(/);
    expect(probe).toMatch(/supports\('color',\s*'color-mix\(/);
  });
});
