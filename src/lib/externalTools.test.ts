import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ENGINE_ALIASES,
  ENGINE_WRAPPERS,
  TOOL_KIND_WORD,
  TOOL_LIMITS,
  appPathIssue,
  engineIssue,
  isAbsolutePath,
  labelIssue,
  normalizeEngine,
  toolStatus,
} from './externalTools';

/**
 * 「外部工具」这层的契约守卫：**名单与上限从 Rust 源码推导，不手写第二份**。
 *
 * 引擎归一化有两条路都要走：写档时后端用它把用户填的引擎折成存库值，读档时又用它把台账里的
 * `protocol` 折成引擎名去查那一档。两侧一旦漂开，就会出现「这一页写着 mysql，账号点开来却是
 * 未配置」——而每一侧单独看都完全正确，只有同源核对才抓得住。
 */

const ROOT = resolve(process.cwd());
const RUST = readFileSync(resolve(ROOT, 'src-tauri/src/external_tools/mod.rs'), 'utf8');

function rustConst(name: string): number {
  const m = new RegExp(`pub const ${name}: usize = (\\d+);`).exec(RUST);
  if (!m) throw new Error(`${name} 在 Rust 侧找不到（改名或删掉了？那这条守卫要跟着改）`);
  return Number(m[1]);
}

/** 取 `pub fn normalize_engine` 那一段函数体。 */
function normalizeBody(): string {
  const start = RUST.indexOf('pub fn normalize_engine');
  if (start < 0) throw new Error('没找到 normalize_engine');
  const end = RUST.indexOf('\n}', start);
  if (end < 0) throw new Error('normalize_engine 没有闭合');
  return RUST.slice(start, end);
}

/** 把 `match` 那些 `"a" | "b" => "canon".to_string(),` 的分支折成 别名 → 标准名。 */
function rustAliasTable(): Record<string, string> {
  const body = normalizeBody();
  const out: Record<string, string> = {};
  for (const line of body.split('\n')) {
    const m = /^\s*((?:"[^"]+"\s*\|?\s*)+)=>\s*"([^"]+)"\.to_string\(\),\s*$/.exec(line);
    if (!m) continue;
    const canon = m[2];
    for (const alias of [...m[1].matchAll(/"([^"]+)"/g)]) out[alias[1]] = canon;
  }
  return out;
}

function rustSlotWords(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of RUST.matchAll(/Kind::(Browser|Terminal|Database) => "([^"]+)",/g)) {
    out[m[1].toLowerCase()] = m[2];
  }
  return out;
}

describe('引擎归一化两侧同源', () => {
  it('确实扫到了 Rust 那张别名表（扫不到就是写法变了，本条守卫要重写）', () => {
    const table = rustAliasTable();
    expect(Object.keys(table).length, '一条别名都没扫到').toBeGreaterThanOrEqual(13);
    expect(table.pg, 'pg 应折到 postgresql').toBe('postgresql');
    expect(table.mssql, 'mssql 应折到 sqlserver').toBe('sqlserver');
  });

  it('别名表逐条一致：后端多了、界面少了、名字不同，都算漂', () => {
    expect(ENGINE_ALIASES).toEqual(rustAliasTable());
  });

  it('驱动前缀那两枚两侧同一份，顺序也一致', () => {
    const m = /for wrapper in \[([^\]]+)\]/.exec(RUST);
    if (!m) throw new Error('没找到 normalize_engine 里的 wrapper 数组');
    const rust = [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
    expect([...ENGINE_WRAPPERS]).toEqual(rust);
  });

  it('归一化的行为与 Rust 的单测口径一致（同一条输入两侧同一个答案）', () => {
    for (const raw of ['MySQL', ' jdbc:MySQL://H:3306/db ', 'mysql://host', 'MYSQLX']) {
      expect(normalizeEngine(raw), raw).toBe('mysql');
    }
    for (const raw of ['PG', 'postgres', 'psql', 'postgresql', 'jdbc:postgresql://h/db', 'odbc:pg']) {
      expect(normalizeEngine(raw), raw).toBe('postgresql');
    }
    expect(normalizeEngine('jdbc:oracle:thin:@//h:1521/xe')).toBe('oracle');
    expect(normalizeEngine('MSSQL')).toBe('sqlserver');
    expect(normalizeEngine('dm'), '认不出的引擎原样保留').toBe('dm');
    expect(normalizeEngine('  ')).toBe('');
  });
});

describe('槽位名与上限两侧同源', () => {
  it('三档中文名叫法与 Rust Kind::slot_word() 一致', () => {
    expect(TOOL_KIND_WORD).toEqual(rustSlotWords());
  });

  it('长度上限取自 Rust 常量，不自己抄一份数', () => {
    expect(TOOL_LIMITS.engineMaxChars).toBe(rustConst('ENGINE_MAX_CHARS'));
    expect(TOOL_LIMITS.labelMaxChars).toBe(rustConst('LABEL_MAX_CHARS'));
    expect(TOOL_LIMITS.appPathMaxChars).toBe(rustConst('APP_PATH_MAX_CHARS'));
  });
});

describe('预校验与后端同一口径', () => {
  it('引擎：空、超限、非法字符都挡；合法的要给出归一化后的值', () => {
    expect(engineIssue('')).toContain('不能为空');
    expect(engineIssue('不合法 引擎')).toContain('小写字母');
    expect(engineIssue('x'.repeat(TOOL_LIMITS.engineMaxChars + 1))).toContain('最多');
    expect(engineIssue('JDBC:PostgreSQL')).toBeNull();
  });

  it('名称：只卡空与超限（与 Rust clean_label 同两条）', () => {
    expect(labelIssue('   ')).toBe('名称不能为空');
    expect(labelIssue('名'.repeat(TOOL_LIMITS.labelMaxChars + 1))).toContain('最多');
    expect(labelIssue('DBeaver（MySQL）')).toBeNull();
  });

  it('路径：空串是合法值（=清除），相对路径与控制字符都挡', () => {
    expect(appPathIssue('')).toBeNull();
    expect(appPathIssue('   ')).toBeNull();
    expect(appPathIssue('DBeaver')).toContain('绝对路径');
    expect(appPathIssue('../x.app')).toContain('绝对路径');
    expect(appPathIssue('/tmp/带\n换行')).toContain('控制字符');
    expect(appPathIssue('/a'.repeat(400))).toContain('最多');
  });

  it('绝对路径三端形状都认，相对一律不认', () => {
    for (const p of ['/Applications/DBeaver.app', 'C:\\Program Files\\x\\x.exe', '\\\\nas\\share\\x.exe']) {
      expect(isAbsolutePath(p), p).toBe(true);
    }
    for (const p of ['DBeaver', './x', 'Applications/DBeaver.app']) expect(isAbsolutePath(p), p).toBe(false);
  });

  /** 徽标那一格必须等于后端 plan_launch 的三态，否则界面说的和发生的是两件事。 */
  it('三态：未配置 / 已配置 / 路径已失效', () => {
    expect(toolStatus({ appPath: '', pathExists: false })).toEqual({ tone: 'muted', label: '未配置（用系统默认）' });
    expect(toolStatus({ appPath: '   ', pathExists: true }).label).toBe('未配置（用系统默认）');
    expect(toolStatus({ appPath: '/Applications/Chrome.app', pathExists: true })).toEqual({ tone: 'success', label: '已配置' });
    expect(toolStatus({ appPath: '/Applications/Chrome.app', pathExists: false }).tone).toBe('danger');
  });
});
