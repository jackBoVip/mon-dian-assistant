import { useState } from 'react';
import { ImportPanel } from '../components/data/ImportPanel';
import { ExportPanel } from '../components/data/ExportPanel';
import { LedgerAccountHint } from '../components/auth/TermHints';
import { PageHeader } from '../components/PageHeader';
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
      <div className="tabs" role="tablist" aria-label="导入导出切换">
        {TABS.map((t) => {
          const active = tab === t.key;
          return (
            <button
              key={t.key}
              role="tab"
              aria-selected={active}
              type="button"
              onClick={() => setTab(t.key)}
              className="chip-toggle"
            >
              {t.label}
            </button>
          );
        })}
      </div>

      <div className="main-panel">
        <div className="panel-notice">
          <LedgerAccountHint />
        </div>
        <div role="tabpanel" aria-label={tab === 'import' ? '批量导入' : '批量导出'}>
          {tab === 'import' ? <ImportPanel /> : <ExportPanel />}
        </div>
      </div>
    </div>
  );
}
