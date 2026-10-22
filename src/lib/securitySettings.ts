import type { SelectOption } from '../components/ui/select';

/**
 * 「安全策略 · 设置项」的展示层：一枚设置键 → 中文名 / 说明 / 控件形态。
 *
 * 键名与取值口径全部来自后端 `commands/system.rs::UPDATABLE_SETTINGS`（本页只渲染这 21 枚），
 * 字典与白名单的对应关系由 `securitySettings.test.ts` 从 Rust 源码反向核对——后端加一枚、
 * 这里没登记就红，界面不会冒出一行英文键名或一个点了没反应的保存。
 *
 * `GET /settings` 还会返回 `theme_style` / `reduce_motion` / `quick_launcher_accelerator` 等
 * 由别的页面维护的键；它们不在白名单里，`update_setting` 会直接拒绝，所以这里不画。
 */
export type SettingControl =
  | { kind: 'switch' }
  | { kind: 'number'; unit: string; min: number; max: number }
  | { kind: 'text'; size: 'md' | 'lg'; placeholder?: string }
  | { kind: 'select'; options: SelectOption[] };

export type SettingGroupId = 'session' | 'secret' | 'network' | 'launcher';

export interface SettingSpec {
  key: string;
  label: string;
  hint: string;
  group: SettingGroupId;
  control: SettingControl;
  /**
   * 默认走 `update_setting`。`launcher-toggle` 是唯一例外：它必须走 `set_launcher_enabled`，
   * 因为那条命令还要注册/注销全局快捷键——只改设置行会让开关在重启前不生效。
   */
  apply?: 'launcher-toggle';
}

export const SETTING_GROUPS: Array<{ id: SettingGroupId; title: string; hint: string }> = [
  { id: 'session', title: '会话与锁定', hint: '空闲、失败与二次认证的时间口径' },
  { id: 'secret', title: '密码与秘密', hint: '复制、查看、导出与剪贴板' },
  { id: 'network', title: '网络与更新', hint: '协议、更新源与浏览器扩展' },
  { id: 'launcher', title: '快捷启动器', hint: '全局唤起、结果条数与安全填充' },
];

