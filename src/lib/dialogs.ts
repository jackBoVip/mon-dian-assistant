import { open, save } from '@tauri-apps/plugin-dialog';
import { ApiError, isTauri } from './api';

/**
 * 原生文件对话框薄封装（唯一入口，便于测试 mock）。
 * 约定：
 *  - 仅在 Tauri 桌面壳内可用；jsdom/浏览器预览下调用会抛 NOT_TAURI 的 ApiError，
 *    绝不伪造路径或静默成功；
 *  - 组件里一律经由本模块调用对话框，测试通过 vi.mock 替换。
 */

export interface DialogFilter {
  name: string;
  extensions: string[];
}

export interface FileDialogOptions {
  title?: string;
  defaultPath?: string;
  filters?: DialogFilter[];
}

function notTauriError(): ApiError {
  return new ApiError({
    code: 'NOT_TAURI',
    message: '文件对话框仅在 Tauri 桌面壳内可用，浏览器预览不会伪造任何路径。',
    detail: '请使用 npm run tauri:dev 启动桌面应用后重试。',
  });
}

/** 选择单个文件；用户取消返回 null。 */
export async function openFile(options: FileDialogOptions = {}): Promise<string | null> {
  if (!isTauri()) throw notTauriError();
  const picked = await open({ ...options, multiple: false, directory: false });
  return typeof picked === 'string' ? picked : null;
}

/** 选择单个目录；用户取消返回 null。只负责选路径，不读写任何文件。 */
export async function openDirectory(options: FileDialogOptions = {}): Promise<string | null> {
  if (!isTauri()) throw notTauriError();
  const picked = await open({ ...options, multiple: false, directory: true });
  return typeof picked === 'string' ? picked : null;
}

/** 选择保存路径；用户取消返回 null。只负责选路径，不写文件。 */
export async function saveFileDialog(options: FileDialogOptions = {}): Promise<string | null> {
  if (!isTauri()) throw notTauriError();
  const picked = await save(options);
  return typeof picked === 'string' ? picked : null;
}

export interface TextFileSaveResult {
  /** 用户在对话框选择的完整路径（用于展示与文件名提取） */
  path: string;
  fileName: string;
}

/**
 * 保存文本内容：先经原生保存对话框确定文件名，再交给 Webview 下载通道落盘。
 * 说明（诚实呈现，不假装写入了所选目录）：当前桌面壳的能力清单未开放「按任意路径写文件」
 * 的后端命令（Rust 侧没有注册 fs 插件/写文件命令），因此实际字节由系统下载通道落盘，
 * 文件名沿用所选路径的 basename。调用方必须把这一事实转述给用户。
 */
export async function saveTextFile(
  options: FileDialogOptions,
  contents: string,
): Promise<TextFileSaveResult | null> {
  const path = await saveFileDialog(options);
  if (!path) return null;
  const fileName = path.split(/[\\/]/).pop() || 'template.csv';
  if (typeof document === 'undefined') {
    throw new ApiError({ code: 'NOT_TAURI', message: '当前环境无法触发文件下载。' });
  }
  const blob = new Blob([contents], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 4000);
  return { path, fileName };
}
