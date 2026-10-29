import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, isTauri } from '../../lib/api';
import { openFile, saveTextFile } from '../../lib/dialogs';
import { toNormalisedError } from '../../lib/errors';
import { invalidateQuizLibraries, queryKeys } from '../../lib/queryClient';
import { confidencePercent, confidenceTone, formatLabel, issueLabel, publishHint, QTYPE_OPTIONS, qtypeLabel } from '../../lib/quiz';
import { pageItems } from '../../lib/pageWindow';
import { notify } from '../../state/notify';
import { cn } from '../../lib/utils';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Checkbox } from '../ui/checkbox';
import { TextField } from '../ui/Field';
import { Icon } from '../ui/Icon';
import { Modal } from '../ui/Modal';
import { Pagination, PaginationContent, PaginationEllipsis, PaginationItem, PaginationLink, PaginationNav } from '../ui/pagination';
import { Select } from '../ui/select';
import { EmptyState, ErrorState, Loading } from '../ui/StateBlocks';
import { QuizRowEditor } from './QuizRowEditor';
import type { QuizBulkEdit, QuizImportJobDetail, QuizImportRow, QuizImportRowPatch } from '../../lib/types';

/** 与解析层 `answer::CONFIDENCE_LOW` 同值：批量排除低置信默认就按这一档。 */
const LOW_CONFIDENCE = 0.6;
/** 复核表每页行数。4,341 行的任务整表铺开会把弹窗拖到几秒一帧，按页取只画一屏。 */
const PAGE_SIZE = 50;
/** 选择框只列主格式；`.xlsm` 不在框里，但拖进来后端照样读（同一套 OOXML 表格）。 */
const FILE_FILTERS = [{ name: '题库文件', extensions: ['docx', 'doc', 'xlsx', 'xls', 'txt', 'csv'] }];
/** 与 `quiz::parse::Format::from_extension` 认的扩展名逐字一致：拖进来先拦一道，别等解析完才报错。 */
const ACCEPTED_EXTENSIONS = ['doc', 'docx', 'xls', 'xlsx', 'xlsm', 'txt', 'csv'];
const FORMAT_HINT = 'DOC / DOCX · XLS / XLSX · TXT / CSV';

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

