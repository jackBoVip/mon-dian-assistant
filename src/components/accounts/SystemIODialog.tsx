import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { isTauri, api } from '../../lib/api';
import { invalidateTargetLists, queryKeys } from '../../lib/queryClient';
import { openFile, saveFileDialog, saveTextFile } from '../../lib/dialogs';
import { toNormalisedError } from '../../lib/errors';
import { notify } from '../../state/notify';
import type { ImportCommitResult, ImportPreview } from '../../lib/types';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { Alert } from '../ui/alert';
import { Checkbox } from '../ui/checkbox';
import { Label } from '../ui/field-primitives';

export type SystemIOMode = 'import' | 'export';

export interface SystemIODialogProps {
  open: boolean;
  mode: SystemIOMode;
  /** 导出格式：左栏导出下拉那两行决定（导出 Excel = xlsx，导出 CSV = csv）。导入侧不用它，格式由文件内容决定。 */
  format: 'csv' | 'xlsx';
  /** 导出范围锁在当前选中的系统上（原型 exportView 那句"当前系统下的所有账号凭据"就是这个意思）。 */
  targetId: string | null;
  targetName: string;
  onClose: () => void;
}

/** 弹窗标题：原型 1137/1157 那三档文案（导入一个标题，导出按格式两个标题）。 */
function dialogTitle(mode: SystemIOMode, format: 'csv' | 'xlsx'): string {
  if (mode === 'import') return '导入系统与账号';
  return format === 'xlsx' ? '导出 Excel' : '导出 CSV';
}

/** 导出格式回显：原型 1160 那个字符串连括号一起照抄。 */
function formatLabel(format: 'csv' | 'xlsx'): string {
  return format === 'xlsx' ? 'Excel (.xlsx)' : 'CSV (.csv)';
}

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

/**
 * 导入完成后的那句话只报后端给的计数，界面上不自己数行。
 * 弹窗提交成功就关了，这句 toast 是这些计数唯一的落点 —— 有行没写进去时必须一并报出来，
 * 不然用户以为文件里的行全进库了。
 */
function importSummary(res: ImportCommitResult): string {
  const base = `导入完成：新增 ${res.createdTargets} 个系统、${res.createdItems} 条凭据，跳过 ${res.skippedRows} 行，冲突 ${res.conflictRows} 行。`;
  return res.errors.length ? `${base}其中 ${res.errors.length} 行有错误未写入。` : base;
}

/**
 * 账号中心左栏的导入 / 导出弹窗（原型 807-862 的 importView / exportView）。
 *
 * 导入按文件内容自动识别 CSV / XLSX（后端 parse_upload 先嗅探再按表头判定，扩展名说了不算），
 * 冲突一律按「跳过」提交。口令加密容器（`.mdaexport`）与「更新 / 中止」两档后端命令仍在，
 * 但 2026-10-22 BE 轮起界面上没有入口——原先接在「导入/导出」页，那一页已整页移除（见 §1-BE）。
 * 导出是 Chrome / Edge 的形状：name,url,username,password,note 五列，勾了「包含明文密码」
 * 就把可读口令写进文件——文件本身没有任何保护，所以那句风险话必须留在界面上。
 * 交付方 2026-10-19：导出去掉主密码二次确认，点「确认导出」直接落盘（出厂策略随之关掉，
 * 见 settings 键 export_requires_reauth）。
 */
