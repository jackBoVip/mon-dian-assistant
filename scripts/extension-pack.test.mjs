import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ASSET_STEM,
  STAGE_DIR_NAME,
  extensionIdFromKey,
  packExtension,
  readZipEntries,
  readZipFile,
  zipFileName,
} from './package-extension.mjs';

/**
 * 发布扩展包的守卫：三件事各自都可能在改动里悄悄坏掉，而且坏了只在真浏览器里才露馅。
 *
 * 1. **公钥 ↔ 内置 ID**：`extension/manifest.json` 的 `key` 决定扩展 ID，
 *    `src-tauri/src/fill_host.rs` 的 `BUILTIN_EXTENSION_ID` 决定宿主清单的 `allowed_origins`。
 *    两侧各改一半 = 清单放行了一个不存在的 ID，填充全坏且界面看不出来。
 *    这条比对把两侧钉在一起（Rust 侧不做 sha256，推导只在这里做一次）。
 * 2. **包的结构**：顶层必须只有一枚目录、`manifest.json` 要在它的根部 ——
 *    多套一层，用户拖进扩展页就是"清单文件缺失"。
 * 3. **可复现**：同输入两次打包字节相同，否则 Release 的 SHA256SUMS 会对不上。
 *
 * 期望条目从 `extension/` 的实测目录推导，不在此手写名单（名单会漏，少算也算绿）。
 */

const ROOT = resolve(process.cwd());
const manifest = JSON.parse(readFileSync(resolve(ROOT, 'extension/manifest.json'), 'utf8'));
const tauriVersion = JSON.parse(
  readFileSync(resolve(ROOT, 'src-tauri/tauri.conf.json'), 'utf8'),
).version;
const fillHostSrc = readFileSync(resolve(ROOT, 'src-tauri/src/fill_host.rs'), 'utf8');

const sourceFiles = readdirSync(resolve(ROOT, 'extension'), { withFileTypes: true })
  .filter((e) => e.isFile())
  .map((e) => e.name)
  .sort();

describe('发布扩展包', () => {
  it('manifest.key 推导出的 ID 与桌面应用内置的那串一致', () => {
    const m = /const BUILTIN_EXTENSION_ID: &str = "([^"]+)";/.exec(fillHostSrc);
    expect(m, 'src-tauri/src/fill_host.rs 里没找到 BUILTIN_EXTENSION_ID').not.toBeNull();
    expect(extensionIdFromKey(manifest.key), '公钥与内置 ID 脱钩：清单会放行错误的扩展').toBe(m[1]);
  });

  it('清单里的 key 是合法 base64 且推导出 32 位小写字母 ID', () => {
    const id = extensionIdFromKey(manifest.key);
    expect(id).toMatch(/^[a-p]{32}$/);
  });

  it('仓库内 manifest 版本与 tauri.conf.json 同步（从源码加载的人不该看到旧版本）', () => {
    expect(manifest.version, 'extension/manifest.json 的版本漂了').toBe(tauriVersion);
  });

  it('同一份源码两次打包字节一致，资源名纯 ASCII', async () => {
    const a = await packExtension();
    const b = await packExtension();
    expect(a.sha256).toBe(b.sha256);
    expect(Buffer.compare(a.bytes, b.bytes)).toBe(0);
    expect(a.fileName).toBe(zipFileName(tauriVersion));
    expect(a.fileName, 'GitHub 上传会静默删掉非 ASCII 字符').toMatch(/^[\x20-\x7e]+$/);
    expect(a.fileName).toBe(`${ASSET_STEM}-v${tauriVersion}.zip`);
  });

  it('包根只有一枚顶层目录，manifest.json 在其根部', async () => {
    const { bytes } = await packExtension();
    const entries = readZipEntries(bytes);
    const names = entries.map((e) => e.name);
    expect(new Set(names.map((n) => n.split('/')[0])), `顶层条目不唯一：${names.join(', ')}`).toEqual(
      new Set([STAGE_DIR_NAME]),
    );
    expect(names).toContain(`${STAGE_DIR_NAME}/`);
    expect(names).toContain(`${STAGE_DIR_NAME}/manifest.json`);
    expect(names.sort()).toEqual([`${STAGE_DIR_NAME}/`, ...sourceFiles.map((n) => `${STAGE_DIR_NAME}/${n}`)].sort());
  });

  it('包里没有私钥类文件，且每条正文长度与源文件一致', async () => {
    const { bytes } = await packExtension();
    const entries = readZipEntries(bytes).filter((e) => !e.isDir);
    expect(entries.filter((e) => /\.(pem|key|p12|mobileprovision)$/.test(e.name))).toEqual([]);
    for (const entry of entries.filter((e) => !e.name.endsWith('/manifest.json'))) {
      // manifest 唯一被改写（盖版本号），它的差异由下一条用例逐字比对。
      const onDisk = readFileSync(resolve(ROOT, 'extension', entry.name.split('/').pop()));
      expect(entry.uncompSize, `${entry.name} 的正文长度对不上`).toBe(onDisk.length);
    }
  });

  it('包内 manifest 的版本盖成 tauri.conf.json 的值，其余字段与源文件逐字一致', async () => {
    const { bytes, version } = await packExtension();
    const packed = JSON.parse(readZipFile(bytes, `${STAGE_DIR_NAME}/manifest.json`).toString('utf8'));
    expect(packed.version, '版本盖章没生效').toBe(version);
    expect({ ...packed, version: manifest.version }, '包内清单与源清单的差异不止版本号').toEqual(manifest);
  });
});
