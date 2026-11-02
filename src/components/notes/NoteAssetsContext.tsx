import { createContext, useContext } from 'react';

/**
 * 当前这篇笔记的素材表：assetId → data URL。
 *
 * 为什么要在 React 之外再留一份模块级登记表（assetRegistry）：
 * 图片节点的 Markdown 序列化发生在 TipTap 的 renderMarkdown 里，那里拿不到 React context；
 * 两处都由 NotesPage 在同一次装载里填满，所以取 URL 时 context 优先、登记表兜底。
 */
export const NoteAssetsContext = createContext<ReadonlyMap<string, string>>(new Map());

export function useNoteAssets(): ReadonlyMap<string, string> {
  return useContext(NoteAssetsContext);
}
