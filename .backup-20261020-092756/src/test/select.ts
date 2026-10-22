import { fireEvent, screen } from '@testing-library/react';
import { pointerTap } from './pointer';

/**
 * 与 Radix Select 交互的测试助手。
 *
 * 原生 <select> 那一套 API（el.options / el.value / fireEvent.change(el,{target:{value}})）
 * 在 Radix 上都不存在：触发钮是 <button>，选项只有展开后才进 DOM，选中发生在 pointerup。
 * 三个入口把"读选项 / 读当前值 / 选一项"重新落在可访问性语义上。
 *
 * 触发钮用 getByLabelText 定位（label→control 关联），不用 getByRole+name：
 * 按钮的可及名来自它自己的文字（当前选中值），按"角色=combobox 且 名字=字段标题"必然查不到。
 */

/** 按 label 找到控件本体。
 *  不用 getByRole('combobox', {name})：Radix 的触发钮是 <button>，而按钮的可及名来自
 *  它自己的文字（也就是当前选中值），<label htmlFor> 不会替按钮提供可及名——按角色+名字查必查不到。
 *  getByLabelText 走的是 label→control 关联，能正确落到触发钮上。 */
function triggerOf(label: string): HTMLElement {
  return screen.getByLabelText(label);
}

/**
 * 展开、读出全部选项文案。
 * 读完**不做关闭动作**：实测过，在 Radix Dialog 里读完后无论按 Escape 还是再点一次选项，
 * 都会把弹窗自己也关掉（body 直接空掉）或把测试进程拖住；而 RTL 的用例间 cleanup 本来就会
 * 卸载整棵树，留着展开状态不影响下一条用例。
 */
export function selectOptions(label: string): string[] {
  const trigger = triggerOf(label);
  // 幂等：已经展开就不再点（再点等于收起），这样调用方可以用 waitFor 轮询到异步选项到齐
  if (trigger.getAttribute('aria-expanded') !== 'true') pointerTap(trigger);
  return screen.getAllByRole('option').map((o) => (o.textContent ?? '').trim());
}

/** 收起仍然展开着的 Select。
 *  实测 Escape 打在浮层（role=listbox）上能干净关闭 Select。不关的话宿主弹窗会一直挂着
 *  aria-hidden（见 select.tsx 里那条未解决缺陷），按 role 查询会跳过这些隐藏节点，
 *  报出来就是"找不到某颗按钮"这种看着不相干的假故障。 */
export function closeSelect(): void {
  const listbox = screen.queryByRole('listbox');
  if (listbox) fireEvent.keyDown(listbox, { key: 'Escape' });
}

/** 触发钮当前显示的文字 = 选中项的标签。 */

export function selectValue(label: string): string {
  return (triggerOf(label).textContent ?? '').trim();
}

/** 选一项（optionName 支持字符串或正则）；选中即由 Radix 自己收起浮层。 */
export function chooseOption(label: string, optionName: string | RegExp): void {
  const trigger = triggerOf(label);
  if (trigger.getAttribute('aria-expanded') !== 'true') pointerTap(trigger);
  pointerTap(screen.getByRole('option', { name: optionName }));
}