export const SETTING_SPECS: SettingSpec[] = [
  {
    key: 'session_idle_timeout_minutes',
    label: '空闲自动锁定',
    hint: '连续这么久没有操作就锁定保险库；0 表示不自动锁定。',
    group: 'session',
    control: { kind: 'number', unit: '分钟', min: 0, max: 1440 },
  },
  {
    key: 'lock_on_system_sleep',
    label: '休眠或挂起时立即锁定',
    hint: '按两次心跳之间的时间跨度推断；无法区分休眠与进程挂起，宁可多锁一次。',
    group: 'session',
    control: { kind: 'switch' },
  },
  {
    key: 'max_failed_login_attempts',
    label: '登录失败次数上限',
    hint: '连续输错主密码达到这个次数就锁定登录；0 表示不锁定。',
    group: 'session',
    control: { kind: 'number', unit: '次', min: 0, max: 100 },
  },
  {
    key: 'lockout_seconds',
    label: '失败锁定时长',
    hint: '达到失败次数上限后，需要等待这么久才能再试。',
    group: 'session',
    control: { kind: 'number', unit: '秒', min: 0, max: 86400 },
  },
  {
    key: 'reauth_window_seconds',
    label: '二次认证有效期',
    hint: '一次重新输入主密码后，后续敏感操作在这段时间内不再重复询问。',
    group: 'session',
    control: { kind: 'number', unit: '秒', min: 0, max: 3600 },
  },
  {
    key: 'accounts_allow_copy_password',
    label: '允许复制密码',
    hint: '关闭后，账号页与快捷启动器都不能复制密码。',
    group: 'secret',
    control: { kind: 'switch' },
  },
  {
    key: 'copy_password_requires_reauth',
    label: '复制密码需二次认证',
    hint: '开启后，复制密码前必须重新输入主密码。',
    group: 'secret',
    control: { kind: 'switch' },
  },
  {
    key: 'reveal_requires_reauth',
    label: '查看秘密需二次认证',
    hint: '开启后，在账号页查看明文秘密前必须重新输入主密码。',
    group: 'secret',
    control: { kind: 'switch' },
  },
  {
    key: 'secret_visible_seconds',
    label: '明文停留时长',
    hint: '明文秘密在界面上停留这么久后自动隐藏。',
    group: 'secret',
    control: { kind: 'number', unit: '秒', min: 0, max: 300 },
  },
  {
    key: 'clipboard_clear_after_seconds',
    label: '剪贴板自动清空',
    hint: '复制密码后这么久自动清空剪贴板；0 表示不清空。',
    group: 'secret',
    control: { kind: 'number', unit: '秒', min: 0, max: 600 },
  },
  {
    key: 'export_requires_reauth',
    label: '导出需二次认证',
    hint: '开启后，导出含明文秘密的文件前必须重新输入主密码。',
    group: 'secret',
    control: { kind: 'switch' },
  },
  {
    key: 'master_password_min_length',
    label: '导出容器口令最小长度',
    hint: '只约束导出的容器口令，主密码不受此项限制；内置下限为 10。',
    group: 'secret',
    control: { kind: 'number', unit: '位', min: 10, max: 64 },
  },
  {
    key: 'allow_insecure_protocols',
    label: '允许不安全协议',
    hint: '开启后放行 http:// 等未加密地址；默认只允许 https。',
    group: 'network',
    control: { kind: 'switch' },
  },
  {
    key: 'update_channel',
    label: '更新通道',
    hint: '稳定版只接收正式发布，测试版会提前收到预发布构建。',
    group: 'network',
    control: {
      kind: 'select',
      options: [
        { value: 'stable', label: '稳定版' },
        { value: 'beta', label: '测试版' },
      ],
    },
  },
  {
    key: 'update_source_url',
    label: '更新源地址',
    hint: '更新清单地址，须为 https；留空则不检查更新。',
    group: 'network',
    control: { kind: 'text', size: 'lg', placeholder: 'https://' },
  },
  {
    key: 'extension_id',
    label: '浏览器扩展 ID',
    hint: '扩展分配的 32 位小写字母；留空则填充通道未就绪。',
    group: 'network',
    control: { kind: 'text', size: 'lg', placeholder: '32 位小写字母' },
  },
  {
    key: 'quick_launcher_enabled',
    label: '启用全局唤起',
    hint: '允许用全局快捷键唤起快速启动器浮层；切换会同时注册或注销快捷键。',
    group: 'launcher',
    control: { kind: 'switch' },
    apply: 'launcher-toggle',
  },
  {
    key: 'quick_launcher_show_recent',
    label: '空查询时显示最近与收藏',
    hint: '关闭后输入为空直接返回空结果，不影响真正的条件查询。',
    group: 'launcher',
    control: { kind: 'switch' },
  },
  {
    key: 'quick_launcher_rank_recent_favorite',
    label: '同级结果按收藏与最近优先',
    hint: '同一匹配等级内按收藏 > 默认账号 > 最近使用微调；关掉后保持索引原序。',
    group: 'launcher',
    control: { kind: 'switch' },
  },
  {
    key: 'quick_launcher_result_limit',
    label: '结果条数上限',
    hint: '浮层一次最多返回多少条结果，后端上限为 50。',
    group: 'launcher',
    control: { kind: 'number', unit: '条', min: 1, max: 50 },
  },
  {
    key: 'quick_launcher_fill_enabled',
    label: '允许打开并安全填充',
    hint: '关闭后浏览器扩展收到的一律降级为手动复制。',
    group: 'launcher',
    control: { kind: 'switch' },
  },
];

export const SETTING_SPEC_BY_KEY = new Map(SETTING_SPECS.map((spec) => [spec.key, spec]));

export function parseBool(value: string | undefined): boolean {
  return value === 'true';
}
