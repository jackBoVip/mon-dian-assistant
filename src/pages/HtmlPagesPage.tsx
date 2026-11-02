import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { invalidateHtmlPages, queryKeys } from '../lib/queryClient';
import { PERM, has, permissionSet, useMyPermissions } from '../lib/permissions';
import { toNormalisedError } from '../lib/errors';
import { formatBytes, formatTimestamp } from '../lib/format';
import { Button } from '../components/ui/Button';
import { Icon } from '../components/ui/Icon';
import { Modal } from '../components/ui/Modal';
import { TextAreaField, TextField } from '../components/ui/Field';
import { EmptyState, ErrorState, Loading } from '../components/ui/StateBlocks';
import { useLauncherNav } from '../state/launcherNav';
import type { HtmlPageSummary } from '../lib/types';

/** 与 `html_pages/store.rs` 的 TITLE_MAX_CHARS 同值：超了后端也会拒。 */
const TITLE_MAX = 120;

interface EditorState {
  mode: 'create' | 'edit';
  id: string | null;
  title: string;
  html: string;
}

/**
 * 页面库（顶栏一级「工具」）。
 *
 * 左列表，右栏是**直接可用**的预览：一块嵌进主窗的独立 webview（`preview/embed.rs`）。
 * 它不是 iframe——Windows 上 wry 会把 `__TAURI_INTERNALS__` 注入子框架，跑得起来的 iframe
 * 会把这套注入原样交给页面内容。独立 webview 没有这个问题，安全来自另一个更硬的事实：
 * 内容由回环服务供出，对 Tauri 是 remote origin，没有 `remote` capability 时所有自定义命令
 * 一律被拒。于是这里能点、能跑脚本、能联网，却调不到本应用任何命令。
 *
 * 「运行脚本」保留：同一页开到独立窗口，适合放大或放到另一块屏幕。
 *
 * 原生 webview 盖在网页上方，所以：弹窗打开时收起、切页/离开/删页/锁库时关闭；
 * 位置与尺寸按占位块的 `getBoundingClientRect()` 同步，原生层不猜布局。
 *
 * 两个消费端都从回环服务取内容，每次加载都重新过会话与 `html.page.read`。
 */
