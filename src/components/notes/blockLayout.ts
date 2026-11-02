import { Extension, getStyleProperty } from '@tiptap/core';
/**
 * 段落级排版：行距与缩进。
 *
 * 为什么不直接用 `@tiptap/extension-text-style` 里那枚 LineHeight：它的命令把值写到
 * `textStyle` 标记上（`setMark('textStyle', …)`），只有被选中的那几**个字**的行距会变；
 * 而界面文案说的是"这一段的行距"，且选中一段时字色/字号本来就在 textStyle 上，
 * 两件事混在一枚标记里，取消行距会顺手把字色也削掉。落点与 TextAlign 保持在同一批块上。
 */
export const BLOCK_LAYOUT_TYPES = ['paragraph', 'heading', 'blockquote', 'listItem'] as const;

/** 行距档：`默认` = 不带 style，跟着主题的正文节奏走。 */
export const NOTE_LINE_HEIGHTS: { value: string | null; label: string }[] = [
  { value: null, label: '默认' },
  { value: '1', label: '1 倍' },
  { value: '1.4', label: '1.4 倍' },
  { value: '1.75', label: '1.75 倍' },
  { value: '2', label: '2 倍' },
];

/** 缩进一档 1.5em，最多四档：再深就顶到正文的 760px 版心右沿了。 */
export const NOTE_INDENT_STEP_EM = 1.5;
export const NOTE_INDENT_MAX = 4;

/** 后端 `sanitize_style` 认的形状：`margin-left: 1.5em` 这一档（单位只有 em）。 */
export function indentStyle(level: number): string {
  return `${Number((level * NOTE_INDENT_STEP_EM).toFixed(2))}em`;
}

function indentLevelOf(styleValue: string | null): number | null {
  if (!styleValue || !styleValue.endsWith('em')) return null;
  const em = Number.parseFloat(styleValue);
  if (!Number.isFinite(em) || em <= 0) return null;
  const level = Math.round(em / NOTE_INDENT_STEP_EM);
  return level > 0 && level <= NOTE_INDENT_MAX ? level : null;
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    blockLayout: {
      setBlockLineHeight: (lineHeight: string | null) => ReturnType;
      indent: () => ReturnType;
      outdent: () => ReturnType;
    };
  }
}

export const BlockLayout = Extension.create({
  name: 'blockLayout',

  addGlobalAttributes() {
    return [
      {
        types: [...BLOCK_LAYOUT_TYPES],
        attributes: {
          lineHeight: {
            default: null,
            parseHTML: (element) => getStyleProperty(element, 'line-height'),
            renderHTML: (attributes) =>
              attributes.lineHeight ? { style: `line-height: ${attributes.lineHeight}` } : {},
          },
          indent: {
            default: null,
            parseHTML: (element) => indentLevelOf(getStyleProperty(element, 'margin-left')),
            renderHTML: (attributes) =>
              attributes.indent ? { style: `margin-left: ${indentStyle(attributes.indent as number)}` } : {},
          },
        },
      },
    ];
  },

  addCommands() {
    const onActiveBlocks = (run: (type: string) => boolean) =>
      BLOCK_LAYOUT_TYPES.map((type) => run(type)).some(Boolean);

    return {
      setBlockLineHeight:
        (lineHeight) =>
          ({ commands }) =>
            onActiveBlocks((type) => commands.updateAttributes(type, { lineHeight })),

      indent:
        () =>
          ({ editor, commands }) =>
            onActiveBlocks((type) => {
              const current = (editor.getAttributes(type).indent as number | null) ?? 0;
              if (current >= NOTE_INDENT_MAX) return true;
              return commands.updateAttributes(type, { indent: current + 1 });
            }),

      outdent:
        () =>
          ({ editor, commands }) =>
            onActiveBlocks((type) => {
              const current = (editor.getAttributes(type).indent as number | null) ?? 0;
              if (current <= 0) return true;
              const next = current - 1;
              return commands.updateAttributes(type, { indent: next === 0 ? null : next });
            }),
    };
  },
});
