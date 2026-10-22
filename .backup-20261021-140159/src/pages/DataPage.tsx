import { useState } from 'react';
import { ImportPanel } from '../components/data/ImportPanel';
import { ExportPanel } from '../components/data/ExportPanel';
import { LedgerAccountHint } from '../components/auth/TermHints';
import { PageHeader } from '../components/PageHeader';
import { Tabs, TabsList, TabsTrigger } from '../components/ui/tabs';
import { PAGE_META } from '../lib/pageMeta';

type DataTab = 'import' | 'export';

const TABS: Array<{ key: DataTab; label: string }> = [
  { key: 'import', label: '批量导入' },
  { key: 'export', label: '批量导出' },
];

/** 数据导入/导出页：台账 CSV 批量导入与（可选口令加密容器的）批量导出。 */
export function DataPage() {
  const [tab, setTab] = useState<DataTab>('import');

  return (
    <div className="page-panel">
      <PageHeader title={PAGE_META.data.label} desc={PAGE_META.data.desc} />
      <Tabs value={tab} onValueChange={(v) => setTab(v as DataTab)}>
        {/* role=tablist 由 Radix 的 List 自己给；标签行外壳仍是那条 .tabs，几何没换地方。
         *  面板不进 Tabs：两栏内容互斥渲染，切走的一侧不挂载，也就不多发一次目标列表查询。 */}
        <TabsList className="tabs" aria-label="导入导出切换">
          {TABS.map((t) => (
            <TabsTrigger key={t.key} value={t.key}>
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>

        <div className="main-panel">
          <div className="panel-notice">
            <LedgerAccountHint />
          </div>
          <div role="tabpanel" aria-label={tab === 'import' ? '批量导入' : '批量导出'}>
            {tab === 'import' ? <ImportPanel /> : <ExportPanel />}
          </div>
        </div>
      </Tabs>
    </div>
  );
}
