import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppStatus } from '../lib/types';

// 在导入 store 之前 mock Tauri invoke，避免真实 IPC。
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

import { invoke } from '@tauri-apps/api/core';
import { derivePhase, useSession } from './session';

const mockInvoke = vi.mocked(invoke);

function status(partial: Partial<AppStatus>): AppStatus {
  return {
    initialized: true,
    unlocked: false,
    userCount: 1,
    appUserId: 'u1',
    nickname: '张三',
    schemaVersion: 1,
    appVersion: '0.1.0',
    platform: 'darwin',
    arch: 'aarch64',
    ...partial,
  };
}

describe('derivePhase（纯状态转移）', () => {
  it('未初始化 → init', () => {
    expect(derivePhase({ status: status({ initialized: false }) })).toBe('init');
  });
  it('已初始化未解锁 → login', () => {
    expect(derivePhase({ status: status({ initialized: true, unlocked: false }) })).toBe('login');
  });
  it('已解锁 → unlocked', () => {
    expect(derivePhase({ status: status({ unlocked: true }) })).toBe('unlocked');
  });
  it('会话错误码优先于 status', () => {
    expect(derivePhase({ status: status({ unlocked: true }), errorCode: 'SESSION_EXPIRED' })).toBe('expired');
    expect(derivePhase({ status: status({ unlocked: true }), errorCode: 'REAUTH_REQUIRED' })).toBe('reauth');
    expect(derivePhase({ status: null, errorCode: 'NOT_TAURI' })).toBe('unavailable');
  });
  it('非会话错误码不改变面板', () => {
    expect(derivePhase({ status: status({ unlocked: true }), errorCode: 'INVALID_INPUT' })).toBe('unlocked');
  });
});

describe('useSession 异步动作（mock invoke）', () => {
  beforeEach(() => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    mockInvoke.mockReset();
    useSession.setState({
      status: null,
      profile: null,
      phase: 'boot',
      errorCode: null,
      errorMessage: null,
      errorDetail: null,
      pending: false,
    });
  });

  it('unlock 成功切到 unlocked', async () => {
    mockInvoke.mockResolvedValueOnce(status({ unlocked: true }));
    const ok = await useSession.getState().unlock('u1', 'pw');
    expect(ok).toBe(true);
    expect(useSession.getState().phase).toBe('unlocked');
  });

  it('unlock 遇 SESSION_LOCKED 切到 locked 面板并保留后端 message', async () => {
    mockInvoke.mockRejectedValueOnce({ code: 'SESSION_LOCKED', message: '连续失败过多，已锁定', detail: '稍后再试' });
    const ok = await useSession.getState().unlock('u1', 'bad');
    expect(ok).toBe(false);
    expect(useSession.getState().phase).toBe('locked');
    expect(useSession.getState().errorMessage).toBe('连续失败过多，已锁定');
    expect(useSession.getState().errorCode).toBe('SESSION_LOCKED');
  });

  it('TOO_MANY_ATTEMPTS 只内联提示、不切换面板', async () => {
    useSession.setState({ status: status({ unlocked: false }), phase: 'login' });
    mockInvoke.mockRejectedValueOnce({ code: 'TOO_MANY_ATTEMPTS', message: '尝试过多，请等待' });
    const ok = await useSession.getState().unlock('u1', 'bad');
    expect(ok).toBe(false);
    expect(useSession.getState().phase).toBe('login');
    expect(useSession.getState().errorMessage).toBe('尝试过多，请等待');
  });

  it('解锁失败后重新取一次 login_profile，界面上的次数不会停在旧值', async () => {
    useSession.setState({ status: status({ unlocked: false }), phase: 'login' });
    mockInvoke
      .mockRejectedValueOnce({ code: 'WRONG_PASSWORD', message: '主密码不正确' })
      .mockResolvedValueOnce({
        initialized: true,
        singleUser: true,
        users: [{ id: 'u1', nickname: '张三', internalCode: 'MDA-AAAA' }],
        lockout: { locked: false, failedCount: 2, secondsRemaining: 0, attemptsRemaining: 3 },
      });
    const ok = await useSession.getState().unlock('u1', 'bad');
    expect(ok).toBe(false);
    expect(mockInvoke).toHaveBeenCalledTimes(2);
    expect(mockInvoke.mock.calls[1]?.[0]).toBe('login_profile');
    // 刷新不能把后端的原始报错冲掉
    expect(useSession.getState().errorMessage).toBe('主密码不正确');
    expect(useSession.getState().profile?.lockout?.failedCount).toBe(2);
  });

  it('initialize 成功后进入 unlocked', async () => {
    mockInvoke.mockResolvedValueOnce(status({ initialized: true, unlocked: true }));
    const ok = await useSession.getState().initialize('李四', 'pw123456');
    expect(ok).toBe(true);
    expect(useSession.getState().phase).toBe('unlocked');
  });
});

