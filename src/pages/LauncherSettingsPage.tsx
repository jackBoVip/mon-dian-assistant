import { useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryKeys } from '../lib/queryClient';
import { Button } from '../components/ui/Button';
import { TextField } from '../components/ui/Field';
import { Badge } from '../components/ui/Badge';
import { Switch } from '../components/ui/switch';
import { Loading, ErrorState } from '../components/ui/StateBlocks';
import { notify } from '../state/notify';
import { toNormalisedError } from '../lib/errors';
import { PageHeader } from '../components/PageHeader';
import { PAGE_META } from '../lib/pageMeta';

/**
 * 一行的外壳：左侧标题与说明，右侧控件。与安全策略页那批设置行同一套版式，
 * 两处差别是这一页的卡片整幅宽（1200px），控件若仍按整块垂直居中就会飘到三行说明中间，
 * 所以改成与标题同一基线顶对齐，说明另按 CJK 一行 ~56 字收在 max-w-2xl 里。
 */
function SettingRow({ title, hint, children }: { title: string; hint: string; children: ReactNode }) {
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-6 border-b border-line py-3.5 last:border-b-0">
      <span className="min-w-0">
        <span className="block text-sm text-ink">{title}</span>
        <span className="mt-1 block max-w-2xl text-pretty text-xs leading-relaxed text-ink-body">{hint}</span>
      </span>
      <span className="flex shrink-0 items-center gap-2 pt-0.5">{children}</span>
    </li>
  );
}

/** 概览条里的一格：上面一行小标签，下面一行当前值（键名芯片、徽标或数字）。 */
function Overview({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="launcher-kpi">
      <span className="launcher-kpi-label">{label}</span>
      <span className="launcher-kpi-value">{children}</span>
    </div>
  );
}

