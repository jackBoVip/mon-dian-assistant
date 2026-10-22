import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AUDIT_ACTION_LABELS, AUDIT_ENTITY_LABELS, auditActionLabel, auditEntityLabel, isOpaqueAuditId } from './auditLabels';

/**
 * 审计中文字典的契约守卫：**名单从 Rust 侧的调用点推导，不手写抽样**。
 *
 * 后端每条 `audit(...)` / `audit::record(...)` 的第 3、4 个实参就是写进 `audit_events` 的
 * `action` 与 `target_type`（`commands/mod.rs:33`、`audit/mod.rs:23` 的参数顺序）。
 * 这里把 `src-tauri/src` 下所有这类调用扫一遍，逐条要求字典里有中文名——
 * 后端加一条新动作而这里没登记，测试就红，而不是界面上冒出一行英文。
 *
 * `#[cfg(test)]` 之后的内容整段跳过：测试里写的动作不会进真实库。
 */

const ROOT = resolve(process.cwd());
const RUST_DIR = join(ROOT, 'src-tauri/src');

function rustFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) rustFiles(p, out);
    else if (name.endsWith('.rs')) out.push(p);
  }
  return out;
}

/** 从 `call(` 的左括号往后配平地扫到右括号，返回括号内的原文。 */
function balancedArgs(src: string, openIndex: number): string {
  let depth = 0;
  for (let i = openIndex; i < src.length; i += 1) {
    if (src[i] === '(') depth += 1;
    else if (src[i] === ')') {
      depth -= 1;
      if (depth === 0) return src.slice(openIndex + 1, i);
    }
  }
  return '';
}

/**
 * 只切掉 `#[cfg(test)] mod tests` 那一段。
 * 不能"从第一处 `#[cfg(test)]` 起全切"：本仓也有挂在单个辅助函数上的 `#[cfg(test)]`
 * （`commands/vault.rs:96`、`commands/rbac.rs:69`），那样一切就会把它们之后的真实审计调用点整片吞掉。
 */
function productionCode(src: string): string {
  const cut = /#\[cfg\(test\)\]\s*(?:#!\[[^\]]*\]\s*)?(?:pub(?:\([^)]*\))?\s+)?mod\s+tests/.exec(src);
  return cut ? src.slice(0, cut.index) : src;
}

function auditCallSites(): Array<{ action: string; targetType: string; where: string }> {
  const sites: Array<{ action: string; targetType: string; where: string }> = [];
  for (const file of rustFiles(RUST_DIR)) {
    const src = productionCode(readFileSync(file, 'utf8'));
    const rel = file.slice(ROOT.length + 1);
    for (const m of src.matchAll(/\b(?:audit|audit::record)\s*\(/g)) {
      const open = (m.index ?? 0) + m[0].length - 1;
      const args = balancedArgs(src, open);
      const literals = [...args.matchAll(/"([^"]*)"/g)].map((x) => x[1]);
      if (literals.length === 0) continue;
      const action = literals[0];
      if (!/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/.test(action)) continue;
      const line = src.slice(0, m.index).split('\n').length;
      sites.push({ action, targetType: /^[a-z_]+$/.test(literals[1] ?? '') ? literals[1] : '', where: `${rel}:${line}` });
    }
  }
  return sites;
}

const sites = auditCallSites();

describe('审计动作与对象类型：每一条后端调用点都有中文名', () => {
  it('确实扫到了后端调用点（防正则失配造成空转）', () => {
    expect(sites.length).toBeGreaterThanOrEqual(55);
    expect(new Set(sites.map((s) => s.action)).size).toBeGreaterThanOrEqual(55);
    // 四枚探针分处不同模块与不同写法：单行 / 多行 / `audit::record` / 挂在 `?` 之后的那条。
    // 少了任何一枚，说明扫描链某一环断了（尤其"把 `#[cfg(test)]` 之后整片切掉"这种过度截断）。
    for (const probe of ['auth.unlock', 'accounts.item.create', 'system.menu.rename', 'session.lock', 'system.role.delete']) {
      expect(sites.map((s) => s.action), `扫描结果里应当有 ${probe}`).toContain(probe);
    }
  });

  it('每个 action 都在字典里，且中文名不是英文标识本身', () => {
    const missing = sites.filter((s) => !(s.action in AUDIT_ACTION_LABELS));
    expect(missing, `后端写了、字典里没有的动作：${missing.map((s) => `${s.action}（${s.where}）`).join('、')}`).toEqual([]);
    const untranslated = Object.entries(AUDIT_ACTION_LABELS).filter(([, zh]) => zh === zh.toLowerCase() && /^[a-z.]+$/.test(zh));
    expect(untranslated, `这些动作的"中文名"还是英文标识：${untranslated.map(([k]) => k).join('、')}`).toEqual([]);
  });

  it('每个 target_type 都在字典里', () => {
    const used = [...new Set(sites.map((s) => s.targetType).filter(Boolean))];
    const missing = used.filter((t) => !(t in AUDIT_ENTITY_LABELS));
    expect(missing, `后端写了、字典里没有的对象类型：${missing.join('、')}`).toEqual([]);
  });

  it('字典不要求与后端逐字相等（旧记录仍要能翻），但每一项都得是短标签', () => {
    for (const [key, label] of Object.entries({ ...AUDIT_ACTION_LABELS, ...AUDIT_ENTITY_LABELS })) {
      expect(label.length, `${key} 的中文名过长`).toBeLessThanOrEqual(12);
      expect(label.trim(), `${key} 的中文名是空白`).not.toBe('');
    }
  });
});

describe('回落规则：查不到的键显示原标识，不显示空白', () => {
  it('未知动作与未知对象类型都原样返回', () => {
    expect(auditActionLabel('legacy.thing')).toBe('legacy.thing');
    expect(auditEntityLabel('legacy_thing')).toBe('legacy_thing');
  });

  it('已知键给出中文', () => {
    expect(auditActionLabel('auth.unlock')).toBe('解锁保险库');
    expect(auditActionLabel('system.menu.rename')).toBe('修改菜单名称');
    expect(auditEntityLabel('app_user')).toBe('使用者');
    expect(auditEntityLabel('menu_node')).toBe('菜单节点');
  });
});

describe('对象 id 的"只读不出信息"判据', () => {
  it('UUID 与带前缀的 UUID 一律算不透明（交付方：对象列那串不要）', () => {
    for (const id of [
      '01a1589a-701d-7260-882e-cab92f011ef1',
      '01a15899-daa1-74a8-8cfe-6a5076eebb95',
      'ci-01a15d44-1b2c-7e30-9a11-4b5c6d7e8f90',
      'r-01a15cc0-bb9a-7609-a2e1-2376a70c0208',
    ]) {
      expect(isOpaqueAuditId(id), `${id} 应当判为不透明`).toBe(true);
    }
  });

  it('可读标识不算不透明：文件名、菜单节点键、来源站点仍要上屏', () => {
    for (const id of [
      '蒙电台账-2026-10-22.json.enc',
      'mn-settings-backup',
      'https://oa.example.gov.cn',
      'u-legacy',
    ]) {
      expect(isOpaqueAuditId(id), `${id} 不该被判成不透明`).toBe(false);
    }
  });
});
