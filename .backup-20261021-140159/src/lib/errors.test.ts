import { describe, expect, it } from 'vitest';
import {
  BOOT_CODE_HINTS,
  BOOT_STAGE_PRESENTATION,
  bootFailurePresentation,
  hidesTrashEntryCode,
  isInlineMessageCode,
  needsReauthCode,
  panelForErrorCode,
  toNormalisedError,
} from './errors';

describe('panelForErrorCode', () => {
  it('会话错误码映射到对应面板（与 Rust error.rs code() 一致）', () => {
    expect(panelForErrorCode('SESSION_LOCKED')).toBe('locked');
    expect(panelForErrorCode('SESSION_EXPIRED')).toBe('expired');
    expect(panelForErrorCode('REAUTH_REQUIRED')).toBe('reauth');
    expect(panelForErrorCode('VAULT_NOT_INITIALIZED')).toBe('init');
    expect(panelForErrorCode('NOT_TAURI')).toBe('unavailable');
  });

  it('普通错误码不切换面板', () => {
    expect(panelForErrorCode('TOO_MANY_ATTEMPTS')).toBeNull();
    expect(panelForErrorCode('INVALID_INPUT')).toBeNull();
    expect(panelForErrorCode(undefined)).toBeNull();
    expect(panelForErrorCode(null)).toBeNull();
  });
});

describe('inline / reauth 判定', () => {
  it('TOO_MANY_ATTEMPTS 走内联提示而非面板', () => {
    expect(isInlineMessageCode('TOO_MANY_ATTEMPTS')).toBe(true);
    expect(panelForErrorCode('TOO_MANY_ATTEMPTS')).toBeNull();
  });

  it('REAUTH_REQUIRED 触发重认证', () => {
    expect(needsReauthCode('REAUTH_REQUIRED')).toBe(true);
    expect(needsReauthCode('SESSION_LOCKED')).toBe(false);
  });
});

describe('hidesTrashEntryCode（回收站入口的可见性）', () => {
  it('后端拒绝（FORBIDDEN）时入口消失，普通使用者不会被"报错"打扰', () => {
    expect(hidesTrashEntryCode('FORBIDDEN')).toBe(true);
    expect(hidesTrashEntryCode('SESSION_LOCKED')).toBe(true);
    expect(hidesTrashEntryCode('NOT_TAURI')).toBe(true);
  });

  it('真正的故障与会话无关的错误码仍要就地展示', () => {
    expect(hidesTrashEntryCode('DB_ERROR')).toBe(false);
    expect(hidesTrashEntryCode('NOT_FOUND')).toBe(false);
    expect(hidesTrashEntryCode(null)).toBe(false);
    expect(hidesTrashEntryCode(undefined)).toBe(false);
  });
});

describe('toNormalisedError', () => {
  it('提取 code/message/detail', () => {
    const e = toNormalisedError({ code: 'X', message: 'msg', detail: 'd' });
    expect(e).toEqual({ code: 'X', message: 'msg', detail: 'd' });
  });

  it('非对象抛出入 UNKNOWN 且不泄漏原始结构', () => {
    const e = toNormalisedError(new Error('boom'));
    expect(e.code).toBe('UNKNOWN');
    expect(typeof e.message).toBe('string');
  });

  it('字符串抛出入 message', () => {
    expect(toNormalisedError('直接文本').message).toBe('直接文本');
  });
});

describe('bootFailurePresentation（启动失败页的取词）', () => {
  it('三个阶段各自有标题与可执行说明，且互不相同', () => {
    const titles = Object.keys(BOOT_STAGE_PRESENTATION);
    expect(titles).toEqual(['data-dir', 'device-key', 'assembly']);
    for (const stage of titles) {
      const { title, hint } = bootFailurePresentation(stage, 'SOME_CODE');
      expect(title).toBe(BOOT_STAGE_PRESENTATION[stage as 'data-dir'].title);
      expect(hint.length).toBeGreaterThan(10);
    }
    expect(new Set(titles.map((s) => BOOT_STAGE_PRESENTATION[s as 'data-dir'].title)).size).toBe(3);
  });

  it('DEVICE_KEY_LOST_VAULT_INTACT 用比阶段更具体的一句话，并明说拒绝生成新密钥', () => {
    const { hint, title } = bootFailurePresentation('device-key', 'DEVICE_KEY_LOST_VAULT_INTACT');
    expect(title).toBe('取不到数据库密钥');
    expect(hint).toContain('拒绝生成新密钥');
    expect(hint).toContain('换一把新密钥会让现有数据永久无法解密');
    // 绝不给出"重置密钥即可继续"这类会造成永久丢数据的建议
    expect(hint).not.toMatch(/重新生成|重置密钥|删除密钥文件后/);
  });

  /**
   * 启动失败页不许承诺"从备份恢复"。
   * 依据：`.mdbak` 的封装密钥由数据库密钥派生（`backup.rs` 的 `backup_key(db_key, salt)`），
   * 而 `restore_backup` 要求已解锁会话 + 二次认证——装配没完成的这一页根本走不到那条命令。
   * 密钥丢失时备份同样解不开，所以任何一句"从备份恢复"都是假出路。
   */
  it('三个阶段与错误码说明里没有一处承诺"从备份恢复"，也不承诺本页做不到的恢复', () => {
    const allHints = [
      ...Object.values(BOOT_STAGE_PRESENTATION).map((v) => v.hint),
      ...Object.values(BOOT_CODE_HINTS),
    ];
    for (const hint of allHints) {
      expect(hint).not.toMatch(/从备份恢复|可用备份恢复/);
    }
    expect(BOOT_CODE_HINTS.DEVICE_KEY_LOST_VAULT_INTACT).toContain('备份同样解不开');
    expect(BOOT_STAGE_PRESENTATION['device-key'].hint).toContain('备份同样解不开');
    expect(BOOT_STAGE_PRESENTATION.assembly.hint).toContain('整条回滚');
  });

  it('认不出的阶段照实说"启动未完成"，不套用别的阶段标题', () => {
    expect(bootFailurePresentation('', 'X')).toEqual({ title: '启动未完成', hint: '' });
    expect(bootFailurePresentation('未来新增的阶段', 'X').title).toBe('启动未完成');
  });
});
