import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SecuritySection } from './SecuritySection';
import { SETTING_SPECS } from '../../lib/securitySettings';
import { chooseOption } from '../../test/select';
import { useNotify } from '../../state/notify';
import { queryKeys } from '../../lib/queryClient';
import type {
  ExtensionChannelStatus,
  KeystoreDiagnostics,
  SecurityStatus,
  SettingTuple,
  SystemInfo,
} from '../../lib/types';

/**
 * 安全策略页的「设置项」这一块：交付方要的是**中文名 + 开关/短控件 + 改后自动保存**。
 *
 * 这里钉四件事：
 * 1. 屏上不出现键名与 true/false——布尔一律是 switch，值由服务端决定；
 * 2. 没有保存按钮：开关/下拉即点即提交，数字与文本在失焦或回车时提交；
 * 3. 失败时不能"假装已改"：草稿丢弃、显示退回服务端值、原文进 toast；
 * 4. 只画 `update_setting` 白名单里的键（主题/外观/快捷键由各自页面维护）。
 *
 * 白名单与控件形态的对应关系另由 `lib/securitySettings.test.ts` 从 Rust 源码核对。
 */
const mocks = vi.hoisted(() => ({
  securityStatus: vi.fn(),
  extensionChannelStatus: vi.fn(),
  systemInfo: vi.fn(),
  keystoreDiagnostics: vi.fn(),
  settings: vi.fn(),
  updateSetting: vi.fn(),
  setLauncherEnabled: vi.fn(),
}));

vi.mock('../../lib/api', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../lib/api')>();
  return { ...mod, api: { ...mod.api, ...mocks } };
});

const SECURITY: SecurityStatus = {
  dbEncrypted: 'encrypted',
  dbKeyStore: 'local-file-0600',
  deviceKeyConsent: 'consented',
  schemaVersion: 10,
  idleTimeoutMinutes: 15,
  maxFailedAttempts: 5,
  lockoutSeconds: 300,
  minPasswordLength: 12,
  lockOnSystemSleep: true,
  copyPasswordEnabled: true,
  copyPasswordRequiresReauth: true,
  exportRequiresReauth: true,
  revealRequiresReauth: true,
  insecureProtocolsAllowed: false,
  lastBackupAt: null,
  updateSourceConfigured: false,
  updateSourceScheme: 'https',
  updateSignatureKeyConfigured: false,
  extensionReady: false,
  telemetry: 'disabled',
  sessionStartedAt: null,
};

const CHANNEL: ExtensionChannelStatus = {
  ready: false,
  hostManifestPath: null,
  channelFilePresent: false,
  pendingTickets: 0,
  note: '扩展尚未连接',
};

const SYSINFO: SystemInfo = {
  appVersion: '0.1.0',
  os: 'macos',
  arch: 'aarch64',
  family: 'unix',
  schemaVersion: 10,
  targetCount: 3,
  dbKeyStore: 'local-file-0600',
  telemetry: 'disabled',
};

const KEYSTORE: KeystoreDiagnostics = {
  dbKeyStore: 'local-file-0600',
  legacyBackend: 'macos-keychain',
  deviceKeyConsent: 'consented',
  note: '数据库主密钥存放在本机 0600 文件中。',
};

const BASE: Record<string, string> = {
  session_idle_timeout_minutes: '15',
  lock_on_system_sleep: 'true',
  max_failed_login_attempts: '5',
  lockout_seconds: '300',
  reauth_window_seconds: '120',
  accounts_allow_copy_password: 'true',
  copy_password_requires_reauth: 'true',
  reveal_requires_reauth: 'true',
  secret_visible_seconds: '30',
  clipboard_clear_after_seconds: '30',
  export_requires_reauth: 'true',
  master_password_min_length: '12',
  allow_insecure_protocols: 'false',
  update_channel: 'stable',
  update_source_url: '',
  extension_id: '',
  quick_launcher_enabled: 'true',
  quick_launcher_show_recent: 'true',
  quick_launcher_rank_recent_favorite: 'true',
  quick_launcher_result_limit: '8',
  quick_launcher_fill_enabled: 'true',
};

/** 这些键 get_settings 会返回，但 update_setting 会拒绝——界面上不该出现。 */
const NOT_UPDATABLE: SettingTuple[] = [
  ['theme_style', 'original', 'user'],
  ['reduce_motion', 'false', 'user'],
  ['quick_launcher_accelerator', 'CmdOrCtrl+Alt+Space', 'user'],
];

let store: Map<string, string>;

function rows(): SettingTuple[] {
  return [...store.entries()].map(([key, value]) => [key, value, 'user']);
}

