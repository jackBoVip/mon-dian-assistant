import { describe, expect, it } from 'vitest'
import {
  ITEM_LABELS,
  ITEM_TONES,
  RUN_LABELS,
  RUN_TONES,
  itemIsLive,
  runIsLive,
  runIsWorking,
} from './releaseStatus'
import type { TaskItemStatus, TaskRunStatus } from '../../lib/types'

/**
 * 状态字面量的对照守卫。`Record<…, string>` 已经在编译期要求"每个后端状态都有中文"，
 * 这里补的是**语义**那一半：中文名不许等于英文标识（那是没翻译），色调不许漏档，
 * 以及"还在跑"和"还能取消"这两档必须分开——把 ready 算成在跑会让重试按钮永远点不动。
 */
const RUN_STATUSES: TaskRunStatus[] = [
  'preparing',
  'ready',
  'running',
  'cancelling',
  'succeeded',
  'partial',
  'failed',
  'cancelled',
]

const ITEM_STATUSES: TaskItemStatus[] = [
  'pending',
  'resolving',
  'ready',
  'publishing',
  'waiting',
  'succeeded',
  'failed',
  'skipped',
]

describe('发布状态对照表', () => {
  it('八个运行状态都有中文与色调，且不是英文标识本身', () => {
    expect(Object.keys(RUN_LABELS).sort()).toEqual([...RUN_STATUSES].sort())
    for (const status of RUN_STATUSES) {
      expect(RUN_LABELS[status]).toBeTruthy()
      expect(RUN_LABELS[status]).not.toBe(status)
      expect(/^[a-z_]+$/.test(RUN_LABELS[status])).toBe(false)
      expect(RUN_TONES[status]).toBeTruthy()
    }
  })

  it('八个条目状态同样齐备', () => {
    expect(Object.keys(ITEM_LABELS).sort()).toEqual([...ITEM_STATUSES].sort())
    for (const status of ITEM_STATUSES) {
      expect(ITEM_LABELS[status]).not.toBe(status)
      expect(ITEM_TONES[status]).toBeTruthy()
    }
    expect(ITEM_LABELS.waiting).toBe('等待生效')
    expect(ITEM_TONES.failed).toBe('danger')
    expect(ITEM_TONES.succeeded).toBe('success')
  })

  it('「还在跑」与「还能取消」是两档：待发布可以被取消，但不算在跑', () => {
    expect(runIsWorking('preparing')).toBe(true)
    expect(runIsWorking('running')).toBe(true)
    expect(runIsWorking('cancelling')).toBe(true)
    expect(runIsWorking('ready')).toBe(false)
    expect(runIsWorking('succeeded')).toBe(false)
    expect(runIsWorking(undefined)).toBe(false)

    expect(runIsLive('ready')).toBe(true)
    expect(runIsLive('succeeded')).toBe(false)
    expect(runIsLive('cancelled')).toBe(false)
  })

  it('终态条目不算在动，中间态才算（页面靠它决定要不要提示"会自己更新"）', () => {
    expect(itemIsLive('resolving')).toBe(true)
    expect(itemIsLive('waiting')).toBe(true)
    expect(itemIsLive('ready')).toBe(false)
    expect(itemIsLive('succeeded')).toBe(false)
    expect(itemIsLive('failed')).toBe(false)
  })
})
