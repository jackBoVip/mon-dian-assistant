/**
 * 掩码与秘密呈现的纯工具。
 * 列表/结果单元格永远只渲染后端下发的脱敏值；明文只在显式 revealSecret 后短暂存在。
 */

export const MASK_PLACEHOLDER = '••••••';

/** 后端已脱敏的用户名直接展示；缺失时以占位符表示"未提供"，绝不回退成明文猜测。 */
export function displayMaskedUsername(masked: string | null | undefined): string {
  if (masked === null || masked === undefined) return '（无用户名）';
  const trimmed = masked.trim();
  return trimmed.length > 0 ? trimmed : '（空）';
}

/** 秘密字段在未显式解锁前统一渲染为掩码。 */
export function secretCell(revealed: string | null | undefined): string {
  return revealed === null || revealed === undefined || revealed.length === 0 ? MASK_PLACEHOLDER : revealed;
}

/** 是否处于可见窗口内（倒计时未归零）。now 与 expiresAt 为毫秒时间戳。 */
export function isRevealActive(expiresAt: number | null, now: number): boolean {
  if (expiresAt === null) return false;
  return now < expiresAt;
}

/** 剩余可见秒数，向上取整且不小于 0。 */
export function revealSecondsLeft(expiresAt: number | null, now: number): number {
  if (expiresAt === null) return 0;
  const ms = expiresAt - now;
  if (ms <= 0) return 0;
  return Math.ceil(ms / 1000);
}

/** 默认明文可见时长（秒），后端未返回 visibleSeconds 时的保守回退。 */
export const DEFAULT_REVEAL_SECONDS = 15;
