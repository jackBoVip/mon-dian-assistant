import { create } from 'zustand';
import { api, ApiError } from '../lib/api';
import type { AppStatus, BootFailureStatus, DeviceKeyConsentStatus, LoginProfile } from '../lib/types';
import { panelForErrorCode, toNormalisedError } from '../lib/errors';
import { useTheme } from './theme';

/** 界面所处的认证阶段。所有分支都由后端 status()/loginProfile() 与错误码驱动，前端不自行判定权限。 */
export type SessionPhase =
  | 'boot'
  | 'bootFailed'
  | 'unavailable'
  | 'deviceKeyConsent'
  | 'init'
  | 'login'
  | 'locked'
  | 'expired'
  | 'reauth'
  | 'unlocked';

export interface SessionState {
  status: AppStatus | null;
  profile: LoginProfile | null;
  phase: SessionPhase;
  errorCode: string | null;
  errorMessage: string | null;
  errorDetail: string | null;
  pending: boolean;
  /** 系统安全存储不可用时的降级待确认信息；其余阶段为 null */
  deviceKeyGate: DeviceKeyConsentStatus | null;
  /** 启动装配失败信息（后端 BootFailure）；正常启动为 null */
  bootFailure: BootFailureStatus | null;

  bootstrap: () => Promise<void>;
  refreshProfile: () => Promise<void>;
  initialize: (nickname: string, password: string) => Promise<boolean>;
  unlock: (appUserId: string, password: string) => Promise<boolean>;
  reauthenticate: (password: string) => Promise<boolean>;
  /** 改自己的主密码：后端重封装 VK 后用新会话替换旧会话，返回新的 AppStatus。 */
  changeMasterPassword: (current: string, next: string) => Promise<boolean>;
  /** 改自己的昵称：后端只动显示名，返回带新昵称的 AppStatus，顶栏那两处（头像首字、下拉名字）随之更新。 */
  updateNickname: (nickname: string) => Promise<boolean>;
  /** 操作者显式同意"仅本机 0600 文件密钥"：后端这时才写密钥文件并装配保险库 */
  grantDeviceKeyFallback: () => Promise<boolean>;
  /** 操作者拒绝降级：后端不写任何文件并退出进程 */
  declineDeviceKeyFallback: () => Promise<boolean>;
  lock: () => Promise<void>;
  /** 后端主动广播的锁定（空闲超时、其它入口调用锁定）：界面立即回到解锁态 */
  markLocked: () => Promise<void>;
  clearError: () => void;
  /** 会话被后端判定为锁定/过期/需重认证时由全局拦截调用 */
  applyAuthError: (raw: unknown) => void;
}

/** 纯函数：由后端 status 与最近一次认证错误码推导当前阶段。可脱离 React 测试。
 *  deviceKeyConsent 与 bootFailed 不在此推导——两者都是 bootstrap 读到后端状态后单独设定的，
 *  因为这两种情况下库里没有可依据的 status。 */
export function derivePhase(input: { status: AppStatus | null; errorCode?: string | null }): SessionPhase {
  const panel = panelForErrorCode(input.errorCode ?? null);
  if (panel === 'unavailable') return 'unavailable';
  if (panel === 'locked') return 'locked';
  if (panel === 'expired') return 'expired';
  if (panel === 'reauth') return 'reauth';
  const s = input.status;
  if (!s) return 'boot';
  if (!s.initialized) return 'init';
  if (s.unlocked) return 'unlocked';
  return 'login';
}

const ERROR_FIELDS = {
  errorCode: null as string | null,
  errorMessage: null as string | null,
  errorDetail: null as string | null,
};

