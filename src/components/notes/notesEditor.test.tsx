import { act } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Editor } from '@tiptap/core';
import { EditorContent } from '@tiptap/react';
import { render } from '@testing-library/react';
import { NOTE_EXTENSIONS } from './extensions';
import { AssetImage } from './AssetImage';
import { replaceAssetRegistry } from './assetRegistry';
import { codeLineMarks } from './codeGutter';
import { useNotify } from '../../state/notify';

/**
 * 图片节点与 Markdown 往返的守卫。
 *
 * 这里验的都是"错了不会报错、只会静默丢东西"的那几件事：
 * 重开笔记时图片还在不在、导出的 Markdown 里图片还有没有地址、
 * 外部 Markdown 的表格与代码块能不能落到这套 schema 里。
 */
function makeEditor(content?: string): Editor {
  return new Editor({
    element: document.createElement('div'),
    extensions: NOTE_EXTENSIONS,
    content: content ?? '',
  });
}

describe('素材引用的往返', () => {
  it('只带 data-mda-asset 的图片能被解析回 image 节点，属性不丢', () => {
    const editor = makeEditor('<p>正文</p><img data-mda-asset="asset-1" alt="现场照片">');
    const html = editor.getHTML();
    expect(html).toContain('data-mda-asset="asset-1"');
    expect(html).toContain('alt="现场照片"');
    let images = 0;
    editor.state.doc.descendants((node) => {
      if (node.type.name === 'image') images += 1;
    });
    expect(images).toBe(1);
    editor.destroy();
  });

  it('导出 Markdown 时把引用换成登记表里的 data URL', () => {
    replaceAssetRegistry([{ id: 'asset-1', mime: 'image/png', dataUrl: 'data:image/png;base64,AAA=' }]);
    const editor = makeEditor('<p><img data-mda-asset="asset-1" alt="图"></p>');
    expect(editor.getMarkdown()).toContain('![图](data:image/png;base64,AAA=)');
    editor.destroy();
  });

  it('登记表里没有的素材导出成空地址，不编造一个能看的图', () => {
    replaceAssetRegistry([]);
    const editor = makeEditor('<p><img data-mda-asset="gone"></p>');
    expect(editor.getMarkdown()).toContain('![]()');
    editor.destroy();
  });

  it('AssetImage 认外部 Markdown 里带 src 的图（导入瞬间的过渡态）', () => {
    const editor = makeEditor('<img src="data:image/gif;base64,R0lGOD=" alt="x">');
    expect(editor.getHTML()).toContain('src="data:image/gif;base64,R0lGOD="');
    editor.destroy();
  });

  it('AssetImage 就是 Image 的扩展，节点名保持 image', () => {
    expect(AssetImage.name).toBe('image');
  });
});

describe('Markdown 进出', () => {
  it('外部 Markdown 的标题、表格、代码块都能落到这套 schema 里', () => {
    const editor = makeEditor();
    editor.commands.setContent(
      ['# 巡检记录', '', '| 设备 | 状态 |', '| --- | --- |', '| 1 号主变 | 正常 |', '', '```python', 'def f():', '    return 1', '```'].join('\n'),
      { contentType: 'markdown' },
    );
    const html = editor.getHTML();
    expect(html).toContain('<h1>巡检记录</h1>');
    expect(html).toContain('<table');
    expect(html).toContain('<th');
    expect(html).toContain('language-python');
    editor.destroy();
  });

  it('代码块的语言属性跟着 updateAttributes 走，着色才有依据', () => {
    const editor = makeEditor();
    editor.commands.setContent('<pre><code class="language-go">package main</code></pre>');
    expect(editor.getAttributes('codeBlock').language).toBe('go');
    editor.commands.updateAttributes('codeBlock', { language: 'rust' });
    expect(editor.getAttributes('codeBlock').language).toBe('rust');
    expect(editor.getMarkdown()).toContain('```rust');
    editor.destroy();
  });

  it('高亮、下划线、删除线这些标记能出得来（工具栏按得动的都得在 schema 里）', () => {
    const editor = makeEditor('<p><u>下</u><s>删</s><mark>亮</mark></p>');
    const html = editor.getHTML();
    expect(html).toContain('<u>');
    expect(html).toContain('<s>');
    expect(html).toContain('<mark>');
    editor.destroy();
  });
});

