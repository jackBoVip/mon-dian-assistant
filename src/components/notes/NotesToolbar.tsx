import { useEffect, useState, type ReactNode } from 'react';
import type { Editor } from '@tiptap/core';
import { Button } from '../ui/Button';
import { Icon, type IconName } from '../ui/Icon';
import { Select } from '../ui/select';
import { DropdownDivider, DropdownItem, DropdownRadioGroup, DropdownRadioItem, Menu } from '../ui/dropdown-menu';
import { NOTE_ALIGNMENTS, NOTE_FONT_SIZES, NOTE_HIGHLIGHT_COLORS, NOTE_TEXT_COLORS, CODE_LANGUAGES } from './extensions';
import { NOTE_LINE_HEIGHTS } from './blockLayout';

/**
 * 笔记工具栏：一行放得下，按"历史 → 整理 → 插入 → 段落与字号 → 行内标记 → 着色 → 结构 → 更多"分组。
 *
 * 分组规则抄自交付方 2026-10-31 给的有道云笔记稿：**属性用带 ▾ 的文字下拉**（正文、字号、行距），
 * **动作用图标**（加粗、列表、缩进），**一行放不下的低频项进「更多」**。
 * 之所以不再并排摆五枚画法相近的图标：上一版那种排布被点名"都长的一样"。
 *
 * 只放**真做了**的项：截图里的 AI 翻译、协作分享、格式刷一概没搬——按得动但什么都不发生的控件
 * 比没有控件更糟。颜色档存的是设计令牌引用（见 extensions 的色板），四套主题各自适配。
 */
const EMOJIS = ['✅', '⚠️', '🔧', '⚡', '📌', '📎', '🗓️', '💡', '🔍', '🧰', '🔒', '📝', '☑️', '❗', '🟢', '🔴'];

type BlockOption = 'paragraph' | 'heading1' | 'heading2' | 'heading3';

const BLOCK_OPTIONS: { value: BlockOption; label: string }[] = [
  { value: 'paragraph', label: '正文' },
  { value: 'heading1', label: '标题 1' },
  { value: 'heading2', label: '标题 2' },
  { value: 'heading3', label: '标题 3' },
];

/** Select 的值不能是 null，用空串当"跟主题走"那一档。 */
const DEFAULT_VALUE = '';

function blockValue(editor: Editor | null): BlockOption {
  if (!editor) return 'paragraph';
  if (editor.isActive('heading', { level: 1 })) return 'heading1';
  if (editor.isActive('heading', { level: 2 })) return 'heading2';
  if (editor.isActive('heading', { level: 3 })) return 'heading3';
  return 'paragraph';
}

function applyBlock(editor: Editor, next: BlockOption): void {
  const chain = editor.chain().focus();
  if (next === 'paragraph') {
    chain.setNode('paragraph').run();
    return;
  }
  chain.setNode('heading', { level: Number(next.replace('heading', '')) }).run();
}

function FormatButton({
  icon,
  label,
  active,
  disabled,
  onPick,
}: {
  icon: IconName;
  label: string;
  active: boolean;
  disabled: boolean;
  onPick: () => void;
}) {
  return (
    <Button
      variant="bare"
      className={active ? 'note-tool is-active' : 'note-tool'}
      aria-label={label}
      title={label}
      aria-pressed={active}
      disabled={disabled}
      onClick={onPick}
    >
      <Icon name={icon} size={16} />
    </Button>
  );
}

/** 带文字与 ▾ 的那类触发钮（插入、更多）：动作菜单与属性下拉都靠它，一眼看出"点开还有东西"。 */
function ToolbarMenu({
  label,
  icon,
  badge,
  disabled,
  children,
}: {
  label: string;
  icon?: IconName;
  /** 实心圆底的那枚记号（插入）：与稿子一致，它是这一行唯一的彩色入口。 */
  badge?: IconName;
  disabled: boolean;
  children: ReactNode;
}) {
  return (
    <Menu
      label={label}
      align="start"
      sideOffset={8}
      triggerClassName="note-tool note-tool--text"
      triggerContent={
        <>
          {badge ? (
            <span className="note-insert-badge" aria-hidden>
              <Icon name={badge} size={12} />
            </span>
          ) : icon ? (
            <Icon name={icon} size={15} />
          ) : null}
          <span>{label}</span>
          <Icon name="chevronDown" size={12} className="note-tool__caret" />
        </>
      }
    >
      {disabled ? <p className="note-menu__notice">当前角色只能读，改不了正文格式。</p> : children}
    </Menu>
  );
}

