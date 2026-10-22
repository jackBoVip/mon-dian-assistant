import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { queryKeys } from '../../lib/queryClient';
import { keystoreDiagnosticsOptions } from '../../lib/queryOptions';
import type { LauncherShortcutStatus, SecurityStatus } from '../../lib/types';
import { Badge } from '../ui/Badge';
import { Input } from '../ui/field-primitives';
import { Select } from '../ui/select';
import { Switch } from '../ui/switch';
import { Loading, ErrorState } from '../ui/StateBlocks';
import { notify } from '../../state/notify';
import { toNormalisedError } from '../../lib/errors';
import { formatTimestamp } from '../../lib/format';
import {
  SETTING_GROUPS,
  SETTING_SPECS,
  parseBool,
  type SettingGroupId,
  type SettingSpec,
} from '../../lib/securitySettings';

function BoolBadge({ value, ok, ng }: { value: boolean; ok: string; ng: string }) {
  return <Badge tone={value ? 'success' : 'muted'}>{value ? ok : ng}</Badge>;
}

/** 未检测/未配置必须显式呈现，不得渲染成"安全/已加密"。 */
function StatusRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-line py-2 text-sm">
      <span className="text-ink-muted">{label}</span>
      <span className="text-right">{children}</span>
    </div>
  );
}

export function SecuritySection() {
  const sec = useQuery({ queryKey: queryKeys.security, queryFn: () => api.securityStatus() });
  const channel = useQuery({ queryKey: queryKeys.channelStatus, queryFn: () => api.extensionChannelStatus() });
  const sysinfo = useQuery({ queryKey: queryKeys.systemInfo, queryFn: () => api.systemInfo() });

  return (
    <div className="flex flex-col gap-6">
      <section>
        <h3 className="mb-2 text-sm font-semibold">安全状态</h3>
        {sec.isLoading ? <Loading label="读取安全状态…" /> : null}
        {sec.isError ? <ErrorState raw={sec.error} onRetry={() => void sec.refetch()} /> : null}
        {sec.data ? <SecurityStatusPanel s={sec.data} /> : null}
        <KeystoreSourcePanel />
      </section>

      <section>
        <h3 className="mb-2 text-sm font-semibold">扩展通道就绪状态</h3>
        {channel.isLoading ? <Loading label="读取通道状态…" /> : null}
        {channel.isError ? <ErrorState raw={channel.error} onRetry={() => void channel.refetch()} /> : null}
        {channel.data ? (
          <div className="surface p-4">
            <StatusRow label="扩展/宿主已就绪">
              <Badge tone={channel.data.ready ? 'success' : 'warning'}>{channel.data.ready ? '已连接' : '未就绪'}</Badge>
            </StatusRow>
            <StatusRow label="通道文件存在">{channel.data.channelFilePresent ? '是' : '否'}</StatusRow>
            <StatusRow label="待消费票据数">{channel.data.pendingTickets}</StatusRow>
            <p className="mt-2 text-xs text-ink-muted">{channel.data.note}</p>
            {!channel.data.ready ? (
              <p className="mt-1 text-xs text-ink-muted">未就绪时，自动填充按后端策略降级为「打开网站 + 手动输入/单独复制」。</p>
            ) : null}
          </div>
        ) : null}
      </section>

      <SettingsSection />

      <section>
        <h3 className="mb-2 text-sm font-semibold">系统信息（诊断，不含路径/密钥/凭据）</h3>
        {sysinfo.isLoading ? <Loading label="读取系统信息…" /> : null}
        {sysinfo.isError ? <ErrorState raw={sysinfo.error} onRetry={() => void sysinfo.refetch()} /> : null}
        {sysinfo.data ? (
          <div className="surface p-4 text-sm">
            <div className="mono flex flex-wrap gap-x-6 gap-y-1 text-xs">
              <span>版本：v{sysinfo.data.appVersion}</span>
              <span>平台：{sysinfo.data.os}/{sysinfo.data.arch}</span>
              <span>schema：{sysinfo.data.schemaVersion}</span>
              <span>目标数：{sysinfo.data.targetCount}</span>
              <span>
                主密钥存放：{sysinfo.data.dbKeyStore === 'local-file-0600' ? '本机 0600 文件' : '未确认'}
              </span>
              <span>遥测：{sysinfo.data.telemetry}</span>
            </div>
          </div>
        ) : null}
      </section>
    </div>
  );
}

