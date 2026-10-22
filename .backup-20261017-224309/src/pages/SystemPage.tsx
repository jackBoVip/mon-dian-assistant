import { useState } from 'react';
import { UsersSection } from '../components/system/UsersSection';
import { PermissionsSection } from '../components/system/PermissionsSection';
import { SecuritySection } from '../components/system/SecuritySection';
import { AppearanceSection } from '../components/system/AppearanceSection';
import { AuditSection } from '../components/system/AuditSection';
import { BackupSection } from '../components/system/BackupSection';
import { UpdateSection } from '../components/system/UpdateSection';

type Tab = 'users' | 'permissions' | 'security' | 'appearance' | 'audit' | 'backup' | 'update';

const TABS: Array<{ key: Tab; label: string }> = [
  { key: 'users', label: '用户与角色' },
  { key: 'permissions', label: '权限矩阵' },
  { key: 'security', label: '安全设置' },
  { key: 'appearance', label: '外观' },
  { key: 'audit', label: '审计日志' },
  { key: 'backup', label: '备份' },
  { key: 'update', label: '更新' },
];

/** 系统管理：管理本软件自身（用户/角色/权限/安全/外观/审计/备份/更新）。 */
export function SystemPage() {
  const [tab, setTab] = useState<Tab>('users');

  return (
    <div>
      <p className="mb-3 text-xs text-ink-muted">
        本菜单管理「蒙电信产助手」自身，与左侧「账号管理」中的外部系统台账账号完全分开。
      </p>
      <div className="mb-4 flex flex-wrap gap-2" role="tablist" aria-label="系统管理分区">
        {TABS.map((t) => {
          const active = tab === t.key;
          return (
            <button
              key={t.key}
              role="tab"
              type="button"
              aria-selected={active}
              onClick={() => setTab(t.key)}
              className="chip-toggle"
            >
              {t.label}
            </button>
          );
        })}
      </div>

      <div role="tabpanel">
        {tab === 'users' ? <UsersSection /> : null}
        {tab === 'permissions' ? <PermissionsSection /> : null}
        {tab === 'security' ? <SecuritySection /> : null}
        {tab === 'appearance' ? <AppearanceSection /> : null}
        {tab === 'audit' ? <AuditSection /> : null}
        {tab === 'backup' ? <BackupSection /> : null}
        {tab === 'update' ? <UpdateSection /> : null}
      </div>
    </div>
  );
}
