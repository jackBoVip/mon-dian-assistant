import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Icon } from './Icon';
import { ICONS } from './icons';

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

  /* 顶栏那两枚换成原型逐字照抄的画法（交付方：「主题图标、设置图标要求和原型保持一致」）。
   * morphicons 会把整个 IconNode 归一采样成一条 path，所以判据分两层：
   * 注册表里必须逐字带着附件那两段 `d`（防止有人换回 lucide），
   * 而"确实上屏"只能验到"画得出来、且与滑杆那颗不是同一个形状"。 */
  it('palette 与 settings 带的是原型那两段字面路径，不是 lucide 的画法', () => {
    const registry = JSON.stringify(ICONS);
    expect(registry).toContain('M12 21a9 9 0 1 1 9-9c0 2.5-2 4.5-4.5 4.5H15a2 2 0 0 0-2 2v.5a2 2 0 0 1-2 2z');
    expect(registry).toContain('M10.325 4.317c.426-1.756');
    expect(registry).toContain('"cx":16,"cy":11,"r":1.5');
  });

  it('两枚都画得出来，且 settings 不再是 filter 那枚滑杆', () => {
    const drawn = (name: 'palette' | 'settings' | 'filter') => {
      const { container } = render(<Icon name={name} />);
      return container.querySelector('path')?.getAttribute('d') ?? '';
    };
    expect(drawn('palette').length).toBeGreaterThan(0);
    expect(drawn('settings').length).toBeGreaterThan(0);
    expect(drawn('settings')).not.toBe(drawn('filter'));
  });
});
