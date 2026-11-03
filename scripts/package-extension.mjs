#!/usr/bin/env node
/**
 * 把 extension/ 打成浏览器扩展 zip，供 GitHub Release 分发。
 *
 * 为什么自己写 ZIP 而不调 `zip`：产物要在 macOS / Windows / Linux 三条线上出，
 * `zip` 在 Windows 上没有，而压缩条目里的时间戳与属性位会随平台变化 —— 同一份源码
 * 打两次对不上摘要，Release 的 SHA256SUMS 就成了假判据。这里钉死时间戳、按名排序、
 * 用 node:zlib 的 deflateRaw，字节可复现。
 *
 * 三件不显眼但会咬人的事：
 *  - zip 的根只放一枚 `mon-dian-assistant-extension/`。解压出来必须正好是一个文件夹，
 *    因为 Chrome/Edge 只接受"把文件夹拖进扩展页"或"加载已解压的扩展程序"，
 *    拖 .zip 会被拒。顶层多一层目录 = 用户拖进去报"清单文件缺失"。
 *  - 清单文件名必须纯 ASCII：GitHub 上传资源时会静默删掉非 ASCII 字符（v1.0.1 那轮
 *    中文名的 setup.exe 就是这么变成 `_0.1.0_x64-setup.exe` 而让 `sha256sum -c` 必失败的）。
 *  - manifest 的 `key` 是扩展私钥对应的 SPKI 公钥，扩展 ID 由它推导且**跨机器恒定**。
 *    桌面应用内置同一串 ID，用户不必再抄 32 位；所以打包前必须确认 key 在、
 *    且推导出的 ID 形状合法（详见 extensionIdFromKey）。
 *
 * 约定：
 *  - 版本号单一来源是 src-tauri/tauri.conf.json；仓库里的 extension/manifest.json
 *    若与之不一致，以 tauri.conf 为准盖进包内（并在 stderr 提示，别让两边各说各话）。
 *  - 参与打包的文件是白名单：extension/ 里出现名单外的东西直接失败。
 *    私钥、临时文件之类混进包里，比少打一个文件严重得多。
 *
 * 用法：
 *   node scripts/package-extension.mjs          # 产出 dist-extension/*.zip
 *   node scripts/package-extension.mjs --check  # 只校验（结构 + 可复现），不落产物
 */
import { createHash } from 'node:crypto';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const EXT_DIR = join(ROOT, 'extension');
const TAURI_CONF = join(ROOT, 'src-tauri', 'tauri.conf.json');
const OUT_DIR = join(ROOT, 'dist-extension');

/** zip 里唯一的顶层目录；解压后用户把这一枚拖进 chrome://extensions。 */
export const STAGE_DIR_NAME = 'mon-dian-assistant-extension';
/** 去掉 .zip 的资源名（ASCII，扩展名由 buildZipFileName 补）。 */
export const ASSET_STEM = 'mon-dian-assistant-browser-extension';

/** 缺了就无法加载或无法填充的文件；名单外的可选文件见 ALLOWED_OPTIONAL。 */
const REQUIRED_FILES = ['manifest.json', 'background.js', 'content.js', 'popup.html', 'popup.js'];
/** 随包发的说明，扩展运行时用不到。新增可选项要在这里登记。 */
const ALLOWED_OPTIONAL = ['README.md'];

// 时间戳钉死：ZIP 的 DOS 时间字段下限是 1980-01-01，取一个固定值让同输入同字节。
const FIXED_DOS = { time: 0, date: ((2026 - 1980) << 9) | (1 << 5) | 1 };

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * 由 manifest 的 `key`（base64 SPKI 公钥）推导 Chrome 扩展 ID：
 * SHA-256(公钥 DER) 的前 16 字节，每个半字节按 0→a … 15→p 映射成 32 个字母。
 * 与 src-tauri/src/fill_host.rs 的 BUILTIN_EXTENSION_ID 必须一致，
 * 由 src/lib/extensionPack.test.ts 逐条比对。
 */
export function extensionIdFromKey(keyBase64) {
  const der = Buffer.from(keyBase64, 'base64');
  if (der.length === 0 || Buffer.from(der).toString('base64') !== keyBase64.replace(/\s+/g, '')) {
    throw new Error(`manifest.key 不是合法的 base64（解码后再编码对不上原值）`);
  }
  const digest = createHash('sha256').update(der).digest();
  let id = '';
  for (const byte of digest.subarray(0, 16)) {
    for (const nibble of [byte >> 4, byte & 0x0f]) id += String.fromCharCode(97 + nibble);
  }
  return id;
}