function renderSection() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return {
    qc,
    ...render(
      <QueryClientProvider client={qc}>
        <SecuritySection />
      </QueryClientProvider>,
    ),
  };
}

function lastNotify() {
  const items = useNotify.getState().items;
  return items[items.length - 1];
}

/** 页面里另外几块状态面板也有同名文案（如「允许复制密码」），所以查询一律收在这一节内。 */
async function renderSettings() {
  const view = renderSection();
  const heading = await screen.findByRole('heading', { name: '设置项' });
  const section = heading.closest('section') as HTMLElement;
  expect(section).not.toBeNull();
  // 标题先于设置数据上屏：等表单真正落地再交给用例
  await waitFor(() => expect(within(section).getAllByRole('listitem')).toHaveLength(SETTING_SPECS.length));
  return { section, ...view };
}

const switchIn = (section: HTMLElement, label: string) => within(section).getByRole('switch', { name: label });

beforeEach(() => {
  Object.values(mocks).forEach((fn) => fn.mockReset());
  store = new Map(Object.entries(BASE));
  mocks.securityStatus.mockResolvedValue(SECURITY);
  mocks.extensionChannelStatus.mockResolvedValue(CHANNEL);
  mocks.systemInfo.mockResolvedValue(SYSINFO);
  mocks.keystoreDiagnostics.mockResolvedValue(KEYSTORE);
  mocks.settings.mockImplementation(async () => [...rows(), ...NOT_UPDATABLE]);
  mocks.updateSetting.mockImplementation(async (key: string, value: string) => {
    store.set(key, value);
  });
  mocks.setLauncherEnabled.mockResolvedValue({
    shortcut: 'CmdOrCtrl+Alt+Space',
    registered: false,
    default: 'CmdOrCtrl+Alt+Space',
    hint: '已停用全局唤起',
  });
  useNotify.setState({ items: [] });
});

describe('中文名与开关：键名、true/false 都不上屏', () => {
  it('每一项都用中文名，行上的 title 才是键名', async () => {
    const { section } = await renderSettings();
    expect(within(section).getByText('允许复制密码')).toBeInTheDocument();
    expect(within(section).getByText('休眠或挂起时立即锁定')).toBeInTheDocument();
    expect(within(section).queryByText(/accounts_allow_copy_password/)).toBeNull();
    expect(within(section).queryByText(/^(true|false)$/)).toBeNull();
    for (const item of within(section).getAllByRole('listitem')) {
      expect(SETTING_SPECS.map((spec) => spec.key)).toContain(item.getAttribute('title') ?? item.querySelector('[title]')?.getAttribute('title'));
    }
  });

  it('所有布尔项都是开关，且开关状态就是服务端取值', async () => {
    const { section } = await renderSettings();
    const boolSpecs = SETTING_SPECS.filter((spec) => spec.control.kind === 'switch');
    expect(within(section).getAllByRole('switch')).toHaveLength(boolSpecs.length);
    expect(switchIn(section, '允许复制密码')).toBeChecked();
    expect(switchIn(section, '允许不安全协议')).not.toBeChecked();
    expect(switchIn(section, '空查询时显示最近与收藏')).toBeChecked();
  });

  it('页面上不再有「保存」按钮', async () => {
    await renderSettings();
    expect(screen.queryByRole('button', { name: '保存' })).toBeNull();
  });

  it('只画白名单里的 21 项，主题/外观/快捷键那几行不出现', async () => {
    const { section } = await renderSettings();
    expect(within(section).getAllByRole('listitem')).toHaveLength(SETTING_SPECS.length);
    for (const key of ['theme_style', 'reduce_motion', 'quick_launcher_accelerator']) {
      expect(section.querySelector(`[title="${key}"]`), key).toBeNull();
    }
  });
});

