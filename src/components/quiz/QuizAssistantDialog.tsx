import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { toNormalisedError } from '../../lib/errors';
import { queryKeys } from '../../lib/queryClient';
import { notify } from '../../state/notify';
import type {
  QuizAssistantPreferences,
  QuizAssistantPreferencesInput,
  QuizAssistantStatus,
  QuizLookup,
  QuizMatchHit,
  QuizOcrStatus,
} from '../../lib/types';
import { Badge, type BadgeTone } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Checkbox } from '../ui/checkbox';
import { SelectField, TextAreaField, TextField } from '../ui/Field';
import { Modal } from '../ui/Modal';
import { Switch } from '../ui/switch';
import { QuizMatchHits } from './QuizMatchHits';

const ENGINE_LABEL: Record<QuizOcrStatus['state'], string> = {
  idle: '引擎未加载',
  loading: '正在加载模型',
  ready: '引擎就绪',
  failed: '引擎加载失败',
  unavailable: '引擎不可用',
};

const ENGINE_TONE: Record<QuizOcrStatus['state'], BadgeTone> = {
  idle: 'muted',
  loading: 'muted',
  ready: 'success',
  failed: 'danger',
  unavailable: 'danger',
};

/** 停留时长候选：都在后端 200–2000ms 的范围内，界面不提供自由输入。 */
const DWELL_OPTIONS = [300, 520, 800, 1200, 2000].map((ms) => ({ value: String(ms), label: `${ms} 毫秒` }));

function toInput(prefs: QuizAssistantPreferences): QuizAssistantPreferencesInput {
  return {
    scopeMode: prefs.scopeMode,
    dwellMs: prefs.dwellMs,
    hotkey: prefs.hotkey,
    showOptions: prefs.showOptions,
    libraryIds: [...prefs.libraryIds],
  };
}

export interface QuizAssistantDialogProps {
  onClose: () => void;
}

/**
 * 答题助手弹窗：启用开关、检索范围、停留时长、快捷键，再加两条手动入口。
 *
 * 原来是常驻在题库页下方的一张卡片，2026-10-29 按交付方意见收进弹窗、页面只留页头一枚图标。
 * 组件随弹窗一起挂载/卸载，所以关掉之后状态轮询（运行中每 3 秒一次）自然停下。
 *
 * 「启用」是真的在跑悬停线程（每 120ms 看一次光标），不是只存一个开关值；
 * 所以关掉时线程、浮层、全局快捷键必须一起收走，这里只负责把用户意图交给后端。
 * 设置是整份提交：改了哪一项都点「保存设置」，避免半截配置在运行中生效。
 */