/**
 * 数据库主密钥的实际存放位置。本包默认把它放在本机 0600 文件（操作者决定的配置，见
 * docs/密钥生命周期与加密边界.md），界面对如实显示，不得伪装成"已封装在系统密钥库里"；
 * 没有显式同意记录的那两种情况必须显眼，不能和正常态混在一起。
 */
function KeystoreSourcePanel() {
  const ks = useQuery(keystoreDiagnosticsOptions());
  if (ks.isLoading) return <Loading label="读取密钥存放诊断…" />;
  if (ks.isError) return <ErrorState raw={ks.error} onRetry={() => void ks.refetch()} />;
  const d = ks.data;
  if (!d) return null;
  return (
    <div className="surface mt-3 p-4">
      <StatusRow label="数据库主密钥存放位置">
        <Badge tone={d.dbKeyStore === 'local-file-0600' ? 'success' : 'danger'}>
          {d.dbKeyStore === 'local-file-0600' ? '本机文件（0600，仅当前系统账户可读写）' : '未确认'}
        </Badge>
      </StatusRow>
      <StatusRow label="这份文件密钥的来源">
        {/* 加设同意闸门之前留下的文件读得到，但必须如实标注为"未经本次确认"，不得显示成同意过的降级 */}
        <Badge tone={d.deviceKeyConsent === 'consented' ? 'success' : d.deviceKeyConsent === 'legacy-file' ? 'danger' : 'warning'}>
          {d.deviceKeyConsent === 'consented'
            ? '本次经操作者显式同意后写入'
            : d.deviceKeyConsent === 'legacy-file'
              ? '旧版本遗留（本机没有本次显式同意的记录）'
              : '读不到同意记录'}
        </Badge>
      </StatusRow>
      <p className="mt-2 text-xs text-ink-muted" role="status">
        {d.note}
      </p>
    </div>
  );
}

function SecurityStatusPanel({ s }: { s: SecurityStatus }) {
  return (
    <div className="surface p-4">
      <StatusRow label="数据库加密">
        {/* 后端只有 encrypted/unknown 两值：unknown 绝不显示为"已加密" */}
        <Badge tone={s.dbEncrypted === 'encrypted' ? 'success' : 'warning'}>
          {s.dbEncrypted === 'encrypted' ? '已加密（SQLCipher 校验通过）' : '未检测'}
        </Badge>
      </StatusRow>
      <StatusRow label="数据库主密钥">
        <Badge tone={s.dbKeyStore === 'local-file-0600' && s.deviceKeyConsent === 'consented' ? 'success' : s.dbKeyStore === 'local-file-0600' ? 'warning' : 'danger'}>
          {s.dbKeyStore === 'local-file-0600'
            ? s.deviceKeyConsent === 'consented'
              ? '本机 0600 文件（已经显式同意）'
              : s.deviceKeyConsent === 'legacy-file'
                ? '本机 0600 文件（旧版本遗留，无同意记录）'
                : '本机 0600 文件（无同意记录）'
            : '存放位置未确认'}
        </Badge>
      </StatusRow>
      <StatusRow label="空闲锁定（分钟）">{s.idleTimeoutMinutes}</StatusRow>
      <StatusRow label="失败锁定">
        {s.maxFailedAttempts} 次 / 锁定 {s.lockoutSeconds} 秒
      </StatusRow>
      {/* 显示的是后端夹紧后的生效值，不是配置原文。L 轮起这一项只作用于**导出容器口令**
          与导出面板的实时强度提示；主密码已不设强度要求，所以标签不能说"主密码"。 */}
      <StatusRow label="导出容器口令最小长度">
        {s.minPasswordLength} 个字符
        <span className="ml-1 text-xs text-ink-muted">（主密码不受此项约束；本项不得配置低于内置下限）</span>
      </StatusRow>
      <StatusRow label="休眠即锁定">
        <BoolBadge value={s.lockOnSystemSleep} ok="已开启（近似检测）" ng="已关闭" />
      </StatusRow>
      <StatusRow label="允许复制密码">
        <BoolBadge value={s.copyPasswordEnabled} ok="允许" ng="已禁用" />
      </StatusRow>
      <StatusRow label="复制密码需二次认证">
        <BoolBadge value={s.copyPasswordRequiresReauth} ok="需要" ng="不需要" />
      </StatusRow>
      <StatusRow label="查看秘密需二次认证">
        <BoolBadge value={s.revealRequiresReauth} ok="需要" ng="不需要" />
      </StatusRow>
      <StatusRow label="导出需二次认证">
        <BoolBadge value={s.exportRequiresReauth} ok="需要" ng="不需要" />
      </StatusRow>
      <StatusRow label="允许不安全协议">
        <BoolBadge value={s.insecureProtocolsAllowed} ok="已显式放开" ng="默认禁用" />
      </StatusRow>
      <StatusRow label="更新源">
        {!s.updateSourceConfigured ? (
          <Badge tone="muted">未配置（{s.updateSourceScheme}）</Badge>
        ) : (
          <Badge tone={s.updateSourceScheme === 'https' ? 'success' : 'danger'}>已配置（scheme：{s.updateSourceScheme}）</Badge>
        )}
      </StatusRow>
      <StatusRow label="更新签名公钥">
        <BoolBadge value={s.updateSignatureKeyConfigured} ok="已配置" ng="未配置（更新不得视为已验证）" />
      </StatusRow>
      <StatusRow label="浏览器扩展就绪">
        <BoolBadge value={s.extensionReady} ok="就绪" ng="未就绪（填充降级为手动复制）" />
      </StatusRow>
      <StatusRow label="最近备份">{s.lastBackupAt ? formatTimestamp(s.lastBackupAt) : <Badge tone="muted">从未备份</Badge>}</StatusRow>
      <StatusRow label="遥测">{s.telemetry === 'disabled' ? '已禁用（完全离线）' : s.telemetry}</StatusRow>
      <StatusRow label="schema 版本">
        <span className="mono text-xs">{s.schemaVersion}</span>
      </StatusRow>
      <p className="mt-2 text-xs text-ink-muted">
        「休眠即锁定」由定时 tick 之间墙上时间的异常跨度推断，无法区分系统休眠与进程被挂起；两种情况都要求重新认证，宁可多锁一次。
      </p>
    </div>
  );
}

