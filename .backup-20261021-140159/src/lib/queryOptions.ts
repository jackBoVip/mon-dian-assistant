import { queryOptions } from '@tanstack/react-query';
import { api } from './api';
import { queryKeys } from './queryClient';

/**
 * react-query 5 的 `queryOptions()` 工厂：只给**取数键与作废键会成对出现**的那两处用。
 *
 * 为什么不是全量替换：其余 `useQuery({ queryKey: queryKeys.x, queryFn })` 本来就取自
 * 同一张表，不存在漂移；工厂换上去只是把两行并成一行，改不到行为。真正出过问题的是
 * 这两处历史上写成内联字面量的——`['quickSearch', debounced]` 与作废整族的 `['quickSearch']`、
 * `['keystoreDiagnostics']` 与八个 `['targets']` 作废点，各写各的，改一边另一边静默失效。
 * 现在键、取数函数、类型三者锁在同一个返回值里，`useQuery(quickSearchOptions(...))` 拿到的
 * data 类型由工厂推出来，不再手写泛型。
 */

/** 空输入要不要发请求由调用方决定（防抖结果 + 「空输入显示最近使用」设置），工厂不替它决定。 */
export function quickSearchOptions(term: string, enabled: boolean) {
  return queryOptions({
    queryKey: queryKeys.quickSearch(term),
    queryFn: () => api.quickSearch(term),
    enabled,
  });
}

export function keystoreDiagnosticsOptions() {
  return queryOptions({
    queryKey: queryKeys.keystoreDiagnostics,
    queryFn: () => api.keystoreDiagnostics(),
  });
}