/** 读扩展源目录 → 白名单校验 → 版本盖章；返回 [{ name, content }]（name 已带顶层目录前缀）。 */
async function collectEntries() {
  const listing = (await readdir(EXT_DIR, { withFileTypes: true }))
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .sort();
  const allowed = new Set([...REQUIRED_FILES, ...ALLOWED_OPTIONAL]);
  const unexpected = listing.filter((n) => !allowed.has(n));
  if (unexpected.length > 0) {
    throw new Error(
      `extension/ 里有白名单外的文件：${unexpected.join(', ')}\n` +
        `  确认它该随包分发后，把它加进 scripts/package-extension.mjs 的白名单。`,
    );
  }
  const missing = REQUIRED_FILES.filter((n) => !listing.includes(n));
  if (missing.length > 0) throw new Error(`extension/ 缺少必需文件：${missing.join(', ')}`);

  const version = JSON.parse(await readFile(TAURI_CONF, 'utf8')).version;
  if (typeof version !== 'string' || version.length === 0) {
    throw new Error('src-tauri/tauri.conf.json 里没有可用的 version');
  }

  const entries = [];
  for (const name of listing) {
    let content = await readFile(join(EXT_DIR, name));
    if (name === 'manifest.json') {
      const manifest = JSON.parse(content.toString('utf8'));
      if (manifest.version !== version) {
        console.error(
          `提示：extension/manifest.json 记的是 ${manifest.version}，按 tauri.conf.json 的 ${version} 打包（请把仓库那份同步成 ${version}）。`,
        );
      }
      if (typeof manifest.key !== 'string' || manifest.key.length === 0) {
        throw new Error(
          'extension/manifest.json 缺少 key：没有它，扩展 ID 每次加载都变，' +
            '用户必须手抄 32 位回桌面应用，"下载即用"不成立。',
        );
      }
      const id = extensionIdFromKey(manifest.key);
      if (!/^[a-p]{32}$/.test(id)) throw new Error(`由 manifest.key 推导的扩展 ID 非法：${id}`);
      content = Buffer.from(`${JSON.stringify({ ...manifest, version }, null, 2)}\n`, 'utf8');
    }
    entries.push({ name: `${STAGE_DIR_NAME}/${name}`, content });
  }
  return entries;
}

