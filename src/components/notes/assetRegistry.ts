import type { NoteAsset } from '../../lib/types';

/**
 * 素材 id → data URL 的模块级登记表。
 *
 * Markdown 导出走 `editor.getMarkdown()`，序列化在扩展的 renderMarkdown 里完成，
 * 那一层没有 React context 可读，只能靠这份登记表把 `data-mda-asset` 换回图片字节。
 * 表里只留**当前打开那篇**的素材：导出也只可能导这一篇，不留历史以免越攒越大。
 */
const registry = new Map<string, string>();

export function replaceAssetRegistry(assets: readonly NoteAsset[]): void {
  registry.clear();
  for (const asset of assets) registry.set(asset.id, asset.dataUrl);
}

export function rememberAsset(asset: NoteAsset): void {
  registry.set(asset.id, asset.dataUrl);
}

export function lookupAssetUrl(id: string | null | undefined): string | null {
  if (!id) return null;
  return registry.get(id) ?? null;
}
