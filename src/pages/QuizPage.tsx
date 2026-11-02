import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PageHeader } from '../components/PageHeader';
import { QuizAssistantDialog } from '../components/quiz/QuizAssistantDialog';
import { QuizImportWizard } from '../components/quiz/QuizImportWizard';
import { QuizLibraryDetail } from '../components/quiz/QuizLibraryDetail';
import { QuizLibraryList } from '../components/quiz/QuizLibraryList';
import { Button } from '../components/ui/Button';
import { Icon } from '../components/ui/Icon';
import { Modal } from '../components/ui/Modal';
import { TextField } from '../components/ui/Field';
import { PAGE_META } from '../lib/pageMeta';
import { PERM, has, permissionSet, useMyPermissions } from '../lib/permissions';
import { api } from '../lib/api';
import { invalidateQuizLibraries, queryKeys } from '../lib/queryClient';
import { toNormalisedError } from '../lib/errors';
import { notify } from '../state/notify';
import { useLauncherNav } from '../state/launcherNav';
import type { QuizLibraryRow } from '../lib/types';

/**
 * 题库页（一级入口，与账号中心同级）。
 *
 * 本页是「导入 → 复核 → 发布」的落点：题库台账在这里，导入向导也从这里开。
 * 入口可见性由 menuTree 推导（`menu.node.top.quiz` + `quiz.library.read`），
 * 页面内的写按钮再按 `quiz.library.import/manage` 裁剪——真正的拒绝始终在后端命令里。
 * 页头三枚纯图标分别开：重建索引、答题助手、导入向导；说明写在各自的 title 里。
 */
