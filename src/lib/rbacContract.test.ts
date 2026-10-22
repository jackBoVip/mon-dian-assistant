import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PERM } from './permissions';

/**
 * 前后端契约的字面量守卫。清单由被检对象推导：
 * - 权限键从 `permissions.ts` 的 PERM 取，逐一在 Rust 的 `rbac::perm` 里找；
 * - 命令名从 `api.ts` 的每一个 `call('…')` 取，逐一在 `lib.rs` 的 invoke_handler 里找。
 * 另外反向钉住两条已被删除的旧命令：没有兼容壳，任何一侧回潮都会在这里红。
 */

const ROOT = resolve(process.cwd());
const API_PATH = join(ROOT, 'src/lib/api.ts');
const LIB_RS_PATH = join(ROOT, 'src-tauri/src/lib.rs');
const RBAC_RS_PATH = join(ROOT, 'src-tauri/src/rbac/mod.rs');
const VAULT_RS_PATH = join(ROOT, 'src-tauri/src/commands/vault.rs');

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

/** `call('name')` 与 `call<T>('name')` 两种写法都认。 */
function commandsFromApi(src: string): string[] {
  return [...src.matchAll(/\bcall(?:<[^>]*>)?\(\s*'([a-z0-9_]+)'/g)].map((m) => m[1]);
}

function rustPermissionValues(src: string): string[] {
  return [...src.matchAll(/pub const [A-Z_]+: &str = "([a-z._]+)";/g)].map((m) => m[1]);
}

function registeredCommands(src: string): string[] {
  const start = src.indexOf('invoke_handler');
  const end = src.indexOf(']', start);
  const block = src.slice(start, end === -1 ? undefined : end);
  return [...block.matchAll(/commands::[a-z_]+::([a-z0-9_]+)/g)].map((m) => m[1]);
}

describe('权限键：前端 PERM 与 Rust rbac::perm 同源', () => {
  const rustPerms = new Set(rustPermissionValues(read(RBAC_RS_PATH)));

  it('Rust 侧至少解析出了预期数量的权限常量（否则下面的逐项断言是空转）', () => {
    expect(rustPerms.size).toBeGreaterThanOrEqual(20);
  });

  it('前端登记的每一枚权限键都在 Rust 侧存在', () => {
    const missing = Object.values(PERM).filter((key) => !rustPerms.has(key));
    expect(missing, `前端有、Rust 没有的权限键：${missing.join('、')}`).toEqual([]);
  });

  it('Rust 侧所有 menu./system. 权限都在前端登记过（反向，防后端新增了前端不知道的键）', () => {
    const front = new Set<string>(Object.values(PERM));
    const missing = [...rustPerms]
      .filter((key) => key.startsWith('menu.') || key.startsWith('system.'))
      .filter((key) => !front.has(key));
    expect(missing, `Rust 有、前端没登记的权限键：${missing.join('、')}`).toEqual([]);
  });

  it('PERM 里没有重复值（重复会让同一枚键在导航与按钮上出现两次）', () => {
    const values = Object.values(PERM);
    expect(new Set(values).size).toBe(values.length);
  });
});

describe('命令名：api.ts 的每个 call 都在 invoke_handler 里注册', () => {
  const apiCommands = [...new Set(commandsFromApi(read(API_PATH)))];
  const registered = new Set(registeredCommands(read(LIB_RS_PATH)));

  it('两侧都解析出了足够多的条目（防正则失配造成的空转）', () => {
    expect(apiCommands.length).toBeGreaterThan(80);
    expect(registered.size).toBeGreaterThan(80);
  });

  it('没有前端调用、后端却没注册的命令', () => {
    const missing = apiCommands.filter((name) => !registered.has(name));
    expect(missing, `api.ts 调用但 lib.rs 未注册：${missing.join('、')}`).toEqual([]);
  });

  it('没有同一命令被注册两次', () => {
    const names = registeredCommands(read(LIB_RS_PATH));
    const dupes = names.filter((name, i) => names.indexOf(name) !== i);
    expect(dupes, `lib.rs 重复注册：${[...new Set(dupes)].join('、')}`).toEqual([]);
  });
});

describe('旧导航命令已彻底删除（不留兼容壳）', () => {
  const surfaces: Array<[string, string]> = [
    ['api.ts', read(API_PATH)],
    ['lib.rs', read(LIB_RS_PATH)],
    ['rbac/mod.rs', read(RBAC_RS_PATH)],
    ['commands/vault.rs', read(VAULT_RS_PATH)],
  ];

  for (const retired of ['assign_user_role', 'visible_menus']) {
    it(`${retired} 不出现在 ${surfaces.map(([name]) => name).join(' / ')} 里`, () => {
      for (const [name, src] of surfaces) {
        expect(src.includes(retired), `${name} 里仍有 ${retired}`).toBe(false);
      }
    });
  }
});
