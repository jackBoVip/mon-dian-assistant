import { Tabs as TabsPrimitive } from 'radix-ui';
import type { ComponentProps } from 'react';
import { cn } from '../../lib/utils';

/**
 * shadcn/ui Tabs（Radix），接的是数据页那两颗 `.chip-toggle`。
 *
 * 换件换的是**键盘与焦点语义**，不是外观：Radix 的 Trigger 本来就带 `role="tab"` 与
 * `aria-selected`，`.chip-toggle[aria-selected='true']` 那条挂载点照样命中，几何一字不动；
 * 补上来的是 radiogroup 式的 ←→/Home/End 切换与 roving tabindex——原来这两颗钮是
 * 两个独立 button 冒充 tab，`role=tablist` 却不发方向键，读屏用户走到这儿就断了。
 *
 * **不含 TabsPanel**：本应用两栏的内容是互斥渲染的（切走的那一侧整个不挂载，
 * 因此不会多发一次目标列表查询）。Radix 的 Panel 是留在 DOM 里加 `hidden`，
 * 换成它等于让导出面板在导入页时就悄悄发请求。面板那层仍由页面自己按状态渲染。
 */
export type TabsProps = ComponentProps<typeof TabsPrimitive.Root>;

/** 根节点走 `display: contents`：Radix 的 Root 是一层真 div，而页面外壳 `.page-panel`
 *  自己是 flex 列 + 16px 间距，多插一层盒子就会把标签行与主面板之间那格间距改掉。
 *  contents 让这层包装盒完全退出布局，两个子节点直接落在 `.page-panel` 的 flex 行上，
 *  间距与重构前逐像素相同。 */
export function Tabs({ className, ...rest }: TabsProps) {
  return <TabsPrimitive.Root className={cn('contents', className)} {...rest} />;
}

export type TabsListProps = ComponentProps<typeof TabsPrimitive.List>;

export function TabsList({ className, ...rest }: TabsListProps) {
  return <TabsPrimitive.List className={cn(className)} {...rest} />;
}

export type TabsTriggerProps = ComponentProps<typeof TabsPrimitive.Trigger>;

export function TabsTrigger({ className, ...rest }: TabsTriggerProps) {
  return <TabsPrimitive.Trigger className={cn('chip-toggle', className)} {...rest} />;
}
