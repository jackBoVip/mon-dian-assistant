import type { ReactNode } from 'react';
import { SecuritySection } from '../components/system/SecuritySection';
import { AppearanceSection } from '../components/system/AppearanceSection';
import { BackupSection } from '../components/system/BackupSection';
import { UpdateSection } from '../components/system/UpdateSection';
import { ExternalToolsSection } from '../components/system/ExternalToolsSection';
import { PageHeader } from '../components/PageHeader';
import { PAGE_META, type SettingsPageKey } from '../lib/pageMeta';

const SECTIONS: Record<SettingsPageKey, ReactNode> = {
  security: <SecuritySection />,
  appearance: <AppearanceSection />,
  backup: <BackupSection />,
  update: <UpdateSection />,
  tools: <ExternalToolsSection />,
};

/** 齿轮下拉里的五个独立设置页：无左侧栏，单栏滚动。 */
export function SettingsPage({ section }: { section: SettingsPageKey }) {
  return (
    <div className="system-page">
      <PageHeader title={PAGE_META[section].label} desc={PAGE_META[section].desc} />
      <div className="system-page-body">{SECTIONS[section]}</div>
    </div>
  );
}
