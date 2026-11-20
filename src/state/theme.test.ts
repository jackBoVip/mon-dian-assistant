import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 主题 store 的三条回退路径（2026-11-20 Win10 报障复盘新增）。
 *
 * 复盘结论：`api.customThemes().catch(() => [])` 把"这次请求没成"和"确实一档自定义都没有"
 * 洗成同一个值，于是 `asThemeStyle` 静默回退 glass——用户看到的是"我选的主题没生效"，
 * 而界面上一个字都不说。现在每条回退都要说得出是哪一种，测试逐条钉住。
 */
const mocks = vi.hoisted(() => ({
  theme: vi.fn(),
  customThemes: vi.fn(),
  setTheme: vi.fn(),
  setReduceMotion: vi.fn(),
}));

vi.mock('../lib/api', () => ({
  api: mocks,
  ApiError: class ApiError extends Error {
    code: string;
    constructor(init: { code: string; message: string }) {
      super(init.message);
      this.code = init.code;
    }
  },
}));

/** 每轮取一份全新的 store：模块级"只说一次"的闸门要能被重置。 */
async function fresh() {
  vi.resetModules();
  const store = (await import('./theme')).useTheme;
  const { useNotify } = await import('./notify');
  useNotify.setState({ items: [] });
  return { store, notes: () => useNotify.getState().items.map((i) => `${i.kind}:${i.text}`) };
}

beforeEach(() => {
  mocks.theme.mockReset();
  mocks.customThemes.mockReset();
  mocks.setTheme.mockReset();
  mocks.setReduceMotion.mockReset();
  document.documentElement.removeAttribute('data-theme');
  document.head.querySelectorAll('style').forEach((s) => s.remove());
});

describe('主题回退不再静默', () => {
  it('自定义主题列表没取到，而当前选的是自定义档：回退 glass 并说明是"没取到"', async () => {
    mocks.theme.mockResolvedValue({ style: 'custom-legacy', reduceMotion: false });
    mocks.customThemes.mockRejectedValue(new Error('network'));
    const { store, notes } = await fresh();

    await store.getState().load();

    expect(store.getState().style).toBe('glass');
    expect(notes().some((n) => n.includes('列表没取到'))).toBe(true);
    expect(document.documentElement.dataset.theme).toBe('glass');
  });

  it('列表取到了、但那一档确实不存在：说的是"已被删除"，不是"没取到"', async () => {
    mocks.theme.mockResolvedValue({ style: 'custom-gone', reduceMotion: false });
    mocks.customThemes.mockResolvedValue([{ id: 'other', name: '另一档', tokens: '{}' }]);
    const { store, notes } = await fresh();

    await store.getState().load();

    expect(store.getState().style).toBe('glass');
    const all = notes().join('|');
    expect(all).toContain('已不存在');
    expect(all).not.toContain('列表没取到');
  });

  it('后端主题整条读不到：按默认外观显示、如实说一次，重复唤起不刷屏', async () => {
    mocks.theme.mockRejectedValue(new Error('locked'));
    const { store, notes } = await fresh();

    await store.getState().load();
    await store.getState().load();
    await store.getState().load();

    expect(store.getState().loaded).toBe(true);
    expect(store.getState().style).toBe('glass');
    const warned = notes().filter((n) => n.includes('没读到'));
    expect(warned).toHaveLength(1);
  });

  /**
   * 这一条是"看不清"的直接成因：`data-theme="custom-x"` 挂着而运行时规则没注入成功
   * （buildThemeRule 在令牌不完整时故意返回空串），整套 var() 取不到值 →
   * 底色落 transparent、文字落 inherit。回退默认档才是诚实的做法。
   */
  it('自定义档的样式没能注入时，apply 不许把 data-theme 留在那一档上', async () => {
    mocks.theme.mockResolvedValue({ style: 'glass', reduceMotion: false });
    mocks.customThemes.mockResolvedValue([]);
    const { store, notes } = await fresh();
    await store.getState().load();

    // 库里存着这一档，但令牌只有一半：注入侧宁可不写
    store.setState({
      style: 'custom-half' as never,
      custom: [{ id: 'half', name: '半套', tokens: JSON.stringify({ '--t-primary': '#4f46e5' }) }],
    });

    store.getState().apply();

    expect(document.documentElement.dataset.theme).toBe('glass');
    expect(store.getState().style).toBe('glass');
    expect(notes().some((n) => n.includes('没能注入'))).toBe(true);
  });

  it('令牌齐全的自定义档：注入成功后 data-theme 就停在那一档（不许误回退）', async () => {
    mocks.theme.mockResolvedValue({ style: 'glass', reduceMotion: false });
    mocks.customThemes.mockResolvedValue([]);
    const { store, notes } = await fresh();
    await store.getState().load();

    // 整套合法值不手抄：直接取仓库自带的那份模板（--blur 那两枚必须是 blur(Npx)，
    // 逐枚填颜色会被判不完整、宁可不注入，那正是上一条测试的场景）
    const { TOKEN_TEMPLATE, parseThemeTokens } = await import('../lib/themeTokens');
    const parsed = parseThemeTokens(TOKEN_TEMPLATE);
    expect(parsed.ok, `模板本身就过不了校验，本测试要跟着模板改：${'errors' in parsed ? JSON.stringify(parsed.errors) : ''}`).toBe(
      true,
    );
    if (!parsed.ok) return;

    store.setState({
      style: 'custom-full' as never,
      custom: [{ id: 'full', name: '整套', tokens: JSON.stringify(parsed.tokens) }],
    });

    store.getState().apply();

    expect(document.documentElement.dataset.theme).toBe('custom-full');
    expect(store.getState().style).toBe('custom-full');
    expect(notes()).toEqual([]);
  });
});
