import StarterKit from '@tiptap/starter-kit';
import { CodeBlockLowlight } from '@tiptap/extension-code-block-lowlight';
import Highlight from '@tiptap/extension-highlight';
import { TableKit } from '@tiptap/extension-table';
import { Placeholder } from '@tiptap/extensions';
import { Markdown } from '@tiptap/markdown';
import { BackgroundColor, Color, FontSize, TextStyle } from '@tiptap/extension-text-style';
import { TextAlign } from '@tiptap/extension-text-align';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { ReactNodeViewRenderer } from '@tiptap/react';
import { common, createLowlight } from 'lowlight';
import { AssetImage } from './AssetImage';
import { BLOCK_LAYOUT_TYPES, BlockLayout } from './blockLayout';
import { CodeBlockView } from './CodeBlockView';
import { CodeGutter } from './codeGutter';

/**
 * 笔记编辑器的扩展清单。
 *
 * 只有一份，且必须在模块级建好：编辑器与各处测试吃同一份，HTML/Markdown 往返才可能一致。
 * 三处的 HTML/Markdown 往返才可能一致。CodeBlockLowlight 用 `common`（37 种常用语言），
 * 不换 `lowlight/lib/all`——那一份接近 1 MB，装进离线安装包不值。
 *
 * 排版属性的落点分两层：**字色/底色/字号**是选区级的，走 `textStyle` 标记；
 * **对齐/行距/缩进**是段落级的，走块节点属性（见 blockLayout）。两层的值一律写成
 * 设计令牌引用或带单位的尺寸，后端 `sanitize_style` 的白名单与此处严格成对——
 * 这边写得出去、那边认不下来，等于下次读出来样式被削平。
 */
const lowlight = createLowlight(common);

/** 字色档：存令牌引用而不是实色，四套主题各自适配，源文件里也就不出现字面色值。 */
export const NOTE_TEXT_COLORS: { value: string | null; label: string }[] = [
  { value: null, label: '默认文字色' },
  { value: 'var(--t-primary)', label: '主题色' },
  { value: 'var(--t-success)', label: '绿' },
  { value: 'var(--t-warning)', label: '橙' },
  /* 红档借的是主题那枚"出错/危险"语义色，这里只当标记用（不代表正文里出了错） */
  { value: 'var(--t-danger)', label: '红' },
  { value: 'var(--t-text)', label: '墨（强调）' },
  { value: 'var(--t-text-muted)', label: '灰（次要）' },
];

/** 底色档：只有淡底那四枚能压在正文上不糊字，所以不给实色。 */
export const NOTE_HIGHLIGHT_COLORS: { value: string | null; label: string }[] = [
  { value: null, label: '不标底色' },
  { value: 'var(--t-primary-glow)', label: '主题色淡底' },
  { value: 'var(--t-success-soft)', label: '绿淡底' },
  { value: 'var(--t-warning-soft)', label: '橙淡底' },
  /* 这一档取自主题那枚"警告/危险"语义色的淡底版，只作标记，不表示正文里出了错 */
  { value: 'var(--t-danger-soft)', label: '红淡底' },
];

/** 字号：与 tokens.css 的字号节奏对齐，`null` = 跟主题走。 */
export const NOTE_FONT_SIZES: { value: string | null; label: string }[] = [
  { value: null, label: '默认' },
  ...[12, 14, 16, 18, 20, 24, 28, 32].map((px) => ({ value: `${px}px`, label: `${px}` })),
];

export const NOTE_ALIGNMENTS: { value: string; label: string }[] = [
  { value: 'left', label: '左对齐' },
  { value: 'center', label: '居中' },
  { value: 'right', label: '右对齐' },
  { value: 'justify', label: '两端对齐' },
];

export const NOTE_EXTENSIONS = [
  StarterKit.configure({
    // 代码块换成 lowlight 那一版，语法着色才存在
    codeBlock: false,
    // 链接不在 webview 里跳转，点击由界面接（见 NotesEditor 的 handleClick）
    link: { openOnClick: false, autolink: true, defaultProtocol: 'https' },
  }),
  TableKit.configure({ table: { resizable: true } }),
  // multicolor：底色按选的那一档写进 style，而不是全局一枚高亮色
  Highlight.configure({ multicolor: true }),
  TextStyle,
  Color,
  BackgroundColor,
  FontSize,
  TextAlign.configure({ types: [...BLOCK_LAYOUT_TYPES] }),
  BlockLayout,
  TaskList,
  TaskItem.configure({ nested: true }),
  AssetImage,
  // 代码块带右上角那两枚钮（格式化 / 复制），语法着色与行号装饰都还在 node view 的内容区里
  CodeBlockLowlight.extend({
    addNodeView() {
      return ReactNodeViewRenderer(CodeBlockView);
    },
  }).configure({ lowlight }),
  CodeGutter,
  Markdown,
  Placeholder.configure({ placeholder: '开始输入…' }),
];

/** 代码块可指认的语言。空串 = 不指定，交给 lowlight 自动识别。 */
export const CODE_LANGUAGES: { value: string; label: string }[] = [
  { value: '', label: '自动识别' },
  ...Object.keys(common)
    .sort()
    .map((lang) => ({ value: lang, label: lang })),
];
