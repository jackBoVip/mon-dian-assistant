import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Icon } from './Icon';

describe('Icon', () => {
  it('装饰性图标对辅助技术不可见', () => {
    const { container } = render(<Icon name="close" />);
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute('aria-hidden')).toBe('true');
  });

  it('给了 label 的图标成为有名字的图形', () => {
    render(<Icon name="key" label="凭据保险库" />);
    expect(screen.getByRole('img', { name: '凭据保险库' })).toBeTruthy();
  });

  it('渲染的是真正的 path 图形，不再是 Unicode 字形', () => {
    const { container } = render(<Icon name="star" />);
    const svg = container.querySelector('svg');
    expect(svg?.querySelectorAll('path').length).toBeGreaterThan(0);
    expect(svg?.textContent ?? '').not.toMatch(/[★☆✕🔍]/);
  });
});