/** 色板：一枚色块 + 一句名字，选中那档由 RadioGroup 的 check 给。 */
function SwatchMenu({
  label,
  icon,
  options,
  current,
  disabled,
  onPick,
}: {
  label: string;
  icon: IconName;
  options: { value: string | null; label: string }[];
  current: string | null;
  disabled: boolean;
  onPick: (value: string | null) => void;
}) {
  return (
    <Menu
      label={label}
      align="start"
      sideOffset={8}
      triggerClassName="note-tool note-tool--color"
      triggerContent={
        <>
          <Icon name={icon} size={16} />
          <span className={current ? 'note-tool__ink' : undefined} style={current ? { background: current } : undefined} />
          <Icon name="chevronDown" size={12} className="note-tool__caret" />
        </>
      }
    >
      <DropdownRadioGroup
        value={current ?? DEFAULT_VALUE}
        onValueChange={(value) => onPick(value === DEFAULT_VALUE ? null : value)}
      >
        {options.map((option) => (
          <DropdownRadioItem key={option.label} value={option.value ?? DEFAULT_VALUE}>
            <span
              className={option.value ? 'note-swatch' : 'note-swatch note-swatch--none'}
              style={option.value ? { background: option.value } : undefined}
              aria-hidden
            />
            <span>{option.label}</span>
          </DropdownRadioItem>
        ))}
      </DropdownRadioGroup>
      {disabled ? <p className="note-menu__notice">当前角色只能读。</p> : null}
    </Menu>
  );
}

export interface NotesToolbarProps {
  editor: Editor | null;
  canWrite: boolean;
  onPickImage: () => void;
  onPickLink: () => void;
}

