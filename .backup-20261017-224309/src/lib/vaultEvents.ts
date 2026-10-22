import { useEffect, useRef } from 'react';

/**
 * 订阅任意后端广播事件。非 Tauri 环境（vitest/jsdom、纯浏览器预览）没有事件总线：
 * 静默降级，绝不因为缺少 IPC 就中断渲染或抛出未捕获异常。
 */
export function subscribeBackendEvent(name: string, handler: () => void): () => void {
  let disposed = false;
  let unlisten: (() => void) | null = null;
  void import('@tauri-apps/api/event')
    .then(({ listen }) => listen(name, () => { if (!disposed) handler(); }))
    .then((u) => {
      unlisten = u;
      if (disposed) u();
    })
    .catch(() => {
      /* 无 Tauri 事件总线：保持静默 */
    });
  return () => {
    disposed = true;
    unlisten?.();
  };
}

/**
 * 订阅后端「保险库已进入锁定态」广播（空闲超时或任一处触发锁定）。
 * 事件只带时间戳，不含任何数据；前端的职责是把界面从已解锁视图降级回解锁页，
 * 并丢弃缓存里上一次解密出来的内容。
 */
export function subscribeVaultLocked(handler: () => void): () => void {
  return subscribeBackendEvent('vault://locked', handler);
}

/** 组件内订阅：handler 每次渲染换引用也不会重复订阅。 */
export function useVaultLocked(handler: () => void): void {
  const ref = useRef(handler);
  useEffect(() => {
    ref.current = handler;
  }, [handler]);
  useEffect(() => subscribeVaultLocked(() => ref.current()), []);
}

/** 浮层是隐藏而非销毁：每次被快捷键唤起时重新读设置并聚焦，管理员改过的开关不必等重启。 */
export function useBackendEvent(name: string, handler: () => void): void {
  const ref = useRef(handler);
  useEffect(() => {
    ref.current = handler;
  }, [handler]);
  useEffect(() => subscribeBackendEvent(name, () => ref.current()), [name]);
}
