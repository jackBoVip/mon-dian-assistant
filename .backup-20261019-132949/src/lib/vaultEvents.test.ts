import { describe, it, expect, vi, beforeEach } from 'vitest';
import { subscribeVaultLocked } from './vaultEvents';

describe('subscribeVaultLocked', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('没有 Tauri 事件总线时静默降级，不抛异常也不触发回调', async () => {
    const handler = vi.fn();
    let dispose = () => {};
    expect(() => {
      dispose = subscribeVaultLocked(handler);
    }).not.toThrow();
    // 等动态 import 的微任务队列走完
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(handler).not.toHaveBeenCalled();
    expect(() => dispose()).not.toThrow();
  });

  it('订阅后立刻取消也不会泄漏（重复 dispose 安全）', async () => {
    const dispose = subscribeVaultLocked(() => {});
    dispose();
    expect(() => dispose()).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
  });
});
