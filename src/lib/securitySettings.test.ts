import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SETTING_GROUPS, SETTING_SPECS, parseBool } from './securitySettings';

/**
 * 设置项字典的契约守卫：**名单从后端白名单推导，不手写抽样**。
 *
 * `commands/system.rs::UPDATABLE_SETTINGS` 是本页唯一可写的键集；`BOOL_KEYS` 与
 * `numeric_ok` 那两段则决定后端认不认值。这里逐条比对，任何一侧加了键而另一侧没跟上，
 * 测试就红——免得上屏一行英文键名、或给一个后端会拒绝的数值配一颗开关。
 */

const ROOT = resolve(process.cwd());
const SYSTEM_RS = readFileSync(resolve(ROOT, 'src-tauri/src/commands/system.rs'), 'utf8');

/** 取 `const NAME ... = &[ ... ];` 这一段里的所有双引号字符串。 */
function stringListAfter(src: string, marker: string): string[] {
  const start = src.indexOf(marker);
  if (start < 0) throw new Error(`没找到 ${marker}`);
  const end = src.indexOf('];', start);
  if (end < 0) throw new Error(`${marker} 没有闭合`);
  return [...src.slice(start, end).matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

const whitelist = stringListAfter(SYSTEM_RS, 'const UPDATABLE_SETTINGS');
const boolKeys = stringListAfter(SYSTEM_RS, 'const BOOL_KEYS');

function numericKeys(): string[] {
  const start = SYSTEM_RS.indexOf('let numeric_ok = matches!(');
  if (start < 0) throw new Error('没找到 numeric_ok');
  const end = SYSTEM_RS.indexOf(');', start);
  return [...SYSTEM_RS.slice(start, end).matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

/** 内置下限与结果条数上限也要从代码里读：字典里写死的 10 / 50 不能自己漂。 */
function rustConst(file: string, name: string): number {
  const src = readFileSync(resolve(ROOT, `src-tauri/src/${file}`), 'utf8');
  const m = new RegExp(`const ${name}:\\s*(?:usize|i64)\\s*=\\s*(\\d+);`).exec(src);
  if (!m) throw new Error(`${file} 里没找到 ${name}`);
  return Number(m[1]);
}

const specs = new Map(SETTING_SPECS.map((spec) => [spec.key, spec]));

describe('设置项字典与后端白名单一一对应', () => {
  it('确实扫到了两段名单（防正则失配造成空转）', () => {
    expect(whitelist.length).toBeGreaterThanOrEqual(21);
    expect(boolKeys.length).toBeGreaterThanOrEqual(10);
    for (const probe of ['session_idle_timeout_minutes', 'extension_id', 'quick_launcher_fill_enabled']) {
      expect(whitelist).toContain(probe);
    }
    for (const probe of ['allow_insecure_protocols', 'quick_launcher_show_recent']) {
      expect(boolKeys).toContain(probe);
    }
  });

  it('白名单里的每个键都有中文名与控件，字典里也没有白名单外的键', () => {
    const missing = whitelist.filter((key) => !specs.has(key));
    expect(missing, `后端允许改、界面没登记的键：${missing.join('、')}`).toEqual([]);
    const extra = [...specs.keys()].filter((key) => !whitelist.includes(key));
    expect(extra, `界面登记了、后端不认的键：${extra.join('、')}`).toEqual([]);
    expect(new Set(whitelist).size, '白名单里有重复键').toBe(whitelist.length);
    expect(SETTING_SPECS.length, '字典里有重复键').toBe(new Set(SETTING_SPECS.map((s) => s.key)).size);
  });

  it('布尔键与开关严格互为同一集合（不靠"值是 true/false"猜）', () => {
    const switches = SETTING_SPECS.filter((s) => s.control.kind === 'switch').map((s) => s.key).sort();
    expect(switches).toEqual([...boolKeys].sort());
  });

  it('后端按整数校验的键都用数字控件，反之亦然', () => {
    const numbers = SETTING_SPECS.filter((s) => s.control.kind === 'number').map((s) => s.key).sort();
    expect(numbers).toEqual(numericKeys().sort());
  });

  it('三枚枚举 / 文本键的控件不能被误画成别的形态', () => {
    expect(specs.get('update_channel')?.control.kind).toBe('select');
    expect(specs.get('update_source_url')?.control.kind).toBe('text');
    expect(specs.get('extension_id')?.control.kind).toBe('text');
    expect(specs.get('quick_launcher_enabled')?.apply, '全局唤起必须走注册快捷键的命令').toBe('launcher-toggle');
    const others = SETTING_SPECS.filter((s) => s.key !== 'quick_launcher_enabled' && s.apply !== undefined);
    expect(others.map((s) => s.key)).toEqual([]);
  });

  it('数值上下限与后端夹紧口径同源，中文名不含英文键名', () => {
    const minLength = specs.get('master_password_min_length');
    if (minLength?.control.kind !== 'number') throw new Error('最小长度应是数字控件');
    expect(minLength.control.min).toBe(rustConst('auth/policy.rs', 'MIN_LENGTH'));
    expect(minLength.control.max).toBe(rustConst('auth/policy.rs', 'MAX_CONFIGURED_MIN_LENGTH'));

    const limit = specs.get('quick_launcher_result_limit');
    if (limit?.control.kind !== 'number') throw new Error('结果条数应是数字控件');
    expect(limit.control.max).toBe(rustConst('commands/launcher.rs', 'SEARCH_LIMIT'));

    for (const spec of SETTING_SPECS) {
      expect(spec.label.trim(), spec.key).not.toBe('');
      expect(spec.hint.trim(), spec.key).not.toBe('');
      expect(spec.label, `${spec.key} 的中文名里还有英文键名`).not.toContain(spec.key);
      expect(spec.label, `${spec.key} 的中文名像英文标识`).not.toMatch(/^[a-z_.]+$/);
    }
  });

  it('四组都有内容，且组顺序固定', () => {
    expect(SETTING_GROUPS.map((g) => g.id)).toEqual(['session', 'secret', 'network', 'launcher']);
    for (const group of SETTING_GROUPS) {
      expect(
        SETTING_SPECS.filter((s) => s.group === group.id).length,
        `${group.title} 是空组`,
      ).toBeGreaterThan(0);
    }
    const known = new Set(SETTING_GROUPS.map((g) => g.id));
    expect(SETTING_SPECS.filter((s) => !known.has(s.group)).map((s) => s.key)).toEqual([]);
  });

  it('取值解析只认字面 true，其它一律按关闭处理', () => {
    expect(parseBool('true')).toBe(true);
    for (const value of ['false', '', 'TRUE', '1', 'yes', undefined]) {
      expect(parseBool(value), String(value)).toBe(false);
    }
  });
});