describe('数据库主密钥降级的显式同意闸门（需求 §4.1）', () => {
  beforeEach(() => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    mockInvoke.mockReset();
    useSession.setState({
      status: null,
      profile: null,
      phase: 'boot',
      errorCode: null,
      errorMessage: null,
      errorDetail: null,
      pending: false,
      deviceKeyGate: null,
    });
  });

  /** 只放行表格里列出的命令：出现未列出的命令直接失败，用来证明"没有偷偷调用"。 */
  function allow(handlers: Record<string, (args?: Record<string, unknown>) => Promise<unknown>>) {
    mockInvoke.mockImplementation(((command: string, args?: Record<string, unknown>) => {
      const fn = handlers[command];
      if (!fn) return Promise.reject(new Error(`未预期的命令：${command}`));
      return fn(args);
    }) as never);
  }

  const cmds = () => mockInvoke.mock.calls.map((c) => String(c[0]));

  /** commands::system::ThemeView；闸门不需要时 bootstrap 会读它，这里给一份合法值。 */
  const themeView = { style: 'enterprise-blue', mode: 'system', glassIntensity: 60, reduceMotion: false };

  /** commands::boot::boot_failure_status 的"没失败"返回；bootstrap 第一条就是它，所以每段序列都以它开头。 */
  const bootOk = () => Promise.resolve({ failed: false, stage: '', code: '', message: '', dataDir: '' });

  it('启动装配失败时停在失败页，一条读库命令都不发（连闸门与外观都不问）', async () => {
    allow({
      boot_failure_status: () =>
        Promise.resolve({ failed: true, stage: 'device-key', code: 'DEVICE_KEY_LOST_VAULT_INTACT', message: '设备密钥丢失', dataDir: '/tmp/x' }),
      device_key_consent_status: () => Promise.reject(new Error('不该被调用')),
      get_theme: () => Promise.reject(new Error('不该被调用')),
      vault_status: () => Promise.reject(new Error('不该被调用')),
    });
    await useSession.getState().bootstrap();
    expect(useSession.getState().phase).toBe('bootFailed');
    expect(useSession.getState().bootFailure?.code).toBe('DEVICE_KEY_LOST_VAULT_INTACT');
    expect(cmds()).toEqual(['boot_failure_status']);
  });

  it('闸门 needed 时停在确认页，且不读取保险库状态（装配前 vault_status 不可用）', async () => {
    allow({
      boot_failure_status: bootOk,
      device_key_consent_status: () =>
        Promise.resolve({ needed: true, consent: 'none', reason: 'fresh', legacyBackend: 'macOS Keychain', keyFile: '' }),
      get_theme: () => Promise.resolve(themeView),
    });
    await useSession.getState().bootstrap();
    expect(useSession.getState().phase).toBe('deviceKeyConsent');
    expect(useSession.getState().deviceKeyGate?.consent).toBe('none');
    expect(useSession.getState().bootFailure).toBeNull();
    // 装配前一条读库命令都不许发：get_theme 落在未装配的共享状态上时，release 的 panic=abort 会把进程带走。
    expect(cmds()).toEqual(['boot_failure_status', 'device_key_consent_status']);
    expect(cmds()).not.toContain('vault_status');
    expect(cmds()).not.toContain('get_theme');
  });

  it('闸门不需要时照常读取状态，闸门信息被清空', async () => {
    allow({
      boot_failure_status: bootOk,
      device_key_consent_status: () =>
        Promise.resolve({ needed: false, consent: 'none', reason: 'fresh', legacyBackend: 'macOS Keychain', keyFile: '' }),
      get_theme: () => Promise.resolve(themeView),
      vault_status: () => Promise.resolve(status({ initialized: true, unlocked: false })),
    });
    await useSession.getState().bootstrap();
    expect(useSession.getState().phase).toBe('login');
    expect(useSession.getState().deviceKeyGate).toBeNull();
    // 顺序也是被测的东西：失败状态→闸门→外观→状态，一条都不能提前。
    expect(cmds()).toEqual(['boot_failure_status', 'device_key_consent_status', 'get_theme', 'vault_status', 'login_profile']);
  });

  it('同意后由后端写文件并装配：重新拉闸门→读取状态→进入主界面', async () => {
    let granted = false;
    allow({
      boot_failure_status: bootOk,
      device_key_consent_status: () =>
        Promise.resolve({
          needed: !granted,
          consent: granted ? 'consented' : 'none',
          reason: 'fresh',
          legacyBackend: 'macOS Keychain',
          keyFile: granted ? 'vault.device.key' : '',
        }),
      grant_device_key_fallback: () => {
        granted = true;
        return Promise.resolve(null);
      },
      get_theme: () => Promise.resolve(themeView),
      vault_status: () => Promise.resolve(status({ initialized: true, unlocked: true })),
    });
    await useSession.getState().bootstrap();
    expect(useSession.getState().phase).toBe('deviceKeyConsent');
    expect(granted).toBe(false);
    // 同意之前一条读库命令都不发（含 get_theme）
    expect(cmds()).toEqual(['boot_failure_status', 'device_key_consent_status']);

    const ok = await useSession.getState().grantDeviceKeyFallback();
    expect(ok).toBe(true);
    expect(granted).toBe(true);
    expect(useSession.getState().phase).toBe('unlocked');
    expect(useSession.getState().deviceKeyGate).toBeNull();
    // grantDeviceKeyFallback 会重跑一次 bootstrap，所以这条序列里失败状态问了两次
    expect(cmds().filter((c) => c === 'grant_device_key_fallback')).toHaveLength(1);
    expect(cmds().filter((c) => c === 'boot_failure_status')).toHaveLength(2);
    // 装配完成后才读外观，且只读一次
    expect(cmds().filter((c) => c === 'get_theme')).toHaveLength(1);
    expect(cmds().indexOf('get_theme')).toBeLessThan(cmds().lastIndexOf('vault_status'));
  });

  it('不同意落到本机文件：只调用退出命令，绝不触发写入密钥的授权命令', async () => {
    useSession.setState({ phase: 'deviceKeyConsent', deviceKeyGate: { needed: true, consent: 'none', reason: 'fresh', legacyBackend: 'KWallet', keyFile: '' } });
    allow({ decline_and_exit: () => Promise.resolve(null) });
    const ok = await useSession.getState().declineDeviceKeyFallback();
    expect(ok).toBe(true);
    expect(cmds()).toEqual(['decline_and_exit']);
    expect(cmds()).not.toContain('grant_device_key_fallback');
  });

  it('同意失败时留在确认页并原样显示后端消息，不伪造成功', async () => {
    useSession.setState({ phase: 'deviceKeyConsent', deviceKeyGate: { needed: true, consent: 'none', reason: 'fresh', legacyBackend: 'KWallet', keyFile: '' } });
    allow({
      grant_device_key_fallback: () => Promise.reject({ code: 'INTERNAL', message: '保险库装配失败，请查看本机日志' }),
    });
    const ok = await useSession.getState().grantDeviceKeyFallback();
    expect(ok).toBe(false);
    expect(useSession.getState().phase).toBe('deviceKeyConsent');
    expect(useSession.getState().errorMessage).toBe('保险库装配失败，请查看本机日志');
    expect(useSession.getState().pending).toBe(false);
  });
});
