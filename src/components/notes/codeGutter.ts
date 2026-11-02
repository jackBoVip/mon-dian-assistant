import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
// `Decoration` 要拿 ProseMirror 那一枚：@tiptap/core 导出的同名类是它自己的装饰基类，没有 widget/inline
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as Doc } from '@tiptap/pm/model';

/**
 * 代码块的行号。
 *
 * 做法是**行首的 widget 装饰**，不是 NodeView：`<pre>` 里的换行只是文本里的 `\n`，
 * ProseMirror 不会为它们生成元素，所以 CSS 数不出行。往每个行首塞一枚小节点，
 * 行号就跟着文本走，编辑时不用重排；预览那扇只读编辑器吃同一份扩展，两边自然一致。
 *
 * 装饰不属于文档内容：复制、导出 Markdown、落库的 HTML 里都不会带上号码。
 */
export interface CodeLineMark {
  pos: number;
  line: number;
}

/** 每个代码块各自从 1 数起；行首位置 = 节点内容起点 + 每个换行符之后。 */
export function codeLineMarks(doc: Doc): CodeLineMark[] {
  const marks: CodeLineMark[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== 'codeBlock') return;
    const text = node.textContent;
    let line = 1;
    marks.push({ pos: pos + 1, line });
    for (let i = 0; i < text.length; i += 1) {
      if (text[i] !== '\n') continue;
      line += 1;
      marks.push({ pos: pos + 1 + i + 1, line });
    }
    return false;
  });
  return marks;
}

function gutterNode(line: number): HTMLElement {
  const el = document.createElement('span');
  el.className = 'note-code__no';
  // 号码是给眼睛看的辅助信息，读屏与复制都不该带上它
  el.setAttribute('aria-hidden', 'true');
  el.textContent = String(line);
  return el;
}

const gutterKey = new PluginKey<DecorationSet>('noteCodeGutter');

export const CodeGutter = Extension.create({
  name: 'codeGutter',

  addProseMirrorPlugins() {
    const build = (doc: Doc) =>
      DecorationSet.create(
        doc,
        codeLineMarks(doc).map((mark) => Decoration.widget(mark.pos, gutterNode(mark.line), { side: -1 })),
      );

    return [
      new Plugin<DecorationSet>({
        key: gutterKey,
        state: {
          init: (_config, state) => build(state.doc),
          apply: (tr, value) => (tr.docChanged ? build(tr.doc) : value),
        },
        props: {
          decorations: (state) => gutterKey.getState(state) ?? DecorationSet.empty,
        },
      }),
    ];
  },
});
