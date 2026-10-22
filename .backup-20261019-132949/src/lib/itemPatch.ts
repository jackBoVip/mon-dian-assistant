/**
 * 「编辑凭据」的最小补丁生成逻辑（纯函数，独立于组件以便单测）。
 *
 * 后端 commands::mod::UpdateItemInput 的线格式语义（camelCase + deny_unknown_fields）：
 *  - 键缺省（不出现在 JSON 里）＝ 保留已存值；
 *  - 键存在且为空串 ＝ 显式清空该字段；
 *  - 键存在且有值 ＝ 只替换该字段。
 * 秘密（密码/令牌/私钥/口令短语）永不回显，所以「留空」必须判定为不改动：只有用户显式点「清空已存值」才允许发出空串。
 * 非秘密载荷（用户名/备注/认证方式/浏览器提示/登录地址覆盖/填充前确认）由 item_detail 回显为基准；
 * 基准缺失（无权限或明细未加载）时这些字段退回"永不回显"的判定，避免读不到就写空。
 * 这里只做判定，不碰网络，也不碰 React。
 */
import type { UpdateItemPatch } from './types';

/**
 * 可作为比较基准的原值（item_detail 回显的非秘密字段）。
 * accountAlias / tags 一直有值；其余字段是"有则回显"：undefined 表示后端没给出（无查看秘密权限、
 * 或明细还没加载完），此时留空一律判定为不改动，绝不能当成清空。
 */
export interface ItemPatchBaseline {
  accountAlias: string;
  tags: string[];
  username?: string;
  note?: string;
  authMethod?: string;
  browserHint?: string;
  loginUrlOverride?: string;
  confirmBeforeFill?: boolean;
}

/** 填充前确认的三态：keep 表示用户不表态，因此该键不参与提交（即使后端已回显当前值）。 */
export type ConfirmBeforeFillChoice = 'keep' | 'required' | 'not_required';

/** 用户可以显式要求清空（发出空串）的非秘密字段。 */
export type ClearableField = 'username' | 'authMethod' | 'browserHint' | 'loginUrlOverride' | 'note';

/** 编辑表单的当前内容；字符串均已由调用方 trim（标签仍是输入框里的逗号串）。 */
export interface ItemPatchForm {
  accountAlias: string;
  username: string;
  authMethod: string;
  browserHint: string;
  loginUrlOverride: string;
  note: string;
  tags: string;
  confirmBeforeFill: ConfirmBeforeFillChoice;
  /** 新密码：空串＝不改动（除非 passwordCleared） */
  password: string;
  passwordCleared: boolean;
  cleared: readonly ClearableField[];
}

const FIELD_NAMES: Record<keyof UpdateItemPatch, string> = {
  accountAlias: '账号别名',
  username: '外部系统用户名',
  password: '已存密码',
  token: '令牌',
  privateKey: '私钥',
  passphrase: '口令短语',
  note: '备注',
  authMethod: '认证方式',
  browserHint: '浏览器提示',
  loginUrlOverride: '登录地址覆盖',
  confirmBeforeFill: '填充前确认',
  tags: '标签',
};

/** 逗号（中英文皆可）分隔的标签串 → 去空、去重、保序的数组。 */
export function parseTags(raw: string): string[] {
  const out: string[] = [];
  for (const part of raw.split(/[,，]/)) {
    const t = part.trim();
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

/**
 * 文本字段判定。
 * @param value    输入框当前值（已 trim）
 * @param initial  基准原值；undefined 表示基准缺失（无查看秘密权限或明细未加载），此时留空一律视为不改动
 * @param cleared  用户显式点击了「清空已存值」
 * @returns 需要发送的值，或 undefined 表示该键不出现在补丁里。
 */
export function diffTextField(value: string, initial: string | undefined, cleared: boolean): string | undefined {
  if (cleared) return '';
  // 无回显字段：留空只是"没动过"，绝不能当成"清空"发送
  if (initial === undefined) return value === '' ? undefined : value;
  return value === initial ? undefined : value;
}

/** 标签判定：与后端回显的数组逐项比较，改动才发送（清空全部标签 → 空数组）。 */
export function diffTagsField(raw: string, initial: string[]): string[] | undefined {
  const next = parseTags(raw);
  if (next.length === initial.length && next.every((t, i) => t === initial[i])) return undefined;
  return next;
}

/** 生成要发给 update_item 的最小补丁：未改动的键一律不出现，从而保住后端已存的秘密。 */
export function buildUpdateItemPatch(form: ItemPatchForm, baseline: ItemPatchBaseline): UpdateItemPatch {
  const patch: UpdateItemPatch = {};
  const cleared = (key: ClearableField) => form.cleared.includes(key);

  const alias = diffTextField(form.accountAlias, baseline.accountAlias, false);
  if (alias !== undefined) patch.accountAlias = alias;

  const username = diffTextField(form.username, baseline.username, cleared('username'));
  if (username !== undefined) patch.username = username;

  if (form.passwordCleared) patch.password = '';
  else if (form.password !== '') patch.password = form.password;

  const authMethod = diffTextField(form.authMethod, baseline.authMethod, cleared('authMethod'));
  if (authMethod !== undefined) patch.authMethod = authMethod;

  const browserHint = diffTextField(form.browserHint, baseline.browserHint, cleared('browserHint'));
  if (browserHint !== undefined) patch.browserHint = browserHint;

  const loginUrl = diffTextField(form.loginUrlOverride, baseline.loginUrlOverride, cleared('loginUrlOverride'));
  if (loginUrl !== undefined) patch.loginUrlOverride = loginUrl;

  const note = diffTextField(form.note, baseline.note, cleared('note'));
  if (note !== undefined) patch.note = note;

  const tags = diffTagsField(form.tags, baseline.tags);
  if (tags !== undefined) patch.tags = tags;

  if (form.confirmBeforeFill !== 'keep') {
    const next = form.confirmBeforeFill === 'required';
    // 基准缺失时无法判断"是否改动"，用户既然表了态就照说；有基准则只在真变了时才发。
    if (baseline.confirmBeforeFill === undefined || next !== baseline.confirmBeforeFill) {
      patch.confirmBeforeFill = next;
    }
  }

  return patch;
}

/** 保存前给使用者看的键级摘要：让"这次到底改了什么"可见，而不是点了个假按钮。 */
export function describeUpdateItemPatch(patch: UpdateItemPatch): string[] {
  const keys = Object.keys(patch) as Array<keyof UpdateItemPatch>;
  return keys.map((key) => {
    const value = patch[key];
    const name = FIELD_NAMES[key];
    if (key === 'password') return value === '' ? `${name}：清空已存密码（危险）` : `${name}：写入新密码`;
    if (Array.isArray(value)) return value.length === 0 ? `${name}：清空全部标签` : `${name}：${value.map((t) => `#${t}`).join(' ')}`;
    if (typeof value === 'boolean') return `${name}：${value ? '需要确认' : '无需确认'}`;
    return value === '' ? `${name}：清空已存值` : `${name}：${value}`;
  });
}
