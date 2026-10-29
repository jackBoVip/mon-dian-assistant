import { describe, expect, it } from 'vitest';
import {
  confidencePercent,
  confidenceTone,
  formatLabel,
  issueLabel,
  optionsToText,
  qtypeLabel,
  textToOptions,
  textToTags,
} from './quiz';

describe('题库词表', () => {
  it('题型与格式都翻成中文，未知值回退原串而不是空白', () => {
    expect(qtypeLabel('true_false')).toBe('判断');
    expect(qtypeLabel('matching')).toBe('matching');
    expect(formatLabel('xlsx')).toBe('Excel');
    expect(issueLabel('missing_answer')).toBe('缺答案');
    expect(issueLabel('brand_new_code')).toBe('brand_new_code');
  });

  it('置信度按 0.4 / 0.6 两档上色，百分比四舍五入', () => {
    expect(confidencePercent(0.556)).toBe('56%');
    expect(confidenceTone(0.39)).toBe('danger');
    expect(confidenceTone(0.4)).toBe('warning');
    expect(confidenceTone(0.6)).toBe('success');
  });
});

describe('选项文本与结构互转', () => {
  it('A. 文本 的多行文本与选项数组互逆', () => {
    const options = [
      { key: 'A', text: '变压器' },
      { key: 'B', text: '电流互感器' },
    ];
    expect(optionsToText(options)).toBe('A. 变压器\nB. 电流互感器');
    expect(textToOptions(optionsToText(options))).toEqual(options);
  });

  it('认全角括号、顿号与半角字母，不认的行直接忽略（不许把正文当选项）', () => {
    expect(textToOptions('a）甲\nB、乙\n（C）丙\n正文行')).toEqual([
      { key: 'A', text: '甲' },
      { key: 'B', text: '乙' },
    ]);
  });

  it('标签按中英文分隔符切开并去空', () => {
    expect(textToTags('一次、二次, 安全 ；')).toEqual(['一次', '二次', '安全']);
  });
});
