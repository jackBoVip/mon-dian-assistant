import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { TextField } from '../ui/Field';
import { Modal } from '../ui/Modal';
import { api } from '../../lib/api';
import { openFile } from '../../lib/dialogs';
import { invalidateNoteList } from '../../lib/queryClient';
import { toNormalisedError } from '../../lib/errors';
import { notify } from '../../state/notify';
import { NOTE_EXTENSIONS } from './extensions';
import { toAssetMap } from './AssetImage';
import { NoteAssetsContext } from './NoteAssetsContext';
import { rememberAsset, replaceAssetRegistry } from './assetRegistry';
import { NotesToolbar } from './NotesToolbar';
import { TableBubble } from './TableBubble';
import '../../styles/notesEditor.css';
import type { NoteDetail } from '../../lib/types';

/** 自动保存的节流档：打字停下来 700ms 才发一次，边写边发会把后端与审计都刷屏。 */
const SAVE_DEBOUNCE_MS = 700;

type SaveState = { kind: 'idle' | 'saving' | 'saved' | 'error'; at?: string; message?: string };

interface Snapshot {
  title: string;
  html: string;
}

export interface NotesEditorProps {
  /** 当前装载进编辑器的那一篇；换篇由父层的详情查询驱动。 */
  detail: NoteDetail | null;
  canWrite: boolean;
  /** 把编辑器实例交回页面：单篇导出 Markdown 要读它的 getMarkdown()。 */
  onEditorChange: (editor: Editor | null) => void;
}

function modifiedAt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '未知时间';
  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return `${date.getMonth() + 1}月${date.getDate()}日 ${time}`;
}

/** 状态那句只说本机这一台做的事：不发"已同步"，也不在没落库时说"已保存"。 */
function saveLabel(state: SaveState): string {
  if (state.kind === 'saving') return '正在保存…';
  if (state.kind === 'error') return `保存失败：${state.message ?? '未知原因'}`;
  return `上次修改发生在${modifiedAt(state.at ?? '')}`;
}

/**
 * 笔记编辑区：标题、工具栏、正文。所见即所得，正文这一屏就是成品效果。
 *
 * 三条约束决定了这里的写法：
 * 1. 换篇前必须先把没写完的防抖落库，否则最后 700ms 的字会丢；
 * 2. 装载另一篇不能被当成"用户改了内容"，所以走 `setContent(…, { emitUpdate: false })`；
 * 3. 保存按内容等值判断，同一份正文不反复发。
 */
