#!/usr/bin/env node
/**
 * 下载并校验答题助手用的 OCR 模型（PP-OCRv5 mobile det/rec，Apache-2.0）。
 *
 * 为什么是 Node 而不是 shell：这个脚本要在 macOS / Windows / Linux 三条 CI 里跑，
 * `curl -o` 的引号、路径与 `sha256sum`/`shasum` 的名字在三端都不一致；Node 的
 * `https` + `crypto` 行为一致，失败时也只会以非 0 退出，不会"看起来成功"。
 *
 * 约定：
 *  - 仓库与 commit 都钉死，再从 Hugging Face 取 `inference.onnx` + `inference.yml`；
 *  - 每个文件都有一个写在这里的 SHA-256；对不上就删掉重下，再对不上直接失败；
 *  - `--check` 只做离线校验（CI 里不需要联网），缺文件或哈希不符返回非 0；
 *  - 幂等：哈希一致就跳过下载。
 *
 * 产物落地在 src-tauri/resources/ocr/ppocrv5/{det,rec}/，该目录在 .gitignore 里，
 * 随 `bundle.resources` 打进安装包。
 */
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import https from 'node:https';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT_DIR = join(ROOT, 'src-tauri', 'resources', 'ocr', 'ppocrv5');

const MODELS = [
  {
    kind: 'det',
    repo: 'PaddlePaddle/PP-OCRv5_mobile_det_onnx',
    revision: 'e6f4fa85f00e168c862bc462aebca69eef9b3d3d',
    files: {
      'inference.onnx': {
        sha256: 'a431985659dc921974177a95adcfbb90fd9e51989a5e04d70d0b75f597b6e61d',
        bytes: 4826518,
      },
      'inference.yml': {
        sha256: '98069072e1b6b37d727fd9d9f11725faa46d6ea0de012f2ed26caea011c37699',
        bytes: 903,
      },
    },
  },
  {
    kind: 'rec',
    repo: 'PaddlePaddle/PP-OCRv5_mobile_rec_onnx',
    revision: 'ed152b8b495f84de93cda5709d768548a9127622',
    files: {
      'inference.onnx': {
        sha256: 'da72dc72ca4dc220df0dfde68c1dedc31c58d3e76a25871122e5056227d50092',
        bytes: 16534782,
      },
      'inference.yml': {
        sha256: '5dfeb2777f6d0db8177d8128a8acfcf6e6276dc4ac73ea3bf0dc06d6a5e85d8e',
        bytes: 148345,
      },
    },
  },
];

const checkOnly = process.argv.includes('--check');

function targetPath(model, name) {
  return join(OUT_DIR, model.kind, name);
}

function urlFor(model, name) {
  return `https://huggingface.co/${model.repo}/resolve/${model.revision}/${name}`;
}

async function sha256Of(path) {
  const hash = createHash('sha256');
  hash.update(await readFile(path));
  return hash.digest('hex');
}

async function verify(path, expected) {
  try {
    const info = await stat(path);
    if (info.size !== expected.bytes) return false;
    return (await sha256Of(path)) === expected.sha256;
  } catch {
    return false;
  }
}

function download(url, dest, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      { headers: { 'user-agent': 'mon-dian-assistant-ocr-model-fetch' }, timeout: 120_000 },
      (response) => {
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400 && response.headers.location) {
          response.resume();
          if (redirectsLeft <= 0) {
            reject(new Error(`重定向次数过多：${url}`));
            return;
          }
          const next = new URL(response.headers.location, url).toString();
          download(next, dest, redirectsLeft - 1).then(resolve, reject);
          return;
        }
        if (status !== 200) {
          response.resume();
          reject(new Error(`下载失败 HTTP ${status}：${url}`));
          return;
        }
        const out = createWriteStream(dest);
        response.pipe(out);
        out.on('finish', () => out.close(() => resolve()));
        out.on('error', reject);
      },
    );
    request.on('timeout', () => request.destroy(new Error(`下载超时：${url}`)));
    request.on('error', reject);
  });
}

async function fetchVerified(model, name, expected) {
  const dest = targetPath(model, name);
  const tmp = `${dest}.part`;
  await mkdir(dirname(dest), { recursive: true });
  await rm(tmp, { force: true });
  await download(urlFor(model, name), tmp);
  const actual = await sha256Of(tmp);
  if (actual !== expected.sha256) {
    await rm(tmp, { force: true });
    throw new Error(
      `${model.repo}/${name} 的 SHA-256 不符：期望 ${expected.sha256}，实际 ${actual}` +
        `（仓库在钉死的 commit 上被改写过，先确认来源再更新脚本里的哈希）`,
    );
  }
  await rename(tmp, dest);
  console.log(`  ✓ ${model.kind}/${name}  ${(expected.bytes / 1024 / 1024).toFixed(2)} MiB`);
}

async function main() {
  if (checkOnly) {
    let missing = 0;
    for (const model of MODELS) {
      for (const [name, expected] of Object.entries(model.files)) {
        const ok = await verify(targetPath(model, name), expected);
        if (!ok) {
          missing += 1;
          console.error(`  ✗ ${model.kind}/${name} 缺失或哈希不符`);
        } else {
          console.log(`  ✓ ${model.kind}/${name}`);
        }
      }
    }
    if (missing > 0) {
      console.error(`\nOCR 模型未就绪（${missing} 个文件）。先运行：node scripts/prepare-ocr-models.mjs`);
      process.exit(1);
    }
    console.log('\nOCR 模型校验通过。');
    return;
  }

  console.log(`OCR 模型目录：${OUT_DIR}`);
  for (const model of MODELS) {
    for (const [name, expected] of Object.entries(model.files)) {
      if (await verify(targetPath(model, name), expected)) {
        console.log(`  - ${model.kind}/${name} 已就绪，跳过`);
        continue;
      }
      await fetchVerified(model, name, expected);
    }
  }
  console.log('\nOCR 模型就绪。');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
