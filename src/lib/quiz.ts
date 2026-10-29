import type { SelectOption } from '../components/ui/select'
import type { QuizImportJob, QuizOption, QuizQType } from './types'

/**
 * 题库领域的中文词表。题型与问题码的真源在 `src-tauri/src/quiz/`：
 *  - 题型字符串与 `quiz_questions.qtype` 的 CHECK 约束一致；
 *  - 问题码由解析层写入 `issues_json`，这里只负责翻译。
 * 表里没有的值一律回退原串——后端新增一枚码时界面显示英文码，而不是空白。
 */
export const QTYPE_LABELS: Record<QuizQType, string> = {
  single: '单选',
  multiple: '多选',
  true_false: '判断',
  fill_blank: '填空',
}

export function qtypeLabel(raw: string): string {
  return QTYPE_LABELS[raw as QuizQType] ?? raw
}

/** 复核表里的题型下拉与批量改题型共用这张表。 */
export const QTYPE_OPTIONS: SelectOption[] = (
  Object.keys(QTYPE_LABELS) as QuizQType[]
).map((value) => ({ value, label: QTYPE_LABELS[value] }))

export const FORMAT_LABELS: Record<string, string> = {
  docx: 'Word',
  txt: 'TXT',
  xlsx: 'Excel',
  csv: 'CSV',
}

export function formatLabel(raw: string): string {
  return FORMAT_LABELS[raw] ?? raw
}

/** 解析层写入的问题码（见 parse/answer.rs 与 parse/mod.rs）。 */
export const ISSUE_LABELS: Record<string, string> = {
  missing_answer: '缺答案',
  option_gap: '选项不连续',
  duplicate_option_key: '选项键重复',
  answer_not_in_options: '答案不在选项里',
  stem_too_short: '题干过短',
  ambiguous_type: '题型不确定',
  blank_count_mismatch: '空位与答案数不符',
  duplicate_in_file: '文内重复',
}

export function issueLabel(code: string): string {
  return ISSUE_LABELS[code] ?? code
}

/** 复核表里"有问题"的判定与后端 `exclude_low_confidence` 的默认阈值不是同一回事：
 *  这里只决定要不要在行尾摆一条提示，是否排除由用户点批量按钮。 */
export function hasIssues(row: { issues: string[] }): boolean {
  return row.issues.length > 0
}

/** 解析置信度 → 百分比串。后端 clamp 在 [0.01, 1]，这里不猜、不补零。 */
export function confidencePercent(confidence: number): string {
  return `${Math.round(confidence * 100)}%`
}

/** 置信度配色：低于解析层的 0.6 记警告，低于 0.4 记危险（与 `CONFIDENCE_LOW` 同值）。 */
export function confidenceTone(confidence: number): 'success' | 'warning' | 'danger' {
  if (confidence < 0.4) return 'danger'
  if (confidence < 0.6) return 'warning'
  return 'success'
}

export function jobStatusLabel(status: string): string {
  switch (status) {
    case 'review':
      return '待复核'
    case 'published':
      return '已发布'
    case 'discarded':
      return '已放弃'
    case 'failed':
      return '解析失败'
    default:
      return status
  }
}

export function jobStatusTone(status: string): 'success' | 'warning' | 'danger' | 'muted' {
  switch (status) {
    case 'published':
      return 'success'
    case 'review':
      return 'warning'
    case 'failed':
      return 'danger'
    default:
      return 'muted'
  }
}

/** 发布前的确认句只陈述后端会做什么：发布是单事务，任一行不合法就整体回滚。 */
export function publishHint(job: QuizImportJob): string {
  return `将把当前 ${job.includedRows} 道纳入的题目写入新题库；任一行不合法会整体回滚且不落任何题目。`
}

/** 选项拼成多行文本（编辑框的初值）。键与文本之间用「. 」对齐解析层的 `A. text` 习惯。 */
export function optionsToText(options: QuizOption[]): string {
  return options.map((o) => `${o.key}. ${o.text}`).join('\n')
}

/** 把编辑框里的多行文本还原成选项。认 `A. text` / `A、text` / `A) text`；不认的行忽略。 */
export function textToOptions(text: string): QuizOption[] {
  const out: QuizOption[] = []
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Ha-h])\s*[.、．)）:：]\s*(.+)$/.exec(line)
    if (m) out.push({ key: m[1].toUpperCase(), text: m[2].trim() })
  }
  return out
}

export function tagsToText(tags: string[]): string {
  return tags.join('、')
}

export function textToTags(text: string): string[] {
  return text
    .split(/[、,，;；\s]+/)
    .map((t) => t.trim())
    .filter(Boolean)
}
