import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryKeys } from '../lib/queryClient';
import { Button } from '../components/ui/Button';
import { TextField } from '../components/ui/Field';
import { Badge } from '../components/ui/Badge';
import { Loading, ErrorState } from '../components/ui/StateBlocks';
import { notify } from '../state/notify';
import { toNormalisedError } from '../lib/errors';

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
    <div className="flex max-w-2xl flex-col gap-4">
      <p className="text-xs text-ink-muted">
        系统级全局快捷键由 Rust 后端注册与检测冲突；前端不自行注册，只读取当前值并提交修改。应用需保持后台运行，快捷键才能在其它前台应用中唤起浮层。
      </p>

      {prefs.isLoading ? <Loading label="读取启动器设置…" /> : null}
      {prefs.isError ? <ErrorState raw={prefs.error} onRetry={() => void prefs.refetch()} /> : null}
      {prefs.data ? (
        <>
          <div className="surface p-4">
            <div className="flex items-center justify-between">
              <span className="text-sm text-ink-muted">当前全局快捷键</span>
              <kbd>{prefs.data.shortcut || '未设置'}</kbd>
            </div>
            <div className="mt-2 flex items-center justify-between">
              <span className="text-sm text-ink-muted">默认快捷键</span>
              <kbd>{prefs.data.default}</kbd>
            </div>
            <div className="mt-2 flex items-center justify-between">
              <span className="text-sm text-ink-muted">唤起已启用</span>
              <span className="flex items-center gap-2">
                <Badge tone={prefs.data.enabled ? 'success' : 'muted'}>{prefs.data.enabled ? '启用' : '停用'}</Badge>
                <Button variant="ghost" disabled={setEnabled.isPending} onClick={() => setEnabled.mutate(!prefs.data!.enabled)}>
                  {setEnabled.isPending ? '提交中…' : prefs.data.enabled ? '停用全局唤起' : '启用全局唤起'}
                </Button>
              </span>
            </div>
            <div className="mt-2 flex items-center justify-between">
              <span className="text-sm text-ink-muted">空查询时显示最近/收藏</span>
              <span className="flex items-center gap-2">
                <Badge tone={prefs.data.showRecentWhenEmpty ? 'success' : 'muted'}>
                  {prefs.data.showRecentWhenEmpty ? '显示' : '不显示'}
                </Badge>
                <Button variant="ghost" disabled={setShowRecent.isPending} onClick={() => setShowRecent.mutate(!prefs.data!.showRecentWhenEmpty)}>
                  {setShowRecent.isPending ? '提交中…' : prefs.data.showRecentWhenEmpty ? '关闭推荐' : '开启推荐'}
                </Button>
              </span>
            </div>
            <p className="mt-1 text-xs text-ink-muted">
              关掉后，输入为空时后端直接返回空结果（需求 §285：空查询的最近使用/收藏项应由设置启用）。执行真正的条件查询不受该开关影响。
            </p>
            <div className="mt-2 flex items-center justify-between">
              <span className="text-sm text-ink-muted">同级结果按收藏/最近优先</span>
              <span className="flex items-center gap-2">
                <Badge tone={prefs.data.rankRecentFavorite ? 'success' : 'muted'}>
                  {prefs.data.rankRecentFavorite ? '按收藏/默认/最近排序' : '只按匹配等级排序'}
                </Badge>
                <Button variant="ghost" disabled={setRankOrder.isPending} onClick={() => setRankOrder.mutate(!prefs.data!.rankRecentFavorite)}>
                  {setRankOrder.isPending ? '提交中…' : prefs.data.rankRecentFavorite ? '关闭该排序档' : '开启该排序档'}
                </Button>
              </span>
            </div>
            <p className="mt-1 text-xs text-ink-muted">
              排序优先级固定为 完全匹配 → 前缀匹配 → 包含匹配（需求 line 294）；这一档只决定同一匹配等级内部的先后，顺序为 收藏 &gt; 默认账号 &gt;
              最近使用。关掉后同级结果保持索引原序。它永远不会把没通过多条件 AND 过滤的记录排回结果列表。
            </p>
            <div className="mt-2 flex items-center justify-between">
              <span className="text-sm text-ink-muted">结果条数上限（后端设置）</span>
              <span className="num">{prefs.data.resultLimit}</span>
            </div>
          </div>

          <div className="surface flex items-end gap-2 p-4">
            <div className="flex-1">
              <TextField
                label="修改快捷键（accelerator 格式）"
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
        </>
      ) : null}
    </div>
  );
}
