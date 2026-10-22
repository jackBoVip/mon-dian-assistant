import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryKeys } from '../lib/queryClient';
import { openTarget } from '../lib/actions';
import type { Tone } from '../lib/tone';
import { useGlance } from '../state/glance';
import { Icon } from './ui/Icon';

/**
 * 「此刻」面板：内容区底部居中的常驻可展开面板（DESIGN.md 的 Chat Widget 规格）。
 * 只读两条既有命令——recent_access(5) 与 keystore_diagnostics——不新增任何后端能力，
 * 也不显示任何秘密字段：行里只有目标名与账号别名（都是脱敏后的展示字段）。
 * 情绪（data-tone）完全由后端诊断给出，本地不做推断。
 */
export function GlancePanel() {
  const collapsed = useGlance((s) => s.collapsed);
  const toggle = useGlance((s) => s.toggle);

  const ks = useQuery({ queryKey: ['keystoreDiagnostics'], queryFn: () => api.keystoreDiagnostics() });
  // 收起时不发起 recent_access：面板常驻但只在展开时才取那一叠行
  const recent = useQuery({
    queryKey: queryKeys.recentAccess,
    queryFn: () => api.recentAccess(5),
    enabled: !collapsed,
  });

  const d = ks.data;
  // 存放位置未确认是真故障（bad），没有显式同意记录只是要人去看一眼（warn）。
  const tone: Tone = ks.isError
    ? 'bad'
    : !d
      ? 'neutral'
      : d.dbKeyStore !== 'local-file-0600'
        ? 'bad'
        : d.deviceKeyConsent === 'consented'
          ? 'ok'
          : 'warn';
  const summary = ks.isError
    ? '密钥存放状态读取失败'
    : !d
      ? '正在读取密钥存放状态…'
      : d.dbKeyStore !== 'local-file-0600' || d.deviceKeyConsent !== 'consented'
        ? `${d.dbKeyStore === 'local-file-0600' ? '数据库主密钥在本机 0600 文件' : '数据库主密钥存放位置未确认'}：${d.note}`
        : '数据库主密钥在本机 0600 文件（已经你的显式同意）';

  const rows = recent.data ?? [];

  return (
    <aside className="glance" data-tone={tone} aria-label="此刻">
      <div className="glance-head">
        <button
          type="button"
          className="glance-toggle"
          aria-expanded={!collapsed}
          aria-controls="glance-body"
          onClick={toggle}
        >
          <Icon name="clock" size={14} />
          <span className="glance-title">此刻</span>
          <span className="glance-summary">{summary}</span>
          <span className="glance-action">{collapsed ? '展开' : '收起'}</span>
        </button>
      </div>
      {collapsed ? null : (
        <div className="glance-body" id="glance-body">
          {recent.isError ? <p className="glance-empty">最近访问读取失败</p> : null}
          {recent.isLoading ? <p className="glance-empty">正在读取最近访问…</p> : null}
          {!recent.isLoading && !recent.isError && rows.length === 0 ? (
            <p className="glance-empty">还没有访问记录。</p>
          ) : null}
          {rows.length > 0 ? (
            <ul className="glance-chips">
              {rows.map((r) => (
                <li key={r.itemId}>
                  <button
                    type="button"
                    className="glance-chip"
                    title={`打开 ${r.targetName}`}
                    onClick={() => void openTarget(r.targetId)}
                  >
                    {r.targetName} · {r.accountAlias}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      )}
    </aside>
  );
}