describe('改后自动保存', () => {
  it('拨开关即时提交，成功后中文 toast，重新取数后显示回服务端值', async () => {
    const { section, qc } = await renderSettings();
    const invalidate = vi.spyOn(qc, 'invalidateQueries');

    fireEvent.click(switchIn(section, '允许复制密码'));

    await waitFor(() => expect(mocks.updateSetting).toHaveBeenCalledWith('accounts_allow_copy_password', 'false'));
    await waitFor(() => expect(lastNotify()).toMatchObject({ kind: 'success', text: '设置已保存' }));
    await waitFor(() => expect(switchIn(section, '允许复制密码')).not.toBeChecked());
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.settings });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.security });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.launcherPrefs });
  });

  it('数字在失焦时提交，回车等于失焦', async () => {
    const { section } = await renderSettings();
    const idle = within(section).getByLabelText('空闲自动锁定') as HTMLInputElement;

    fireEvent.change(idle, { target: { value: '0' } });
    expect(mocks.updateSetting).not.toHaveBeenCalled();
    act(() => idle.focus());
    fireEvent.blur(idle);
    await waitFor(() => expect(mocks.updateSetting).toHaveBeenCalledWith('session_idle_timeout_minutes', '0'));
    await waitFor(() => expect(lastNotify()).toMatchObject({ kind: 'success', text: '设置已保存' }));
    // 等重新取数落地再进下一步，避免把上一笔的收尾算进下一条断言的 act 范围
    await waitFor(() => expect(idle).toHaveValue(0));

    const limit = within(section).getByLabelText('结果条数上限') as HTMLInputElement;
    fireEvent.change(limit, { target: { value: '20' } });
    act(() => limit.focus());
    fireEvent.keyDown(limit, { key: 'Enter' });
    await waitFor(() => expect(mocks.updateSetting).toHaveBeenCalledWith('quick_launcher_result_limit', '20'));
    await waitFor(() => expect(useNotify.getState().items).toHaveLength(2));
    await waitFor(() => expect(limit).toHaveValue(20));
  });

  it('数字越界不提交，提示范围并把输入退回服务端值', async () => {
    const { section } = await renderSettings();
    const idle = within(section).getByLabelText('空闲自动锁定') as HTMLInputElement;

    fireEvent.change(idle, { target: { value: '9999' } });
    act(() => idle.focus());
    fireEvent.blur(idle);

    await waitFor(() => expect(lastNotify()).toMatchObject({ kind: 'warning' }));
    expect(lastNotify()?.text).toContain('0–1440');
    expect(mocks.updateSetting).not.toHaveBeenCalled();
    expect(idle).toHaveValue(15);
  });

  it('没改动就失焦不提交', async () => {
    const { section } = await renderSettings();
    const idle = within(section).getByLabelText('空闲自动锁定') as HTMLInputElement;
    act(() => idle.focus());
    fireEvent.blur(idle);
    expect(mocks.updateSetting).not.toHaveBeenCalled();
    expect(lastNotify()).toBeUndefined();
  });

  it('文本在失焦时提交（更新源地址）', async () => {
    const { section } = await renderSettings();
    const source = within(section).getByLabelText('更新源地址') as HTMLInputElement;

    fireEvent.change(source, { target: { value: 'https://upd.example.gov.cn' } });
    act(() => source.focus());
    fireEvent.blur(source);

    await waitFor(() =>
      expect(mocks.updateSetting).toHaveBeenCalledWith('update_source_url', 'https://upd.example.gov.cn'),
    );
    await waitFor(() => expect(lastNotify()).toMatchObject({ kind: 'success', text: '设置已保存' }));
  });

  it('下拉选一项即提交（更新通道）', async () => {
    const { section } = await renderSettings();
    within(section).getByLabelText('更新通道');
    chooseOption('更新通道', '测试版');
    await waitFor(() => expect(mocks.updateSetting).toHaveBeenCalledWith('update_channel', 'beta'));
    await waitFor(() => expect(lastNotify()).toMatchObject({ kind: 'success', text: '设置已保存' }));
  });

  it('后端拒绝时草稿丢弃、开关退回服务端值、错误原文进 toast', async () => {
    mocks.updateSetting.mockRejectedValue({ code: 'INVALID_INPUT', message: '值必须是 true 或 false' });
    const { section } = await renderSettings();

    fireEvent.click(switchIn(section, '允许不安全协议'));

    await waitFor(() => expect(lastNotify()).toMatchObject({ kind: 'danger', text: '值必须是 true 或 false' }));
    expect(switchIn(section, '允许不安全协议')).not.toBeChecked();
  });

  it('全局唤起开关走 set_launcher_enabled（还要注册/注销快捷键），不直接改设置行', async () => {
    const { section } = await renderSettings();

    fireEvent.click(switchIn(section, '启用全局唤起'));

    await waitFor(() => expect(mocks.setLauncherEnabled).toHaveBeenCalledWith(false));
    expect(mocks.updateSetting).not.toHaveBeenCalledWith('quick_launcher_enabled', expect.anything());
    await waitFor(() => expect(lastNotify()).toMatchObject({ kind: 'warning', text: '已停用全局唤起' }));
  });
});

describe('读取失败', () => {
  it('设置读不到时给错误态与重试，不画半截表单', async () => {
    mocks.settings.mockRejectedValue({ code: 'DB_ERROR', message: '数据库访问失败' });
    renderSection();
    expect(await screen.findByText('数据库访问失败')).toBeInTheDocument();
    expect(screen.queryByRole('switch', { name: '允许复制密码' })).toBeNull();
  });
});
