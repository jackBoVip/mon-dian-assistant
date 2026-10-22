import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REVEAL_SECONDS,
  displayMaskedUsername,
  isRevealActive,
  revealSecondsLeft,
  secretCell,
} from './mask';

describe('displayMaskedUsername', () => {
  it('直接展示后端脱敏值', () => {
    expect(displayMaskedUsername('zha***san')).toBe('zha***san');
  });
  it('缺失/空白时不伪造明文', () => {
    expect(displayMaskedUsername(null)).toBe('（无用户名）');
    expect(displayMaskedUsername('   ')).toBe('（空）');
  });
});

describe('secretCell', () => {
  it('未解锁一律掩码，绝不渲染明文', () => {
    expect(secretCell(null)).toBe('••••••');
    expect(secretCell('')).toBe('••••••');
  });
  it('显式解锁后展示后端返回值', () => {
    expect(secretCell('abc123')).toBe('abc123');
  });
});

describe('reveal 倒计时', () => {
  const now = 1_000_000;
  it('未过期时按向上取整返回剩余秒', () => {
    expect(revealSecondsLeft(now + 10_000, now)).toBe(10);
    expect(revealSecondsLeft(now + 10_001, now)).toBe(11);
  });
  it('过期或空返回 0 / false', () => {
    expect(revealSecondsLeft(now - 1, now)).toBe(0);
    expect(revealSecondsLeft(null, now)).toBe(0);
    expect(isRevealActive(now, now)).toBe(false);
    expect(isRevealActive(now + 1000, now)).toBe(true);
  });
  it('默认窗口保守且有限', () => {
    expect(DEFAULT_REVEAL_SECONDS).toBeGreaterThan(0);
    expect(DEFAULT_REVEAL_SECONDS).toBeLessThanOrEqual(30);
  });
});