type Commit = { spec: SettingSpec; value: string };

/**
 * 设置项：一行一项，右侧是控件，**改动即保存**（布尔与枚举即时提交，数字与文本在失焦/回车时提交）。
 *
 * 键到中文名、控件形态与上下限全部来自 `lib/securitySettings.ts`；这里只负责草稿、提交与失败回退。
 * 提交失败时草稿被丢弃，显示回到服务端值——不能让人看到"改了但其实没改"。
 */
function SettingsSection() {
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: queryKeys.settings, queryFn: () => api.settings() });
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const update = useMutation<unknown, unknown, Commit>({
    mutationFn: (input) =>
      input.spec.apply === 'launcher-toggle'
        ? api.setLauncherEnabled(input.value === 'true')
        : api.updateSetting(input.spec.key, input.value),
    onSuccess: (data, input) => {
      if (input.spec.apply === 'launcher-toggle') {
        const reply = data as LauncherShortcutStatus;
        notify(reply.registered ? 'success' : 'warning', reply.hint);
      } else {
        notify('success', '设置已保存');
      }
      dropDraft(input.spec.key);
      void qc.invalidateQueries({ queryKey: queryKeys.settings });
      void qc.invalidateQueries({ queryKey: queryKeys.security });
      void qc.invalidateQueries({ queryKey: queryKeys.launcherPrefs });
    },
    onError: (raw, input) => {
      notify('danger', toNormalisedError(raw).message);
      dropDraft(input.spec.key);
    },
  });

  function dropDraft(key: string) {
    setDrafts((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }

  function commit(spec: SettingSpec, raw: string, serverValue: string) {
    const value = raw.trim();
    if (value === serverValue) {
      dropDraft(spec.key);
      return;
    }
    if (spec.control.kind === 'number') {
      const { min, max, unit } = spec.control;
      const parsed = Number(value);
      if (value === '' || !Number.isInteger(parsed) || parsed < min || parsed > max) {
        dropDraft(spec.key);
        notify('warning', `${spec.label}请填 ${min}–${max} 之间的整数（${unit}）`);
        return;
      }
    }
    update.mutate({ spec, value });
  }

  const rows = settings.data ?? [];
  const server = new Map(rows.map(([key, value]) => [key, value]));
  const visible = SETTING_SPECS.filter((spec) => server.has(spec.key));
  const pendingKey = update.isPending ? update.variables?.spec.key : undefined;

  function valueOf(spec: SettingSpec): string {
    return drafts[spec.key] ?? server.get(spec.key) ?? '';
  }

  function control(spec: SettingSpec) {
    const value = valueOf(spec);
    const pending = pendingKey === spec.key;
    switch (spec.control.kind) {
      case 'switch':
        return (
          <Switch
            checked={parseBool(value)}
            disabled={pending}
            aria-label={spec.label}
            onCheckedChange={(checked) => {
              setDrafts((prev) => ({ ...prev, [spec.key]: String(checked) }));
              commit(spec, String(checked), server.get(spec.key) ?? '');
            }}
          />
        );
      case 'number':
        return (
          <span className="flex items-center gap-2">
            <span className="w-20">
              <Input
                type="number"
                inputMode="numeric"
                step={1}
                min={spec.control.min}
                max={spec.control.max}
                aria-label={spec.label}
                className="text-right tabular-nums"
                value={value}
                disabled={pending}
                onChange={(event) => setDrafts((prev) => ({ ...prev, [spec.key]: event.target.value }))}
                onBlur={(event) => commit(spec, event.target.value, server.get(spec.key) ?? '')}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') event.currentTarget.blur();
                }}
              />
            </span>
            <span className="text-xs text-ink-muted">{spec.control.unit}</span>
          </span>
        );
      case 'text':
        return (
          <span className={spec.control.size === 'lg' ? 'w-72' : 'w-56'}>
            <Input
              aria-label={spec.label}
              placeholder={spec.control.placeholder}
              spellCheck={false}
              value={value}
              disabled={pending}
              onChange={(event) => setDrafts((prev) => ({ ...prev, [spec.key]: event.target.value }))}
              onBlur={(event) => commit(spec, event.target.value, server.get(spec.key) ?? '')}
              onKeyDown={(event) => {
                if (event.key === 'Enter') event.currentTarget.blur();
              }}
            />
          </span>
        );
      case 'select':
        return (
          <span className="w-28">
            <Select
              aria-label={spec.label}
              value={value}
              options={spec.control.options}
              disabled={pending}
              onValueChange={(next) => {
                setDrafts((prev) => ({ ...prev, [spec.key]: next }));
                commit(spec, next, server.get(spec.key) ?? '');
              }}
            />
          </span>
        );
    }
  }

  return (
    <section>
      <div className="mb-3 flex items-start justify-between gap-4">
        <div>
          <h3 className="text-sm font-semibold">设置项</h3>
          <p className="mt-1 max-w-2xl text-xs text-ink-muted">
            改动后自动保存。只列出本页可改的项——主题、外观与快捷键等由各自页面维护；按钮类切换要在下次敏感操作时才会被要求二次认证。
          </p>
        </div>
        <Badge tone={update.isPending ? 'warning' : 'muted'}>{update.isPending ? '保存中…' : '自动保存'}</Badge>
      </div>

      {settings.isLoading ? <Loading label="读取设置…" /> : null}
      {settings.isError ? <ErrorState raw={settings.error} onRetry={() => void settings.refetch()} /> : null}
      {!settings.isLoading && !settings.isError && visible.length === 0 ? (
        <p className="text-sm text-ink-muted">后端未返回可修改的设置项。</p>
      ) : null}

      {visible.length > 0 && !settings.isError ? (
        <div className="grid items-start gap-4 xl:grid-cols-2">
          {/* 两栏各自成列：按列排而不是按行排，避免"会话/密码"行高差在中间留一块空洞。
              窄屏回落成单列，顺序与 DOM 一致（会话 → 网络 → 密码 → 启动器）。 */}
          {([['session', 'network'], ['secret', 'launcher']] as SettingGroupId[][]).map((column) => (
            <div key={column.join(':')} className="flex flex-col gap-4">
              {column.map((groupId) => {
                const group = SETTING_GROUPS.find((item) => item.id === groupId);
                const specs = group ? visible.filter((spec) => spec.group === group.id) : [];
                if (!group || specs.length === 0) return null;
                return (
                  <div key={group.id} className="surface p-4">
                    <div className="mb-1">
                      <h4 className="text-sm font-semibold">{group.title}</h4>
                      <p className="text-[11px] text-ink-muted">{group.hint}</p>
                    </div>
                    <ul className="flex flex-col">
                      {specs.map((spec) => (
                        <li
                          key={spec.key}
                          className="flex items-center justify-between gap-4 border-b border-line py-3 last:border-b-0"
                        >
                          <span className="min-w-0" title={spec.key}>
                            <span className="block text-sm">{spec.label}</span>
                            <span className="mt-0.5 block text-pretty text-xs leading-relaxed text-ink-muted">{spec.hint}</span>
                          </span>
                          <span className="flex shrink-0 items-center gap-2">{control(spec)}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}
