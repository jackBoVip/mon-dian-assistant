import type { ReactNode } from 'react';
import { Button } from './Button';
import { Alert } from './alert';
import { toNormalisedError } from '../../lib/errors';

export function Loading({ label = '加载中…' }: { label?: string }) {
  return (
    <div className="empty-state" role="status" aria-live="polite">
      <span aria-hidden className="spinner" />
      <span>{label}</span>
    </div>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="empty-state" role="status">
      {children}
    </div>
  );
}

/** 后端错误的统一呈现：只展示后端中文 message/detail，不伪造数据。
 *  外壳换成 shadcn 的 Alert，但 `.empty-state .empty-state--alert` 两个挂载点原样保留——
 *  这两条规则在 `@layer mda` 里，优先级高于 Alert 自带的那几行工具类，所以几何一处没动。 */
export function ErrorState({ raw, onRetry }: { raw: unknown; onRetry?: () => void }) {
  const err = toNormalisedError(raw);
  return (
    <Alert variant="destructive" className="empty-state empty-state--alert" aria-live="assertive">
      <span className="badge badge-danger badge-status">错误 · {err.code}</span>
      <span>{err.message}</span>
      {err.detail ? <span className="text-xs text-ink-muted">{err.detail}</span> : null}
      {onRetry ? (
        <Button onClick={onRetry}>重试</Button>
      ) : null}
    </Alert>
  );
}

/** 浏览器预览（NOT_TAURI）：呈现后端给定的中文说明，绝不渲染假数据。 */
export function BackendUnavailable({ message, detail }: { message: string; detail?: string }) {
  return (
    <div className="mx-auto mt-16 max-w-md">
      <div className="panel panel-body text-center">
        <h1 className="mb-2 text-lg font-semibold">桌面后端不可用</h1>
        <p className="text-sm text-ink">{message}</p>
        {detail ? <p className="mt-2 text-xs text-ink-muted">{detail}</p> : null}
      </div>
    </div>
  );
}