/** 确定性 ZIP：目录条目在前，文件条目按名排序，固定时间戳，deflateRaw。 */
function buildZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;

  const push = (bytes) => {
    chunks.push(bytes);
    offset += bytes.length;
  };

  const records = [{ name: `${STAGE_DIR_NAME}/`, content: null }, ...entries];
  for (const { name, content } of records) {
    const nameBuf = Buffer.from(name, 'utf8');
    // UTF-8 名称位（bit 11）：本包全 ASCII，置位只为防以后有人加中文名把解压端搞糊涂。
    const flags = 0x0800;
    const isDir = content === null;
    const raw = isDir ? Buffer.alloc(0) : content;
    const deflated = isDir ? null : deflateRawSync(raw, { level: 9 });
    const stored = isDir || deflated.length >= raw.length;
    const method = stored ? 0 : 8;
    const body = isDir ? Buffer.alloc(0) : stored ? raw : deflated;
    const crc = isDir ? 0 : crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(FIXED_DOS.time, 10);
    local.writeUInt16LE(FIXED_DOS.date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    const localHeaderOffset = offset;
    push(local);
    push(nameBuf);
    push(body);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(flags, 8);
    dir.writeUInt16LE(method, 10);
    dir.writeUInt16LE(FIXED_DOS.time, 12);
    dir.writeUInt16LE(FIXED_DOS.date, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(body.length, 20);
    dir.writeUInt32LE(raw.length, 24);
    dir.writeUInt16LE(nameBuf.length, 28);
    dir.writeUInt16LE(0, 30);
    dir.writeUInt16LE(0, 32);
    dir.writeUInt16LE(0, 34);
    dir.writeUInt16LE(0, 36);
    dir.writeUInt32LE(isDir ? 0x10 : 0, 38);
    dir.writeUInt32LE(localHeaderOffset, 42);
    central.push(dir, nameBuf);
  }

  const centralBuf = Buffer.concat(central);
  const centralOffset = offset;
  push(centralBuf);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(records.length, 8);
  eocd.writeUInt16LE(records.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  eocd.writeUInt16LE(0, 20);
  push(eocd);

  return Buffer.concat(chunks);
}

/** 只从中央目录读回条目名与大小；--check 用它自证结构，不依赖任何外部解压工具。 */
export function readZipEntries(zip) {
  const eocdAt = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocdAt < 0) throw new Error('不是合法的 zip：找不到中央目录结束记录');
  const count = zip.readUInt16LE(eocdAt + 10);
  const centralOffset = zip.readUInt32LE(eocdAt + 16);
  const out = [];
  let p = centralOffset;
  for (let i = 0; i < count; i += 1) {
    if (zip.readUInt32LE(p) !== 0x02014b50) throw new Error(`中央目录第 ${i} 条签名不对`);
    const method = zip.readUInt16LE(p + 10);
    const crc = zip.readUInt32LE(p + 16);
    const compSize = zip.readUInt32LE(p + 20);
    const uncompSize = zip.readUInt32LE(p + 24);
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const localOffset = zip.readUInt32LE(p + 42);
    const name = zip.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    out.push({ name, method, crc, compSize, uncompSize, localOffset, isDir: name.endsWith('/') });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** 读出一条目正文（本地头 + inflate），并校验 CRC；包内内容与源文件不符时会红。 */
export function readZipFile(zip, name) {
  const entry = readZipEntries(zip).find((e) => e.name === name);
  if (!entry) throw new Error(`包里没有 ${name}`);
  const local = entry.localOffset;
  if (zip.readUInt32LE(local) !== 0x04034b50) throw new Error(`${name} 的本地头签名不对`);
  const nameLen = zip.readUInt16LE(local + 26);
  const extraLen = zip.readUInt16LE(local + 28);
  const start = local + 30 + nameLen + extraLen;
  const body = zip.subarray(start, start + entry.compSize);
  const raw = entry.method === 8 ? inflateRawSync(body) : Buffer.from(body);
  if (crc32(raw) !== entry.crc) throw new Error(`${name} 的 CRC 校验失败`);
  return raw;
}

export function zipFileName(version) {
  return `${ASSET_STEM}-v${version}.zip`;
}

/** 打包一份，返回 { fileName, bytes, sha256, version, extensionId }。不落盘。 */
export async function packExtension() {
  const entries = await collectEntries();
  const bytes = buildZip(entries);
  const version = JSON.parse(await readFile(TAURI_CONF, 'utf8')).version;
  const manifest = JSON.parse(
    (entries.find((e) => e.name.endsWith('/manifest.json')).content).toString('utf8'),
  );
  return {
    fileName: zipFileName(version),
    bytes,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    version,
    extensionId: extensionIdFromKey(manifest.key),
  };
}

async function assertReproducible() {
  const first = await packExtension();
  const second = await packExtension();
  if (first.sha256 !== second.sha256) {
    throw new Error(`打包不可复现：${first.sha256} ≠ ${second.sha256}`);
  }
  if (!/^[\x20-\x7e]+$/.test(first.fileName)) {
    throw new Error(`资源名含非 ASCII 字符，GitHub 上传时会静默截掉：${first.fileName}`);
  }
  const names = readZipEntries(first.bytes).map((e) => e.name);
  if (!names.every((n) => /^[\x20-\x7e]+$/.test(n))) {
    throw new Error(`包内条目名含非 ASCII：${names.filter((n) => /[^\x20-\x7e]/.test(n)).join(', ')}`);
  }
  if (names[0] !== `${STAGE_DIR_NAME}/`) {
    throw new Error(`包根必须是唯一顶层目录 ${STAGE_DIR_NAME}/，实际第一条是 ${names[0]}`);
  }
  const roots = new Set(names.map((n) => n.split('/')[0]));
  if (roots.size !== 1) throw new Error(`包里有多个顶层条目：${[...roots].join(', ')}`);
  if (!names.includes(`${STAGE_DIR_NAME}/manifest.json`)) {
    throw new Error('manifest.json 不在顶层目录根部，拖进去会报"清单文件缺失"');
  }
  // 逐条读回正文：只有名字与长度对上还不够，deflate  round-trip 坏了要到解压端才露馅。
  for (const entry of readZipEntries(first.bytes).filter((e) => !e.isDir)) {
    const source = await readFile(join(EXT_DIR, entry.name.split('/').pop()));
    const packed = readZipFile(first.bytes, entry.name);
    if (entry.name.endsWith('/manifest.json')) {
      const a = JSON.parse(source.toString('utf8'));
      const b = JSON.parse(packed.toString('utf8'));
      if (b.version !== first.version || JSON.stringify({ ...b, version: a.version }) !== JSON.stringify(a)) {
        throw new Error('包内 manifest 与源文件的差异不止版本号');
      }
      continue;
    }
    if (!packed.equals(source)) throw new Error(`包内 ${entry.name} 与源文件字节不同`);
  }
  return first;
}

async function main() {
  const checkOnly = process.argv.slice(2).includes('--check');
  if (checkOnly) {
    const packed = await assertReproducible();
    console.log(
      `扩展包校验通过：${packed.fileName}（${packed.bytes.length} 字节，sha256 ${packed.sha256}），扩展 ID ${packed.extensionId}`,
    );
    return;
  }
  const packed = await assertReproducible();
  await rm(OUT_DIR, { recursive: true, force: true });
  await mkdir(OUT_DIR, { recursive: true });
  const target = join(OUT_DIR, packed.fileName);
  await writeFile(target, packed.bytes);
  console.log(`已产出 ${target}`);
  console.log(`  大小 ${packed.bytes.length} 字节 · 版本 ${packed.version} · sha256 ${packed.sha256}`);
  console.log(`  扩展 ID ${packed.extensionId}（由 manifest.key 推导，与桌面应用内置值一致）`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
