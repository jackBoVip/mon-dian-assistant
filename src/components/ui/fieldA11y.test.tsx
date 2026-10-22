import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TextField, SelectField } from './Field';
import { Checkbox } from './checkbox';
import { Label } from './field-primitives';

/**
 * 字段层与三枚新 Radix 控件的**可及性契约**（代码质量审查 F34）。
 *
 * 为什么单独一条文件：`Field.tsx` 早就把 `aria-invalid` / `aria-describedby` 接好了
 * （:39-40），但整个 400 条测试里没有任何一条断言过它们 —— 也就是"接没接"这件事
 * 完全靠人眼，删掉那两行不会有任何测试变红。同理，`.select-auto`、自绘勾选框这些
 * 本轮换件的东西，可及名/展开态也没人守。
 */
describe('错误与提示的关联', () => {
  it('有 error 时 aria-invalid 为 true，且 aria-describedby 指到那段错误文本', () => {
    render(<TextField label="别名" error="这一栏不能为空。" />);
    const input = screen.getByLabelText('别名');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    const id = input.getAttribute('aria-describedby');
    expect(id, 'describedby 必须真的指向一个存在的节点').toBeTruthy();
    const err = document.getElementById(id as string);
    expect(err).toHaveTextContent('这一栏不能为空。');
    expect(err).toHaveAttribute('role', 'alert');
  });

  it('只有 hint 时不报 invalid，describedby 指向提示；两者都有时错误优先', () => {
    render(<TextField label="令牌" hint="可选" />);
    const withHint = screen.getByLabelText('令牌');
    expect(withHint).not.toHaveAttribute('aria-invalid');
    expect(document.getElementById(withHint.getAttribute('aria-describedby') as string)).toHaveTextContent('可选');

    render(<TextField label="私钥" hint="PEM 原文" error="解析失败。" />);
    const both = screen.getByLabelText('私钥');
    expect(both).toHaveAttribute('aria-invalid', 'true');
    expect(document.getElementById(both.getAttribute('aria-describedby') as string)).toHaveTextContent('解析失败。');
  });

  it('禁用与只读都得让读屏拿得到状态', () => {
    render(<TextField label="系统名" value="OA" readOnly />);
    expect(screen.getByLabelText('系统名')).toHaveAttribute('readonly');
    render(<SelectField label="类型" value="web" options={[{ value: 'web', label: '网页' }]} onValueChange={() => {}} disabled />);
    expect(screen.getByRole('combobox', { name: '类型' })).toBeDisabled();
  });
});

describe('换件后的两枚控件的可及性形状', () => {
  it('SelectField 是 combobox：有可及名、可展开，且展开前不带 aria-expanded=true', () => {
    render(<SelectField label="每页条数" value="20" options={[{ value: '20', label: '20' }]} onValueChange={() => {}} />);
    const trigger = screen.getByRole('combobox', { name: '每页条数' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    // Radix 的 Trigger 不带 aria-haspopup（本仓库以 node_modules 里的实际渲染为准，不猜上游行为），
    // 弹层自己才是 role=listbox；这里守的是"可及名 + 展开态"这两件真会影响读屏的东西。
    expect(trigger).toHaveAttribute('data-state', 'closed');
  });

  it('自绘勾选框与 Label 用 id 绑定后，可及名仍然来自 Label 文本', () => {
    render(
      <>
        <Checkbox id="c1" />
        <Label htmlFor="c1">每次填充前确认</Label>
      </>,
    );
    const box = screen.getByRole('checkbox', { name: '每次填充前确认' });
    expect(box).toHaveAttribute('aria-checked', 'false');
    // 原生 input 时代 name 来自包裹它的 <label>；Radix 那颗是 button，label 不命名 button——
    // 没有 htmlFor 就会得到一个没有任何可及名的勾选框，这条就是把那个陷阱钉住。
    render(
      <>
        <Checkbox id="c2" />
        <Label>没有 for 的文字</Label>
      </>,
    );
    expect(screen.getAllByRole('checkbox')[1]).toHaveAccessibleName('');
  });
});
