import { fireEvent, render, screen, within } from '@testing-library/react';
import { Editor } from '@tiptap/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pointerTap } from '../../test/pointer';
import { NotesToolbar } from './NotesToolbar';
import { NOTE_EXTENSIONS } from './extensions';

/**
 * 工具栏这一屏守三件事：
 * 1. **分组顺序**（交付方 2026-10-31 给的稿子把"历史"放在最左、"更多"收在末尾）；
 * 2. 每一档**按得动且落到 HTML 上**——菜单里写着"红"、存进去却是默认色，比少一档更糟；
 * 3. 只读角色看到的说法与能做的事一致（不给一排按了不动的项）。
 */
let editor: Editor | null = null;

function mount(content: string): Editor {
  editor = new Editor({ element: document.createElement('div'), extensions: NOTE_EXTENSIONS, content });
  return editor;
}

function renderToolbar(canWrite = true) {
  const instance = editor ?? mount('<p>主变巡检记录</p>');
  return render(
    <NotesToolbar editor={instance} canWrite={canWrite} onPickImage={() => undefined} onPickLink={() => undefined} />,
  );
}

/** 触发钮与菜单共用同一个可及名，所以按名字取菜单即可。 */
function openMenu(label: string) {
  pointerTap(screen.getByRole('button', { name: label }));
  return screen.getByRole('menu', { name: label });
}

/** 动作项是 menuitem，色板/行距那类"当前是哪一档"的是 menuitemradio。 */
function pick(menu: HTMLElement, text: RegExp) {
  fireEvent.click(within(menu).getByRole('menuitem', { name: text }));
}

function pickRadio(menu: HTMLElement, text: RegExp) {
  fireEvent.click(within(menu).getByRole('menuitemradio', { name: text }));
}

beforeEach(() => {
  editor = null;
});

afterEach(() => {
  editor?.destroy();
  editor = null;
});

describe('分组与顺序照的是那份稿子', () => {
  it('撤销/重做在最左，插入紧随其后，「更多」收在末尾', () => {
    renderToolbar();
    const names = screen
      .getAllByRole('button')
      .map((button) => button.getAttribute('aria-label') ?? button.textContent ?? '');
    const at = (needle: string) => names.findIndex((name) => name === needle || name.startsWith(needle));
    expect(at('撤销')).toBe(0);
    expect(at('重做')).toBe(1);
    expect(at('清除格式')).toBeGreaterThan(at('重做'));
    expect(at('插入')).toBeGreaterThan(at('清除格式'));
    expect(at('更多')).toBeGreaterThan(at('文字颜色'));
    expect(at('任务列表')).toBeLessThan(at('更多'));
  });

  it('属性用文字下拉（正文、字号），动作才是图标钮', () => {
    renderToolbar();
    expect(screen.getByLabelText('段落样式')).toBeInTheDocument();
    expect(screen.getByLabelText('字号')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '加粗' })).toBeInTheDocument();
  });
});

describe('每一档都要真的改得动', () => {
  it('字色选「红」：存的是令牌引用，不是实色', () => {
    const instance = mount('<p>主变巡检记录</p>');
    instance.commands.setTextSelection({ from: 2, to: 4 });
    renderToolbar();
    pickRadio(openMenu('文字颜色'), /^红$/);
    expect(instance.getHTML()).toContain('color: var(--t-danger)');
  });

  it('底色选「橙淡底」：mark 上带 data-color，读回来还是这一档', () => {
    const instance = mount('<p>重点项</p>');
    instance.commands.setTextSelection({ from: 2, to: 4 });
    renderToolbar();
    pickRadio(openMenu('底色'), /橙淡底/);
    const html = instance.getHTML();
    expect(html).toContain('data-color="var(--t-warning-soft)"');
    expect(html).toContain('background-color: var(--t-warning-soft)');
  });

  it('「更多」里能改对齐、缩进与行距', () => {
    const instance = mount('<p>油位检查</p>');
    renderToolbar();
    const menu = openMenu('更多');
    pick(menu, /居中/);
    expect(instance.getHTML()).toContain('text-align: center');

    const second = openMenu('更多');
    pick(second, /增加缩进/);
    expect(instance.getHTML()).toContain('margin-left: 1.5em');

    const third = openMenu('更多');
    pickRadio(third, /1.75 倍/);
    expect(instance.getHTML()).toContain('line-height: 1.75');
  });

  it('字号选 18：与字色同一条 style，互不覆盖', async () => {
    const instance = mount('<p>油位检查</p>');
    instance.commands.setTextSelection({ from: 2, to: 4 });
    instance.commands.setColor('var(--t-primary)');
    renderToolbar();
    pointerTap(screen.getByLabelText('字号'));
    fireEvent.click(await screen.findByRole('option', { name: '18' }));
    const html = instance.getHTML();
    expect(html).toContain('font-size: 18px');
    expect(html).toContain('color: var(--t-primary)');
  });

  it('有序列表与引用收在「更多」里（稿子也是这两档进溢出层）', () => {
    const instance = mount('<p>巡检项</p>');
    renderToolbar();
    expect(screen.queryByRole('button', { name: '有序列表' })).toBeNull();
    expect(screen.queryByRole('button', { name: '引用' })).toBeNull();
    pick(openMenu('更多'), /有序列表/);
    expect(instance.getHTML()).toContain('<ol>');
  });

  it('「更多」里的引用按得下去', () => {
    const instance = mount('<p>巡检项</p>');
    renderToolbar();
    pick(openMenu('更多'), /^引用/);
    expect(instance.getHTML()).toContain('<blockquote>');
  });

  it('任务列表那一枚按得下去', () => {
    const instance = mount('<p>巡检项</p>');
    renderToolbar();
    fireEvent.click(screen.getByRole('button', { name: '任务列表' }));
    expect(instance.getHTML()).toContain('data-type="taskList"');
  });
});

describe('只读角色看到的说法与能做的事一致', () => {
  it('图标钮整排禁用，菜单里没有可挑的档，只有一句说明', () => {
    mount('<p>只能看的那一篇</p>');
    renderToolbar(false);
    expect(screen.getByRole('button', { name: '加粗' })).toBeDisabled();
    const menu = openMenu('文字颜色');
    expect(menu.textContent).toContain('只能读');
    const more = openMenu('更多');
    expect(more.textContent).toContain('只能读');
  });
});

