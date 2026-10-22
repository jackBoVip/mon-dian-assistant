/**
 * 「编辑账号」的最小补丁生成逻辑（纯函数，独立于组件以便单测）。
 *
 * 后端 commands::mod::UpdateItemInput 的线格式语义（camelCase + deny_unknown_fields）：
 *  - 键缺省（不出现在 JSON 里）＝ 保留已存值；
 *  - 键存在且为空串 ＝ 显式清空该字段；
 *  - 键存在且有值 ＝ 只替换该字段。
 * 秘密（密码/令牌/私钥/口令短语）永不回显，所以「留空」必须判定为不改动：界面上没有清密码的入口，
 * 发出 password 只可能是"写一个新值"。
 * 非秘密载荷（用户名/备注/填充前确认）由 item_detail 回显为基准；
 * 基准缺失（无权限或明细未加载）时这些字段退回"永不回显"的判定，避免读不到就写空。
 * 载荷里还有认证方式、浏览器提示、登录地址覆盖三栏：界面上不再给入口，
 * 于是这一份补丁永远不带它们，后端按"键缺省＝保留"原样留着已存值。
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
  confirmBeforeFill?: boolean;
}

/** 填充前确认的三态：keep 表示用户不表态，因此该键不参与提交（即使后端已回显当前值）。 */
export type ConfirmBeforeFillChoice = 'keep' | 'required' | 'not_required';

/** 编辑表单的当前内容；字符串均已由调用方 trim（标签仍是输入框里的逗号串）。 */
export interface ItemPatchForm {
  accountAlias: string;
  username: string;
  note: string;
  tags: string;
  confirmBeforeFill: ConfirmBeforeFillChoice;
  /** 密码：空串＝不改动 */
  password: string;
  /** 用户名读不到时（无查看秘密权限）唯一抹掉它的入口，见编辑账号弹窗那颗两段式确认。 */
  usernameCleared: boolean;
}

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

  const alias = diffTextField(form.accountAlias, baseline.accountAlias, false);
  if (alias !== undefined) patch.accountAlias = alias;

  const username = diffTextField(form.username, baseline.username, form.usernameCleared);
  if (username !== undefined) patch.username = username;

  if (form.password !== '') patch.password = form.password;

  const note = diffTextField(form.note, baseline.note, false);
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
