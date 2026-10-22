/**
 * 错误码 → 界面面板的稳定映射。
 * 前端不自行判定权限，只对后端返回的稳定错误码做呈现分流。
 * 未列出的错误码一律按普通错误提示处理（保留后端中文 message/detail）。
 */

export type AuthPanel = 'init' | 'login' | 'locked' | 'expired' | 'reauth' | 'unavailable';

/** 后端稳定错误码（error.rs AppError::code()）到认证面板的映射。 */
export const AUTH_PANEL_BY_CODE: Record<string, AuthPanel> = {
  VAULT_NOT_INITIALIZED: 'init',
  SESSION_LOCKED: 'locked',
  SESSION_EXPIRED: 'expired',
  REAUTH_REQUIRED: 'reauth',
  NOT_TAURI: 'unavailable',
};

/** 这些错误码不应清空当前面板，只在原地以文字提示后端 message。 */
export const INLINE_MESSAGE_CODES = new Set<string>([
  'TOO_MANY_ATTEMPTS',
  'WRONG_PASSWORD',
  'WEAK_PASSWORD',
  'NICKNAME_REQUIRED',
  'INVALID_INPUT',
  'KEYSTORE_UNAVAILABLE',
]);

export function panelForErrorCode(code: string | undefined | null): AuthPanel | null {
  if (!code) return null;
  return AUTH_PANEL_BY_CODE[code] ?? null;
}

export function isInlineMessageCode(code: string | undefined | null): boolean {
  if (!code) return false;
  return INLINE_MESSAGE_CODES.has(code);
}

export function needsReauthCode(code: string | undefined | null): boolean {
  return code === 'REAUTH_REQUIRED';
}

/**
 * 回收站（已删除凭据）入口是否应当整体隐藏。
 * 判定只依据后端错误码：FORBIDDEN = 后端按 accounts.delete 拒绝，普通使用者看不到该入口，
 * 也不该被"加载失败"打扰；会话级错误交给全局会话面板，入口同样不出现。
 * 其他错误码（如 DB_ERROR）说明是真实故障，必须就地呈现。前端绝不自行按角色猜权限。
 */
export function hidesTrashEntryCode(code: string | undefined | null): boolean {
  return code === 'FORBIDDEN' || panelForErrorCode(code) !== null;
}

/**
 * 启动失败页的分流说明。
 * 判定只依据后端给出的稳定字段（阶段），前端绝不猜原因、也不自行判定权限。
 * 三条修法都刻意不要求用户"删除数据目录"——那等于删掉保险库本身。
 */
export const BOOT_STAGE_PRESENTATION: Record<'data-dir' | 'device-key' | 'assembly', { title: string; hint: string }> = {
  'data-dir': {
    title: '数据目录不可用',
    hint: '先看看这个位置能不能写、磁盘是否还有剩余空间、当前系统账户对它有没有权限；理顺之后退出并重新打开应用就行。',
  },
  'device-key': {
    title: '取不到数据库密钥',
    hint:
      '系统安全存储里应有一条 com.mda.assistant / vault-db-key-v1。换过系统账户或重装过系统时它可能已经不在了。先把原来那把密钥找回原位——本包的备份容器也是用同一枚数据库密钥封装的，密钥没回来之前备份同样解不开，这一页也没有任何恢复入口；切勿删除数据目录。',
  },
  assembly: {
    title: '保险库没能打开',
    hint:
      '数据库密钥已经拿到了，只是建库或结构迁移没走完。迁移是逐条事务：失败的这一条整条回滚，已经提交的会保留，应用不会带着半套结构继续跑。按下面的错误码定位，再退出并重新打开应用；备份的恢复动作要等库能打开、并且解锁之后才做得到。',
  },
};

/** 少数错误码需要比阶段更具体的一句话；其余只按阶段说明。 */
export const BOOT_CODE_HINTS: Record<string, string> = {
  DEVICE_KEY_LOST_VAULT_INTACT:
    '保险库文件还在，只是暂时配不上一把能打开它的设备密钥。软件已经拒绝生成新密钥——换一把新密钥会让现有数据永久无法解密。唯一出路是把原来那把密钥找回原位：本包的备份容器用同一枚数据库密钥封装，密钥没回来时备份同样解不开，这一页也没有恢复入口。',
};

/** 失败页的标题与可执行说明：说明先按错误码，退回到阶段。未知阶段照实说"启动未完成"。 */
export function bootFailurePresentation(stage: string, code: string): { title: string; hint: string } {
  const base = stage === 'data-dir' || stage === 'device-key' || stage === 'assembly' ? BOOT_STAGE_PRESENTATION[stage] : null;
  const hint = BOOT_CODE_HINTS[code] ?? base?.hint ?? '';
  return { title: base?.title ?? '启动未完成', hint };
}

export interface NormalisedError {
  code: string;
  message: string;
  detail?: string;
}

/** 从未知抛出物中安全提取错误形状；绝不记录秘密，只保留错误码与面向用户的说明。 */
export function toNormalisedError(raw: unknown): NormalisedError {
  if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    const code = typeof o.code === 'string' ? o.code : 'UNKNOWN';
    const message = typeof o.message === 'string' ? o.message : '发生未预期的错误。';
    const detail = typeof o.detail === 'string' ? o.detail : undefined;
    return { code, message, detail };
  }
  if (typeof raw === 'string') {
    return { code: 'UNKNOWN', message: raw };
  }
  return { code: 'UNKNOWN', message: '发生未预期的错误，请查看应用日志中的错误码。' };
}
