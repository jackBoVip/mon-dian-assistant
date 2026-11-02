import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
import { queryKeys } from '../lib/queryClient'
import { PERM, has, permissionSet, useMyPermissions } from '../lib/permissions'
import { toNormalisedError } from '../lib/errors'
import { notify } from '../state/notify'
import { useLauncherNav } from '../state/launcherNav'
import { openFile } from '../lib/dialogs'
import { useBackendEventPayload } from '../lib/vaultEvents'
import { PageHeader } from '../components/PageHeader'
import { Button } from '../components/ui/Button'
import { Badge } from '../components/ui/Badge'
import { Drawer } from '../components/ui/Drawer'
import { Modal } from '../components/ui/Modal'
import { Tabs, TabsList, TabsTrigger } from '../components/ui/tabs'
import { EmptyState, ErrorState, Loading } from '../components/ui/StateBlocks'
import { Icon } from '../components/ui/Icon'
import { ReleaseItemsTable } from '../components/tasks/ReleaseItemsTable'
import { EnvConfigDialog } from '../components/tasks/EnvConfigDialog'
import { RUN_LABELS, RUN_TONES, itemIsLive, runIsLive, runIsWorking } from '../components/tasks/releaseStatus'
import { PAGE_META } from '../lib/pageMeta'
import { TASK_ENV_LABELS, type TaskEnv, type TaskItemEvent, type TaskParsedNotes, type TaskRunEvent, type TaskRunStatus } from '../lib/types'

const TASK_KEY = 'release'

// 顺序与档位在这里，标签本身在 `TASK_ENV_LABELS`（浮层里的任务命中也读同一份，两处不能各抄一遍）
const ENVS: { value: TaskEnv; label: string }[] = (['test', 'prod'] as const).map((value) => ({
  value,
  label: TASK_ENV_LABELS[value],
}))


/** 还没选轮次时给的不是"这里没有东西"，而是接下来按顺序点哪。 */
function FirstRunGuide({ step, canRun }: { step: 'import' | 'prepare'; canRun: boolean }) {
  const steps = ['导入发布说明', '读取发布信息', '开始发布']
  const active = step === 'import' ? 0 : 1
  return (
    <div className="flex flex-col gap-3 py-1">
      <ol className="flex flex-wrap items-center gap-2">
        {steps.map((label, index) => (
          <li key={label} className="flex items-center gap-2">
            <span
              className={`flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs ${
                index === active ? 'border-[var(--t-primary)] font-semibold text-ink' : 'border-line text-ink-muted'
              }`}
            >
              <span className="num">{index + 1}</span>
              {label}
            </span>
            {index < steps.length - 1 ? <Icon name="chevronNext" size={12} className="text-ink-muted" /> : null}
          </li>
        ))}
      </ol>
      <p className="panel-notice">
        {step === 'import'
          ? '还没选这一轮要发什么：点「导入发布说明」，从本机挑一份 .docx（老的 .doc 请先用 Word/WPS 另存）。'
          : canRun
            ? '清单已经读到了：点「读取发布信息」，把每个服务的线上版本与目标镜像先对一遍。'
            : '清单已经读到了，但你这一档没有执行权限：找管理员要「执行测试环境发布」。'}
      </p>
    </div>
  )
}

/**
 * 微服务发布。
 *
 * 页面只做三件事：说清**现在能不能发**（四枚状态卡）、把**这一轮要发什么**摊开（条目表）、
 * 留下**发过什么**的凭据（右侧历史 + 日志抽屉）。每颗按钮的禁用理由都是可执行的下一步，
 * 不写"不可用"；生产那一发额外要逐条核对镜像。
 */