export function QuizPage() {
  const qc = useQueryClient();
  const perms = permissionSet(useMyPermissions().data);
  const canImport = has(perms, PERM.QUIZ_LIBRARY_IMPORT);
  const canManage = has(perms, PERM.QUIZ_LIBRARY_MANAGE);
  const canUse = has(perms, PERM.QUIZ_ASSISTANT_USE);

  const libraries = useQuery({ queryKey: queryKeys.quizLibraries, queryFn: () => api.quizLibraries() });
  const rows = libraries.data ?? [];

  const [viewing, setViewing] = useState<QuizLibraryRow | null>(null);
  const [renaming, setRenaming] = useState<QuizLibraryRow | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [deleting, setDeleting] = useState<QuizLibraryRow | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [assistantOpen, setAssistantOpen] = useState(false);
  /** 详情弹窗里要落在哪一道题。只在浮层导航来时带值，手动打开必须是 null。 */
  const [detailFocus, setDetailFocus] = useState<{ questionId: string; seq: number } | null>(null);
  /** 导航到达、但那一份题库还没在异步来的清单里出现时先攥着的目标。 */
  const [navTarget, setNavTarget] = useState<{ libraryId: string; questionId: string; seq: number } | null>(null);

  function openLibrary(lib: QuizLibraryRow, focus: { questionId: string; seq: number } | null = null) {
    setViewing(lib);
    setDetailFocus(focus);
  }

  function closeLibrary() {
    setViewing(null);
    setDetailFocus(null);
  }

  /**
   * 浮层「打开这道题」的落点：先按 libraryId 认出那一份题库，再开弹窗并落在题号所在的那一页。
   *
   * 清单是异步来的，导航到达时 `rows` 可能还是空的，所以目标先攥在 `navTarget` 里，
   * 等那一份题库真的出现再开——拿一个清单里查不到的 libraryId 直接开弹窗，
   * 屏幕上会亮一句「这份题库里没有题目」，那是个比不开更糟的假象。
   */
  const pendingNav = useLauncherNav((s) => s.pending);
  useEffect(() => {
    if (!pendingNav || pendingNav.page !== 'quiz') return;
    useLauncherNav.getState().clear();
    setNavTarget({ libraryId: pendingNav.libraryId, questionId: pendingNav.questionId, seq: pendingNav.seq });
  }, [pendingNav]);

  useEffect(() => {
    if (navTarget === null) return;
    const lib = rows.find((row) => row.id === navTarget.libraryId);
    if (!lib) return;
    openLibrary(lib, { questionId: navTarget.questionId, seq: navTarget.seq });
    setNavTarget(null);
  }, [navTarget, rows]);

  const onError = (raw: unknown) => notify('danger', toNormalisedError(raw).message);

  const rename = useMutation({
    mutationFn: () => api.quizRenameLibrary((renaming as QuizLibraryRow).id, renameValue.trim()),
    onSuccess: (lib) => {
      notify('success', `已重命名为「${lib.name}」`);
      setRenaming(null);
      invalidateQuizLibraries(qc);
    },
    onError,
  });

  const remove = useMutation({
    mutationFn: () => api.quizDeleteLibrary((deleting as QuizLibraryRow).id),
    onSuccess: () => {
      notify('success', `已删除题库「${deleting?.name ?? ''}」`);
      setDeleting(null);
      invalidateQuizLibraries(qc);
    },
    onError,
  });

  const reindex = useMutation({
    mutationFn: () => api.quizReindex(),
    onSuccess: (count) => {
      notify('success', `全文索引已重建，共 ${count} 题`);
      invalidateQuizLibraries(qc);
    },
    onError,
  });

  function startRename(lib: QuizLibraryRow) {
    setRenameValue(lib.name);
    setRenaming(lib);
  }

  return (
    <div className="system-page">
      <PageHeader
        title={PAGE_META.quiz.label}
        desc={PAGE_META.quiz.desc}
        actions={
          <>
            {canManage ? (
              <Button
                variant="bare"
                className="icon-btn"
                aria-label="重建检索索引"
                title="重建检索索引：发布与删除时已自动维护，只有怀疑检索不全时才需要手动重建"
                disabled={reindex.isPending || rows.length === 0}
                onClick={() => reindex.mutate()}
              >
                <Icon name="refresh" className={reindex.isPending ? 'animate-spin' : undefined} />
              </Button>
            ) : null}
            {canUse ? (
              <Button
                variant="bare"
                className="icon-btn"
                aria-label="答题助手"
                title="答题助手：悬停自动识别、检索范围、停留时长与快捷键"
                onClick={() => setAssistantOpen(true)}
              >
                <Icon name="zap" />
              </Button>
            ) : null}
            {canImport ? (
              <Button
                variant="bare"
                className="icon-btn"
                aria-label="导入题库"
                title="导入题库：Word / Excel / TXT / CSV，可把文件直接拖进弹窗"
                onClick={() => setImportOpen(true)}
              >
                <Icon name="importTray" />
              </Button>
            ) : null}
          </>
        }
      />

      <div className="system-page-body">
        {!canImport ? (
          <p className="panel-notice">
            当前角色没有导入权限（quiz.library.import），只能查看已有题库。导入与发布题库需要由管理员授予该权限。
          </p>
        ) : null}

        <QuizLibraryList
          rows={rows}
          loading={libraries.isLoading}
          error={libraries.isError ? libraries.error : null}
          onRetry={() => void libraries.refetch()}
          canManage={canManage}
          pending={remove.isPending || rename.isPending}
          onView={(lib) => openLibrary(lib)}
          onRename={startRename}
          onDelete={setDeleting}
        />
      </div>

      <QuizLibraryDetail library={viewing} focus={detailFocus} onClose={closeLibrary} />

      <QuizImportWizard open={importOpen} onClose={() => setImportOpen(false)} />

      {/* 关掉即卸载：助手的状态轮询（运行中每 3 秒一次）随之停下，不在后台空转。 */}
      {canUse && assistantOpen ? <QuizAssistantDialog onClose={() => setAssistantOpen(false)} /> : null}

      <Modal
        open={!!renaming}
        title="重命名题库"
        onClose={() => setRenaming(null)}
        footer={
          <div className="flex w-full items-center justify-end gap-2 whitespace-nowrap">
            <Button onClick={() => setRenaming(null)}>取消</Button>
            <Button
              variant="primary"
              disabled={rename.isPending || !renameValue.trim()}
              onClick={() => rename.mutate()}
            >
              {rename.isPending ? '保存中…' : '保存'}
            </Button>
          </div>
        }
      >
        <TextField
          label="题库名称"
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          hint="最多 64 个字；重名是允许的（同一份资料的不同版本）。"
        />
      </Modal>

      <Modal
        open={!!deleting}
        title="删除题库"
        onClose={() => setDeleting(null)}
        footer={
          <div className="flex w-full items-center justify-end gap-2 whitespace-nowrap">
            <Button onClick={() => setDeleting(null)}>取消</Button>
            <Button variant="danger" disabled={remove.isPending} onClick={() => remove.mutate()}>
              {remove.isPending ? '删除中…' : '确认删除'}
            </Button>
          </div>
        }
      >
        <p className="text-sm leading-relaxed text-ink">
          将删除题库「{deleting?.name}」及其中 {deleting?.questionCount ?? 0} 道题目，并一并清掉全文索引。
          题目的导入记录仍留在审计日志里，但题目本身无法恢复。
        </p>
      </Modal>
    </div>
  );
}
