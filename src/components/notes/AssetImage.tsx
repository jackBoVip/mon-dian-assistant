import { mergeAttributes } from '@tiptap/core';
import Image from '@tiptap/extension-image';
import { NodeViewWrapper, ReactNodeViewRenderer, type ReactNodeViewProps } from '@tiptap/react';
import { useNoteAssets } from './NoteAssetsContext';
import { lookupAssetUrl } from './assetRegistry';
import type { NoteAsset } from '../../lib/types';

/** 正文里只留这一条引用；图片字节在保险库的 note_assets 表里。 */
export const ASSET_ATTR = 'data-mda-asset';

/**
 * 图片节点：`assetId` 指向保险库素材，`src` 只在「外部 Markdown 刚导入、还没上传成素材」
 * 那一瞬存在。两条 parse 规则都必须留：
 * 父类的默认规则是 `img[src]:not([src^="data:"])`，存进库的节点**没有 src**，
 * 按默认规则一条也匹配不上——重开笔记时图片会静默消失（本方案最容易踩的坑）。
 */
export const AssetImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      assetId: {
        default: null,
        parseHTML: (element) => element.getAttribute(ASSET_ATTR),
        renderHTML: (attributes) => (attributes.assetId ? { [ASSET_ATTR]: attributes.assetId } : {}),
      },
    };
  },

  parseHTML() {
    return [{ tag: `img[${ASSET_ATTR}]` }, { tag: 'img[src]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['img', mergeAttributes(this.options.HTMLAttributes, HTMLAttributes)];
  },

  parseMarkdown: (token, helpers) =>
    helpers.createNode('image', { src: token.href, title: token.title, alt: token.text }),

  // 导出 Markdown 时把 assetId 换成内联 data URL：导出的单篇文件要能脱离本机保险库看开。
  renderMarkdown: (node) => {
    const attrs = (node.attrs ?? {}) as Record<string, string | null>;
    const alt = attrs.alt ?? '';
    const src = attrs.src || lookupAssetUrl(attrs.assetId);
    return `![${alt}](${src ?? ''})`;
  },

  addNodeView() {
    return ReactNodeViewRenderer(AssetImageView);
  },
});

function AssetImageView({ node, selected, editor, deleteNode }: ReactNodeViewProps) {
  const assets = useNoteAssets();
  const assetId = (node.attrs.assetId as string | null) ?? null;
  const src = (assetId ? (assets.get(assetId) ?? lookupAssetUrl(assetId)) : null) ?? (node.attrs.src as string | null);
  const alt = (node.attrs.alt as string | null) ?? '';

  return (
    <NodeViewWrapper className="note-image">
      {src ? (
        <img src={src} alt={alt} draggable={false} />
      ) : (
        // 素材不在库里（旧备份缺文件、或导入时被拒绝）：如实说清，不给一张空图当成功
        <span className="note-image__missing">图片未能载入：素材不在这台机器的保险库里</span>
      )}
      {selected && editor.isEditable ? (
        <button type="button" className="note-image__remove" title="移除这张图片" onClick={deleteNode}>
          移除
        </button>
      ) : null}
    </NodeViewWrapper>
  );
}

/** 把上传回来的素材拼成 context 用的一张表。 */
export function toAssetMap(assets: readonly NoteAsset[]): Map<string, string> {
  return new Map(assets.map((asset) => [asset.id, asset.dataUrl]));
}