export function HtmlPagesPage() {
  const qc = useQueryClient();
  const perms = permissionSet(useMyPermissions().data);
  const canCreate = has(perms, PERM.HTML_PAGE_CREATE);
  const canUpdate = has(perms, PERM.HTML_PAGE_UPDATE);
  const canDelete = has(perms, PERM.HTML_PAGE_DELETE);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [deleting, setDeleting] = useState<HtmlPageSummary | null>(null);
  const previewHost = useRef<HTMLDivElement | null>(null);
  // 本页的回执写在标题下面，不用全局 toast：右栏是原生层，toast 在右下角，下半截会被它压住。
  const [status, setStatus] = useState<{ tone: 'ok' | 'danger'; text: string } | null>(null);

  const list = useQuery({ queryKey: queryKeys.htmlPages, queryFn: () => api.htmlPageList() });
  const rows = useMemo(() => list.data ?? [], [list.data]);

  // 选中的那页不在了（删掉了）就落到第一条；列表空了就清空选中。
  useEffect(() => {
    if (rows.length === 0) {
      if (selectedId !== null) setSelectedId(null);
      return;
    }
    if (selectedId === null || !rows.some((row) => row.id === selectedId)) setSelectedId(rows[0].id);
  }, [rows, selectedId]);

  /**
   * 浮层「选中这一页」的落点。本页左栏没有筛选框，列表就是全部，
   * 所以直接置选中即可；上面那条自动落第一行的规则声明在前，等列表到位时
   * 它认得出这一条已经在列表里，不会把它抢走。
   */
  const pendingNav = useLauncherNav((s) => s.pending);
  useEffect(() => {
    if (!pendingNav || pendingNav.page !== 'html') return;
    useLauncherNav.getState().clear();
    setSelectedId(pendingNav.pageId);
  }, [pendingNav]);

  const selected = rows.find((row) => row.id === selectedId) ?? null;

  const preview = useQuery({
    queryKey: queryKeys.htmlPreview(selectedId ?? 'none'),
    queryFn: () => api.htmlPagePreviewUrl(selectedId as string),
    enabled: selectedId !== null,
  });

  // 回执自动淡出；新一条直接顶掉旧一条。
  useEffect(() => {
    if (!status) return;
    const timer = window.setTimeout(() => setStatus(null), 6000);
    return () => window.clearTimeout(timer);
  }, [status]);

  const onError = (raw: unknown) => setStatus({ tone: 'danger', text: toNormalisedError(raw).message });

  const loadForEdit = useMutation({
    mutationFn: (id: string) => api.htmlPageGet(id),
    onSuccess: (page) => setEditor({ mode: 'edit', id: page.id, title: page.title, html: page.html }),
    onError,
  });

  const save = useMutation({
    mutationFn: (input: EditorState) =>
      input.mode === 'create'
        ? api.htmlPageCreate(input.title.trim(), input.html)
        : api.htmlPageUpdate(input.id as string, input.title.trim(), input.html),
    onSuccess: (page, input) => {
      invalidateHtmlPages(qc);
      setSelectedId(page.id);
      setEditor(null);
      setStatus({
        tone: 'ok',
        text: input.mode === 'create' ? `已新建「${page.title}」` : `已保存「${page.title}」`,
      });
    },
    onError,
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.htmlPageDelete(id),
    onSuccess: (_data, id) => {
      setStatus({ tone: 'ok', text: '已删除这个页面' });
      setDeleting(null);
      if (selectedId === id) setSelectedId(null);
      invalidateHtmlPages(qc);
    },
    onError,
  });

  const runScripts = useMutation({
    mutationFn: (id: string) => api.htmlPagePreviewOpen(id),
    onError,
  });

  // 原生预览块的生命周期。地址拿到了才贴上去；尺寸按占位块量，原生层不猜布局。
  const embedId = preview.data ? (selected?.id ?? null) : null;
  const embedVersion = preview.data ? (selected?.updatedAt ?? '') : '';
  const overlayOpen = editor !== null || deleting !== null;
  // 收进托盘会连这块原生层一起收掉，主窗回来时没有任何状态变化：靠重新获得焦点把预览放回去。
  // 同 id 同版本重放只摆位置；页面里已点出来的状态不会被清掉。
  const [wake, setWake] = useState(0);

  useEffect(() => {
    const bump = () => setWake((n) => n + 1);
    window.addEventListener('focus', bump);
    return () => window.removeEventListener('focus', bump);
  }, []);

  useEffect(() => {
    const host = previewHost.current;
    if (!embedId || !preview.data || !host) return;

    const measure = () => {
      const r = host.getBoundingClientRect();
      return { x: r.left, y: r.top, width: r.width, height: r.height };
    };
    const push = () => {
      const r = measure();
      void api.htmlPageEmbedSync(r.x, r.y, r.width, r.height).catch(() => {});
    };

    const rect = measure();
    void api
      .htmlPageEmbedOpen(embedId, embedVersion, rect.x, rect.y, rect.width, rect.height)
      .catch((raw) => setStatus({ tone: 'danger', text: toNormalisedError(raw).message }));

    const ro = new ResizeObserver(push);
    ro.observe(host);
    window.addEventListener('resize', push);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', push);
    };
    // embedVersion 进依赖：保存后地址没变，但内容必须重新加载。
  }, [embedId, embedVersion, preview.data, wake]);

  // 原生层盖在网页上方，弹窗遮不住它：打开期间收起，关掉再放回。
  useEffect(() => {
    void api.htmlPageEmbedVisible(!overlayOpen).catch(() => {});
  }, [overlayOpen]);

  // 没选中页面、或预览服务出错时，右边不该继续挂着上一页的内容。
  useEffect(() => {
    if (selectedId !== null && !preview.isError) return;
    void api.htmlPageEmbedClose().catch(() => {});
  }, [selectedId, preview.isError]);

  // 离开这一页（切页、锁库导致的卸载）就把原生块收掉：明文不留在窗口里。
  useEffect(
    () => () => {
      void api.htmlPageEmbedClose().catch(() => {});
    },
    [],
  );

  function openCreate() {
    if (!canCreate) return;
    setEditor({ mode: 'create', id: null, title: '', html: '' });
  }

  return (
    <>
      <div className="left-panel">
        <div className="panel-header">
          <div className="panel-title">已存页面</div>
          <div className="header-actions">
            <Button
              variant="bare"
              className="btn-mini"
              aria-label="新建页面"
              title={canCreate ? '新建页面' : '当前角色没有新建权限（html.page.create）'}
              disabled={!canCreate}
              onClick={openCreate}
            >
              <Icon name="plus" size={13} />
            </Button>
          </div>
        </div>

        <div className="system-list" aria-busy={list.isLoading}>
          {list.isLoading ? <Loading label="加载页面列表…" /> : null}
          {list.isError ? <ErrorState raw={list.error} onRetry={() => void list.refetch()} /> : null}
          {list.data && rows.length === 0 ? (
            <p className="system-list-empty">还没有页面。点上方「+」新建。</p>
          ) : null}
          {rows.map((row) => (
            <button
              key={row.id}
              type="button"
              className={row.id === selectedId ? 'system-item active' : 'system-item'}
              aria-current={row.id === selectedId ? 'true' : undefined}
              onClick={() => setSelectedId(row.id)}
            >
              <span className="sys-icon" aria-hidden>
                {row.title.slice(0, 1)}
              </span>
              <span className="sys-info">
                <span className="sys-name">{row.title}</span>
                <span className="sys-meta">
                  {formatBytes(row.byteLen)} · {formatTimestamp(row.updatedAt)}
                </span>
              </span>
            </button>
          ))}
        </div>
      </div>

      <div className="right-panel">
        <div className="right-header">
          <div className="right-title">
            <h2>{selected?.title ?? '未选择页面'}</h2>
            <p>
              {selected
                ? `页面可直接操作：脚本与 CDN 资源照常运行，但调不到本应用任何命令 · 更新于 ${formatTimestamp(selected.updatedAt)}`
                : '右边显示选中页面的渲染结果，可以直接点按；要放到独立窗口请用「运行脚本」。'}
            </p>
            {status?.tone === 'danger' ? (
              <p role="alert" className="mt-1 text-xs text-danger">
                {status.text}
              </p>
            ) : status ? (
              <p role="status" aria-live="polite" className="mt-1 text-xs text-ink-muted">
                {status.text}
              </p>
            ) : null}
          </div>

          <div className="right-actions">
            <button
              type="button"
              className="filter-btn"
              aria-label="运行脚本"
              title={selected ? '在独立窗口里打开：脚本可执行、可联网，但调不到本应用任何命令' : '请先选择一个页面'}
              disabled={!selected || runScripts.isPending}
              onClick={() => selected && runScripts.mutate(selected.id)}
            >
              <Icon name="externalLink" size={18} />
            </button>

            {canUpdate ? (
              <button
                type="button"
                className="filter-btn"
                aria-label="编辑当前页面"
                title={selected ? `编辑页面：${selected.title}` : '请先选择一个页面'}
                disabled={!selected || loadForEdit.isPending}
                onClick={() => selected && loadForEdit.mutate(selected.id)}
              >
                <Icon name="edit" size={18} />
              </button>
            ) : null}

            {canDelete ? (
              <button
                type="button"
                className="filter-btn is-danger"
                aria-label="删除当前页面"
                title={selected ? `删除页面：${selected.title}` : '请先选择一个页面'}
                disabled={!selected}
                onClick={() => selected && setDeleting(selected)}
              >
                <Icon name="trash" size={18} />
              </button>
            ) : null}
          </div>
        </div>

        {selected === null ? (
          <EmptyState>
            <Icon name="code" size={26} />
            <span className="text-sm font-medium text-ink">
              {rows.length === 0 ? '还没有页面' : '左边选一页'}
            </span>
            <span className="text-xs leading-relaxed">
              {rows.length === 0
                ? '点左上「+」新建：把 HTML 粘进来，起个标题。'
                : '右边可以直接操作；想放到独立窗口或另一块屏幕，点右上「运行脚本」。'}
            </span>
          </EmptyState>
        ) : preview.isError ? (
          <div className="flex min-h-0 flex-col gap-3">
            <ErrorState raw={preview.error} onRetry={() => void preview.refetch()} />
            <p className="text-xs leading-relaxed text-ink-muted">
              预览服务这次没起来，重启应用再看日志；反复重试不会让它变好。
            </p>
          </div>
        ) : preview.data ? (
          <div className="relative min-h-0 flex-1 overflow-hidden rounded-lg border border-line">
            {/* 原生子 webview 照这块的位置贴上去，这块只负责占位与量尺寸。 */}
            <div ref={previewHost} data-testid="html-preview-host" className="h-full w-full" />
          </div>
        ) : (
          <Loading label="准备预览…" />
        )}
      </div>

      <Modal
        open={editor !== null}
        title={editor?.mode === 'create' ? '新建页面' : '编辑页面'}
        onClose={() => setEditor(null)}
        footer={
          <>
            <Button onClick={() => setEditor(null)}>取消</Button>
            <Button
              variant="primary"
              disabled={save.isPending || (editor?.title.trim() ?? '') === ''}
              onClick={() => editor && save.mutate(editor)}
            >
              保存
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <TextField
            label="标题"
            value={editor?.title ?? ''}
            maxLength={TITLE_MAX}
            placeholder="这个页面叫什么"
            hint={`最多 ${TITLE_MAX} 字，留空无法保存`}
            onChange={(e) => setEditor((cur) => (cur ? { ...cur, title: e.target.value } : cur))}
          />
          <TextAreaField
            label="HTML"
            value={editor?.html ?? ''}
            rows={18}
            className="font-mono text-xs"
            placeholder={'<h1>标题</h1>\n<p>正文……</p>'}
            hint="原样保存、原样渲染：一整页（含 <html>/<head>/<body>）或一段片段都可以，上限 5 MiB。"
            onChange={(e) => setEditor((cur) => (cur ? { ...cur, html: e.target.value } : cur))}
          />
        </div>
      </Modal>

      <Modal
        open={deleting !== null}
        title="删除这个页面"
        onClose={() => setDeleting(null)}
        footer={
          <>
            <Button onClick={() => setDeleting(null)}>取消</Button>
            <Button
              variant="danger"
              disabled={remove.isPending}
              onClick={() => deleting && remove.mutate(deleting.id)}
            >
              确认删除
            </Button>
          </>
        }
      >
        <p className="text-sm leading-relaxed text-ink-body">
          「{deleting?.title ?? ''}」会从本机保险库里删除，右栏预览与「运行脚本」窗口若正开着也会一并关掉。这一步不可撤销。
        </p>
      </Modal>
    </>
  );
}
