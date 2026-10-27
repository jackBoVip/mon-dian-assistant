import type { BadgeTone } from '../components/ui/Badge';
import type { ExternalTool, ToolKind } from './types';

/**
 * 「外部工具」页的展示与预校验层。
 *
 * 引擎归一化这张表在后端有一份完全同形的实现（`src-tauri/src/external_tools/mod.rs::normalize_engine`），
 * 两边必须一字不差：写档时后端按它归一化存库，读档时后端又按它把台账里的 protocol 折成引擎名去查。
 * 任何一侧多一个别名或少一个别名，都会出现「界面说这条是 postgresql，账号却匹配不上」这种
 * 单看一侧永远看不出来的错。`externalTools.test.ts` 直接从 Rust 源码把分组扫出来逐条比对。
 *
 * 这里的校验只是**把红色提前到输入框**；真正说了算的是后端（它才知道本机文件系统长什么样）。
 */

/** 与 Rust 侧 `pub const *_MAX_*` 同源的上限。 */
export const TOOL_LIMITS = { engineMaxChars: 32, labelMaxChars: 40, appPathMaxChars: 500 } as const;

/** 槽位中文名：与 Rust `Kind::slot_word()` 同一份词，提示语与界面用词不会各说一套。 */
export const TOOL_KIND_WORD: Record<ToolKind, string> = {
  browser: '浏览器',
  terminal: '终端工具',
  database: '数据库工具',
};

export const ENGINE_ALIASES: Record<string, string> = {
  pg: 'postgresql',
  postgres: 'postgresql',
  psql: 'postgresql',
  postgresql: 'postgresql',
  mssql: 'sqlserver',
  sqlserver: 'sqlserver',
  maria: 'mariadb',
  mariadb: 'mariadb',
  mysql: 'mysql',
  mysqlx: 'mysql',
  oracle: 'oracle',
  oci: 'oracle',
  thin: 'oracle',
};

/** 连接串外面那层驱动前缀，剥掉才是引擎名。与 Rust `normalize_engine` 里那一枚数组同源。 */
export const ENGINE_WRAPPERS = ['jdbc:', 'odbc:'] as const;

/** `JDBC:PostgreSQL://h/db`、`psql`、`pg` 都折成同一枚 `postgresql`；认不出的原样保留（管理员自己建档用的就是原文）。 */
export function normalizeEngine(raw: string): string {
  let s = raw.trim().toLowerCase();
  for (const wrapper of ENGINE_WRAPPERS) {
    if (s.startsWith(wrapper)) s = s.slice(wrapper.length);
  }
  const head = s.split(/[:/?#]/)[0] ?? '';
  return ENGINE_ALIASES[head] ?? head;
}

/** 引擎标识：归一化后非空、不超限、只允许小写字母数字与 `_ - + .`。 */
export function engineIssue(raw: string): string | null {
  const engine = normalizeEngine(raw);
  if (!engine) return '引擎标识不能为空，例如 mysql、oracle、postgresql';
  if (engine.length > TOOL_LIMITS.engineMaxChars) return `引擎标识最多 ${TOOL_LIMITS.engineMaxChars} 位`;
  if (!/^[a-z0-9_+.-]+$/.test(engine)) return '引擎标识只能用小写字母、数字、下划线、连字符、加号或点';
  return null;
}

export function labelIssue(raw: string): string | null {
  const label = raw.trim();
  if (!label) return '名称不能为空';
  if (label.length > TOOL_LIMITS.labelMaxChars) return `名称最多 ${TOOL_LIMITS.labelMaxChars} 个字`;
  return null;
}

/// 三端绝对路径形状：POSIX 的 `/`、Windows 的盘符与 UNC 前缀。后端用 `Path::is_absolute` 判定，
/// 这里只为把提示提前；写法与后端不一致时以后端为准。
export function isAbsolutePath(raw: string): boolean {
  return /^\//.test(raw) || /^[A-Za-z]:[\\/]/.test(raw) || /^\\\\/.test(raw);
}

/** 空串是合法值（=清除=交系统默认），所以这条只在"填了但不成"时说话。 */
export function appPathIssue(raw: string): string | null {
  const path = raw.trim();
  if (!path) return null;
  if (path.length > TOOL_LIMITS.appPathMaxChars) return `应用路径最多 ${TOOL_LIMITS.appPathMaxChars} 个字符`;
  // 换行与控制字符会把一条路径变成两次注入的机会，后端同一口径再判一遍
  if (/[\u0000-\u001f\u007f]/.test(path)) return '应用路径不能包含控制字符或换行';
  if (!isAbsolutePath(path)) return '要填绝对路径，例如 /Applications/DBeaver.app 或 C:\\Program Files\\x\\x.exe';
  return null;
}

/** 这一行现在到底会用谁——文案必须与后端 `plan_launch` 的三态一一对应。 */
export function toolStatus(tool: Pick<ExternalTool, 'appPath' | 'pathExists'>): { tone: BadgeTone; label: string } {
  if (!tool.appPath.trim()) return { tone: 'muted', label: '未配置（用系统默认）' };
  if (tool.pathExists) return { tone: 'success', label: '已配置' };
  return { tone: 'danger', label: '路径已失效（将回退系统默认）' };
}

/** 固定两档按 kind 取；数据库档是清单，由调用方自己过滤。 */
export function fixedSlot(tools: ExternalTool[], kind: Extract<ToolKind, 'browser' | 'terminal'>): ExternalTool | undefined {
  return tools.find((tool) => tool.kind === kind);
}

export function databaseTools(tools: ExternalTool[]): ExternalTool[] {
  return tools.filter((tool) => tool.kind === 'database');
}
