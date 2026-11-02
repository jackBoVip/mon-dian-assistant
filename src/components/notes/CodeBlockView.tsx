import { useState } from 'react';
import { NodeViewContent, NodeViewWrapper, type NodeViewProps } from '@tiptap/react';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { notify } from '../../state/notify';
import { formatCode, formatHint } from './codeFormat';

/**
 * 代码块：正文之外只多右上角那两枚钮——「格式化」与「复制」，与稿子同一位置。
 *
 * 为什么用 node view 而不是浮动那一行（表格用的是那种）：这两件事针对的是**这一块**，
 * 挂在块上才说得出"复制的是哪段"；光标跑到别处时浮动行会留在原地，读起来像坏了。
 *
 * 两枚钮都不进文档内容：node view 只活在编辑器里，`getHTML()` 与导出的 .md 里都只有
 * `<pre><code class="language-…">`。只读角色只留「复制」——格式化是改正文，它改不动。
 */
export function CodeBlockView({ editor, node, getPos }: NodeViewProps) {
  const [busy, setBusy] = useState(false);
  const language = (node.attrs.language as string | null) ?? '';
  const editable = editor.isEditable;

  async function onFormat() {
    setBusy(true);
    try {
      const result = await formatCode(language, node.textContent);
      if (!result.ok) {
        notify('warning', result.reason);
        return;
      }
      if (result.text === node.textContent) {
        notify('info', '这一段已经是排好的样子了');
        return;
      }
      const attrs = { language: node.attrs.language ?? null };
      editor
        .chain()
        .focus()
        .command(({ state, tr, dispatch }) => {
          const pos = getPos();
          const type = state.schema.nodes.codeBlock;
          if (typeof pos !== 'number' || !type) return false;
          const next = result.text === '' ? type.create(attrs) : type.create(attrs, state.schema.text(result.text));
          if (dispatch) dispatch(tr.replaceWith(pos, pos + node.nodeSize, next));
          return true;
        })
        .run();
    } catch (raw) {
      notify('danger', `格式化失败：${raw instanceof Error ? raw.message : String(raw)}`);
    } finally {
      setBusy(false);
    }
  }

  async function onCopy() {
    try {
      await navigator.clipboard.writeText(node.textContent);
      notify('success', '代码已复制到剪贴板');
    } catch (raw) {
      notify('danger', `复制失败：${raw instanceof Error ? raw.message : String(raw)}`);
    }
  }

  return (
    <NodeViewWrapper className="note-code">
      <div className="note-code__tools" contentEditable={false}>
        {editable ? (
          <Button
            variant="bare"
            className="note-tool note-tool--small"
            aria-label="格式化代码"
            title={formatHint(language)}
            disabled={busy}
            onClick={() => void onFormat()}
          >
            <Icon name="wandSparkles" size={14} />
          </Button>
        ) : null}
        <Button
          variant="bare"
          className="note-tool note-tool--small"
          aria-label="复制这段代码"
          title="复制这段代码到剪贴板"
          onClick={() => void onCopy()}
        >
          <Icon name="copy" size={14} />
        </Button>
      </div>
      {/* as 是 NoInfer 的，得把标签名当类型参数写出来，否则默认按 div 收 */}
      <NodeViewContent<"pre"> as="pre" />
    </NodeViewWrapper>
  );
}
