import '@testing-library/jest-dom/vitest';

/**
 * Radix 的原语（DropdownMenu / Dialog / Select 的 Content）在挂载时会观察尺寸与书写方向，
 * 这两个 API jsdom 都没实现。不补的话报错只会是一句 `ResizeObserver is not defined`，
 * 看不出是谁要的、为什么要——所以在这里集中桩掉，并注明是哪条依赖的哪个行为。
 */
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver;
}

if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList;
}

/**
 * jsdom 没有实现 Pointer Capture 这组 API（不是只缺 ResizeObserver 那个老问题）。
 * Radix Select 在 pointerdown 里调 `target.hasPointerCapture(id)`，缺它就抛
 * `TypeError: target.hasPointerCapture is not a function`——而且它是在 React 的事件分发里抛的，
 * 冒出来是一条 Unhandled Error：测试全绿但进程 rc=1，整跑还会把 worker 挂住。
 * 真实浏览器里这组方法一直在，所以桩成"没有捕获"是这个环境下的正确回答。
 */
if (typeof Element !== 'undefined' && !Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
}

/**
 * jsdom 也没实现 scrollIntoView。Radix Select 挂载时会把"当前选中那一行"滚动到位，
 * 于是抛 `candidate?.scrollIntoView is not a function`——而且它是在组件渲染期抛的，
 * React 会把整棵树卸载：现象是查询说"找不到 label"、body 直接剩一个空 div，
 * 看起来像组件写错了，实际是环境缺一个方法。真实浏览器里这个方法一直在。
 */
if (typeof Element !== 'undefined' && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

