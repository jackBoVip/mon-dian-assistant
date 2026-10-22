import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * macOS 产物语言声明的契约守卫。
 *
 * 原生面板（打开/保存对话框的侧栏、New Folder / Cancel / Open、系统消息框按钮）由 macOS 绘制，
 * 用哪种语言取决于**产物 bundle 声明了哪些本地化**：bundler 生成的默认 `Info.plist` 把
 * `CFBundleDevelopmentRegion` 写死成 `English`，产物里又没有任何 `.lproj`，于是 CoreFoundation
 * 认为本应用只有 English 可用，中文系统上这些字符串照样是英文（本机实测：
 * `CFBundleCopyLocalizationsForURL` 对已装机的旧产物返回 `["English"]`，对带 `src-tauri/Info.plist`
 * 这两枚键的 bundle 返回 `["zh-Hans"]`）。
 *
 * 所以这枚 `Info.plist` 必须在、且必须声明 zh-Hans。它在 `tauri.conf.json` 的同目录，
 * bundler 会自动合并（`bundle.macOS.infoPlist` 的 schema 说明写明了这一点），不需要配置项。
 */

const ROOT = resolve(process.cwd());
const TAURI_DIR = join(ROOT, 'src-tauri');
const PLIST = join(TAURI_DIR, 'Info.plist');

/** 只取 `<plist>` 里的键值对，注释与 DTD 不参与判断。 */
function plistBody(): string {
  return readFileSync(PLIST, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
}

describe('macOS 产物的本地化声明', () => {
  it('Info.plist 与 tauri.conf.json 同目录（bundler 自动发现的前提）', () => {
    expect(existsSync(join(TAURI_DIR, 'tauri.conf.json'))).toBe(true);
    expect(existsSync(PLIST)).toBe(true);
  });

  it('开发区域声明为 zh-Hans，不再回落英文', () => {
    const body = plistBody();
    expect(body).toMatch(/<key>CFBundleDevelopmentRegion<\/key>\s*<string>zh-Hans<\/string>/);
    expect(body).not.toContain('<string>English</string>');
  });

  it('CFBundleLocalizations 只列 zh-Hans（界面只有中文一套，不对外承诺英文）', () => {
    const block = plistBody().match(/<key>CFBundleLocalizations<\/key>\s*<array>([\s\S]*?)<\/array>/);
    expect(block).not.toBeNull();
    const langs = [...block![1].matchAll(/<string>([^<]+)<\/string>/g)].map((m) => m[1]);
    expect(langs).toEqual(['zh-Hans']);
  });

  it('配置里若显式写了 infoPlist，必须指向这枚存在的文件', () => {
    const conf = JSON.parse(readFileSync(join(TAURI_DIR, 'tauri.conf.json'), 'utf8')) as {
      bundle?: { macOS?: { infoPlist?: string } };
    };
    const explicit = conf.bundle?.macOS?.infoPlist;
    if (explicit !== undefined) {
      expect(existsSync(join(TAURI_DIR, explicit))).toBe(true);
    }
  });
});
