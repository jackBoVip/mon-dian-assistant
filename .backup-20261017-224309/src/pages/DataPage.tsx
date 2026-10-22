import { useState } from 'react';
import { ImportPanel } from '../components/data/ImportPanel';
import { ExportPanel } from '../components/data/ExportPanel';
import { LedgerAccountHint } from '../components/auth/TermHints';

type DataTab = 'import' | 'export';

const TABS: Array<{ key: DataTab; label: string }> = [
  { key: 'import', label: '批量导入' },
  { key: 'export', label: '批量导出' },
];

/** 数据导入/导出页：台账 CSV 批量导入与（可选口令加密容器的）批量导出。 */
export function DataPage() {
  const [tab, setTab] = useState<DataTab>('import');

  return (
    <div>
      <p className="mb-3 text-xs text-ink-muted">
        本页搬运的是<strong>外部系统账号台账</strong>（批量 CSV 导入 / 导出），不是本软件的保险库备份文件。
        导入导出均由后端按 RBAC 权限校验；含秘密导出额外要求主密码二次认证。
      </p>
      <LedgerAccountHint />

      <div className="my-3 flex flex-wrap items-center gap-2" role="tablist" aria-label="导入导出切换">
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

      <div role="tabpanel" aria-label={tab === 'import' ? '批量导入' : '批量导出'}>
        {tab === 'import' ? <ImportPanel /> : <ExportPanel />}
      </div>
    </div>
  );
}
