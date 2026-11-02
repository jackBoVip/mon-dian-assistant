import { Badge } from '../ui/Badge'
import type { TaskRunItem } from '../../lib/types'
import { ITEM_LABELS, ITEM_TONES } from './releaseStatus'

/** `task_run_items` 的一行。列是固定的（服务名 / 目标镜像 / AppId / 线上变更时间 / 状态 / 尝试 / 说明），
 *  不做"可配置表头"：这几列就是发布这件事本身， configurable 只会让人不知道该看哪。 */
const COLUMNS = 'grid-cols-[minmax(9rem,1.2fr)_minmax(12rem,1.8fr)_minmax(7rem,1fr)_minmax(9rem,1fr)_5.5rem_3.5rem_minmax(10rem,1.4fr)]'

interface Props {
  items: TaskRunItem[]
  /** 尝试上限来自后端的任务定义；没读到就只显示次数，不显示分母。 */
  maxAttempts?: number
}

function stamp(value: string | null): string {
  if (!value) return '—'
  return value.replace('T', ' ').replace('+00:00', ' UTC')
}

export function ReleaseItemsTable({ items, maxAttempts }: Props) {
  return (
    <div className="min-w-0">
      <div
        className={`grid ${COLUMNS} gap-2 border-b border-line px-3 py-2 text-[11px] uppercase tracking-wide text-ink-muted`}
        role="presentation"
      >
        <span>服务名</span>
        <span>目标镜像</span>
        <span>AppId</span>
        <span>线上变更时间</span>
        <span>状态</span>
        <span>尝试</span>
        <span>说明</span>
      </div>
      {items.length === 0 ? (
        <p className="panel-notice">这一轮还没有条目。</p>
      ) : (
        <ul className="min-w-0">
          {items.map((item) => (
            <li
              key={item.id}
              className={`grid ${COLUMNS} items-center gap-2 border-b border-line px-3 py-2.5 text-xs transition-colors hover:bg-sunken ${item.status === 'failed' ? 'bg-sunken' : ''}`}
            >
              <span className="min-w-0 truncate font-semibold text-ink" title={item.itemKey}>
                {item.displayName ?? item.itemKey}
              </span>
              <span className="min-w-0 truncate text-ink-body" title={item.imageRef ?? ''}>
                {item.imageRef ?? '未读取'}
              </span>
              <span className="min-w-0 truncate text-ink-body" title={item.appId ?? ''}>
                {item.appId ?? '—'}
              </span>
              <span className="min-w-0 truncate tabular-nums text-ink-muted">{stamp(item.serviceUpdatedAt)}</span>
              <Badge tone={ITEM_TONES[item.status]}>{ITEM_LABELS[item.status]}</Badge>
              <span className="tabular-nums text-ink-muted">
                {item.attempts}
                {maxAttempts !== undefined ? <span className="text-ink-muted">/{maxAttempts}</span> : null}
              </span>
              <span className="min-w-0 truncate text-ink-muted" title={item.message ?? ''}>
                {item.message ?? (attemptsSpent(item.attempts, maxAttempts) ? '尝试次数已用完，请重新导入发布说明' : '—')}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function attemptsSpent(attempts: number, max: number | undefined): boolean {
  return max !== undefined && attempts >= max
}