export function SystemIODialog({ open, mode, format, targetId, targetName, onClose }: SystemIODialogProps) {
  const qc = useQueryClient();
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  /** 已经拿到手的那份文件（完整路径）。识别失败也留着，让界面说得出"错的是哪一份"。 */
  const [picked, setPicked] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [includeSecrets, setIncludeSecrets] = useState(true);
  const [savePath, setSavePath] = useState('');

  // 关掉重开、或这一份实例被另一种模式复用：一次完整重置，不留上一轮的文件名与报错
  useEffect(() => {
    if (!open) {
      setPreview(null);
      setPicked(null);
      setStatus(null);
      setError(null);
      setSavePath('');
      setIncludeSecrets(true);
      // 审查 F26：dragOver 以前不在重置清单里——鼠标正悬在拖拽区上时关掉弹窗，
      // 重开之后高亮还挂着，看着像"已经选中了文件"。
      setDragOver(false);
    }
  }, [open, mode, format]);

  const previewMut = useMutation({
    mutationFn: (path: string) => api.importPreview(path),
    onSuccess: (p) => {
      setPreview(p);
      setError(null);
    },
    onError: (raw) => {
      setPreview(null);
      const err = toNormalisedError(raw);
      setError(`${err.message}${err.detail ? `（${err.detail}）` : ''}`);
    },
  });

  /**
   * 识别回执：那四个计数说的是后端**按文件内容**嗅探出的格式与逐行判定，不是文件扩展名。
   *
   * 交付方 2026-10-20 指定它落在拖拽区里、文件名下面那一行，原来那句
   * 「点击或拖入另一份文件可替换」撤掉。所以它由 `preview` 直接派生（不再经 `status` 中转）：
   * 同一句话只有一个来源，也不会出现"文件名是新的、计数是上一份的"这种错位。
   * `status` 从此只装会消失的动作回执（取消选文件、模板写到哪里）。
   */
  const parsedSummary = preview
    ? `已识别为 ${preview.fileFormat}：共 ${preview.totalRows} 行，可导入 ${preview.validRows} 行，错误 ${preview.errorRows} 行，冲突 ${preview.conflictRows} 行。`
    : null;

  /** 点击与拖拽两条路都走这里：先把文件名落到框里，再让后端嗅探格式。 */
  function pickAndPreview(path: string) {
    setPicked(path);
    previewMut.mutate(path);
  }

  const pickFile = useMutation({
    mutationFn: async () => {
      const path = await openFile({
        title: '选择要导入的文件（CSV 或 Excel）',
        filters: [{ name: '表格文件', extensions: ['csv', 'xlsx'] }],
      });
      if (!path) return null;
      return path;
    },
    onSuccess: (path) => {
      if (!path) {
        setStatus('已取消文件选择。');
        return;
      }
      pickAndPreview(path);
    },
    onError: (raw) => setError(toNormalisedError(raw).message),
  });

  const commitMut = useMutation({
    mutationFn: () => {
      if (!preview) throw new Error('缺少预览结果');
      return api.importCommit(preview.jobId, 'skip');
    },
    onSuccess: (res) => {
      setPreview(null);
      setPicked(null);
      invalidateTargetLists(qc);
      void qc.invalidateQueries({ queryKey: queryKeys.groups });
      void qc.invalidateQueries({ queryKey: queryKeys.stats });
      notify('success', importSummary(res));
      // 交付方 2026-10-19：导入成功后弹窗必须自己关掉。计数由上面那句 toast 报，
      // 界面里的结果段落随之删除 —— 留着只会让人以为要点关闭才知道导入完了。
      onClose();
    },
    onError: (raw) => setError(toNormalisedError(raw).message),
  });

  const templateMut = useMutation({
    mutationFn: async () => {
      const t = await api.importTemplate();
      const saved = await saveTextFile(
        { title: '保存导入模板（CSV）', defaultPath: '导入模板.csv', filters: [{ name: 'CSV 文件', extensions: ['csv'] }] },
        t.csv,
      );
      return { t, saved };
    },
    onSuccess: ({ saved }) => {
      setStatus(saved ? `模板已写出：${baseName(saved.path)}（字节经系统下载通道落盘）。` : '已取消模板保存。');
    },
    onError: (raw) => setError(toNormalisedError(raw).message),
  });

  const exportMut = useMutation({
    mutationFn: async () => {
      if (!targetId) throw new Error('请先选择一个系统');
      if (!savePath) throw new Error('请先选择保存路径');
      return api.exportCommit({
        path: savePath,
        includeSecrets,
        passphrase: null,
        targetIds: [targetId],
        format,
        shape: 'browser',
      });
    },
    onSuccess: (res) => {
      notify('success', res.message);
      // 与上面 commitMut 同一条口径（交付方 2026-10-19 点名的是导入，导出这一侧当时漏了）：
      // 文件已经落盘，界面里既没有回执也没有进度，留着一张原样的面板只会让人以为还没导。
      // 失败与两条前置拦截（没选路径 / 左栏没选中系统）仍然不关窗——报错得留在原地让人补。
      onClose();
    },
    onError: (raw) => {
      const err = toNormalisedError(raw);
      setError(`导出失败：${err.message}${err.detail ? `（${err.detail}）` : ''}`);
    },
  });

  async function pickDestination() {
    setError(null);
    const path = await saveFileDialog({
      title: format === 'xlsx' ? '选择 Excel 导出路径（.xlsx）' : '选择 CSV 导出路径（.csv）',
      defaultPath: `${targetName || '账号导出'}.${format}`,
      filters: [{ name: format === 'xlsx' ? 'Excel 工作簿' : 'CSV 文件', extensions: [format] }],
    }).catch((raw: unknown) => {
      setError(toNormalisedError(raw).message);
      return null;
    });
    if (path) setSavePath(path);
  }

  function onConfirm() {
    setError(null);
    if (mode === 'import') {
      // 没有 preview 时按钮本身就是禁的（原型 1139 那一条），这里不需要再守一遍
      commitMut.mutate();
      return;
    }
    if (!targetId) {
      setError('请先在左栏选择一个系统。');
      return;
    }
    if (!savePath) {
      setError('请先选择保存路径。');
      return;
    }
    exportMut.mutate();
  }

  // 拖拽：Tauri 的 webview 拖放事件给的是真实路径（HTML5 的 File 对象没有路径，后端读不到）。
  // 只在本弹窗打开期间订阅，关掉立刻退订，避免拖放到其它页面时也触发导入。
  useEffect(() => {
    if (!open || mode !== 'import' || !isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void import('@tauri-apps/api/webview')
      .then(({ getCurrentWebview }) => getCurrentWebview().onDragDropEvent((event) => {
        if (disposed) return;
        const p = event.payload;
        if (p.type === 'over') setDragOver(true);
        else if (p.type === 'leave') setDragOver(false);
        else if (p.type === 'drop') {
          setDragOver(false);
          const first = p.paths[0];
          if (first) pickAndPreview(first);
          else setError('拖拽的内容里没有文件路径。');
        }
      }))
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => {
        /* 订阅失败只意味着拖拽不可用，点击选择照常 */
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [open, mode]);

  const busy = previewMut.isPending || commitMut.isPending || pickFile.isPending || exportMut.isPending || templateMut.isPending;

  return (
    <Modal
      open={open}
      title={dialogTitle(mode, format)}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          {/* 原型 1138-1139：导入那颗「开始导入」在识别出文件之前是禁的，导出那颗叫「确认导出」。
            * 提交一成功 preview 就清空并关闭弹窗（见 commitMut），连点两次提不了两遍。 */}
          <Button
            variant="primary"
            onClick={onConfirm}
            disabled={busy || (mode === 'import' && preview === null)}
          >
            {busy ? '处理中…' : mode === 'import' ? '开始导入' : '确认导出'}
          </Button>
        </>
      }
    >
      {mode === 'import' ? (
        <div className="flex flex-col gap-4">
          <div
            className={dragOver ? 'drop-zone is-dragover' : 'drop-zone'}
            role="button"
            tabIndex={0}
            aria-label={picked ? `已选择 ${baseName(picked)}，点击可换一份文件` : '选择要导入的 CSV 或 Excel 文件'}
            onClick={() => pickFile.mutate()}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                pickFile.mutate();
              }
            }}
          >
            {picked ? (
              <>
                <Icon name="fileSheet" />
                <p className="drop-file-name">{baseName(picked)}</p>
                {/* 这一行原来是「点击或拖入另一份文件可替换」，交付方 2026-10-20 让识别回执搬进来顶掉它。
                 *  读屏播报的落点仍在这一枚 role=status 上（它嵌在 role=button 的拖拽区里，
                 *  个别读屏器对交互元素内部的 live region 播报不稳定，这一处已知未证，记在交付文档 §9）。 */}
                {previewMut.isPending ? (
                  <span>正在按文件内容识别格式…</span>
                ) : parsedSummary ? (
                  <span role="status" aria-live="polite">
                    {parsedSummary}
                  </span>
                ) : null}
              </>
            ) : (
              <>
                <Icon name="exportTray" />
                <p>点击或将文件拖拽至此区域</p>
                <span>支持 CSV / XLSX 格式导入，格式按文件内容自动识别</span>
              </>
            )}
          </div>

          <div className="template-action">
            <p>没有合适的文件？下载标准导入模板。</p>
            <Button variant="bare" className="btn-download" onClick={() => templateMut.mutate()} disabled={busy}>
              <Icon name="importTray" size={14} />
              下载模板
            </Button>
          </div>

          {status ? <p className="parsed-result" role="status" aria-live="polite">{status}</p> : null}
          {preview?.errors.length ? (
            <ul className="flex flex-col gap-1 text-xs text-warning">
              {preview.errors.slice(0, 5).map((e, i) => (
                // 一行可能带多条错误（rowNo 相同），key 只用 rowNo 会撞：审查 F26。
                <li key={`${e.rowNo}-${i}`}>
                  第 {e.rowNo} 行：{e.message}
                </li>
              ))}
              {preview.errors.length > 5 ? <li>另有 {preview.errors.length - 5} 条错误，请到「导入导出」页看完整清单。</li> : null}
            </ul>
          ) : null}
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="export-info-box">
            <p>当前系统「{targetName || '未选择'}」下的所有账号凭据。</p>
            <span>
              导出格式：<strong>{formatLabel(format)}</strong>
            </span>
          </div>

          <div className="checkbox-label">
            <Checkbox id="sio-secrets" checked={includeSecrets} onCheckedChange={(c) => setIncludeSecrets(c === true)} />
            <Label htmlFor="sio-secrets">在导出文件中包含明文密码（请注意保管）</Label>
          </div>
          {includeSecrets ? (
            <Alert variant="destructive" className="rounded-sm px-3 py-2 text-xs">
              明文口令会以可读文本写进这份 {format === 'xlsx' ? 'Excel' : 'CSV'} 文件，文件本身没有任何保护：拿到文件就等于拿到全部口令。请把它与口令通过独立的安全渠道交付。
            </Alert>
          ) : (
            <p className="text-xs text-ink-muted">不勾选则 password 列留空，导出的表里没有凭据内容。</p>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={() => void pickDestination()} disabled={busy}>
              {savePath ? '重新选择保存路径' : '选择保存路径'}
            </Button>
            <span className="text-sm text-ink-muted">{savePath ? `已选：${baseName(savePath)}` : '尚未选择保存路径'}</span>
          </div>
        </div>
      )}

      {error ? (
        <p role="alert" aria-live="assertive" className="mt-3 rounded-sm border border-danger px-3 py-2 text-sm text-danger">
          {error}
        </p>
      ) : null}
    </Modal>
  );
}
