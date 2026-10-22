import { useEffect, useRef } from 'react';
import { Toaster, toast } from 'sonner';
import { useNotify, type NotifyKind } from '../../state/notify';
import { Icon } from './Icon';
import type { IconName } from './icons';

/**
 * shadcn/ui 的 Toast（最新 shadcn 的 toast 就是 sonner）。替换掉手写的 ui/NotifyHost。
 *
 * 队列真源仍然是 `state/notify` 的 store，sonner 只做渲染：`notify()` 有 23 处调用点、
 * 多条"后端回了什么就播什么"的断言都读 store；若把真源交给 sonner，两边各持一份状态必然漂移。
 * 所以 store 新增一条就镜像给 sonner 一次（按 id 去重），sonner 关掉一条就回调移除 store 那条。
 * 计时器只有 sonner 一个主人——原实现里那个"每条挂一个 6s setTimeout"的 effect 随之删掉。
 *
 * 关键是 `unstyled`：sonner 注入的样式表**不带层**，而我们整套界面规则在 `@layer mda` 里，
 * 不带层 > 所有层，不关掉它的默认样式，`.toast` 那几档（padding 8/12、1px 边框、
 * --radius-md、内高光 + dropdown 阴影、13px 字号、`.toast::before` 之类）会被静默压住。
 * 用 unstyled 把样式权交回来，现有 CSS 原样命中，几何一行都不必重抄。
 */

const TONE: Record<NotifyKind, string> = {
  info: 'badge-muted',
  success: 'badge-success',
  warning: 'badge-warning',
  danger: 'badge-danger',
};

const KIND_ICON: Record<NotifyKind, IconName> = {
  info: 'info',
  success: 'check',
  warning: 'warning',
  danger: 'warning',
};

/** 我们那四档语气 → sonner 的四个入口。颜色不走它的 richColors（下面已关），只用来选语义位。 */
const ROUTE: Record<NotifyKind, 'message' | 'success' | 'warning' | 'error'> = {
  info: 'message',
  success: 'success',
  warning: 'warning',
  danger: 'error',
};

export function NotifyHost() {
  const items = useNotify((s) => s.items);
  const sent = useRef(new Set<number>());

  useEffect(() => {
    const live = new Set(items.map((i) => i.id));
    // store 被整体置空（测试里 setState({items:[]})）时，把已镜像出去的记录收掉，允许同 id 重来
    for (const id of [...sent.current]) if (!live.has(id)) sent.current.delete(id);

    for (const item of items) {
      if (sent.current.has(item.id)) continue;
      sent.current.add(item.id);
      toast[ROUTE[item.kind]](item.text, {
        id: item.id,
        duration: 6000,
        unstyled: true,
        // 原实现里点整条不会关掉它，只有那颗 X 能关；也没有滑动手势。
        // 注：sonner 2.0.8 没有 closeOnClick 这个选项，真正的开关是 dismissible。
        dismissible: false,
        className: `toast pointer-events-auto ${TONE[item.kind]}`,
        icon: <Icon name={KIND_ICON[item.kind]} size={16} className="mt-0.5 shrink-0" />,
        onDismiss: () => useNotify.getState().dismiss(item.id),
        onAutoClose: () => useNotify.getState().dismiss(item.id),
        // 原容器是 w-80（320px）；unstyled 之后宽度没人给了，这里显式钉回那一档
        style: { width: '320px' },
      });
    }
  }, [items]);

  return (
    <Toaster
      position="bottom-right"
      gap={8}
      offset={16}
      mobileOffset={16}
      visibleToasts={4}
      closeButton
      richColors={false}
      expand={false}
      duration={6000}
      icons={{
        info: <Icon name="info" size={16} />,
        success: <Icon name="check" size={16} />,
        warning: <Icon name="warning" size={16} />,
        error: <Icon name="warning" size={16} />,
      }}
      toastOptions={{
        unstyled: true,
        classNames: {
          // 关闭那颗沿用原来的类：22px 点击区、未悬停降到 0.75 透明、按压缩放
          closeButton: 'toast-dismiss hover:opacity-100',
        },
      }}
    />
  );
}
