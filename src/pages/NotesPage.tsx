import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Editor } from '@tiptap/core';
import { PageHeader } from '../components/PageHeader';
import { Button } from '../components/ui/Button';
import { Icon } from '../components/ui/Icon';
import { Modal } from '../components/ui/Modal';
import { TextField } from '../components/ui/Field';
import { DropdownDivider, DropdownItem, Menu } from '../components/ui/dropdown-menu';
import { ErrorState, Loading } from '../components/ui/StateBlocks';
import { NotesEditor } from '../components/notes/NotesEditor';
import { exportAllZip, exportNoteMarkdown, importMarkdownFiles, importZipBackup } from '../components/notes/importExport';
import { api } from '../lib/api';
import { invalidateNotes, queryKeys } from '../lib/queryClient';
import { PAGE_META } from '../lib/pageMeta';
import { PERM, has, permissionSet, useMyPermissions } from '../lib/permissions';
import { toNormalisedError } from '../lib/errors';
import { notify } from '../state/notify';
import { useLauncherNav } from '../state/launcherNav';
import { formatTimestamp } from '../lib/format';
import type { NoteSummary } from '../lib/types';

/**
 * 笔记页（一级入口，与账号中心、题库同级）。
 *
 * 左栏列表、右栏编辑器。内容按使用者隔离，都存在本机保险库里，
 * 所以这一页只在解锁后可用——入口由 menuTree 推导，读写门槛在 `notes.read` / `notes.write`，
 * 真正的拒绝始终在 Rust 那侧。
 */