export const useSession = create<SessionState>((set, get) => ({
  status: null,
  profile: null,
  phase: 'boot',
  ...ERROR_FIELDS,
  pending: false,
  deviceKeyGate: null,
  bootFailure: null,

  bootstrap: async () => {
    set({ pending: true });
    try {
      // 第一条就问启动失败状态：装配失败时后端只挂了一条 BootFailure、共享状态根本没建起来，
      // 这时任何读库命令都落在未装配的句柄上（`core()` 在 release 的 panic=abort 下等于让进程自杀）。
      // 问到失败就只渲染失败页，连读库的 get_theme 都不发，只把本地默认外观刷上 DOM。
      const boot = await api.bootFailureStatus().catch(() => null);
      if (boot?.failed) {
        set({ bootFailure: boot, status: null, profile: null, phase: 'bootFailed', ...ERROR_FIELDS, pending: false });
        useTheme.getState().apply();
        return;
      }
      set({ bootFailure: null });
      // vault_status 等命令在数据库装配完成前不可用（Rust 侧还没有共享状态），
      // 所以接着问密钥闸门：本机还没有密钥文件时，必须由操作者显式同意才会写入任何字节。
      const gate = await api.deviceKeyConsentStatus().catch(() => null);
      if (gate?.needed) {
        set({
          deviceKeyGate: gate,
          status: null,
          profile: null,
          phase: 'deviceKeyConsent',
          ...ERROR_FIELDS,
          pending: false,
        });
        // 闸门阶段连数据库都没有，get_theme 无从应答（后端此时回 DEVICE_KEY_CONSENT_REQUIRED）。
        // 这里只把本地默认外观应用到 DOM，确认页照常渲染，不去发那条注定失败的请求。
        useTheme.getState().apply();
        return;
      }
      set({ deviceKeyGate: null });
      // 过了闸门才装配完成，外观与状态这两条读库命令这时才可用。
      // 顺序不能反：此前 App.tsx 把 loadTheme() 与 bootstrap() 并发发出去，全新库走到闸门分支时
      // get_theme 落在尚未装配的共享状态上，release 下 panic=abort 直接把进程带走（界面开不出来）。
      await useTheme.getState().load();
      const status = await api.status();
      set({ status, phase: derivePhase({ status, errorCode: null }), pending: false });
      if (status.initialized && !status.unlocked) {
        await get().refreshProfile();
      }
    } catch (raw) {
      const err = toNormalisedError(raw);
      const phase = derivePhase({ status: get().status, errorCode: err.code });
      set({ phase, errorCode: err.code, errorMessage: err.message, errorDetail: err.detail, pending: false });
    }
  },

  refreshProfile: async () => {
    try {
      const profile = await api.loginProfile();
      set({ profile });
    } catch (raw) {
      get().applyAuthError(raw);
    }
  },

  initialize: async (nickname, password) => {
    set({ pending: true, ...ERROR_FIELDS });
    try {
      const status = await api.initialize(nickname, password);
      set({ status, phase: derivePhase({ status, errorCode: null }), pending: false });
      return true;
    } catch (raw) {
      get().applyAuthError(raw);
      set({ pending: false });
      return false;
    }
  },

  unlock: async (appUserId, password) => {
    set({ pending: true, ...ERROR_FIELDS });
    try {
      const status = await api.unlock(appUserId, password);
      set({ status, phase: derivePhase({ status, errorCode: null }), pending: false });
      return true;
    } catch (raw) {
      get().applyAuthError(raw);
      set({ pending: false });
      // 失败次数与剩余锁定时间由后端记账：不重新取一次 loginProfile，
      // 解锁页那句"刚才 N 次没对上，还剩 M 次"会停在进入本页时的旧值。
      await get().refreshProfile();
      return false;
    }
  },

  reauthenticate: async (password) => {
    set({ pending: true, ...ERROR_FIELDS });
    try {
      await api.reauthenticate(password);
      const status = await api.status();
      set({ status, phase: derivePhase({ status, errorCode: null }), pending: false });
      return true;
    } catch (raw) {
      get().applyAuthError(raw);
      set({ pending: false });
      return false;
    }
  },

  changeMasterPassword: async (current, next) => {
    set({ pending: true, ...ERROR_FIELDS });
    try {
      const status = await api.changeMasterPassword(current, next);
      set({ status, phase: derivePhase({ status, errorCode: null }), pending: false });
      return true;
    } catch (raw) {
      // 后端在换密钥失败时会自行 lock_down：这里不猜状态，按错误码走统一的会话分支。
      get().applyAuthError(raw);
      set({ pending: false });
      return false;
    }
  },

  updateNickname: async (nickname) => {
    set({ pending: true, ...ERROR_FIELDS });
    try {
      const status = await api.updateOwnNickname(nickname);
      set({ status, phase: derivePhase({ status, errorCode: null }), pending: false });
      return true;
    } catch (raw) {
      // 失败不改昵称也不改阶段：界面按错误码显示，会话状态停在原值。
      get().applyAuthError(raw);
      set({ pending: false });
      return false;
    }
  },

  grantDeviceKeyFallback: async () => {
    set({ pending: true, ...ERROR_FIELDS });
    try {
      // 只有这条路径会让 Rust 写入 vault.device.key：界面已拿到操作者的明确选择。
      await api.grantDeviceKeyFallback();
      set({ deviceKeyGate: null, pending: false });
      await get().bootstrap();
      return get().phase !== 'deviceKeyConsent';
    } catch (raw) {
      // 非会话类错误码不会改阶段：确认页留在原地并显示后端原始消息，绝不伪造成功。
      get().applyAuthError(raw);
      set({ pending: false });
      return false;
    }
  },

  declineDeviceKeyFallback: async () => {
    set({ pending: true, ...ERROR_FIELDS });
    try {
      // 后端不写任何密钥文件，记录一条拒绝日志后退出进程。
      await api.declineDeviceKeyAndExit();
      set({ pending: false });
      return true;
    } catch (raw) {
      get().applyAuthError(raw);
      set({ pending: false });
      return false;
    }
  },

  lock: async () => {
    try {
      await api.lock();
    } catch {
      /* 锁定失败不改变前端呈现，下面统一按未解锁处理 */
    }
    const cur = get().status;
    set({ status: cur ? { ...cur, unlocked: false } : null, profile: null, phase: 'login', ...ERROR_FIELDS });
    await get().refreshProfile();
  },

  markLocked: async () => {
    // 不重复调用后端：这是后端广播的事实。前端只负责把界面从"已解锁"降级，
    // 并把上一次解密出来的视图缓存丢在调用方（queryClient.clear()）处理。
    const cur = get().status;
    set({ status: cur ? { ...cur, unlocked: false } : null, profile: null, phase: 'login', ...ERROR_FIELDS });
    await get().refreshProfile();
  },

  clearError: () => set({ ...ERROR_FIELDS, phase: derivePhase({ status: get().status, errorCode: null }) }),

  applyAuthError: (raw) => {
    const err = toNormalisedError(raw);
    const isAuth = panelForErrorCode(err.code) !== null;
    if (!isAuth) {
      set({ errorCode: err.code, errorMessage: err.message, errorDetail: err.detail });
      return;
    }
    const phase = derivePhase({ status: get().status, errorCode: err.code });
    set({ phase, errorCode: err.code, errorMessage: err.message, errorDetail: err.detail });
  },
}));

/** 供非组件代码判断某 ApiError 是否应触发会话面板切换。 */
export function isSessionError(err: unknown): err is ApiError {
  return err instanceof ApiError && panelForErrorCode(err.code) !== null;
}
