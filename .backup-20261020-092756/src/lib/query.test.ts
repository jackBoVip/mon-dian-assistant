import { describe, expect, it } from 'vitest';
import {
  formatCondition,
  formatConditionsSummary,
  hasConditions,
  parseCondition,
  parseConditions,
  splitConditions,
} from './query';

describe('splitConditions', () => {
  it('按英文逗号拆分并去空白、忽略空条件', () => {
    expect(splitConditions('OA,  zhangsan ,')).toEqual(['OA', 'zhangsan']);
  });

  it('支持中文逗号', () => {
    expect(splitConditions('运维账号，数据库')).toEqual(['运维账号', '数据库']);
  });

  it('混合中英文逗号', () => {
    expect(splitConditions('a，b,c，d')).toEqual(['a', 'b', 'c', 'd']);
  });

  it('全空返回空数组', () => {
    expect(splitConditions(' , ， ')).toEqual([]);
    expect(hasConditions('  ')).toBe(false);
    expect(hasConditions('x')).toBe(true);
  });
});

describe('parseCondition', () => {
  it('识别字段限定词（英文冒号）', () => {
    expect(parseCondition('地址:10.0.0.22')).toEqual({ raw: '地址:10.0.0.22', field: '地址', term: '10.0.0.22' });
  });

  it('识别中文冒号', () => {
    expect(parseCondition('账号别名：日常办公')).toEqual({
      raw: '账号别名：日常办公',
      field: '账号别名',
      term: '日常办公',
    });
  });

  it('账号别名优先于账号（最长匹配）', () => {
    const r = parseCondition('账号别名:root');
    expect(r.field).toBe('账号别名');
    expect(r.term).toBe('root');
  });

  it('未知前缀整体作为关键字', () => {
    expect(parseCondition('随便写点啥')).toEqual({ raw: '随便写点啥', field: null, term: '随便写点啥' });
  });

  it('冒号后为空则不视为字段限定', () => {
    expect(parseCondition('类型:').field).toBeNull();
  });
});

describe('parseConditions / summary', () => {
  it('多条件解析', () => {
    const list = parseConditions('系统:内部门户, 账号别名:日常办公, 类型:网页');
    expect(list).toHaveLength(3);
    expect(list.map((c) => c.field)).toEqual(['系统', '账号别名', '类型']);
  });

  it('单条件回显', () => {
    expect(formatCondition(parseCondition('地址:10.0.0.22'))).toBe('地址 包含 10.0.0.22');
    expect(formatCondition({ raw: 'oa', field: null, term: 'oa' })).toBe('关键字 包含 oa');
  });

  it('多条件 AND 摘要', () => {
    expect(formatConditionsSummary('a,b')).toMatch('2 个条件全部命中（AND）');
    expect(formatConditionsSummary('')).toBeNull();
  });
});