export function NotesEditor({ detail, canWrite, onEditorChange }: NotesEditorProps) {
  const qc = useQueryClient();
  const [state, setState] = useState<SaveState>({ kind: 'idle', at: detail?.note.updatedAt ?? '' });
  const [titleDraft, setTitleDraft] = useState(detail?.note.title ?? '');
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkHref, setLinkHref] = useState('');

  // 回调与最新入参一律经 ref 读：useEditor 的依赖表要稳定，闭包不能把首帧焊死。
  const detailRef = useRef(detail);
  detailRef.current = detail;
  const canWriteRef = useRef(canWrite);
  canWriteRef.current = canWrite;
  const idRef = useRef(detail?.note.id ?? '');
  const titleRef = useRef(titleDraft);
  const savedRef = useRef<Snapshot>({ title: detail?.note.title ?? '', html: detail?.note.contentHtml ?? '' });
  const timerRef = useRef<number | null>(null);
  const editorRef = useRef<Editor | null>(null);

  const flush = useCallback(async () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const targetId = idRef.current;
    const editor = editorRef.current;
    if (!targetId || !editor || !canWriteRef.current) return;
    const payload: Snapshot = { title: titleRef.current, html: editor.getHTML() };
    const last = savedRef.current;
    if (payload.title === last.title && payload.html === last.html) return;
    setState({ kind: 'saving' });
    try {
      const record = await api.notesUpdate(targetId, payload.title, payload.html);
      // 只有还停在那一篇时才把"已保存"落到基线：切走了就不要污染新篇的基线
      if (idRef.current === targetId) savedRef.current = payload;
      setState({ kind: 'saved', at: record.updatedAt });
      invalidateNoteList(qc);
    } catch (raw) {
      setState({ kind: 'error', message: toNormalisedError(raw).message });
    }
  }, [qc]);

  const flushRef = useRef(flush);
  flushRef.current = flush;

  const schedule = useCallback(() => {
    if (!canWriteRef.current || !idRef.current) return;
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    setState({ kind: 'saving' });
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      void flushRef.current();
    }, SAVE_DEBOUNCE_MS);
  }, []);

  const editor = useEditor(
    {
      extensions: NOTE_EXTENSIONS,
      content: detail?.note.contentHtml ?? '',
      editable: canWrite,
      onUpdate: () => {
        schedule();
      },
      editorProps: {
        attributes: { class: 'notes-prose', 'aria-label': '笔记正文' },
        // 粘贴图片：剪贴板里的图片先上库，再插成引用素材的节点。
        handlePaste: (_view, event) => {
          const files = Array.from(event.clipboardData?.files ?? []).filter((f) => f.type.startsWith('image/'));
          if (files.length === 0) return false;
          event.preventDefault();
          const instance = editorRef.current;
          const noteId = idRef.current;
          if (!instance || !noteId || !canWriteRef.current) return true;
          for (const file of files) {
            const reader = new FileReader();
            reader.onload = () => {
              const dataUrl = typeof reader.result === 'string' ? reader.result : '';
              if (!dataUrl) return;
              void api
                .noteUploadAssetBytes(noteId, dataUrl)
                .then((asset) => {
                  rememberAsset(asset);
                  instance
                    .chain()
                    .focus()
                    .insertContent({ type: 'image', attrs: { assetId: asset.id, src: null, alt: file.name } })
                    .run();
                })
                .catch((raw: unknown) => notify('danger', toNormalisedError(raw).message));
            };
            reader.readAsDataURL(file);
          }
          return true;
        },
      },
    },
    [],
  );

  useEffect(() => {
    editorRef.current = editor;
    onEditorChange(editor);
  }, [editor, onEditorChange]);

  useEffect(() => {
    editor?.setEditable(canWrite);
  }, [editor, canWrite]);

  // 素材表：context 与模块级登记表在同一次装载里填，两处取 URL 才可能一致。
  const assets = detail?.assets;
  const assetMap = toAssetMap(assets ?? []);
  useEffect(() => {
    replaceAssetRegistry(assets ?? []);
  }, [assets]);

  // 换篇：先把上一篇的改动写完，再装载新篇。detail 为 null（还在读）时保持原样，不空屏。
  useEffect(() => {
    if (!editor || !detail) return;
    const loadedId = idRef.current;
    if (loadedId === detail.note.id) return;
    void flushRef.current();
    idRef.current = detail.note.id;
    titleRef.current = detail.note.title;
    setTitleDraft(detail.note.title);
    savedRef.current = { title: detail.note.title, html: detail.note.contentHtml };
    setState({ kind: 'idle', at: detail.note.updatedAt });
    editor.commands.setContent(detail.note.contentHtml, { emitUpdate: false });
  }, [editor, detail]);

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    [],
  );

  const pickImage = useCallback(async () => {
    const instance = editorRef.current;
    const noteId = idRef.current;
    if (!instance || !noteId || !canWriteRef.current) return;
    try {
      const path = await openFile({
        title: '选择要插入的图片',
        filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }],
      });
      if (!path) return;
      const asset = await api.noteUploadAssetFromPath(noteId, path);
      rememberAsset(asset);
      instance
        .chain()
        .focus()
        .insertContent({ type: 'image', attrs: { assetId: asset.id, src: null, alt: path.split(/[\\/]/).pop() ?? '' } })
        .run();
    } catch (raw) {
      notify('danger', toNormalisedError(raw).message);
    }
  }, []);

  return (
    <NoteAssetsContext.Provider value={assetMap}>
      <div
        className="note-editor"
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
            event.preventDefault();
            void flush();
          }
        }}
      >
        <div className="note-editor__head">
          <input
            className="note-title-input"
            value={titleDraft}
            placeholder="无标题笔记"
            maxLength={120}
            disabled={!canWrite}
            aria-label="笔记标题"
            onChange={(event) => {
              titleRef.current = event.target.value;
              setTitleDraft(event.target.value);
              schedule();
            }}
          />
          <p className="note-editor__meta">
            {state.kind === 'saving' || state.kind === 'error' ? null : <Icon name="checkCircle" size={14} />}
            <span
              className={state.kind === 'error' ? 'note-editor__status note-editor__status--error' : 'note-editor__status'}
            >
              {saveLabel(state)}
            </span>
          </p>
          {canWrite ? (
            <Button className="note-save-btn" disabled={state.kind === 'saving'} onClick={() => void flush()}>
              保存
            </Button>
          ) : null}
        </div>

        <NotesToolbar editor={editor} canWrite={canWrite} onPickImage={pickImage} onPickLink={() => setLinkOpen(true)} />
        <TableBubble editor={editor} />

        <div className="note-body">
          <EditorContent editor={editor} />
        </div>
      </div>

      <Modal open={linkOpen} title="添加链接" onClose={() => setLinkOpen(false)}>
        <div className="note-link-form">
          <TextField
            label="链接地址"
            type="url"
            value={linkHref}
            placeholder="https://example.com"
            onChange={(event) => setLinkHref(event.target.value)}
            hint="桌面壳内不打开外部浏览器：链接只作标记，选中正文里的文字再填地址。"
          />
          <div className="note-link-form__actions">
            <Button
              variant="primary"
              onClick={() => {
                const href = linkHref.trim();
                if (!href) {
                  notify('warning', '请先填写链接地址');
                  return;
                }
                editor?.chain().focus().extendMarkRange('link').setLink({ href }).run();
                setLinkHref('');
                setLinkOpen(false);
              }}
            >
              套用链接
            </Button>
            <Button
              onClick={() => {
                editor?.chain().focus().extendMarkRange('link').unsetLink().run();
                setLinkOpen(false);
              }}
            >
              清除链接
            </Button>
          </div>
        </div>
      </Modal>
    </NoteAssetsContext.Provider>
  );
}
