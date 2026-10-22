import type { ReactNode } from 'react';
import { UsersSection } from '../components/system/UsersSection';
import { RolesSection } from '../components/system/RolesSection';
import { MenusSection } from '../components/system/MenusSection';
import { PermissionsSection } from '../components/system/PermissionsSection';
import { AuditSection } from '../components/system/AuditSection';
import { PageHeader } from '../components/PageHeader';
import { PAGE_META, type AdminPageKey } from '../lib/pageMeta';

const SECTIONS: Record<AdminPageKey, ReactNode> = {
  users: <UsersSection />,
  roles: <RolesSection />,
  menus: <MenusSection />,
  permissions: <PermissionsSection />,
  audit: <AuditSection />,
};

/** 系统管理二级页：页头与滚动体沿用原 .system-page 骨架，左栏由 AppShell 包在外面。 */
export function AdminPage({ section }: { section: AdminPageKey }) {
  return (
    <div className="system-page">
      <PageHeader title={PAGE_META[section].label} desc={PAGE_META[section].desc} />
      <div className="system-page-body">{SECTIONS[section]}</div>
    </div>
  );
}
