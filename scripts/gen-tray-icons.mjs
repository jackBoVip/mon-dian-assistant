// 生成系统托盘图标。本机没有 ImageMagick / PIL，仓库也不该为三张 2 KB 的位图引入依赖，
// 所以这里只做一件事：把 design/app-mark.svg 里那条闪电多边形按超采样填成 PNG。
//
//   node scripts/gen-tray-icons.mjs
//
// 产出（提交进仓库，三端构建机直接 include_bytes!）：
//   src-tauri/icons/tray/tray-template.png     22×22  纯黑 + alpha，macOS 模板图
//   src-tauri/icons/tray/tray-template@2x.png  44×44  同上，Retina 实际加载这张
//   src-tauri/icons/tray/tray.png              32×32  绿色实心闪电，Windows / Linux
//
// 底板的深色圆角方块绝不能进托盘：macOS 模板图只取 alpha，带底板会变成菜单栏一块实心方块。

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src-tauri', 'icons', 'tray');

// design/app-mark.svg 的闪电路径，逐字照抄。
const BOLT = [
  [560, 180],
  [340, 560],
  [490, 560],
  [400, 844],
  [700, 440],
  [540, 440],
];
// 以闪电包围盒中心居中，留约 8% 边距；比 app-mark 的 87% 再撑开一点，16px 下才认得出。
const CENTER = { x: 520, y: 512 };
const SIDE = 718;
const SUPERSAMPLE = 4;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * stride] = 0; // filter: none
    rgba.copy(raw, y * stride + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 每个像素的覆盖率 0..255（超采样后按面积平均）。 */
function boltCoverage(size) {
  const width = size * SUPERSAMPLE;
  const scale = (value, center) => ((value - (center - SIDE / 2)) / SIDE) * width;
  const points = BOLT.map(([x, y]) => [scale(x, CENTER.x), scale(y, CENTER.y)]);
  const hits = new Uint8Array(width * width);

  for (let y = 0; y < width; y += 1) {
    const scanY = y + 0.5;
    const crossings = [];
    for (let i = 0; i < points.length; i += 1) {
      const [x1, y1] = points[i];
      const [x2, y2] = points[(i + 1) % points.length];
      if ((y1 <= scanY && y2 > scanY) || (y2 <= scanY && y1 > scanY)) {
        crossings.push(x1 + ((scanY - y1) / (y2 - y1)) * (x2 - x1));
      }
    }
    crossings.sort((a, b) => a - b);
    for (let k = 0; k + 1 < crossings.length; k += 2) {
      const from = Math.max(0, Math.ceil(crossings[k] - 0.5));
      const to = Math.min(width - 1, Math.floor(crossings[k + 1] - 0.5));
      for (let x = from; x <= to; x += 1) hits[y * width + x] = 1;
    }
  }

  const coverage = new Uint8Array(size * size);
  const samples = SUPERSAMPLE * SUPERSAMPLE;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let count = 0;
      for (let dy = 0; dy < SUPERSAMPLE; dy += 1) {
        for (let dx = 0; dx < SUPERSAMPLE; dx += 1) {
          count += hits[(y * SUPERSAMPLE + dy) * width + (x * SUPERSAMPLE + dx)];
        }
      }
      coverage[y * size + x] = Math.round((count / samples) * 255);
    }
  }
  return coverage;
}

function render(size, [r, g, b]) {
  const coverage = boltCoverage(size);
  const rgba = Buffer.alloc(size * size * 4);
  for (let i = 0; i < coverage.length; i += 1) {
    rgba[i * 4] = r;
    rgba[i * 4 + 1] = g;
    rgba[i * 4 + 2] = b;
    rgba[i * 4 + 3] = coverage[i];
  }
  return encodePng(size, rgba);
}

const OUTPUTS = [
  ['tray-template.png', 22, [0, 0, 0]],
  ['tray-template@2x.png', 44, [0, 0, 0]],
  ['tray.png', 32, [0x10, 0xb9, 0x81]],
];

mkdirSync(OUT_DIR, { recursive: true });
for (const [name, size, color] of OUTPUTS) {
  const file = join(OUT_DIR, name);
  writeFileSync(file, render(size, color));
  console.log(`${name}  ${size}×${size}  ${file}`);
}
