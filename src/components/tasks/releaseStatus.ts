import type { TaskItemStatus, TaskRunStatus } from '../../lib/types'

/**
 * 发布状态的字面量与色调。单独成文件是因为它是**界面文案与后端状态机的唯一对照表**：
 * 引擎（`tasks/runner.rs`）写的是 `preparing / ready / running / …`，运维熟悉的词是
 * 「待发布 / 发布中（等待生效）/ 成功 / 异常 / 失败 / 已取消」，两边只能在这里对一次。
 */
export const RUN_LABELS: Record<TaskRunStatus, string> = {
  preparing: '读取中',
  ready: '待发布',
  running: '发布中',
  cancelling: '正在取消',
  succeeded: '全部成功',
  partial: '部分成功',
  failed: '失败',
  cancelled: '已取消',
}

export const ITEM_LABELS: Record<TaskItemStatus, string> = {
  pending: '未读取',
  resolving: '读取中',
  ready: '待发布',
  publishing: '改镜像中',
  waiting: '等待生效',
  succeeded: '成功',
  failed: '失败',
  skipped: '已跳过',
}

type Tone = 'success' | 'warning' | 'danger' | 'muted'

export const RUN_TONES: Record<TaskRunStatus, Tone> = {
  preparing: 'warning',
  ready: 'warning',
  running: 'warning',
  cancelling: 'warning',
  succeeded: 'success',
  partial: 'danger',
  failed: 'danger',
  cancelled: 'muted',
}

export const ITEM_TONES: Record<TaskItemStatus, Tone> = {
  pending: 'muted',
  resolving: 'warning',
  ready: 'warning',
  publishing: 'warning',
  waiting: 'warning',
  succeeded: 'success',
  failed: 'danger',
  skipped: 'muted',
}

/** 一条运行还允许取消吗？`ready`（待发布）也算：停在待发布的一轮同样可以不发了。 */
export function runIsLive(status: TaskRunStatus | undefined): boolean {
  return runIsWorking(status) || status === 'ready'
}

/** 后台线程还在动吗？`ready` 不算——那是等人按发布的中间态，
 *  拿它挡住"重试失败项"会让人以为按钮坏了。 */
export function runIsWorking(status: TaskRunStatus | undefined): boolean {
  return status === 'preparing' || status === 'running' || status === 'cancelling'
}

/** 条目还在动吗？（`ready` 不算：那是等人按发布的中间态。） */
export function itemIsLive(status: TaskItemStatus): boolean {
  return status === 'resolving' || status === 'publishing' || status === 'waiting'
}

/** 尝试次数用完后界面要给的那句话：可执行的下一步，不是"不可用"。 */
export function attemptsExhausted(attempts: number, max: number): boolean {
  return attempts >= max
}
