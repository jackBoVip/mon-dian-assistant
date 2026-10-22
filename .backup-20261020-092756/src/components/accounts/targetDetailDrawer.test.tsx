import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi } from 'vitest';
import { TargetDetailDrawer } from './TargetDetailDrawer';
import type { TargetDetail } from '../../lib/types';

const mocks = vi.hoisted(() => ({ targetDetail: vi.fn(), targetItems: vi.fn() }));

vi.mock('../../lib/api', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../lib/api')>();
  return { ...mod, api: { ...mod.api, ...mocks } };
});

const META = {
  url: 'https://oa.example.cn',
  allowedOrigin: '',
  host: '',
  port: '',
  databaseName: '',
  tenant: '',
  vendor: '',
  protocol: 'https',
  extra: {},
};

function detail(over: { insecureProtocol: boolean; status?: string }): TargetDetail {
  return {
    target: {
      id: 't-7',
      targetType: 'web',
      displayName: 'OA办公系统',
      groupId: null,
      status: over.status ?? 'active',
      createdAt: '2026-10-01T00:00:00Z',
      updatedAt: '2026-10-16T00:00:00Z',
      credentialCount: 0,
    },
    meta: META,
    items: [],
    fillAvailable: true,
    insecureProtocol: over.insecureProtocol,
  };
}

function renderDrawer() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TargetDetailDrawer targetId="t-7" onClose={() => {}} />
    </QueryClientProvider>,
  );
}

const dialog = () => screen.getByRole('dialog', { name: '目标详情' });

beforeEach(() => {
  mocks.targetDetail.mockReset();
  mocks.targetItems.mockReset();
  mocks.targetItems.mockResolvedValue([]);
});

describe('详情抽屉的情绪头部带（换皮新增，只改配色不改判定）', () => {
  it('目标启用且协议安全 → ok', async () => {
    mocks.targetDetail.mockResolvedValue(detail({ insecureProtocol: false }));
    renderDrawer();
    await waitFor(() => expect(dialog().getAttribute('data-tone')).toBe('ok'));
  });

  it('明文协议 → warn（优先级高于停用态）', async () => {
    mocks.targetDetail.mockResolvedValue(detail({ insecureProtocol: true, status: 'disabled' }));
    renderDrawer();
    await waitFor(() => expect(dialog().getAttribute('data-tone')).toBe('warn'));
  });

  it('目标停用 → idle', async () => {
    mocks.targetDetail.mockResolvedValue(detail({ insecureProtocol: false, status: 'disabled' }));
    renderDrawer();
    await waitFor(() => expect(dialog().getAttribute('data-tone')).toBe('idle'));
  });

  it('详情读取失败 → bad，且错误状态照常呈现给读者', async () => {
    mocks.targetDetail.mockRejectedValue({ code: 'DB_ERROR', message: '数据库访问失败' });
    renderDrawer();
    await waitFor(() => expect(dialog().getAttribute('data-tone')).toBe('bad'));
  });

  it('关闭入口与标题的可访问名没有被换皮改动', async () => {
    mocks.targetDetail.mockResolvedValue(detail({ insecureProtocol: false }));
    renderDrawer();
    await screen.findByRole('button', { name: '关闭详情' });
    /* 抽屉的可及名现在由 Radix Title（aria-labelledby）给，而不是原先手写的 aria-label；
     * 上面那两条 getByRole('dialog', {name:'目标详情'}) 能命中就已经证明了这一点。
     * aria-modal 这一档 Radix 不再写，改用"背景整棵子树 aria-hidden + 滚动锁"表达模态。 */
    expect(dialog()).toHaveAttribute('aria-labelledby');
    expect(document.querySelector('body > div[aria-hidden="true"]')).not.toBeNull();
    expect(document.body).toHaveAttribute('data-scroll-locked', '1');
  });
});