export function QuizAssistantDialog({ onClose }: QuizAssistantDialogProps) {
  const qc = useQueryClient();
  const [cursorResult, setCursorResult] = useState<QuizLookup | null>(null);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [pasteHits, setPasteHits] = useState<QuizMatchHit[] | null>(null);

  const status = useQuery({
    queryKey: queryKeys.quizAssistantStatus,
    queryFn: () => api.quizAssistantStatus(),
    // 运行中要能看见「自己停了」（权限被收回、连续失败），加载模型时要能等到就绪。
    refetchInterval: (query) => {
      const data = query.state.data;
      if (data?.running) return 3000;
      return data?.ocr.state === 'loading' ? 700 : false;
    },
  });
  const libraries = useQuery({ queryKey: queryKeys.quizLibraries, queryFn: () => api.quizLibraries() });

  const saved = status.data?.preferences;
  const savedKey = saved ? JSON.stringify(toInput(saved)) : '';
  const [draft, setDraft] = useState<{ value: QuizAssistantPreferencesInput; base: string } | null>(null);
  useEffect(() => {
    if (!saved) return;
    // 已经存进去的值变了才覆盖草稿；轮询回来的同一份值不能把正在编辑的内容冲掉。
    setDraft((cur) => (cur && cur.base === savedKey ? cur : { value: toInput(saved), base: savedKey }));
  }, [savedKey, saved]);

  const onError = (raw: unknown) => notify('danger', toNormalisedError(raw).message);
  const applyStatus = (next: QuizAssistantStatus) => {
    qc.setQueryData(queryKeys.quizAssistantStatus, next);
    void qc.invalidateQueries({ queryKey: queryKeys.quizScreenPermission });
  };

  const start = useMutation({
    mutationFn: () => api.quizAssistantStart(),
    onSuccess: (next) => {
      applyStatus(next);
      notify('success', '悬停识别已启用：把鼠标停在题干上就会出答案。');
    },
    onError,
  });

  const stop = useMutation({
    mutationFn: () => api.quizAssistantStop(),
    onSuccess: (next) => {
      applyStatus(next);
      notify('info', '悬停识别已停用，全局快捷键也已摘除。');
    },
    onError,
  });

  const savePrefs = useMutation({
    mutationFn: (input: QuizAssistantPreferencesInput) => api.quizAssistantSetPreferences(input),
    onSuccess: (prefs) => {
      setDraft({ value: toInput(prefs), base: JSON.stringify(toInput(prefs)) });
      void qc.invalidateQueries({ queryKey: queryKeys.quizAssistantStatus });
      notify('success', '答题助手设置已保存。');
    },
    onError,
  });

  const cursorLookup = useMutation({
    mutationFn: () => api.quizLookupAtCursor(scopeIds(saved)),
    onSuccess: (data) => {
      setCursorResult(data);
      if (!data.text.trim()) notify('warning', '光标附近没有识别到文字。');
      else if (data.hits.length === 0) notify('info', '识别到了文字，但题库里没有足够接近的题目。');
    },
    onError,
    // 首次识别才会加载模型：结果回来时引擎状态多半已经变了。
    onSettled: () => void qc.invalidateQueries({ queryKey: queryKeys.quizAssistantStatus }),
  });

  const pasteLookup = useMutation({
    mutationFn: (text: string) => api.quizMatchText(text),
    onSuccess: (hits) => setPasteHits(hits),
    onError,
  });

  const requestPermission = useMutation({
    mutationFn: () => api.quizRequestScreenPermission(),
    onSuccess: (perm) => {
      qc.setQueryData(queryKeys.quizScreenPermission, perm);
      void qc.invalidateQueries({ queryKey: queryKeys.quizAssistantStatus });
      if (perm.permission === 'granted') {
        notify('success', '已获得屏幕录制权限；系统要求重启应用后才对截屏生效。');
      } else {
        notify('warning', '还没有授权：请在系统设置的「隐私与安全性 → 屏幕录制」里勾选本应用。');
      }
    },
    onError,
  });

  const data = status.data;
  const engineState = data?.ocr.state ?? 'idle';
  const engineUsable = engineState === 'idle' || engineState === 'ready' || engineState === 'loading';
  const perm = data?.screen;
  const permBlocked = perm ? !perm.supported || perm.permission === 'denied' : false;
  const running = data?.running ?? false;
  const busy = start.isPending || stop.isPending || savePrefs.isPending;
  const textEmpty = pasteText.trim().length < 2;

  /**
   * 拨到「启用」：能开就直接开；卡在权限上就当场去向系统申请，而不是把开关禁掉让人猜。
   * 授权后 macOS 仍要求重启应用才对截屏生效，这句由 `requestPermission` 的回执说。
   */
  function requestStart() {
    if (!data) {
      notify('warning', '还在读取助手状态，稍等一下再拨。');
      return;
    }
    if (permBlocked) {
      if (perm?.supported === false) {
        notify('warning', '当前运行环境不支持截屏，悬停识别开不起来。');
        return;
      }
      notify('warning', '还没有屏幕录制权限，正在向系统申请：授权后需退出并重开本应用才生效。');
      requestPermission.mutate();
      return;
    }
    if (!engineUsable) {
      notify('warning', data?.ocr.detail || 'OCR 引擎当前不可用，先处理模型问题再启用。');
      void qc.invalidateQueries({ queryKey: queryKeys.quizAssistantStatus });
      return;
    }
    start.mutate();
  }

  const startHint = !data
    ? '正在读取助手状态'
    : permBlocked
      ? perm?.supported === false
        ? '当前运行环境不支持截屏'
        : '还没有屏幕录制权限：点这里会直接向系统申请'
      : !engineUsable
        ? 'OCR 引擎当前不可用，先处理模型问题'
        : '启用悬停识别';

  const value = draft?.value;
  const dirty = !!draft && JSON.stringify(draft.value) !== draft.base;
  const scopeEmpty = !!value && value.scopeMode === 'selected' && value.libraryIds.length === 0;
  const scopeDisabled = !value || !dirty || scopeEmpty;
  const knownLibraries = libraries.data ?? [];

  function toggleLibrary(id: string) {
    setDraft((cur) => {
      if (!cur) return cur;
      const ids = cur.value.libraryIds.includes(id)
        ? cur.value.libraryIds.filter((x) => x !== id)
        : [...cur.value.libraryIds, id];
      return { ...cur, value: { ...cur.value, libraryIds: ids } };
    });
  }

  return (
    <Modal
      open
      wide
      title="答题助手"
      onClose={onClose}
      footer={
        <div className="flex w-full items-center justify-between gap-3">
          <span className="min-w-0 text-xs text-ink-muted">截图只在内存里过一遍，不落盘、不写审计。</span>
          <Button className="shrink-0 whitespace-nowrap" onClick={onClose}>
            关闭
          </Button>
        </div>
      }
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="min-w-0 text-xs leading-relaxed text-ink-muted">
          截取光标附近的文字，在已发布的题库里找最接近的一道题并给出答案。
        </p>
        <span className="flex shrink-0 items-center gap-2">
          {/* 状态读不到时不猜：开关仍然给出去（拨了由后端回话），旁边那枚徽标说明现在读不到。 */}
          {status.isLoading ? <Badge>读取状态…</Badge> : null}
          {status.isError ? <Badge tone="warning">状态未知</Badge> : null}
          <Switch
            aria-label="启用悬停自动识别"
            checked={running}
            checkedText="启用"
            uncheckedText="关闭"
            disabled={busy}
            title={running ? '停用悬停识别' : startHint}
            onCheckedChange={(on) => (on ? requestStart() : stop.mutate())}
          />
        </span>
      </div>

      {data?.detail ? (
        <p className="mt-2 rounded-md border border-line bg-sunken px-3 py-2 text-xs leading-relaxed text-ink-body">
          上次自动停用：{data.detail}
        </p>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="text-xs text-ink-muted">屏幕录制</span>
        {status.isLoading ? (
          <Badge>检测中…</Badge>
        ) : status.isError ? (
          <Badge tone="warning">无法检测</Badge>
        ) : permBlocked ? (
          <>
            <Badge tone="warning">{perm?.supported === false ? '当前环境不支持' : '未授权'}</Badge>
            {perm?.supported === false ? null : (
              <Button
                variant="ghost"
                className="whitespace-nowrap"
                disabled={requestPermission.isPending}
                onClick={() => requestPermission.mutate()}
              >
                {requestPermission.isPending ? '申请中…' : '申请权限'}
              </Button>
            )}
          </>
        ) : (
          <Badge tone="success">已授权</Badge>
        )}
        <span className="text-xs text-ink-muted">OCR 引擎</span>
        <Badge tone={status.isError ? 'warning' : ENGINE_TONE[engineState]}>
          {status.isError ? '状态未知' : ENGINE_LABEL[engineState]}
        </Badge>
        {perm?.detail ? <span className="w-full text-xs leading-relaxed text-ink-muted">{perm.detail}</span> : null}
        {data?.ocr.detail ? (
          <span className="w-full text-xs leading-relaxed text-ink-muted">{data.ocr.detail}</span>
        ) : null}
      </div>

      <div className="mt-3 grid gap-3 rounded-md border border-line bg-sunken px-3 py-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm text-ink">悬停自动识别</p>
            <p className="mt-0.5 text-xs leading-relaxed text-ink-muted">
              开启后鼠标在同一处停留约 {saved?.dwellMs ?? 520} 毫秒即截取一次并显示答案；按住{' '}
              <kbd>{saved?.hotkey ?? '—'}</kbd> 可在不解锁主界面的情况下随时开关。
            </p>
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <SelectField
            label="匹配范围"
            value={value?.scopeMode ?? 'all'}
            options={[
              { value: 'all', label: '全部题库' },
              { value: 'selected', label: '指定题库' },
            ]}
            disabled={!value || savePrefs.isPending}
            onValueChange={(next) =>
              setDraft((cur) =>
                cur ? { ...cur, value: { ...cur.value, scopeMode: next === 'selected' ? 'selected' : 'all' } } : cur,
              )
            }
            hint="全部题库按相似度在每一份已发布题库里找；指定题库只在你勾选的范围内查。"
          />
          <SelectField
            label="停留时长"
            value={String(value?.dwellMs ?? 520)}
            options={DWELL_OPTIONS}
            disabled={!value || savePrefs.isPending}
            onValueChange={(next) =>
              setDraft((cur) => (cur ? { ...cur, value: { ...cur.value, dwellMs: Number(next) } } : cur))
            }
            hint="越短越跟手，但手划过题干时更容易误触发。"
          />
        </div>

        {value?.scopeMode === 'selected' ? (
          <fieldset className="grid gap-1.5">
            <legend className="text-xs text-ink-muted">参与识别的题库</legend>
            {libraries.isLoading ? (
              <p className="text-xs text-ink-muted">正在读取题库…</p>
            ) : knownLibraries.length === 0 ? (
              <p className="text-xs text-ink-muted">还没有已发布的题库，先导入一份再来指定范围。</p>
            ) : (
              <div className="grid gap-1.5 sm:grid-cols-2">
                {knownLibraries.map((lib) => (
                  <label key={lib.id} className="flex items-center gap-2 text-sm text-ink">
                    <Checkbox
                      checked={value.libraryIds.includes(lib.id)}
                      onCheckedChange={() => toggleLibrary(lib.id)}
                      aria-label={`在检索范围里包含题库「${lib.name}」`}
                    />
                    <span className="min-w-0 truncate" title={lib.name}>
                      {lib.name}
                    </span>
                    <span className="ml-auto shrink-0 text-xs tabular-nums text-ink-muted">{lib.questionCount}</span>
                  </label>
                ))}
              </div>
            )}
            {scopeEmpty ? <p className="text-xs text-warning">至少勾选一份题库，否则范围为空、无法开始识别。</p> : null}
          </fieldset>
        ) : null}

        <div className="grid gap-3 sm:grid-cols-2">
          <TextField
            label="全局快捷键"
            value={value?.hotkey ?? ''}
            disabled={!value || savePrefs.isPending}
            onChange={(e) =>
              setDraft((cur) => (cur ? { ...cur, value: { ...cur.value, hotkey: e.target.value } } : cur))
            }
            hint="至少含一个非 Shift 修饰键，例如 Cmd+Alt+Q / Ctrl+Alt+Q；不能与启动器快捷键相同。"
          />
          <div className="flex flex-wrap items-start justify-between gap-3 self-end">
            <div className="min-w-0">
              <p className="text-sm text-ink">答案里显示选项</p>
              <p className="mt-0.5 text-xs leading-relaxed text-ink-muted">关掉后浮层只给题干与答案。</p>
            </div>
            <Switch
              aria-label="答案里显示选项"
              checked={value?.showOptions ?? true}
              disabled={!value || savePrefs.isPending}
              onCheckedChange={(on) =>
                setDraft((cur) => (cur ? { ...cur, value: { ...cur.value, showOptions: on } } : cur))
              }
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2">
          {dirty ? <span className="mr-auto text-xs text-ink-muted">设置已改动，尚未生效。</span> : null}
          <Button
            variant="primary"
            className="whitespace-nowrap"
            disabled={scopeDisabled || savePrefs.isPending}
            onClick={() => value && savePrefs.mutate(value)}
          >
            {savePrefs.isPending ? '保存中…' : '保存设置'}
          </Button>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          variant="primary"
          className="whitespace-nowrap"
          disabled={!engineUsable || permBlocked || cursorLookup.isPending}
          title={
            !engineUsable
              ? 'OCR 引擎不可用，先解决模型问题'
              : permBlocked
                ? '需要先获得屏幕录制权限'
                : '识别光标附近的文字，在已保存的检索范围里找答案'
          }
          onClick={() => cursorLookup.mutate()}
        >
          {cursorLookup.isPending ? '识别中…' : '在光标处试一次'}
        </Button>
        <Button
          variant="ghost"
          className="whitespace-nowrap"
          onClick={() => {
            setPasteHits(null);
            setPasteOpen(true);
          }}
        >
          粘贴题干试一次
        </Button>
      </div>

      {cursorResult ? (
        <div className="mt-3 grid gap-2">
          <p className="text-xs leading-relaxed text-ink-muted">
            识别原文（{cursorResult.ocrMs}ms · 匹配 {cursorResult.matchMs}ms）
          </p>
          <pre className="max-h-28 overflow-auto whitespace-pre-wrap break-all rounded-md border border-line bg-sunken px-3 py-2 text-xs leading-relaxed text-ink-body">
            {cursorResult.text || '（没有识别到文字）'}
          </pre>
          <QuizMatchHits
            hits={cursorResult.hits}
            showOptions={saved?.showOptions ?? true}
            emptyHint={cursorResult.text.trim() ? '题库里没有足够接近的题目。' : '光标附近没有文字，把鼠标停在题干上再试。'}
          />
        </div>
      ) : null}

      <Modal
        open={pasteOpen}
        title="粘贴题干试一次"
        onClose={() => setPasteOpen(false)}
        footer={
          <div className="flex w-full items-center justify-end gap-2 whitespace-nowrap">
            <Button onClick={() => setPasteOpen(false)}>关闭</Button>
            <Button variant="primary" disabled={textEmpty || pasteLookup.isPending} onClick={() => pasteLookup.mutate(pasteText)}>
              {pasteLookup.isPending ? '查找中…' : '查找答案'}
            </Button>
          </div>
        }
      >
        <div className="grid gap-3">
          <TextAreaField
            label="题干"
            rows={4}
            value={pasteText}
            placeholder="粘贴或输入题干，至少 2 个字"
            hint="不经过 OCR，直接在全部题库里检索——用来确认题库本身有没有收录这道题。"
            onChange={(e) => setPasteText(e.target.value)}
          />
          {pasteHits ? <QuizMatchHits hits={pasteHits} showOptions={saved?.showOptions ?? true} /> : null}
        </div>
      </Modal>
    </Modal>
  );
}

/** 手动识别的检索范围：与悬停线程共用同一份设置，「指定题库」时只查勾选的几份。 */
function scopeIds(prefs: QuizAssistantPreferences | undefined): string[] | null {
  if (!prefs || prefs.scopeMode !== 'selected' || prefs.libraryIds.length === 0) return null;
  return prefs.libraryIds;
}