export function ReleasePage() {
  const qc = useQueryClient()
  const perms = permissionSet(useMyPermissions().data)
  const canView = has(perms, PERM.TASK_RELEASE_VIEW)
  const canConfigure = has(perms, PERM.TASK_RELEASE_CONFIGURE)
  const canRunTest = has(perms, PERM.TASK_RELEASE_RUN)
  const canRunProd = has(perms, PERM.TASK_RELEASE_RUN_PROD)

  const [env, setEnv] = useState<TaskEnv>('test')
  const [runId, setRunId] = useState<string | null>(null)
  const [parsed, setParsed] = useState<TaskParsedNotes | null>(null)
  const [envDialog, setEnvDialog] = useState(false)
  const [logOpen, setLogOpen] = useState(false)
  const [confirming, setConfirming] = useState(false)

  const canRunHere = env === 'prod' ? canRunProd && canRunTest : canRunTest
  const envLabel = TASK_ENV_LABELS[env]

  /** 切环境时一并撤掉当前视图：那一次运行属于另一档环境，留在屏上就是拿测试的进度讲生产。 */
  function switchEnv(next: TaskEnv) {
    setEnv(next)
    setRunId(null)
    setParsed(null)
  }

  /**
   * 浮层里点「微服务发布（测试/生产）」的落点：只把环境开关切到那一档。
   *
   * `taskKey` 不在这里判——后端 `quick_reveal` 已经验过它是不是真任务、
   * 环境是不是这一枚定义支持的档位；本页目前也只有 `release` 这一枚，重复判一遍只会多一处要走样的地方。
   */
  const pendingNav = useLauncherNav((s) => s.pending)
  useEffect(() => {
    if (!pendingNav || pendingNav.page !== 'tasks') return
    useLauncherNav.getState().clear()
    switchEnv(pendingNav.env)
  }, [pendingNav])

  // 任务定义（静态）：并发与尝试上限都由后端说一句话，界面不抄一份数字。
  const defs = useQuery({ queryKey: ['task-definitions'], queryFn: () => api.taskDefinitions(), enabled: canView })
  const def = useMemo(() => (defs.data ?? []).find((row) => row.key === TASK_KEY) ?? null, [defs.data])

  const session = useQuery({
    queryKey: queryKeys.taskSession(TASK_KEY, env),
    queryFn: () => api.taskSessionStatus(TASK_KEY, env),
    enabled: canView,
  })
  const detail = useQuery({
    queryKey: queryKeys.taskRun(runId ?? 'none'),
    queryFn: () => api.taskRunGet(runId as string),
    enabled: runId !== null,
  })
  const history = useQuery({
    queryKey: queryKeys.taskRuns(TASK_KEY, env),
    queryFn: () => api.taskRunList(TASK_KEY, env, 20),
    enabled: canView,
  })
  const logs = useQuery({
    queryKey: queryKeys.taskRunLogs(runId ?? 'none'),
    queryFn: () => api.taskRunLogs(runId as string, 0, 300),
    enabled: logOpen && runId !== null,
  })

  // 进页面就接上"这一档最近一轮"：运维点开时想看的是上一次发到哪了。
  // 已经导入了一份新说明时不抢——那说明人正要开新的一轮。
  useEffect(() => {
    if (runId === null && parsed === null && (history.data?.length ?? 0) > 0) {
      setRunId(history.data![0].id)
    }
  }, [history.data, runId, parsed])

  const run = detail.data?.run ?? null
  const items = useMemo(() => detail.data?.items ?? [], [detail.data])
  // 取消的可用范围比"还在跑"宽一档：停在待发布的一轮也可以取消（不发了）。
  const live = runIsLive(run?.status)
  const failedCount = items.filter((i) => i.status === 'failed').length
  const readyCount = items.filter((i) => i.status === 'ready').length
  const succeededCount = items.filter((i) => i.status === 'succeeded').length

  useBackendEventPayload<TaskRunEvent>('task://run', (event) => {
    if (event.runId !== runId) return
    qc.invalidateQueries({ queryKey: queryKeys.taskRun(event.runId) })
    qc.invalidateQueries({ queryKey: queryKeys.taskRunsAll })
    qc.invalidateQueries({ queryKey: queryKeys.taskRunLogs(event.runId) })
    if (!runIsLive(event.status) && event.status !== 'ready') {
      const label = RUN_LABELS[event.status as TaskRunStatus] ?? event.status
      notify(event.status === 'succeeded' ? 'success' : event.status === 'partial' ? 'warning' : 'danger', `${envLabel}发布结束：${label}`)
    }
  })
  useBackendEventPayload<TaskItemEvent>('task://item', (event) => {
    if (event.runId !== runId) return
    qc.invalidateQueries({ queryKey: queryKeys.taskRun(event.runId) })
  })

  const fail = (raw: unknown) => notify('danger', toNormalisedError(raw).message)

  const importNotes = useMutation({
    mutationFn: async () => {
      const path = await openFile({ filters: [{ name: '发布说明', extensions: ['docx'] }] })
      if (!path) return null
      return api.taskReleaseParse(path)
    },
    onSuccess: (result) => {
      if (!result) return
      setParsed(result)
      setRunId(null)
      if (result.rows.length === 0) {
        notify('warning', result.headerSeen ? '这份发布说明里没有可发的服务' : '没有找到带「服务名」与「镜像」表头的清单表格')
      } else {
        notify('success', `读到 ${result.rows.length} 个服务${result.appTars.length ? `，另有 ${result.appTars.length} 个微应用包链接` : ''}`)
      }
    },
    onError: fail,
  })

  /** 建一轮 + 读线上信息：合成一次点击，符合运维原来的用法。 */
  const prepare = useMutation({
    mutationFn: async () => {
      const rows = (parsed?.rows ?? []).map((row) => ({
        itemKey: row.serviceName,
        displayName: row.serviceName,
        desiredTag: row.designatedTag,
      }))
      const created = await api.taskRunCreate(TASK_KEY, env, rows)
      return api.taskRunPrepare(created.id)
    },
    onSuccess: (result) => {
      setRunId(result.id)
      qc.invalidateQueries({ queryKey: queryKeys.taskRuns(TASK_KEY, env) })
    },
    onError: fail,
  })

  const publish = useMutation({
    mutationFn: () => api.taskRunPublish(runId as string),
    onSuccess: (result) => {
      setConfirming(false)
      qc.invalidateQueries({ queryKey: queryKeys.taskRun(result.id) })
    },
    onError: fail,
  })

  const cancel = useMutation({
    mutationFn: () => api.taskRunCancel(runId as string),
    onSuccess: () => notify('success', '已请求取消：正在等待生效的条目会停下，没开始的直接跳过'),
    onError: fail,
  })

  const retry = useMutation({
    mutationFn: () => api.taskRunRetry(runId as string),
    onSuccess: () => notify('success', '失败项已放回读取；读完之后仍需你再次点「开始发布」'),
    onError: fail,
  })

  const login = useMutation({
    mutationFn: () => api.taskSessionLogin(TASK_KEY, env, true),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.taskSession(TASK_KEY, env) })
      notify('success', '已重新登录（后台完成，无需打开浏览器）')
    },
    onError: fail,
  })

  if (!canView) {
    return (
      <div className="page-panel">
        <PageHeader title={PAGE_META.release.label} desc={PAGE_META.release.desc} />
        <div className="main-panel">
          <EmptyState>当前账号没有「查看发布任务」权限，这一页没有可展示的内容。</EmptyState>
        </div>
      </div>
    )
  }

  const status = session.data
  const missingRunCopy = env === 'prod' ? '需要「执行生产环境发布」权限' : '需要「执行测试环境发布」权限'
  // 会话与绑定这些"背景状态"不再常驻一条卡片带；缺什么直接写在按钮的理由上。
  // 只在真的读过状态之后才判"没绑定"，否则首帧会把加载中的那一瞬说成缺配置。
  const notBoundCopy = '还没绑定登录凭据：请到「环境配置」里绑一条保险库账号'
  const notBound = status !== undefined && !status.bound
  const blockedCopy = !canRunHere ? missingRunCopy : notBound ? notBoundCopy : null
  const prepareDisabled = parsed === null || blockedCopy !== null || prepare.isPending || runIsWorking(run?.status)
  const prepareHint =
    blockedCopy ??
    (parsed === null
      ? '先导入发布说明'
      : runIsWorking(run?.status)
        ? '这一轮正在读取'
        : '读取线上版本并生成新一轮')
  const publishHint = blockedCopy
    ? blockedCopy
    : run === null
      ? '先导入发布说明，或从右侧历史里选一轮'
      : run.status === 'preparing'
        ? '还在读取线上信息'
        : run.status === 'running'
          ? '正在发布中'
          : run.status === 'ready'
            ? env === 'prod'
              ? '生产发布：将逐条核对镜像后确认'
              : `发布 ${readyCount} 个服务到${envLabel}`
            : '这一轮已经结束了，重新读取后再发'

  return (
    <div className="page-panel">
      <PageHeader
        title={PAGE_META.release.label}
        desc={PAGE_META.release.desc}
        actions={
          <div className="page-actions">
            <Tabs
              value={env}
              onValueChange={(value) => switchEnv(value as TaskEnv)}
            >
              <TabsList className="tabs" aria-label="发布环境">
                {ENVS.map((option) => (
                  <TabsTrigger key={option.value} value={option.value}>
                    {option.label}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
            <Button
              variant="ghost"
              disabled={!canConfigure}
              title={canConfigure ? '配置登录地址、凭据与站点参数' : '需要「配置发布任务」权限'}
              onClick={() => setEnvDialog(true)}
            >
              <Icon name="settings" size={14} />
              环境配置
            </Button>
          </div>
        }
      />

      <div className="flex min-h-0 flex-1 flex-col gap-4 lg:flex-row">
        <section className="main-panel flex min-h-0 min-w-0 flex-1 flex-col gap-3" aria-label="发布条目">
          <div className="panel-header">
            <h2 className="panel-title flex items-center gap-2">
              本轮清单
              {run ? <Badge tone={RUN_TONES[run.status]}>{RUN_LABELS[run.status]}</Badge> : null}
            </h2>
            <div className="header-actions">
              <Button
                variant="primary"
                disabled={importNotes.isPending || !canRunHere}
                title={canRunHere ? '从本机选一份 .docx 发布说明' : missingRunCopy}
                onClick={() => importNotes.mutate()}
              >
                {importNotes.isPending ? '读取文件中…' : '导入发布说明'}
              </Button>
              <Button disabled={prepareDisabled} title={prepareHint} onClick={() => prepare.mutate()}>
                {prepare.isPending ? '读取中…' : '读取发布信息'}
              </Button>
              <Button
                variant={env === 'prod' ? 'danger' : 'primary'}
                disabled={run?.status !== 'ready' || blockedCopy !== null || publish.isPending}
                title={publishHint}
                onClick={() => (env === 'prod' ? setConfirming(true) : publish.mutate())}
              >
                {publish.isPending ? '发布中…' : '开始发布'}
              </Button>
              <Button variant="ghost" disabled={!live || cancel.isPending} title={live ? '停止后续条目' : '这一轮没在跑'} onClick={() => cancel.mutate()}>
                取消
              </Button>
              <Button
                variant="ghost"
                disabled={runId === null || failedCount === 0 || retry.isPending || runIsWorking(run?.status)}
                title={failedCount === 0 ? '没有失败项' : runIsWorking(run?.status) ? '这一轮还在跑' : `重试 ${failedCount} 个失败项`}
                onClick={() => retry.mutate()}
              >
                重试失败项
              </Button>
              <Button variant="ghost" disabled={runId === null} title={runId === null ? '先读取发布信息' : '看这一轮的过程日志'} onClick={() => setLogOpen(true)}>
                运行日志
              </Button>
              {status?.active ? (
                <Button
                  variant="ghost"
                  disabled={login.isPending || blockedCopy !== null}
                  title={blockedCopy ?? '丢掉当前会话，重新静默登录一次'}
                  onClick={() => login.mutate()}
                >
                  {login.isPending ? '登录中…' : '重新登录'}
                </Button>
              ) : null}
            </div>
          </div>

          {parsed !== null && runId === null ? (
            <p className="panel-notice">
              已从发布说明读到 {parsed.rows.length} 个服务待读取
              {parsed.truncated ? '（文档超出单轮上限，只取前若干条）' : ''}
              {parsed.appTars.length > 0 ? `；另有 ${parsed.appTars.length} 个微应用包链接，不属于本次镜像发布` : ''}。点「读取发布信息」把它们与线上版本对一遍。
            </p>
          ) : null}

          {runId === null ? (
            <FirstRunGuide canRun={canRunHere} step={parsed === null ? 'import' : 'prepare'} />
          ) : detail.isPending ? (
            <Loading />
          ) : detail.isError ? (
            <ErrorState raw={detail.error} />
          ) : run === null ? (
            <EmptyState>这一轮的记录读不到了：可能已被清理，重新读取一次。</EmptyState>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-muted">
                <span>
                  共 {items.length} 项 · 成功 {succeededCount} · 待发布 {readyCount} · 失败 {failedCount}
                </span>
                {items.some((i) => itemIsLive(i.status)) ? <span>有条目正在读写，这一页会自己更新</span> : null}
              </div>
              <div className="min-h-0 flex-1 overflow-auto">
                <ReleaseItemsTable items={items} maxAttempts={def?.maxAttempts} />
              </div>
            </>
          )}
        </section>

        <aside className="panel flex w-full shrink-0 flex-col gap-2 p-3 lg:w-[19rem]" aria-label="历史运行">
          <div className="panel-header">
            <h2 className="panel-title">最近{envLabel}发布</h2>
            <span className="text-[11px] text-ink-muted">{(history.data ?? []).length} 轮</span>
          </div>
          {history.isPending ? (
            <Loading />
          ) : (history.data?.length ?? 0) === 0 ? (
            <p className="panel-notice">还没有过{envLabel}发布记录。</p>
          ) : (
            <ul className="flex min-h-0 flex-col gap-1 overflow-auto">
              {(history.data ?? []).map((row) => (
                <li key={row.id}>
                  <button
                    type="button"
                    className={`flex w-full flex-col gap-1 rounded-md border px-3 py-2 text-left text-xs transition-colors ${
                      row.id === runId ? 'border-[var(--t-primary)] bg-sunken' : 'border-line hover:bg-sunken'
                    }`}
                    onClick={() => {
                      setRunId(row.id)
                      setParsed(null)
                    }}
                  >
                    <span className="flex items-center gap-2">
                      <Badge tone={RUN_TONES[row.status]}>{RUN_LABELS[row.status]}</Badge>
                      <span className="tabular-nums text-ink-body">{row.createdAt.slice(5, 16).replace('T', ' ')}</span>
                    </span>
                    <span className="truncate text-ink-muted">
                      {row.total} 项 · 成功 {row.succeeded} · 失败 {row.failed}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </aside>
      </div>

      <Drawer open={logOpen} title="运行日志" onClose={() => setLogOpen(false)}>
        {logs.isPending ? (
          <Loading />
        ) : (logs.data?.length ?? 0) === 0 ? (
          <EmptyState>这一轮还没有日志。</EmptyState>
        ) : (
          <ul className="flex flex-col gap-1 font-mono text-xs">
            {(logs.data ?? []).map((line) => (
              <li key={line.seq} className="flex gap-2">
                <span className="shrink-0 tabular-nums text-ink-muted">{line.ts.slice(11, 19)}</span>
                <Badge tone={line.level === 'error' ? 'danger' : line.level === 'warn' ? 'warning' : 'muted'}>{line.level}</Badge>
                <span className="min-w-0 break-words">
                  {line.itemKey ? `${line.itemKey}：` : ''}
                  {line.message}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Drawer>

      {envDialog && <EnvConfigDialog taskKey={TASK_KEY} env={env} envLabel={envLabel} onClose={() => setEnvDialog(false)} />}

      {confirming && (
        <Modal
          open
          title="生产环境发布确认"
          onClose={() => setConfirming(false)}
          wide
          footer={
            <>
              <Button variant="ghost" onClick={() => setConfirming(false)}>
                取消
              </Button>
              <Button variant="danger" disabled={publish.isPending} onClick={() => publish.mutate()}>
                {publish.isPending ? '发布中…' : `确认发布 ${readyCount} 个服务`}
              </Button>
            </>
          }
        >
          <p className="panel-notice">
            下面是即将发到{envLabel}的每一个服务与它要换上的镜像。逐条看清镜像，确认后不可撤回——只能再用一份新的发布说明把它换回去。
          </p>
          <ul className="flex flex-col gap-1">
            {items
              .filter((i) => i.status === 'ready')
              .map((item) => (
                <li key={item.id} className="flex items-center gap-2 text-xs">
                  <span className="min-w-0 truncate font-medium text-ink">{item.itemKey}</span>
                  <span className="min-w-0 flex-1 truncate text-ink-body" title={item.imageRef ?? ''}>
                    {item.imageRef ?? '未读取'}
                  </span>
                  <span className="shrink-0 text-ink-muted">线上 {item.serviceUpdatedAt?.slice(0, 19).replace('T', ' ') ?? '未知'}</span>
                </li>
              ))}
          </ul>
        </Modal>
      )}
    </div>
  )
}
