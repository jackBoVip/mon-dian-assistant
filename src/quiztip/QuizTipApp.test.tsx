import { act, render, screen } from '@testing-library/react';
import { vi } from 'vitest';
import { QuizTipApp } from './QuizTipApp';
import type { QuizMatchHit } from '../lib/types';

/**
 * 浮层只负责显示后端给的那一条命中：阈值、范围、换题确认都在悬停线程里。
 * 这里钉住三件事——没命中就不渲染、命中时答案主显、关掉选项开关时选项真的不出现。
 */
const handler = vi.hoisted(() => ({ current: null as ((p: unknown) => void) | null }));

vi.mock('../lib/vaultEvents', () => ({
  useBackendEventPayload: (_name: string, fn: (p: unknown) => void) => {
    handler.current = fn;
  },
}));

vi.mock('../state/theme', () => {
  const state = { apply: vi.fn(), load: vi.fn(async () => {}) };
  return { useTheme: { getState: () => state } };
});

function hit(over: Partial<QuizMatchHit> = {}): QuizMatchHit {
  return {
    questionId: 'q1',
    libraryId: 'lib-1',
    libraryName: '变电运维',
    seq: 12,
    qtype: 'single',
    stem: '电压互感器二次侧不允许',
    options: [
      { key: 'A', text: '开路' },
      { key: 'B', text: '短路' },
      { key: 'C', text: '接地' },
    ],
    answerDisplay: 'B',
    tags: [],
    score: 0.93,
    ...over,
  };
}

function push(payload: unknown) {
  act(() => {
    handler.current?.(payload);
  });
}

describe('QuizTipApp', () => {
  it('载荷 visible=false 时什么都不渲染（窗口由 Rust 隐藏）', () => {
    const { container } = render(<QuizTipApp />);
    push({ visible: false, hit: hit(), showOptions: true, at: 1 });
    expect(container).toBeEmptyDOMElement();
  });

  it('命中时给出题干、答案、题库与相似度', () => {
    const { container } = render(<QuizTipApp />);
    push({ visible: true, hit: hit(), showOptions: true, at: 1 });
    expect(screen.getByText('电压互感器二次侧不允许')).toBeInTheDocument();
    expect(container.querySelector('.quiztip-answer')?.textContent).toContain('B');
    expect(screen.getByText(/变电运维 · 第 12 题/)).toBeInTheDocument();
    expect(screen.getByText('93%')).toBeInTheDocument();
  });

  it('关掉「显示选项」后选项一栏不出现', () => {
    render(<QuizTipApp />);
    push({ visible: true, hit: hit(), showOptions: false, at: 1 });
    expect(screen.queryByText('开路')).not.toBeInTheDocument();
  });

  it('显示选项时按选项表渲染', () => {
    render(<QuizTipApp />);
    push({ visible: true, hit: hit(), showOptions: true, at: 1 });
    expect(screen.getByText('开路')).toBeInTheDocument();
    expect(screen.getByText('接地')).toBeInTheDocument();
  });
});