/**
 * 排版属性（颜色/底色/字号/对齐/行距/缩进）与任务列表。
 *
 * 这一组盯的是"工具栏按得动、落进 HTML、后端 sanitizer 认得"这条链：
 * 值一律用设计令牌引用（`var(--t-…)`）而不是实色，四套主题才各自适配；
 * 后端 `sanitize_style` 的白名单形状与此处必须一致，否则存进去的样式在下次读出来时会被削掉。
 */
describe('排版属性', () => {
  it('字色与底色存的是令牌引用，不是实色', () => {
    const editor = makeEditor('<p>主变巡检</p>');
    editor.commands.setTextSelection({ from: 2, to: 4 });
    editor.commands.setColor('var(--t-danger)');
    editor.commands.toggleHighlight({ color: 'var(--t-warning-soft)' });
    const html = editor.getHTML();
    expect(html).toContain('color: var(--t-danger)');
    expect(html).toContain('background-color: var(--t-warning-soft)');
    expect(/#[0-9a-f]{3,8}/i.test(html), '色板不该往内容里写实色').toBe(false);
    editor.destroy();
  });

  it('字号落在 textStyle 上，与字色同一条 style 不互相覆盖', () => {
    const editor = makeEditor('<p>主变巡检</p>');
    editor.commands.setTextSelection({ from: 2, to: 4 });
    editor.commands.setColor('var(--t-primary)');
    editor.commands.setFontSize('18px');
    const html = editor.getHTML();
    expect(html).toContain('font-size: 18px');
    expect(html).toContain('color: var(--t-primary)');
    editor.destroy();
  });

  it('对齐、行距、缩进都是段落级属性，合并成同一条 style', () => {
    const editor = makeEditor('<p>计划 检查油位</p>');
    editor.commands.setTextAlign('center');
    editor.commands.setBlockLineHeight('1.75');
    editor.commands.indent();
    editor.commands.indent();
    const html = editor.getHTML();
    expect(html).toContain('text-align: center');
    expect(html).toContain('line-height: 1.75');
    expect(html).toContain('margin-left: 3em');
    editor.commands.outdent();
    expect(editor.getHTML()).toContain('margin-left: 1.5em');
    editor.destroy();
  });

  it('缩进有下限：顶到第一格再按「减少」不会变成负值', () => {
    const editor = makeEditor('<p>顶格</p>');
    editor.commands.outdent();
    expect(editor.getHTML()).not.toContain('margin-left');
    editor.destroy();
  });

  it('样式类属性导出 Markdown 时按 Markdown 的规矩丢掉（界面文案已写明这一条）', () => {
    const editor = makeEditor('<p style="text-align: center"><span style="color: var(--t-danger)">红</span></p>');
    expect(editor.getMarkdown()).toBe('红');
    editor.destroy();
  });
});

describe('任务列表', () => {
  it('勾选状态走 data-checked，且能出成 - [x] 的 Markdown', () => {
    const editor = makeEditor();
    editor.commands.setContent('<p>巡检项一</p><p>巡检项二</p>');
    editor.commands.setTextSelection(3);
    editor.commands.toggleTaskList();
    let html = editor.getHTML();
    expect(html).toContain('data-type="taskList"');
    expect(html).toContain('data-type="taskItem"');
    expect(html).toContain('type="checkbox"');
    editor.commands.updateAttributes('taskItem', { checked: true });
    html = editor.getHTML();
    expect(html).toContain('data-checked="true"');
    expect(editor.getMarkdown()).toContain('- [x] 巡检项一');
    editor.destroy();
  });

  it('从外部 Markdown 读回 - [ ] 与 - [x] 时勾不丢', () => {
    const editor = makeEditor();
    editor.commands.setContent(['- [ ] 未做', '- [x] 已做'].join('\n'), { contentType: 'markdown' });
    const html = editor.getHTML();
    expect(html).toContain('data-type="taskList"');
    expect(html).toContain('data-checked="true"');
    editor.destroy();
  });
});

describe('代码块右上角那两枚钮', () => {
  const codeDoc = '<pre><code class="language-json">{"sadf":1}</code></pre>';

  /**
   * 角标是 React node view：TipTap 在 `editor.contentComponent` 挂上之前会把它退化成空 span，
   * 而那一枚只有经 `<EditorContent>` 渲染才有——应用里就是这条路（见 NotesEditor），
   * 所以这里也必须真渲染一次，否则测的是"没挂载时的兜底壳"。
   */
  async function mountCode(content: string, editable = true): Promise<Editor> {
    const instance = new Editor({
      element: document.createElement('div'),
      extensions: NOTE_EXTENSIONS,
      content,
      editable,
    });
    // node view 是 React 树里的东西：不套 act 就停在 TipTap 那个兜底空壳上（`<span></span>`），
    // 测出来的是"没挂载"，不是"渲染错了"。
    await act(async () => {
      render(<EditorContent editor={instance} />);
    });
    return instance;
  }

  afterEach(() => {
    useNotify.setState({ items: [] });
  });

  it('node view 里语法着色与行号装饰都还在（换成 node view 最容易掉的就是这两样）', async () => {
    const editor = await mountCode(codeDoc);
    const dom = editor.view.dom;
    expect(dom.querySelector('.note-code__tools'), '角标没渲染：' + dom.innerHTML).toBeTruthy();
    expect(dom.querySelector('.note-code__no')).toBeTruthy();
    expect(dom.querySelector('[class*="hljs-"]')).toBeTruthy();
    editor.destroy();
  });

  it('点「格式化代码」把这段 JSON 重排回文档，导出的 HTML 里没有那两枚钮', async () => {
    const editor = await mountCode(codeDoc);
    const button = editor.view.dom.querySelector('[aria-label="格式化代码"]') as HTMLButtonElement;
    await act(async () => {
      button.click();
    });
    expect(editor.getHTML()).toContain('{\n  "sadf": 1');
    expect(editor.getHTML()).not.toContain('note-code__tools');
    editor.destroy();
  });

  it('JSON 语法不过时报的是解析原因，不改文档', async () => {
    const editor = await mountCode('<pre><code class="language-json">{"sadf" 1}</code></pre>');
    const button = editor.view.dom.querySelector('[aria-label="格式化代码"]') as HTMLButtonElement;
    await act(async () => {
      button.click();
    });
    expect(useNotify.getState().items.map((item) => item.text).join('|')).toContain('JSON 解析不过');
    expect(editor.getHTML()).toContain('{"sadf" 1}');
    editor.destroy();
  });

  it('「复制这段代码」写的是这一块的正文，不是整篇', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const editor = await mountCode(codeDoc + '<p>正文别跟着复制</p>');
    const button = editor.view.dom.querySelector('[aria-label="复制这段代码"]') as HTMLButtonElement;
    await act(async () => {
      button.click();
    });
    expect(writeText).toHaveBeenCalledWith('{"sadf":1}');
    editor.destroy();
  });

  it('只读那一档不给「格式化」（它改正文），复制留着', async () => {
    const editor = await mountCode(codeDoc, false);
    const dom = editor.view.dom;
    expect(dom.querySelector('[aria-label="格式化代码"]')).toBeNull();
    expect(dom.querySelector('[aria-label="复制这段代码"]')).toBeTruthy();
    editor.destroy();
  });
});

describe('代码块行号', () => {
  it('行号取自代码文本的换行数，每个代码块各自从 1 开始', () => {
    const editor = makeEditor(
      '<pre><code class="language-json">{\n  "sadf":1\n}</code></pre><p>正文</p><pre><code>a\nb</code></pre>',
    );
    const marks = codeLineMarks(editor.state.doc);
    expect(marks.map((m) => m.line)).toEqual([1, 2, 3, 1, 2]);
    editor.destroy();
  });

  it('空代码块也有一行（第 1 行），不出现没有号号的正文', () => {
    const editor = makeEditor('<pre><code></code></pre>');
    const marks = codeLineMarks(editor.state.doc);
    expect(marks.map((m) => m.line)).toEqual([1]);
    expect(marks[0].pos).toBeGreaterThan(0);
    editor.destroy();
  });
});
