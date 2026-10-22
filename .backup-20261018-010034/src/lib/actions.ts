import { api, ApiError } from './api';
import type { ActionReply } from './types';
import { notify } from '../state/notify';
import { toNormalisedError } from './errors';
import { useSession } from '../state/session';

/** 执行一个返回 ActionReply 的后端动作，原样回显 message；ok=false 用 warning 呈现。 */
export async function runReplyAction(
  fn: () => Promise<ActionReply>,
  opts: { onCandidates?: (reply: ActionReply) => void } = {},
): Promise<ActionReply | null> {
  try {
    const reply = await fn();
    notify(reply.ok ? 'success' : 'warning', reply.message);
    if (!reply.ok && reply.candidates && reply.candidates.length > 0) {
      opts.onCandidates?.(reply);
    }
    return reply;
  } catch (raw) {
    const err = toNormalisedError(raw);
    if (raw instanceof ApiError && (err.code === 'SESSION_LOCKED' || err.code === 'SESSION_EXPIRED' || err.code === 'REAUTH_REQUIRED')) {
      useSession.getState().applyAuthError(raw);
    } else {
      notify('danger', `${err.message}${err.detail ? `（${err.detail}）` : ''}`);
    }
    return null;
  }
}

export const openTarget = (targetId: string) => runReplyAction(() => api.openTarget(targetId));
export const openAndFill = (targetId: string, credentialId?: string) =>
  runReplyAction(() => api.openAndFill(targetId, credentialId));
export const copyUsername = (itemId: string) => runReplyAction(() => api.copyUsername(itemId));
export const copyPassword = (itemId: string) => runReplyAction(() => api.copyPassword(itemId));
export const connectTerminal = (itemId: string) => runReplyAction(() => api.connectTerminal(itemId));
