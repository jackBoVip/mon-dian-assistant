import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * 应用标识素材守卫（2026-10-18 R 轮）。
 *
 * 这五条守的是"两版素材别再各改各的"、"尖上的白点别再回来"和"旧占位企业标不得复活"：
 * 界面用的无底板版与打包用的完整底板版是两份文件，闪电几何靠这两条断言钉在一起；
 * 运行时素材与 design/ 真源同理。至于 src-tauri/icons 那 17 个文件是否落后于
 * design/app-icon.svg，**vitest 里做不到像素级判据**（tauri icon 会把源图缩到 512 再落盘，sha 对不上，
 * 且比对解码像素要跑 AppKit），只能按 design/app-icon.svg 注释里那两条命令重跑，
 * 或用交付文档 §10 第 31 步第 5 项那段 Swift 四点采样做内容级复核 —— 这一条仍登记在未证面里。
 */

const root = process.cwd();
const read = (rel: string) => readFileSync(resolve(root, rel), 'utf8');
/** 只取 <svg> 元素本体：两份文件的头部注释措辞不同，比对几何而不是注释。 */
const svgElement = (text: string) => text.slice(text.indexOf('<svg '));
const pathData = (text: string) => [...text.matchAll(/\sd="([^"]+)"/g)].map((m) => m[1]);

describe('应用标识素材（R 轮）', () => {
  it('运行时素材 src/assets/brand/logo.svg 是 design/app-mark.svg 的逐字副本', () => {
    expect(svgElement(read('src/assets/brand/logo.svg'))).toBe(svgElement(read('design/app-mark.svg')));
  });

  it('无底板版与完整底板版的闪电几何逐字一致（只允许底板与裁切不同）', () => {
    const mark = pathData(svgElement(read('design/app-mark.svg')));
    const icon = pathData(svgElement(read('design/app-icon.svg')));
    // 闪电主体 + 内部走线，两版各两条；完整版的第三条 d 属于网格 pattern
    expect(mark).toHaveLength(2);
    expect(icon).toHaveLength(3);
    expect(icon.slice(1)).toEqual(mark);
    // 同一支渐变：boltGrad 的三个色标逐字相同，换色只能两处一起换
    const boltStops = (rel: string) =>
      [...svgElement(read(rel)).matchAll(/id="boltGrad"[\s\S]*?<\/linearGradient>/g)]
        .flatMap((m) => [...m[0].matchAll(/stop-color="([^"]+)"/g)].map((s) => s[1]));
    expect(boltStops('design/app-mark.svg')).toEqual(['#6ee7b7', '#10b981', '#047857']);
    expect(boltStops('design/app-icon.svg')).toEqual(boltStops('design/app-mark.svg'));
  });

  it('尖上的白色节点已从两版素材里撤干净，不得再出现（反向断言）', () => {
    const mark = svgElement(read('design/app-mark.svg'));
    const runtime = svgElement(read('src/assets/brand/logo.svg'));
    const icon = svgElement(read('design/app-icon.svg'));
    // 无底板版与运行时副本：一个 circle 都不该有
    expect(mark.includes('<circle')).toBe(false);
    expect(runtime.includes('<circle')).toBe(false);
    // 完整底板版只剩两圈背景辅助环，且没有任何白色实心点、nodeGlow 滤镜一并作废
    expect([...icon.matchAll(/<circle[^>]*>/g)]).toHaveLength(2);
    expect(icon.includes('fill="#fff"')).toBe(false);
    expect(icon.includes('nodeGlow')).toBe(false);
  });

  it('旧占位企业标已移出 src/，只留在 design/archive/（不进构建）', () => {
    expect(readdirSync(resolve(root, 'src/assets/brand')).filter((f) => f.includes('placeholder'))).toEqual([]);
    const archived = readdirSync(resolve(root, 'design/archive')).filter((f) => f.includes('placeholder'));
    expect(archived).toEqual(['logo-placeholder-旧企业标-20261018.svg']);
  });

  it('src/ 与 dist 入口里没有任何源文件再引用 logo-placeholder（反向断言）', () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name);
        if (entry.isDirectory()) walk(p);
        // 守卫自己的文件名与断言字符串都带这个词，扫自己只会自证
        else if (/\.(?:tsx?|css|html|svg)$/.test(entry.name) && !/\.(?:test|spec)\./.test(entry.name)) {
          if (readFileSync(p, 'utf8').includes('logo-placeholder')) hits.push(p);
        }
      }
    };
    walk(resolve(root, 'src'));
    for (const entry of ['index.html', 'launcher.html']) {
      if (read(resolve(root, entry)).includes('logo-placeholder')) hits.push(entry);
    }
    expect(hits).toEqual([]);
  });

  it('tauri.conf.json 声明的 6 枚打包图标都在，源图是 1024 方图且带 alpha 通道', () => {
    const cfg = JSON.parse(read('src-tauri/tauri.conf.json')) as { bundle: { icon: string[] } };
    expect(cfg.bundle.icon).toHaveLength(6);
    for (const rel of cfg.bundle.icon) {
      expect(existsSync(resolve(root, 'src-tauri', rel)), `缺打包图标 ${rel}`).toBe(true);
    }
    const png = readFileSync(resolve(root, 'design/app-icon-1024.png'));
    expect(png.subarray(1, 8).toString('ascii')).toBe('PNG\r\n\x1a\n');
    expect(png.readUInt32BE(16), '源图必须是 1024 宽').toBe(1024);
    expect(png.readUInt32BE(20), '源图必须是 1024 高').toBe(1024);
    expect(png[25], 'color type 必须是 6（RGBA，圆角外要透明）').toBe(6);
    // 归档不是空壳：旧图标全套仍在 design/archive/，随时可退回
    expect(statSync(resolve(root, 'design/archive/tauri-icons-20261014/icon.icns')).size).toBeGreaterThan(0);
  });
});