export function NotesToolbar({ editor, canWrite, onPickImage, onPickLink }: NotesToolbarProps) {
  const [, bump] = useState(0);
  useEffect(() => {
    if (!editor) return;
    const refresh = () => bump((n) => n + 1);
    editor.on('transaction', refresh);
    return () => {
      editor.off('transaction', refresh);
    };
  }, [editor]);

  const disabled = editor === null || !canWrite;
  const toggle = (name: string) => () => editor?.chain().focus().toggleMark(name).run();
  const inCode = editor?.isActive('codeBlock') === true;
  const textColor = (editor?.getAttributes('textStyle').color as string | undefined) ?? null;
  const highlight = (editor?.getAttributes('highlight').color as string | undefined) ?? null;
  const fontSize = (editor?.getAttributes('textStyle').fontSize as string | undefined) ?? null;
  const lineHeight = (editor?.getAttributes('paragraph').lineHeight as string | undefined) ?? null;
  const align = (editor?.getAttributes('paragraph').textAlign as string | undefined) ?? null;

  return (
    <div className="note-toolbar" role="toolbar" aria-label="正文格式">
      <FormatButton
        icon="undo"
        label="撤销"
        active={false}
        disabled={disabled || editor?.can().undo() !== true}
        onPick={() => editor?.chain().focus().undo().run()}
      />
      <FormatButton
        icon="redo"
        label="重做"
        active={false}
        disabled={disabled || editor?.can().redo() !== true}
        onPick={() => editor?.chain().focus().redo().run()}
      />

      <span className="note-toolbar__gap" aria-hidden />
      <FormatButton
        icon="eraser"
        label="清除格式（只留文字）"
        active={false}
        disabled={disabled}
        onPick={() => editor?.chain().focus().extendMarkRange('textStyle').unsetAllMarks().run()}
      />

      <span className="note-toolbar__gap" aria-hidden />
      <ToolbarMenu label="插入" badge="plus" disabled={disabled}>
        <DropdownItem icon="image" onPick={onPickImage}>
          图片
        </DropdownItem>
        <DropdownItem
          icon="table"
          onPick={() => editor?.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}
        >
          表格（3×3，带表头）
        </DropdownItem>
        <DropdownItem icon="code" onPick={() => editor?.chain().focus().toggleCodeBlock().run()}>
          代码块
        </DropdownItem>
        <DropdownItem icon="link" onPick={onPickLink}>
          链接
        </DropdownItem>
        <DropdownItem icon="minus" onPick={() => editor?.chain().focus().setHorizontalRule().run()}>
          水平线
        </DropdownItem>
        <DropdownDivider />
        <div className="note-emoji-block">
          <p className="note-emoji-block__title">常用符号</p>
          <div className="note-emoji-grid">
            {EMOJIS.map((emoji) => (
              <button
                key={emoji}
                type="button"
                className="note-emoji"
                aria-label={`插入 ${emoji}`}
                onClick={() => editor?.chain().focus().insertContent(emoji).run()}
              >
                {emoji}
              </button>
            ))}
          </div>
        </div>
      </ToolbarMenu>

      <span className="note-toolbar__gap" aria-hidden />
      <Select
        aria-label="段落样式"
        className="note-select"
        value={blockValue(editor)}
        options={BLOCK_OPTIONS}
        disabled={disabled}
        onValueChange={(value) => {
          if (editor) applyBlock(editor, value as BlockOption);
        }}
      />
      <Select
        aria-label="字号"
        className="note-select"
        value={fontSize ?? DEFAULT_VALUE}
        options={NOTE_FONT_SIZES.map((option) => ({ value: option.value ?? DEFAULT_VALUE, label: option.label }))}
        disabled={disabled}
        onValueChange={(value) => {
          if (value === DEFAULT_VALUE) {
            editor?.chain().focus().unsetFontSize().run();
            return;
          }
          editor?.chain().focus().setFontSize(value).run();
        }}
      />

      <span className="note-toolbar__gap" aria-hidden />
      <FormatButton icon="bold" label="加粗" active={editor?.isActive('bold') === true} disabled={disabled} onPick={toggle('bold')} />
      <FormatButton icon="italic" label="斜体" active={editor?.isActive('italic') === true} disabled={disabled} onPick={toggle('italic')} />
      <FormatButton
        icon="underline"
        label="下划线"
        active={editor?.isActive('underline') === true}
        disabled={disabled}
        onPick={toggle('underline')}
      />
      <FormatButton
        icon="strikethrough"
        label="删除线"
        active={editor?.isActive('strike') === true}
        disabled={disabled}
        onPick={toggle('strike')}
      />

      <span className="note-toolbar__gap" aria-hidden />
      <SwatchMenu
        label="文字颜色"
        icon="type"
        options={NOTE_TEXT_COLORS}
        current={textColor}
        disabled={disabled}
        onPick={(value) => {
          if (value === null) {
            editor?.chain().focus().unsetColor().run();
            return;
          }
          editor?.chain().focus().setColor(value).run();
        }}
      />
      <SwatchMenu
        label="底色"
        icon="highlighter"
        options={NOTE_HIGHLIGHT_COLORS}
        current={highlight}
        disabled={disabled}
        onPick={(value) => {
          if (value === null) {
            editor?.chain().focus().unsetHighlight().run();
            return;
          }
          editor?.chain().focus().setHighlight({ color: value }).run();
        }}
      />

      <span className="note-toolbar__gap" aria-hidden />
      <FormatButton
        icon="listChecks"
        label="任务列表"
        active={editor?.isActive('taskList') === true}
        disabled={disabled}
        onPick={() => editor?.chain().focus().toggleTaskList().run()}
      />
      <FormatButton
        icon="list"
        label="无序列表"
        active={editor?.isActive('bulletList') === true}
        disabled={disabled}
        onPick={() => editor?.chain().focus().toggleBulletList().run()}
      />

      <span className="note-toolbar__gap" aria-hidden />
      {/* 有序列表与引用进「更多」：这一行必须在一屏里放得下，稿子也是把低频的两档收进去 */}
      <ToolbarMenu label="更多" disabled={disabled}>
        <DropdownItem icon="listOrdered" onPick={() => editor?.chain().focus().toggleOrderedList().run()}>
          有序列表
          {editor?.isActive('orderedList') === true ? '（当前）' : ''}
        </DropdownItem>
        <DropdownItem icon="quote" onPick={() => editor?.chain().focus().toggleBlockquote().run()}>
          引用
          {editor?.isActive('blockquote') === true ? '（当前）' : ''}
        </DropdownItem>
        <DropdownDivider />
        {NOTE_ALIGNMENTS.map((option) => (
          <DropdownItem
            key={option.value}
            icon={
              option.value === 'center'
                ? 'alignCenter'
                : option.value === 'right'
                  ? 'alignRight'
                  : option.value === 'justify'
                    ? 'alignJustify'
                    : 'alignLeft'
            }
            onPick={() => editor?.chain().focus().setTextAlign(option.value).run()}
          >
            {option.label}
            {align === option.value ? '（当前）' : ''}
          </DropdownItem>
        ))}
        <DropdownDivider />
        <DropdownItem icon="indent" onPick={() => editor?.chain().focus().indent().run()}>
          增加缩进
        </DropdownItem>
        <DropdownItem icon="outdent" onPick={() => editor?.chain().focus().outdent().run()}>
          减少缩进
        </DropdownItem>
        <DropdownDivider />
        <DropdownRadioGroup
          value={lineHeight ?? DEFAULT_VALUE}
          onValueChange={(value) => editor?.chain().focus().setBlockLineHeight(value === DEFAULT_VALUE ? null : value).run()}
        >
          {NOTE_LINE_HEIGHTS.map((option) => (
            <DropdownRadioItem key={option.label} value={option.value ?? DEFAULT_VALUE}>
              {option.label}
            </DropdownRadioItem>
          ))}
        </DropdownRadioGroup>
      </ToolbarMenu>

      {inCode ? (
        <>
          <span className="note-toolbar__gap" aria-hidden />
          <Select
            aria-label="代码语言"
            className="note-select"
            value={(editor?.getAttributes('codeBlock').language as string | undefined) ?? ''}
            options={CODE_LANGUAGES}
            disabled={disabled}
            onValueChange={(value) => {
              editor?.chain().focus().updateAttributes('codeBlock', { language: value || null }).run();
            }}
          />
        </>
      ) : null}
    </div>
  );
}
