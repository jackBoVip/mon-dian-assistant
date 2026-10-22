import { Select } from '../ui/select';
import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import type { SecretField } from '../../lib/types';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { notify } from '../../state/notify';
import { toNormalisedError } from '../../lib/errors';
import { revealSecondsLeft } from '../../lib/mask';

const FIELD_LABELS: Record<SecretField, string> = {
  password: '密码',
  token: '令牌',
  private_key: '私钥',
  passphrase: '口令',
};

export interface RevealFieldProps {
  itemId: string;
  /** 来自后端 ItemView 的存在性标志；无对应秘密的字段不提供入口 */
  has: { password: boolean; token: boolean; privateKey: boolean };
}

/**
 * 查看明文：显式动作后短暂展示，倒计时结束自动隐藏并清除内存。
 * 倒计时窗口使用后端 reveal_secret 返回的 visibleSeconds（secret_visible_seconds 设置），
 * 前端不自行放宽；切换条目/字段立即清除。
 */
export function RevealField({ itemId, has }: RevealFieldProps) {
  const options: SecretField[] = [
    ...(has.password ? (['password'] as SecretField[]) : []),
    ...(has.token ? (['token'] as SecretField[]) : []),
    ...(has.privateKey ? (['private_key'] as SecretField[]) : []),
  ];
  const [field, setField] = useState<SecretField | null>(options[0] ?? null);
  const [value, setValue] = useState<string | null>(null);
  const [left, setLeft] = useState(0);
  const [busy, setBusy] = useState(false);
  const timer = useRef<number | null>(null);
  /** reveal 请求世代：每次清空/切换都推进，迟到的响应对不上号就整份丢掉。 */
  const reqSeq = useRef(0);

  function clear() {
    // 让**在途**的那次 reveal 一并作废：不递增世代的话，用户切了字段/条目之后
    // 旧请求返回，会把上一条秘密写进新的那一格并重新起表（审查 F6）。
    reqSeq.current += 1;
    setValue(null);
    setLeft(0);
    if (timer.current) {
      window.clearInterval(timer.current);
      timer.current = null;
    }
  }

  useEffect(() => () => clear(), []);
  // 切换字段/条目时清除上一次明文
  useEffect(() => clear(), [itemId, field]);

  const activeField = field !== null && options.includes(field) ? field : options[0] ?? null;

  async function reveal() {
    if (!activeField) return;
    const seq = ++reqSeq.current;
    const fieldForThisRequest = activeField;
    setBusy(true);
    try {
      const res = await api.revealSecret(itemId, fieldForThisRequest);
      if (seq !== reqSeq.current) return; // 等待期间被切换或清空过：这一份不再上屏
      setValue(res.value);
      const seconds = Math.max(1, Math.floor(res.visibleSeconds));
      const until = Date.now() + seconds * 1000;
      setLeft(seconds);
      if (timer.current) window.clearInterval(timer.current);
      timer.current = window.setInterval(() => {
        const s = revealSecondsLeft(until, Date.now());
        setLeft(s);
        if (s <= 0) clear();
      }, 500);
    } catch (raw) {
      if (seq !== reqSeq.current) return;
      const err = toNormalisedError(raw);
      if (raw instanceof ApiError && (err.code === 'REAUTH_REQUIRED' || err.code === 'SESSION_LOCKED' || err.code === 'SESSION_EXPIRED')) {
        // 交由全局会话面板处理
        notify('warning', err.message);
      } else {
        notify('danger', err.message);
      }
      clear();
    } finally {
      if (seq === reqSeq.current) setBusy(false);
    }
  }

  if (options.length === 0) {
    return <p className="text-xs text-ink-muted">该账号未保存可揭示的秘密字段。</p>;
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <label className="text-xs text-ink-muted" htmlFor={`rf-${itemId}`}>
        字段
      </label>
      <Select
        id={`rf-${itemId}`}
        className="select-auto"
        value={activeField ?? options[0]}
        onValueChange={(v) => setField(v as SecretField)}
        options={options.map((f) => ({ value: f, label: FIELD_LABELS[f] }))}
      />

      {value === null ? (
        <Button variant="ghost" onClick={() => void reveal()} disabled={busy}>
          <Icon name="eye" size={14} />
          查看明文
        </Button>
      ) : (
        <span className="mono flex items-center gap-2 rounded-sm border border-line-strong px-2 py-1 text-sm">
          {value}
          <span className="num text-xs text-ink-muted" aria-live="polite">
            {left}s 后自动隐藏
          </span>
          <Button variant="ghost" aria-label="立即隐藏" onClick={clear}>
            <Icon name="eyeOff" size={14} />
            隐藏
          </Button>
        </span>
      )}
    </div>
  );
}
