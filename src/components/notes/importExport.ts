import { Editor } from '@tiptap/core';
import { api } from '../../lib/api';
import { openFile, openFiles, saveFileDialog } from '../../lib/dialogs';
import { NOTE_EXTENSIONS } from './extensions';
import { rememberAsset } from './assetRegistry';
import type { NoteImportResult, NoteRecord } from '../../lib/types';

/** 文件名里不能有的那几个字符，连同空白一起压成下划线；标题可以带中文，路径不行。 */
function safeFileName(raw: string): string {
  const cleaned = raw.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim();
  return cleaned.slice(0, 60) || '笔记';
}

function fileStem(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

/**
 * 单篇导出 Markdown。图片以 data URL 内联——
 * 素材表在 `assetRegistry` 里，序列化由 AssetImage 的 renderMarkdown 完成，
 * 所以调用前那篇笔记的素材必须已经装载（打开笔记时就会装，导出走的也是这一篇）。
 */
export async function exportNoteMarkdown(editor: Editor, note: NoteRecord): Promise<boolean> {
  const path = await saveFileDialog({
    title: '导出这篇笔记为 Markdown',
    defaultPath: `${safeFileName(note.title)}.md`,
    filters: [{ name: 'Markdown', extensions: ['md'] }],
  });
  if (!path) return false;
  await api.notesExportMarkdown(path, editor.getMarkdown());
  return true;
}

/** 全部笔记打包成 zip 备份：正文 + 图片素材，走真实文件写入（0600）。 */
export async function exportAllZip(): Promise<boolean> {
  const path = await saveFileDialog({
    title: '导出全部笔记（zip 备份）',
    defaultPath: `notes-backup-${new Date().toISOString().slice(0, 10)}.zip`,
    filters: [{ name: 'zip 备份', extensions: ['zip'] }],
  });
  if (!path) return false;
  await api.notesExportZip(path);
  return true;
}

export async function importZipBackup(): Promise<NoteImportResult | null> {
  const path = await openFile({
    title: '选择本应用导出的笔记备份',
    filters: [{ name: 'zip 备份', extensions: ['zip'] }],
  });
  if (!path) return null;
  return api.notesImportZip(path);
}

/**
 * 把正文里的 `data:` 图片逐张上传成素材，再把 src 换成素材引用。
 *
 * 认不出是图片的那几张（后端按魔数判）会被丢掉并计数：
 * 存一条永远渲染不出来的引用，比页面上少一张图更容易让人误会。
 */
async function inlineImagesToAssets(noteId: string, html: string): Promise<{ html: string; dropped: number }> {
  const pattern = /<img\b[^>]*>/gi;
  const srcPattern = /\bsrc="data:([^;"]+);base64,([^"]+)"/i;
  const altPattern = /\balt="([^"]*)"/i;
  let out = '';
  let last = 0;
  let dropped = 0;
  for (let match = pattern.exec(html); match; match = pattern.exec(html)) {
    out += html.slice(last, match.index);
    const tag = match[0];
    const src = srcPattern.exec(tag);
    if (!src) {
      out += tag;
    } else {
      const alt = altPattern.exec(tag)?.[1] ?? '';
      try {
        const asset = await api.noteUploadAssetBytes(noteId, src[0].slice(5));
        rememberAsset(asset);
        out += `<img data-mda-asset="${asset.id}"${alt ? ` alt="${alt}"` : ''}>`;
      } catch {
        dropped += 1;
      }
    }
    last = match.index + tag.length;
  }
  return { html: out + html.slice(last), dropped };
}

export interface MarkdownImportResult {
  notes: number;
  droppedImages: number;
}

/**
 * 导入 .md / .txt：文本先经一枚无头编辑器按 Markdown 解析成节点，
 * 再走与手打内容完全相同的保存通道（同一套扩展，同一份 HTML 形状）。
 */
export async function importMarkdownFiles(): Promise<MarkdownImportResult | null> {
  const paths = await openFiles({
    title: '选择要导入的 Markdown / 文本文件',
    filters: [{ name: 'Markdown / 文本', extensions: ['md', 'markdown', 'txt'] }],
  });
  if (paths.length === 0) return null;

  let notes = 0;
  let droppedImages = 0;
  for (const path of paths) {
    const text = await api.notesReadTextFile(path);
    const headless = new Editor({
      element: document.createElement('div'),
      extensions: NOTE_EXTENSIONS,
      content: text,
      contentType: 'markdown',
    });
    const html = headless.getHTML();
    headless.destroy();

    const created = await api.notesCreate();
    const inlined = await inlineImagesToAssets(created.note.id, html);
    droppedImages += inlined.dropped;
    await api.notesUpdate(created.note.id, fileStem(path), inlined.html);
    notes += 1;
  }
  return { notes, droppedImages };
}