function extensionOf(path: string): string {
  const name = baseName(path);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

type Step = 'pick' | 'review';
type FooterMode = 'idle' | 'publish' | 'discard';

export interface QuizImportWizardProps {
  open: boolean;
  onClose: () => void;
}

/**
 * 导入向导：选文件 → 解析成待复核任务 → 逐行/批量调整 → 发布成题库。
 *
 * 步骤状态留在这个组件里而不是每次打开都清空：关掉再打开应该回到原来的复核进度，
 * 真正丢弃要走「放弃任务」（后端把任务标成 discarded）。
 */
export function QuizImportWizard({ open, onClose }: QuizImportWizardProps) {
  const qc = useQueryClient();
  const [step, setStep] = useState<Step>('pick');
  const [path, setPath] = useState('');
  const [jobId, setJobId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [page, setPage] = useState(1);
  /** 复核默认只看有问题的行（问题码由解析层落库），干净的文件仍整表过一遍。 */
  const [onlyIssues, setOnlyIssues] = useState(true);
  const [editing, setEditing] = useState<QuizImportRow | null>(null);
  const [mode, setMode] = useState<FooterMode>('idle');
  const [libraryName, setLibraryName] = useState('');
  const [nameError, setNameError] = useState('');
  const [bulkQType, setBulkQType] = useState('single');
  const [dragOver, setDragOver] = useState(false);
  const listWrapRef = useRef<HTMLDivElement>(null);

  function fail(raw: unknown) {
    notify('danger', toNormalisedError(raw).message);
  }

  const offset = (page - 1) * PAGE_SIZE;
  const detail = useQuery({
    queryKey: jobId
      ? queryKeys.quizImportJob(jobId, offset, PAGE_SIZE, onlyIssues)
      : ['quizImportJob', 'none', offset, PAGE_SIZE, onlyIssues],
    queryFn: () => api.quizImportJob(jobId as string, offset, PAGE_SIZE, onlyIssues),
    enabled: !!jobId,
    // 翻页/切筛选时先留住上一页，避免整块列表闪成骨架屏。
    placeholderData: keepPreviousData,
  });

  const job = detail.data?.job ?? null;
  const rows = detail.data?.rows ?? [];
  const total = detail.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // 换任务、切筛选、翻页后，旧的选择不再指向屏幕上的行。
  useEffect(() => {
    setSelected(new Set());
  }, [jobId, onlyIssues, page]);

  // 批量删除/改筛选后行数会缩水：页码超出新上界时要退回去，否则会停在一页空表上。
  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  const parse = useMutation({
    mutationFn: (file: string) => api.quizImportParse(file),
    onSuccess: (created) => {
      setJobId(created.id);
      setLibraryName(created.libraryName);
      setOnlyIssues(created.issueRows > 0);
      setPage(1);
      setMode('idle');
      setStep('review');
    },
    onError: fail,
  });

  const updateRow = useMutation({
    mutationFn: (args: { rowId: string; patch: QuizImportRowPatch }) =>
      api.quizImportUpdateRow(jobId as string, args.rowId, args.patch),
    // 当前页只有几十行：用后端交回的那一行就地替换。改完问题码清空的行，
    // 在「只看有问题」里要当场退场——它是编辑的结果，不该等翻页才消失。
    onSuccess: (updated) => {
      setEditing(null);
      qc.setQueryData<QuizImportJobDetail>(queryKeys.quizImportJob(jobId as string, offset, PAGE_SIZE, onlyIssues), (prev) => {
        if (!prev) return prev;
        if (onlyIssues && updated.row.issues.length === 0) {
          return {
            job: updated.job,
            rows: prev.rows.filter((r) => r.id !== updated.row.id),
            total: Math.max(0, prev.total - 1),
          };
        }
        return {
          job: updated.job,
          rows: prev.rows.map((r) => (r.id === updated.row.id ? updated.row : r)),
          total: prev.total,
        };
      });
    },
    onError: fail,
  });

  const bulk = useMutation({
    mutationFn: (edit: QuizBulkEdit) => api.quizImportBulkUpdate(jobId as string, edit),
    // 批量操作会跨页改动行数与内容（删除、改题型）：当前页原参数重取一次，几十行的往返。
    onSuccess: () => {
      setSelected(new Set());
      if (jobId) void qc.invalidateQueries({ queryKey: ['quizImportJob', jobId] });
    },
    onError: fail,
  });

  const publish = useMutation({
    mutationFn: () => api.quizImportPublish(jobId as string, libraryName.trim()),
    onSuccess: (lib) => {
      notify('success', `已发布题库「${lib.name}」，共 ${lib.questionCount} 题`);
      invalidateQuizLibraries(qc);
      reset();
      onClose();
    },
    onError: fail,
  });

  const discard = useMutation({
    mutationFn: () => api.quizImportDiscard(jobId as string),
    onSuccess: () => {
      notify('info', '已放弃这次导入，复核表已丢弃');
      reset();
      onClose();
    },
    onError: fail,
  });

  /** 模板内容由后端给（`parse::grid::template_csv()`），这里只负责交给系统下载通道落盘。 */
  const template = useMutation({
    mutationFn: async () => {
      const t = await api.quizImportTemplate();
      return saveTextFile(
        {
          title: '保存题库导入模板（CSV）',
          defaultPath: '题库导入模板.csv',
          filters: [{ name: 'CSV 文件', extensions: ['csv'] }],
        },
        t.csv,
      );
    },
    onSuccess: (saved) => {
      if (saved) notify('success', `模板已写出：${baseName(saved.path)}`);
      else notify('info', '已取消模板保存。');
    },
    onError: fail,
  });

  function reset() {
    setStep('pick');
    setPath('');
    setJobId(null);
    setSelected(new Set());
    setPage(1);
    setOnlyIssues(true);
    setEditing(null);
    setMode('idle');
    setLibraryName('');
    setNameError('');
    setDragOver(false);
  }

  async function pickFile() {
    try {
      const picked = await openFile({ title: '选择题库文件', filters: FILE_FILTERS });
      if (picked) acceptFile(picked);
    } catch (raw) {
      fail(raw);
    }
  }

  /**
   * 点击与拖拽两条路都落到这里。格式先在这边按扩展名拦一道：后端也是按扩展名选解析器，
   * 提前拦能直接说清「这份文件读不了」，而不是让人点完「解析」再等一条报错。
   */
  function acceptFile(picked: string) {
    if (!ACCEPTED_EXTENSIONS.includes(extensionOf(picked))) {
      notify('warning', `不支持的文件格式：${baseName(picked)}。可选 ${FORMAT_HINT.replaceAll(' · ', ' / ')}。`);
      return;
    }
    setPath(picked);
  }

  // 拖拽与账号中心那份导入弹窗同一条口径：Tauri 的 webview 拖放事件给的是真实路径
  // （HTML5 的 File 对象没有路径，后端读不到文件）。只在「选文件」这一步订阅，
  // 复核时不接拖放——那时拖进来的第二份文件没有落点，接住只会让人以为替换成功了。
  useEffect(() => {
    if (!open || step !== 'pick' || !isTauri()) return;
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
          if (first) acceptFile(first);
          else notify('warning', '拖拽的内容里没有文件路径。');
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
  }, [open, step]);

  const selectedIds = useMemo(() => [...selected], [selected]);

  function runBulk(edit: QuizBulkEdit) {
    bulk.mutate(edit);
  }

  /** 列表自己滚，分页条在带子外面：翻页时把带子拉回顶部，否则会停在旧页的末尾。 */
  function gotoPage(next: number) {
    setPage(next);
    if (listWrapRef.current) listWrapRef.current.scrollTop = 0;
  }

  function confirmPublish() {
    const name = libraryName.trim();
    if (!name || name.length > 64) {
      setNameError('题库名称不能为空，最多 64 个字。');
      return;
    }
    setNameError('');
    publish.mutate();
  }

  const busy = updateRow.isPending || bulk.isPending || publish.isPending || discard.isPending || parse.isPending;

  const footer =
    step === 'pick' ? (
      <div className="flex w-full items-center justify-between gap-3">
        <span className="min-w-0 text-xs text-ink-muted">
          支持 {FORMAT_HINT.replaceAll(' · ', ' / ')}，单文件 ≤ 32MiB、单次 ≤ 20000 题。
        </span>
        <div className="flex shrink-0 items-center gap-2 whitespace-nowrap">
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" disabled={!path || parse.isPending} onClick={() => parse.mutate(path)}>
            {parse.isPending ? '解析中…' : '解析并生成复核表'}
          </Button>
        </div>
      </div>
    ) : mode === 'publish' ? (
      <div className="flex w-full items-center justify-between gap-3">
        <span className="min-w-0 text-xs text-ink-body">{job ? publishHint(job) : ''}</span>
        <div className="flex shrink-0 items-center gap-2 whitespace-nowrap">
          <Button onClick={() => setMode('idle')} disabled={publish.isPending}>
            取消
          </Button>
          <Button variant="primary" disabled={publish.isPending} onClick={confirmPublish}>
            {publish.isPending ? '发布中…' : '确认发布'}
          </Button>
        </div>
      </div>
    ) : mode === 'discard' ? (
      <div className="flex w-full items-center justify-between gap-3">
        <span className="min-w-0 text-xs text-ink-body">放弃后复核表与这次解析结果会被丢弃，不影响已有题库。</span>
        <div className="flex shrink-0 items-center gap-2 whitespace-nowrap">
          <Button onClick={() => setMode('idle')} disabled={discard.isPending}>
            取消
          </Button>
          <Button variant="danger" disabled={discard.isPending} onClick={() => discard.mutate()}>
            {discard.isPending ? '丢弃中…' : '确认放弃'}
          </Button>
        </div>
      </div>
    ) : (
      <div className="flex w-full items-center justify-between gap-3">
        <span className="text-xs text-ink-muted">关掉窗口不会丢进度；未发布的任务 24 小时后由系统清理。</span>
        <div className="flex shrink-0 items-center gap-2 whitespace-nowrap">
          <Button variant="danger" disabled={busy} onClick={() => setMode('discard')}>
            放弃任务
          </Button>
          <Button
            variant="primary"
            disabled={busy || !job || job.includedRows === 0}
            title={job && job.includedRows === 0 ? '先勾选至少一行再发布' : undefined}
            onClick={() => setMode('publish')}
          >
            发布为题库
          </Button>
        </div>
      </div>
    );

  return (
    <>
      <Modal
        open={open}
        title={step === 'pick' ? '导入题库' : '导入题库 · 复核与发布'}
        onClose={onClose}
        footer={footer}
        wide
        bodyScroll={step === 'review' ? 'internal' : 'auto'}
      >
        {step === 'pick' ? (
          <div className="grid gap-4">
            <div
              className={dragOver ? 'drop-zone is-dragover' : 'drop-zone'}
              role="button"
              tabIndex={0}
              aria-label={path ? `已选择 ${baseName(path)}，点击可换一份文件` : '选择题库文件，或把文件拖到这里'}
              aria-disabled={parse.isPending || undefined}
              onClick={() => {
                if (!parse.isPending) void pickFile();
              }}
              onKeyDown={(e) => {
                if (parse.isPending) return;
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  void pickFile();
                }
              }}
            >
              {parse.isPending ? (
                <>
                  <Icon name="fileSheet" />
                  <p className="drop-file-name">{baseName(path)}</p>
                  <span role="status" aria-live="polite">
                    正在解析并生成复核表…
                  </span>
                </>
              ) : path ? (
                <>
                  <Icon name="fileSheet" />
                  <p className="drop-file-name">{baseName(path)}</p>
                  <span>点击或拖入另一份文件可替换</span>
                </>
              ) : (
                <>
                  <Icon name="exportTray" />
                  <p>点击或将文件拖拽至此区域</p>
                  <span>支持 {FORMAT_HINT}</span>
                </>
              )}
            </div>

            <div className="grid gap-2 sm:grid-cols-3">
              <FormatCard
                title="Word"
                meta=".doc · .docx"
                body="带「题干 + 答案」或「题干 + 选项」表头的表格整表读成题库；其余按正文题号切题。"
              />
              <FormatCard
                title="Excel / CSV"
                meta=".xls · .xlsx · .csv"
                body="按表头别名认列；认不出表头就按「题型 · 题干 · A–D · 答案 · 标签」的固定列序读。"
              />
              <FormatCard
                title="纯文本"
                meta=".txt"
                body="先按 BOM / 编码探测解码，乱码占比超过 2% 直接报错，不猜着导入。"
              />
            </div>

            <div className="template-action">
              <p>没有合适的文件？下载标准导入模板（CSV，Excel 双击即可打开）：四行示例覆盖单选 / 多选 / 判断 / 填空。</p>
              <Button
                variant="bare"
                className="btn-download shrink-0 whitespace-nowrap"
                disabled={parse.isPending || template.isPending}
                onClick={() => template.mutate()}
              >
                <Icon name="importTray" size={14} />
                {template.isPending ? '准备中…' : '下载模板'}
              </Button>
            </div>

            <div className="panel-notice">
              <p>
                解析完成后先落成「待复核」任务，确认无误再发布——发布是单事务，任一行不合法会整体回滚。
              </p>
            </div>
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col gap-2.5">
            {detail.isLoading && !detail.data ? <Loading label="读取复核表…" /> : null}
            {detail.isError ? <ErrorState raw={detail.error} onRetry={() => void detail.refetch()} /> : null}

            {job ? (
              <>
                {/* 头部一行：左边这份文件，右边三枚计数；它不随列表滚，滚的时候永远知道自己在复核哪份文件。 */}
                <div className="flex min-w-0 shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5">
                  <span className="flex min-w-0 items-center gap-1.5 text-xs text-ink-body">
                    <Icon name="fileSheet" size={14} />
                    <span className="min-w-0 truncate" title={job.sourceFilename}>
                      {formatLabel(job.sourceFormat)} · {job.sourceFilename}
                    </span>
                  </span>
                  <div className="ml-auto flex shrink-0 items-center gap-1.5">
                    <Stat label="解析总行" value={job.totalRows} />
                    <Stat label="纳入发布" value={job.includedRows} />
                    <Stat label="有问题" value={job.issueRows} tone={job.issueRows > 0 ? 'warning' : 'ok'} />
                  </div>
                </div>

                <div className="grid shrink-0 gap-1.5 rounded-md border border-line bg-sunken px-3 py-1.5">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <label className="flex items-center gap-2 text-xs text-ink-body">
                      <Checkbox
                        checked={onlyIssues}
                        onCheckedChange={(v) => {
                          setOnlyIssues(v === true);
                          setPage(1);
                        }}
                        aria-label="只看有问题"
                      />
                      只看有问题（{job.issueRows}）
                    </label>
                    <span className="h-4 w-px bg-line" aria-hidden />
                    <label className="flex items-center gap-2 text-xs text-ink-body">
                      <Checkbox
                        checked={rows.length > 0 && rows.every((r) => selected.has(r.id))}
                        onCheckedChange={(v) => setSelected(v === true ? new Set(rows.map((r) => r.id)) : new Set())}
                        aria-label="全选本页"
                      />
                      全选本页
                    </label>
                    <span className="text-xs text-ink-muted">已选 {selected.size} 行</span>
                    <span className="h-4 w-px bg-line" aria-hidden />
                    <span className="text-xs text-ink-muted">未选行时，改题型作用于整份任务；纳入/排除只改所选行。</span>
                  </div>
                  <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                    <div className="w-24 shrink-0">
                      <Select
                        value={bulkQType}
                        options={QTYPE_OPTIONS}
                        onValueChange={setBulkQType}
                        aria-label="批量设为题型"
                      />
                    </div>
                    <Button
                      variant="ghost"
                      className="shrink-0 whitespace-nowrap"
                      title="把所选行改成左侧题型；未选行则整份任务都改"
                      disabled={bulk.isPending}
                      onClick={() => runBulk({ op: 'set_qtype', qtype: bulkQType, ids: selectedIds })}
                    >
                      改题型
                    </Button>
                    <Button
                      variant="ghost"
                      className="shrink-0 whitespace-nowrap"
                      title="所选行纳入发布"
                      disabled={bulk.isPending || selected.size === 0}
                      onClick={() => runBulk({ op: 'set_include', include: true, ids: selectedIds })}
                    >
                      纳入所选
                    </Button>
                    <Button
                      variant="ghost"
                      className="shrink-0 whitespace-nowrap"
                      title="所选行不参与发布"
                      disabled={bulk.isPending || selected.size === 0}
                      onClick={() => runBulk({ op: 'set_include', include: false, ids: selectedIds })}
                    >
                      排除所选
                    </Button>
                    <Button
                      variant="ghost"
                      className="shrink-0 whitespace-nowrap"
                      title={`排除置信度低于 ${LOW_CONFIDENCE} 的行（整份任务）`}
                      disabled={bulk.isPending}
                      onClick={() => runBulk({ op: 'exclude_low_confidence', threshold: LOW_CONFIDENCE })}
                    >
                      排除低置信
                    </Button>
                    <Button
                      variant="ghost"
                      className="shrink-0 whitespace-nowrap"
                      title="解析层按「题干 + 题型 + 答案」判定的文内重复，整份任务一起排除"
                      disabled={bulk.isPending}
                      onClick={() => runBulk({ op: 'exclude_duplicates' })}
                    >
                      排除重复
                    </Button>
                    <Button
                      variant="danger"
                      className="shrink-0 whitespace-nowrap"
                      title="从这次任务里删除所选行"
                      disabled={bulk.isPending || selected.size === 0}
                      onClick={() => runBulk({ op: 'remove', ids: selectedIds })}
                    >
                      删除所选
                    </Button>
                  </div>
                </div>

                {/* 只有这一条带子滚：头部、工具栏、分页与题库名都留在带子外面。 */}
                <div
                  ref={listWrapRef}
                  className="min-h-32 min-w-0 flex-1 overflow-y-auto overscroll-contain"
                >
                  {total === 0 ? (
                    <EmptyState>
                      {onlyIssues && job.issueRows === 0 ? (
                        <>
                          <span>本次解析没有问题行。</span>
                          <Button
                            variant="ghost"
                            onClick={() => {
                              setOnlyIssues(false);
                              setPage(1);
                            }}
                          >
                            查看全部 {job.totalRows} 行
                          </Button>
                        </>
                      ) : (
                        '这次任务没有可复核的行。'
                      )}
                    </EmptyState>
                  ) : (
                    <ul aria-label="待复核题目" className="grid gap-0">
                      {rows.map((row) => (
                        <ReviewRow
                          key={row.id}
                          row={row}
                          selected={selected.has(row.id)}
                          busy={busy}
                          onSelect={setSelected}
                          onInclude={updateRow.mutate}
                          onEdit={setEditing}
                        />
                      ))}
                    </ul>
                  )}
                </div>

                {total > 0 ? (
                  <>
                    <div className="flex min-w-0 shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-2">
                      <span className="page-info whitespace-nowrap" role="status">
                        共 {total} 行 · 第 {page}/{totalPages} 页
                      </span>
                      <Pagination aria-label="复核表分页" className="shrink-0">
                        <PaginationContent className="page-controls">
                          <PaginationItem>
                            <PaginationNav
                              label="上一页"
                              variant="bare"
                              className="page-btn whitespace-nowrap"
                              disabled={page <= 1}
                              onClick={() => gotoPage(Math.max(1, page - 1))}
                            />
                          </PaginationItem>
                          {pageItems(page, totalPages).map((item, idx) =>
                            item === 'gap' ? (
                              <PaginationItem key={`gap-${idx}`}>
                                <PaginationEllipsis className="page-btn">…</PaginationEllipsis>
                              </PaginationItem>
                            ) : (
                              <PaginationItem key={item}>
                                <PaginationLink
                                  className="page-num"
                                  isActive={item === page}
                                  aria-label={`第 ${item} 页`}
                                  onClick={() => gotoPage(item)}
                                >
                                  {item}
                                </PaginationLink>
                              </PaginationItem>
                            ),
                          )}
                          <PaginationItem>
                            <PaginationNav
                              label="下一页"
                              variant="bare"
                              className="page-btn whitespace-nowrap"
                              disabled={page >= totalPages}
                              onClick={() => gotoPage(Math.min(totalPages, page + 1))}
                            />
                          </PaginationItem>
                        </PaginationContent>
                      </Pagination>
                    </div>

                  </>
                ) : null}

                {/* 题库名只在点过「发布为题库」之后出现：复核那一步的正文要留给行本身。 */}
                {mode === 'publish' ? (
                  <div className="w-full max-w-md shrink-0">
                    <TextField
                      label="发布后的题库名称"
                      value={libraryName}
                      onChange={(e) => setLibraryName(e.target.value)}
                      error={nameError || undefined}
                      hint="默认取文件名；可以改成版本化的名字（同名题库允许存在）。"
                    />
                  </div>
                ) : null}
              </>
            ) : null}
          </div>
        )}
      </Modal>

      <QuizRowEditor
        row={editing}
        pending={updateRow.isPending}
        onClose={() => setEditing(null)}
        onSubmit={(patch) => {
          if (editing) updateRow.mutate({ rowId: editing.id, patch });
        }}
      />
    </>
  );
}

function optionsLine(row: QuizImportRow): string {
  return row.options.map((o) => `${o.key}. ${o.text}`).join('　');
}

interface ReviewRowProps {
  row: QuizImportRow;
  selected: boolean;
  busy: boolean;
  onSelect: Dispatch<SetStateAction<Set<string>>>;
  onInclude: (args: { rowId: string; patch: QuizImportRowPatch }) => void;
  onEdit: (row: QuizImportRow | null) => void;
}

/**
 * 复核表的一行。做成 `memo`：勾选一行只改 `selected`，被勾的那一行才是唯一需要重画的。
 *
 * 行做成卡片而不是表格列：弹窗正文只有 ~28rem，八列网格在 512px 里会把题干列压到 0 宽。
 */
const ReviewRow = memo(function ReviewRow({ row, selected, busy, onSelect, onInclude, onEdit }: ReviewRowProps) {
  return (
    <li className="flex min-w-0 items-start gap-2 border-b border-line py-2.5 last:border-b-0 hover:bg-row-hover">
      <div className="shrink-0 pt-0.5">
        <Checkbox
          checked={selected}
          aria-label={`选择第 ${row.seq} 题`}
          onCheckedChange={(v) =>
            onSelect((prev) => {
              const next = new Set(prev);
              if (v === true) next.add(row.id);
              else next.delete(row.id);
              return next;
            })
          }
        />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs tabular-nums text-ink-muted">#{row.seq}</span>
          <Badge>{qtypeLabel(row.qtype)}</Badge>
          <Badge tone={confidenceTone(row.confidence)}>{confidencePercent(row.confidence)}</Badge>
          {row.issues.map((code) => (
            <Badge key={code} tone="warning">
              {issueLabel(code)}
            </Badge>
          ))}
        </div>
        <p
          className={cn(
            'mt-1 line-clamp-2 text-sm leading-relaxed text-pretty',
            row.include ? 'text-ink' : 'text-ink-muted line-through',
          )}
          title={row.stem}
        >
          {row.stem || '（空题干）'}
        </p>
        {/* 答案在前、选项在后，一行装下：复核要看的就是「这个答案落不落在这几个选项里」，
            分两行写等于每行多看一遍。整行 nowrap + truncate，悬停看全文。 */}
        <p
          className="mt-0.5 truncate text-xs text-ink-body"
          title={[
            `答案：${row.answerDisplay || '—'}`,
            row.options.map((o) => `${o.key}. ${o.text}`).join('；'),
          ]
            .filter(Boolean)
            .join(' ')}
        >
          <span className="text-ink-muted">答案：</span>
          {row.answerDisplay || '—'}
          {row.options.length > 0 ? <span className="text-ink-muted">　{optionsLine(row)}</span> : null}
        </p>
      </div>
      <div className="flex shrink-0 flex-col items-center gap-1.5 pt-0.5">
        <Checkbox
          checked={row.include}
          aria-label={`第 ${row.seq} 题纳入发布`}
          disabled={busy}
          onCheckedChange={(v) => onInclude({ rowId: row.id, patch: { include: v === true } })}
        />
        <Button
          variant="bare"
          className="btn-mini"
          aria-label={`编辑第 ${row.seq} 题`}
          title="编辑这一题"
          disabled={busy}
          onClick={() => onEdit(row)}
        >
          <Icon name="edit" size={12} />
        </Button>
      </div>
    </li>
  );
});

function Stat({ label, value, tone = 'ok' }: { label: string; value: number; tone?: 'ok' | 'warning' }) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-baseline gap-1.5 rounded-full border px-2.5 py-0.5 text-xs',
        tone === 'warning' ? 'border-line-strong' : 'border-line',
      )}
    >
      <span className="text-ink-muted">{label}</span>
      <span className={cn('text-sm font-semibold tabular-nums', tone === 'warning' ? 'text-warning' : 'text-ink')}>
        {value}
      </span>
    </span>
  );
}

/** 一族的读法说明。写在选文件这一步，是因为「导入后题型/选项对不上」多数源于文件本身不是表格题库。 */
function FormatCard({ title, meta, body }: { title: string; meta: string; body: string }) {
  return (
    <div className="rounded-md border border-line bg-sunken px-3 py-2.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs font-semibold text-ink">{title}</span>
        <span className="shrink-0 text-[11px] tabular-nums text-ink-muted">{meta}</span>
      </div>
      <p className="mt-1 text-xs leading-relaxed text-ink-body">{body}</p>
    </div>
  );
}
