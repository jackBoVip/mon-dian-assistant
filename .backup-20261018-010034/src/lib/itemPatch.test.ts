import { describe, expect, it } from 'vitest';
import {
  buildUpdateItemPatch,
  describeUpdateItemPatch,
  diffTagsField,
  diffTextField,
  parseTags,
  type ItemPatchBaseline,
  type ItemPatchForm,
} from './itemPatch';
import type { UpdateItemPatch } from './types';

/** 后端只回显这两个非秘密字段（ItemRow：账号别名 / 标签）；其余一律视为不回显。 */
const BASELINE: ItemPatchBaseline = { accountAlias: '日常办公', tags: ['运维', '内网'] };

function form(overrides: Partial<ItemPatchForm> = {}): ItemPatchForm {
  return {
    accountAlias: BASELINE.accountAlias,
    username: '',
    authMethod: '',
    browserHint: '',
    loginUrlOverride: '',
    note: '',
    tags: '运维，内网',
    confirmBeforeFill: 'keep',
    password: '',
    passwordCleared: false,
    cleared: [],
    ...overrides,
  };
}

describe('parseTags', () => {
  it('中英文逗号混合、去空去重保序', () => {
    expect(parseTags(' 运维, 内网，运维 ,,  ')).toEqual(['运维', '内网']);
  });

  it('空串得到空数组', () => {
    expect(parseTags('')).toEqual([]);
  });
});

describe('diffTextField', () => {
  it('已回显字段：与初值相同则不发键', () => {
    expect(diffTextField('日常办公', '日常办公', false)).toBeUndefined();
  });

  it('已回显字段：改成空串就是清空', () => {
    expect(diffTextField('', '日常办公', false)).toBe('');
  });

  it('不回显字段：留空表示不修改，显式清空才发空串', () => {
    expect(diffTextField('', undefined, false)).toBeUndefined();
    expect(diffTextField('', undefined, true)).toBe('');
  });
});

describe('diffTagsField', () => {
  it('逐项相同（含顺序无关的重排前先规范化）则不发键', () => {
    expect(diffTagsField('运维,内网', ['运维', '内网'])).toBeUndefined();
  });

  it('清空全部标签发空数组，与"不改动"是两回事', () => {
    expect(diffTagsField('', ['运维', '内网'])).toEqual([]);
    expect(diffTagsField('运维', ['运维', '内网'])).toEqual(['运维']);
  });
});

describe('buildUpdateItemPatch：未改动的键必须缺席（否则后端会照单覆盖）', () => {
  it('什么都没动 → 空补丁', () => {
    expect(buildUpdateItemPatch(form(), BASELINE)).toEqual({});
  });

  it('只改别名 → 补丁里只有 accountAlias', () => {
    const patch = buildUpdateItemPatch(form({ accountAlias: '只读账号' }), BASELINE);
    expect(Object.keys(patch)).toEqual(['accountAlias']);
    expect(patch).toEqual({ accountAlias: '只读账号' });
  });

  it('打开后直接保存：不回显的空白字段与秘密都不会出现在补丁里', () => {
    const patch = buildUpdateItemPatch(form(), BASELINE);
    expect('password' in patch).toBe(false);
    expect('username' in patch).toBe(false);
    expect('note' in patch).toBe(false);
    expect('confirmBeforeFill' in patch).toBe(false);
    expect('tags' in patch).toBe(false);
  });

  it('改别名 + 清空已存密码 → 只有 accountAlias 与 password:""', () => {
    const patch: UpdateItemPatch = buildUpdateItemPatch(
      form({ accountAlias: '运维账号', passwordCleared: true }),
      BASELINE,
    );
    expect(Object.keys(patch)).toEqual(['accountAlias', 'password']);
    expect(patch).toEqual({ accountAlias: '运维账号', password: '' });
  });

  it('输入新密码才发 password；点清空则发空串', () => {
    expect(buildUpdateItemPatch(form({ password: 'New-secret!' }), BASELINE)).toEqual({ password: 'New-secret!' });
    expect(buildUpdateItemPatch(form({ passwordCleared: true }), BASELINE)).toEqual({ password: '' });
  });

  it('不回显字段：填了值才替换，清空按钮才发空串', () => {
    expect(buildUpdateItemPatch(form({ note: '仅限工作日使用' }), BASELINE)).toEqual({ note: '仅限工作日使用' });
    expect(buildUpdateItemPatch(form({ cleared: ['username'] }), BASELINE)).toEqual({ username: '' });
    expect(buildUpdateItemPatch(form({ username: 'ops', cleared: ['username'] }), BASELINE)).toEqual({ username: '' });
  });

  it('标签改动 → 发数组；填充前确认三态 → keep 不发键', () => {
    expect(buildUpdateItemPatch(form({ tags: '运维' }), BASELINE)).toEqual({ tags: ['运维'] });
    expect(buildUpdateItemPatch(form({ confirmBeforeFill: 'keep' }), BASELINE)).toEqual({});
    expect(buildUpdateItemPatch(form({ confirmBeforeFill: 'required' }), BASELINE)).toEqual({
      confirmBeforeFill: true,
    });
    expect(buildUpdateItemPatch(form({ confirmBeforeFill: 'not_required' }), BASELINE)).toEqual({
      confirmBeforeFill: false,
    });
  });

  it('补丁不含 targetId / setAsDefault（后端 deny_unknown_fields 会拒绝）', () => {
    const patch = buildUpdateItemPatch(
      form({ accountAlias: 'A', tags: '', password: 'p', username: 'u', note: 'n', confirmBeforeFill: 'required' }),
      BASELINE,
    );
    expect(Object.keys(patch).sort()).toEqual([
      'accountAlias',
      'confirmBeforeFill',
      'note',
      'password',
      'tags',
      'username',
    ]);
  });
});

describe('describeUpdateItemPatch', () => {
  it('把键级改动翻译成人话，清空秘密要显眼', () => {
    expect(describeUpdateItemPatch({ accountAlias: 'A', password: '' })).toEqual([
      '账号别名：A',
      '已存密码：清空已存密码（危险）',
    ]);
    expect(describeUpdateItemPatch({ tags: [], confirmBeforeFill: false })).toEqual([
      '标签：清空全部标签',
      '填充前确认：无需确认',
    ]);
  });
});
