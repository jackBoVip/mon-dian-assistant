import type { ReactNode } from 'react';
import { UsersSection } from '../components/system/UsersSection';
import { PermissionsSection } from '../components/system/PermissionsSection';
import { SecuritySection } from '../components/system/SecuritySection';
import { AppearanceSection } from '../components/system/AppearanceSection';
import { AuditSection } from '../components/system/AuditSection';
import { BackupSection } from '../components/system/BackupSection';
import { UpdateSection } from '../components/system/UpdateSection';
import { PageHeader } from '../components/PageHeader';
import { PAGE_META, type PageKey } from '../lib/pageMeta';

/** 顶部胶囊里那三个系统落点：同一枚 menu.system 权限，三屏内容各自取用下面的分区。 */
type SystemPageKey = Extract<PageKey, 'members' | 'audit' | 'settings'>;

const SECTIONS: Record<SystemPageKey, { label: string; desc: string; body: ReactNode }> = {
  members: {
    ...PAGE_META.members,
    body: (
      <>
        <UsersSection />
        <PermissionsSection />
      </>
    ),
  },
  audit: { ...PAGE_META.audit, body: <AuditSection /> },
  settings: {
    ...PAGE_META.settings,
    body: (
      <>
        <SecuritySection />
        <AppearanceSection />
        <BackupSection />
        <UpdateSection />
      </>
    ),
  },
};

/**
 * 系统那一组三屏（成员管理 / 审计日志 / 系统配置）。
 * 原型把它们当成三个导航项，后端只给一枚 menu.system，所以三个落点共用这一个组件：
 * 分区归属在这里一次定死，界面上不会再出现"七个标签页挤在一行"的那版。
 */
export function SystemPage({ section }: { section: SystemPageKey }) {
  const s = SECTIONS[section];
  return (
    <div className="system-page">
      <PageHeader title={s.label} desc={s.desc} />
      <div className="system-page-body">{s.body}</div>
    </div>
  );
}
