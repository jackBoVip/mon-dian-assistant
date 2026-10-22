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
  const metas = ['index.html', 'launcher.html']
    .map((f) => /Content-Security-Policy" content="([^"]+)"/.exec(read(f))?.[1])
    .filter((x): x is string => Boolean(x));

  it('两份 HTML meta 与 tauri.conf 的 csp 都在，且逐项对齐（frame-ancestors 只能待在 conf 里）', () => {
    expect(metas).toHaveLength(2);
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

  it('载荷键名两侧同一套 camelCase：targetId / itemId / keyword', () => {
    for (const key of ['targetId', 'itemId', 'keyword']) {
      expect(rust, `Rust 侧的载荷里没有 ${key}`).toContain(key);
      expect(nav, `前端 LauncherNavPayload 里没有 ${key}`).toContain(key);
    }
  });

  it('ViewDetail 分支必须做三件事：收起浮层、把主窗带到前台、发导航事件', () => {
    const branch = /QuickAction::ViewDetail => \{([\s\S]*?)\n        \}/.exec(rust);
    expect(branch, '找不到 ViewDetail 分支（写法变了就要重写这条正则）').not.toBeNull();
    // 三件事收在 reveal_in_main 那一枚 helper 里（分支只负责判权限 + 调它 + 回一句真话）。
    const helper = /fn reveal_in_main[\s\S]*?\n\}/.exec(rust);
    expect(helper, '导航动作没有被收进一个可核对的地方（既不在分支里，也没有 reveal_in_main）').not.toBeNull();
    const script = `${branch![1]}\n${helper![0]}`;
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