/** 快速启动器设置（主窗口次级页）：读取/展示后端快捷键与开关状态；注册与冲突处理全部由 Rust 完成。 */
export function LauncherSettingsPage() {
  const qc = useQueryClient();
  const prefs = useQuery({ queryKey: queryKeys.launcherPrefs, queryFn: () => api.launcherPreferences() });
  const [accel, setAccel] = useState('');

  function invalidate() {
    void qc.invalidateQueries({ queryKey: queryKeys.launcherPrefs });
  }
  const onError = (raw: unknown) => notify('danger', toNormalisedError(raw).message);

  const setShortcut = useMutation({
    mutationFn: () => api.setLauncherShortcut(accel.trim()),
    onSuccess: (r) => {
      notify(r.registered ? 'success' : 'warning', r.hint);
      setAccel('');
      invalidate();
    },
    onError,
  });

  const setEnabled = useMutation({
    mutationFn: (enabled: boolean) => api.setLauncherEnabled(enabled),
    onSuccess: (r) => {
      notify('success', r.hint);
      invalidate();
    },
    onError,
  });

  // 走通用 update_setting：键在后端白名单里，布尔值只认 true/false，权限同样是 SYS_SECURITY。
  const setShowRecent = useMutation({
    mutationFn: (show: boolean) => api.updateSetting('quick_launcher_show_recent', show ? 'true' : 'false'),
    onSuccess: () => {
      notify('success', '已提交，下一次唤起即生效');
      invalidate();
    },
    onError,
  });

  // 需求 line 294 排序优先级里"最近使用/收藏"这一档的可配置开关，同样每次查询由后端读取。
  const setRankOrder = useMutation({
    mutationFn: (on: boolean) => api.updateSetting('quick_launcher_rank_recent_favorite', on ? 'true' : 'false'),
    onSuccess: () => {
      notify('success', '已提交，下一次查询即生效');
      invalidate();
    },
    onError,
  });

  return (
    <div className="page-panel">
      <PageHeader title={PAGE_META.launcher.label} desc={PAGE_META.launcher.desc} />
      {/* 页头留在滚动区外，下面整段自己滚：.main-content 是 overflow:hidden，这页在 1280×821
          的默认窗口里就差 58px（Chrome 探针实测），窗口再矮一点「应用」钮直接够不着。
          .system-page-body 是同一件事，但那枚类属于系统管理那五页。 */}
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain pr-1">
        {prefs.isLoading ? <Loading label="读取启动器设置…" /> : null}
        {prefs.isError ? <ErrorState raw={prefs.error} onRetry={() => void prefs.refetch()} /> : null}
        {prefs.data ? (
          <>
            {/* BC 轮（2026-10-22）：这页原来是 672px 的一列窄栏，右边整块空着，四行"徽标 + 一颗文字按钮"
                把当前值和修改入口混在一起。现在把"现在是什么"抬到顶部四格概览，"要改什么"落到下面两张卡。 */}
            <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
              <Overview label="当前全局快捷键">
                {prefs.data.shortcut ? <kbd>{prefs.data.shortcut}</kbd> : <span className="text-ink-muted">未设置</span>}
              </Overview>
              <Overview label="默认快捷键">
                <kbd>{prefs.data.default}</kbd>
              </Overview>
              <Overview label="全局唤起">
                <Badge tone={prefs.data.enabled ? 'success' : 'muted'}>{prefs.data.enabled ? '启用' : '停用'}</Badge>
              </Overview>
              <Overview label="结果条数上限">
                <span className="tabular-nums">{prefs.data.resultLimit}</span>
                <span className="text-xs font-normal text-ink-body">条 · 在安全策略页改</span>
              </Overview>
            </div>

            <section className="surface p-4">
              <h2 className="text-sm font-semibold text-ink">唤起与推荐</h2>
              <p className="mt-1 text-xs leading-relaxed text-ink-body">
                三项都写在后端设置里，拨动即提交；下一次唤起或查询生效。
              </p>
              <ul className="mt-1 flex flex-col">
                <SettingRow
                  title="启用全局唤起"
                  hint="切换会同时注册或注销系统级快捷键，只改设置行不会立即生效。应用需保持后台运行，快捷键才能在其它前台应用中唤起浮层。"
                >
                  <Switch
                    aria-label="启用全局唤起"
                    checked={prefs.data.enabled}
                    disabled={setEnabled.isPending}
                    onCheckedChange={(checked) => setEnabled.mutate(checked)}
                  />
                </SettingRow>
                <SettingRow
                  title="空查询时显示最近/收藏"
                  hint="关掉后，输入为空时后端直接返回空结果（需求 §285：空查询的最近使用/收藏项应由设置启用）。执行真正的条件查询不受该开关影响。"
                >
                  <Switch
                    aria-label="空查询时显示最近/收藏"
                    checked={prefs.data.showRecentWhenEmpty}
                    disabled={setShowRecent.isPending}
                    onCheckedChange={(checked) => setShowRecent.mutate(checked)}
                  />
                </SettingRow>
                <SettingRow
                  title="同级结果按收藏/最近优先"
                  hint="排序优先级固定为 完全匹配 → 前缀匹配 → 包含匹配（需求 line 294）；这一档只决定同一匹配等级内部的先后，顺序为 收藏 > 默认账号 > 最近使用。关掉后同级结果保持索引原序，它永远不会把没通过多条件 AND 过滤的记录排回结果列表。"
                >
                  <Switch
                    aria-label="同级结果按收藏/最近优先"
                    checked={prefs.data.rankRecentFavorite}
                    disabled={setRankOrder.isPending}
                    onCheckedChange={(checked) => setRankOrder.mutate(checked)}
                  />
                </SettingRow>
              </ul>
            </section>

            <section className="surface p-4">
              <h2 className="text-sm font-semibold text-ink">修改全局快捷键</h2>
              <p className="mt-1 text-xs leading-relaxed text-ink-body">
                前端不自行注册：这里只读取后端当前值并提交修改，注册与冲突检测由 Rust 完成。
              </p>
              <div className="mt-3 flex items-end gap-3">
                <div className="w-full max-w-md">
                  <TextField
                    label="新的快捷键（accelerator 格式）"
                    value={accel}
                    onChange={(e) => setAccel(e.target.value)}
                    placeholder={`例如：${prefs.data.default}`}
                    hint="示例：CmdOrCtrl+Alt+Space、Ctrl+Shift+U。以后端注册结果为准；注册失败时后端会回滚旧键并提示。"
                  />
                </div>
                <Button variant="primary" disabled={!accel.trim() || setShortcut.isPending} onClick={() => setShortcut.mutate()}>
                  {setShortcut.isPending ? '提交中…' : '应用'}
                </Button>
              </div>
            </section>
          </>
        ) : null}
      </div>
    </div>
  );
}