export function NotesPage() {
  const qc = useQueryClient();
  const perms = permissionSet(useMyPermissions().data);
  const canWrite = has(perms, PERM.NOTES_WRITE);

  const [term, setTerm] = useState('');
  const [debounced, setDebounced] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<NoteSummary | null>(null);
  /** 从浮层导航过来、等着列表就位再选中的那一篇。 */
  const [navTarget, setNavTarget] = useState<string | null>(null);
  const editorRef = useRef<Editor | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(term.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [term]);

  const query = debounced === '' ? null : debounced;
  const list = useQuery({ queryKey: queryKeys.notesList(query), queryFn: () => api.notesList(query) });
  const rows = useMemo(() => list.data ?? [], [list.data]);

  /**
   * 浮层「打开这一篇」的落点。
   *
   * 页内筛选框留着关键字时，命中的那一篇很可能不在当前列表里，下面那条"选中项不在列表就落第一行"
   * 的规则会直接把导航选择改掉——所以这里先把筛选撤干净。撤销会让列表重新取数，
   * 而重取的那一帧 `rows` 是空的，同一条规则又会把选中清空。
   * 因此导航目标先攥在自己手里（`navTarget`），等它真的出现在列表里再落选中，
   * 期间让那条自动落第一行的规则让路。
   */
  const pendingNav = useLauncherNav((s) => s.pending);
  useEffect(() => {
    if (!pendingNav || pendingNav.page !== 'notes') return;
    useLauncherNav.getState().clear();
    setTerm('');
    setDebounced('');
    setNavTarget(pendingNav.noteId);
  }, [pendingNav]);

  useEffect(() => {
    if (navTarget === null) return;
    if (!rows.some((row) => row.id === navTarget)) return;
    setSelectedId(navTarget);
    setNavTarget(null);
  }, [rows, navTarget]);

  // 选中的那篇不在列表里（删掉了、或搜索结果变了）就落到第一条；列表空了就清空选中。
  // 有一条导航在等列表就位时不抢——它要选的那一篇正是我们要找的东西。
  useEffect(() => {
    if (navTarget !== null) return;
    if (rows.length === 0) {
      if (selectedId !== null) setSelectedId(null);
      return;
    }
    if (selectedId === null || !rows.some((row) => row.id === selectedId)) setSelectedId(rows[0].id);
  }, [rows, selectedId, navTarget]);

  const detail = useQuery({
    queryKey: queryKeys.note(selectedId ?? 'none'),
    queryFn: () => api.notesGet(selectedId as string),
    enabled: selectedId !== null,
  });

  const onError = (raw: unknown) => notify('danger', toNormalisedError(raw).message);

  const create = useMutation({
    mutationFn: () => api.notesCreate(),
    onSuccess: (created) => {
      invalidateNotes(qc);
      setSelectedId(created.note.id);
    },
    onError,
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.notesDelete(id),
    onSuccess: (_data, id) => {
      notify('success', '已删除这篇笔记');
      setDeleting(null);
      if (selectedId === id) setSelectedId(null);
      invalidateNotes(qc);
    },
    onError,
  });

  async function onExportMarkdown() {
    const editor = editorRef.current;
    const note = detail.data?.note;
    if (!editor || !note) {
      notify('warning', '还没有打开的笔记可导出');
      return;
    }
    try {
      const done = await exportNoteMarkdown(editor, note);
      if (done) notify('success', `已导出「${note.title}.md」，图片以内联 data URL 写在文件里`);
    } catch (raw) {
      onError(raw);
    }
  }

  async function onExportZip() {
    try {
      const done = await exportAllZip();
      if (done) notify('success', '已导出全部笔记的 zip 备份（只含你自己的笔记）');
    } catch (raw) {
      onError(raw);
    }
  }

  async function onImportMarkdown() {
    try {
      const result = await importMarkdownFiles();
      if (!result) return;
      invalidateNotes(qc);
      const dropped = result.droppedImages > 0 ? `，${result.droppedImages} 张图不是 PNG/JPEG/GIF/WebP 已跳过` : '';
      notify('success', `已导入 ${result.notes} 篇${dropped}`);
    } catch (raw) {
      onError(raw);
    }
  }

  async function onImportZip() {
    try {
      const result = await importZipBackup();
      if (!result) return;
      invalidateNotes(qc);
      notify('success', `已导入 ${result.notes} 篇笔记、${result.assets} 张图片（全部换成了新编号）`);
    } catch (raw) {
      onError(raw);
    }
  }

  return (
    <div className="system-page">
      <PageHeader
        title={PAGE_META.notes.label}
        actions={
          <>
            {/* 五枚图标钮里四枚画法几乎一样（箭头朝上/朝下 × 带不带托盘），并排只看得出一团灰。
                收成一枚下拉：图标在菜单里有文字并排，就不必靠字形自己说话了。
                触发钮只放一枚图标、不挂小箭头——40px 圆钮里托盘本身已带一个朝下的箭头，
                再并一枚小箭头就是两个箭头挤在一起；顶栏齿轮也是「单图标，点开出菜单」的同一套。 */}
            <Menu label="导入与导出" icon="importTray" align="end">
              {canWrite ? (
                <>
                  <DropdownItem icon="importTray" onPick={() => void onImportMarkdown()}>
                    导入 Markdown / 文本（可一次选多篇）
                  </DropdownItem>
                  <DropdownItem icon="upload" onPick={() => void onImportZip()}>
                    导入 zip 备份（本应用导出的那份）
                  </DropdownItem>
                  <DropdownDivider />
                </>
              ) : null}
              <DropdownItem icon="exportTray" onPick={() => void onExportMarkdown()}>
                导出本篇为 .md（图片内联；颜色、字号与对齐不保留）
              </DropdownItem>
              <DropdownItem icon="download" onPick={() => void onExportZip()}>
                导出全部为 zip 备份
              </DropdownItem>
            </Menu>
            {canWrite ? (
              <Button
                variant="bare"
                className="icon-btn"
                aria-label="新建笔记"
                title="新建笔记"
                disabled={create.isPending}
                onClick={() => create.mutate()}
              >
                <Icon name="plus" />
              </Button>
            ) : null}
          </>
        }
      />

      <div className="system-page-body">
        {!canWrite ? (
          <p className="panel-notice">
            当前角色只有查看权限（notes.read），这一页只能读：新建、修改与导入都需要 notes.write。
          </p>
        ) : null}

        <div className="notes-shell">
          <aside className="notes-list" aria-label="笔记列表">
            <TextField
              label="搜索笔记"
              value={term}
              placeholder="标题或正文里的词"
              leadingIcon="search"
              onChange={(event) => setTerm(event.target.value)}
            />

            {list.isLoading ? <Loading label="读取笔记列表…" /> : null}
            {list.isError ? <ErrorState raw={list.error} onRetry={() => void list.refetch()} /> : null}

            {!list.isLoading && !list.isError && rows.length === 0 ? (
              <p className="notes-blank notes-blank--inline">
                {query === null ? '还没有写过笔记' : '没有匹配这篇词的笔记'}
              </p>
            ) : null}

            <ul className="notes-list__items">
              {rows.map((row) => (
                <li key={row.id} className={row.id === selectedId ? 'notes-item is-active' : 'notes-item'}>
                  <button
                    type="button"
                    className="notes-item__main"
                    aria-current={row.id === selectedId ? 'true' : undefined}
                    onClick={() => setSelectedId(row.id)}
                  >
                    <span className="notes-item__title">{row.title}</span>
                    <span className="notes-item__snippet">{row.snippet === '' ? '空白笔记' : row.snippet}</span>
                    <span className="notes-item__time">{formatTimestamp(row.updatedAt)}</span>
                  </button>
                  {canWrite ? (
                    <Button
                      variant="bare"
                      className="btn-mini"
                      aria-label={`删除笔记 ${row.title}`}
                      title="删除这篇笔记"
                      onClick={() => setDeleting(row)}
                    >
                      <Icon name="trash" size={13} />
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          </aside>

          <section className="notes-main" aria-label="笔记内容">
            {selectedId === null ? (
              <div className="notes-blank">
                <Icon name="notebookPen" size={26} />
                <p className="notes-blank__title">左边选一篇，或者新建一篇</p>
                <p className="notes-blank__hint">正文自动保存：停下来约一秒就写进保险库，Cmd/Ctrl+S 立刻保存。</p>
              </div>
            ) : detail.isError ? (
              <ErrorState raw={detail.error} onRetry={() => void detail.refetch()} />
            ) : (
              <NotesEditor
                detail={detail.data ?? null}
                canWrite={canWrite}
                onEditorChange={(instance) => {
                  editorRef.current = instance;
                }}
              />
            )}
          </section>
        </div>
      </div>

      <Modal
        open={deleting !== null}
        title="删除这篇笔记"
        onClose={() => setDeleting(null)}
        footer={
          <>
            <Button onClick={() => setDeleting(null)}>取消</Button>
            <Button variant="danger" disabled={remove.isPending} onClick={() => deleting && remove.mutate(deleting.id)}>
              确认删除
            </Button>
          </>
        }
      >
        <p className="text-sm leading-relaxed text-ink-body">
          「{deleting?.title ?? ''}」连同它的图片会从本机保险库里删除。这一步不可撤销——删掉就没有回收站可以找回，
          要留档请先用页头的「导出本篇」。
        </p>
      </Modal>
    </div>
  );
}
