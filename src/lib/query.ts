/**
 * 快捷启动器查询串的纯解析工具。
 * 真正的多条件 AND 检索由 Rust 后端 `quick_search` 完成；
 * 这里只按同一套分隔/字段规则把输入拆成"条件"用于界面回显，绝不据此自行判定结果。
 */

/** 支持的条件分隔符：英文逗号与中文逗号。 */
export const CONDITION_SEPARATORS = [',', '，'] as const;

/** 字段限定词（含简短同义词），与需求 2.6.2 一致。 */
export const FIELD_QUALIFIERS = [
  '系统',
  '地址',
  '账号别名',
  '账号',
  '用户名',
  '类型',
  '标签',
] as const;

export type FieldQualifier = (typeof FIELD_QUALIFIERS)[number];

export interface ParsedCondition {
  /** 原始片段，已去首尾空格 */
  raw: string;
  /** 字段限定词，无前缀时为 null */
  field: FieldQualifier | null;
  /** 去掉字段前缀后的检索词 */
  term: string;
}

const QUALIFIER_SET = new Set<string>(FIELD_QUALIFIERS);

/** 按中英文逗号拆分，去空白、忽略空条件。 */
export function splitConditions(query: string): string[] {
  let work = query;
  for (const sep of CONDITION_SEPARATORS) {
    work = work.split(sep).join('\u0000');
  }
  return work
    .split('\u0000')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** 解析单个条件片段，识别 `字段:值` / `字段：值` 前缀。 */
export function parseCondition(raw: string): ParsedCondition {
  const colon = raw.search(/[:：]/);
  if (colon > 0) {
    const head = raw.slice(0, colon).trim();
    const tail = raw.slice(colon + 1).trim();
    if (QUALIFIER_SET.has(head) && tail.length > 0) {
      return { raw, field: head as FieldQualifier, term: tail };
    }
  }
  return { raw, field: null, term: raw };
}

/** 解析整条查询串为条件列表（AND 语义在界面呈现为多个条件）。 */
export function parseConditions(query: string): ParsedCondition[] {
  return splitConditions(query).map(parseCondition);
}

/** 是否存在有效条件（非空查询）。 */
export function hasConditions(query: string): boolean {
  return splitConditions(query).length > 0;
}

/** 条件回显文案，如 `地址 包含 10.0.0.22`。 */
export function formatCondition(c: ParsedCondition): string {
  return c.field ? `${c.field} 包含 ${c.term}` : `关键字 包含 ${c.term}`;
}

/** 多条件 AND 提示文案。 */
export function formatConditionsSummary(query: string): string | null {
  const list = parseConditions(query);
  if (list.length === 0) return null;
  if (list.length === 1) return formatCondition(list[0]);
  return `${list.length} 个条件全部命中（AND）：${list.map(formatCondition).join(' 且 ')}`;
}
