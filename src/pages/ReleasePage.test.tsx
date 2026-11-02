import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { vi } from 'vitest'
import { ReleasePage } from './ReleasePage'
import { pointerTap } from '../test/pointer'
import { PERM } from '../lib/permissions'
import { useLauncherNav } from '../state/launcherNav'
import type { TaskRunDetail, TaskRunListItem, TaskSessionStatus } from '../lib/types'

const mocks = vi.hoisted(() => ({
  myPermissions: vi.fn(),
  taskDefinitions: vi.fn(),
  taskProfileGet: vi.fn(),
  taskBindingGet: vi.fn(),
  taskSessionStatus: vi.fn(),
  taskSessionLogin: vi.fn(),
  taskProbeLogin: vi.fn(),
  taskReleaseParse: vi.fn(),
  taskRunCreate: vi.fn(),
  taskRunPrepare: vi.fn(),
  taskRunPublish: vi.fn(),
  taskRunCancel: vi.fn(),
  taskRunRetry: vi.fn(),
  taskRunGet: vi.fn(),
  taskRunList: vi.fn(),
  taskRunLogs: vi.fn(),
  listTargets: vi.fn(),
  targetItems: vi.fn(),
}))

vi.mock('../lib/api', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../lib/api')>()
  return { ...mod, api: { ...mod.api, ...mocks } }
})

const picked = vi.fn()
vi.mock('../lib/dialogs', () => ({ openFile: (opts: unknown) => picked(opts) }))

const VIEW = [PERM.TASK_RELEASE_VIEW]
const TEST_RUN = [...VIEW, PERM.TASK_RELEASE_CONFIGURE, PERM.TASK_RELEASE_RUN]
const PROD_RUN = [...TEST_RUN, PERM.TASK_RELEASE_RUN_PROD]

function session(over: Partial<TaskSessionStatus> = {}): TaskSessionStatus {
  return {
    bound: true,
    configured: true,
    active: false,
    cookieNames: [],
    acquiredSecondsAgo: null,
    ttlMinutes: 30,
    loginUrl: 'https://sso.example.com/login',
    loginUrlSource: 'credential',
    credentialLabel: '运维账号',
    ...over,
  }
}

function detail(status: 'ready' | 'running' | 'partial' = 'ready'): TaskRunDetail {
  return {
    run: { id: 'r-1', taskKey: 'release', env: 'test', status, cancelRequested: false, createdBy: 'u1' },
    items: [
      {
        id: 'i-1',
        ordinal: 0,
        itemKey: 'order-service',
        displayName: 'order-service',
        desiredTag: null,
        imageRef: 'harbor/ns/order:20261030',
        appId: 'app-1',
        serviceUpdatedAt: '2024-10-27T03:33:20+00:00',
        tagUpdatedAt: '2024-10-28T07:20:00+00:00',
        status: 'ready',
        attempts: 1,
        message: '目标 tag 20261030',
      },
      {
        id: 'i-2',
        ordinal: 1,
        itemKey: 'pay-service',
        displayName: null,
        desiredTag: '20261029',
        imageRef: null,
        appId: null,
        serviceUpdatedAt: null,
        tagUpdatedAt: null,
        status: 'failed',
        attempts: 2,
        message: '指定的镜像 20261029 不在「pay-service」的仓库里',
      },
    ],
  }
}

function historyRow(): TaskRunListItem {
  return {
    id: 'r-1',
    taskKey: 'release',
    env: 'test',
    status: 'ready',
    createdBy: 'u1',
    createdAt: '2026-10-30T06:02:00.000Z',
    startedAt: null,
    finishedAt: null,
    cancelRequested: false,
    total: 2,
    ready: 1,
    succeeded: 0,
    failed: 1,
    skipped: 0,
  }
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return render(
    <QueryClientProvider client={qc}>
      <ReleasePage />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  for (const fn of Object.values(mocks)) fn.mockReset()
  // 导航 store 是模块级的：上一条用例留下的那一条会把这一条的环境开关切走
  useLauncherNav.getState().clear()
  picked.mockReset()
  mocks.myPermissions.mockResolvedValue(TEST_RUN)
  mocks.taskDefinitions.mockResolvedValue([
    { key: 'release', label: '微服务发布', envs: ['test', 'prod'], prepareConcurrency: 5, publishConcurrency: 10, maxAttempts: 3 },
  ])
  mocks.taskSessionStatus.mockResolvedValue(session())
  mocks.taskRunGet.mockResolvedValue(detail())
  mocks.taskRunList.mockResolvedValue([historyRow()])
  mocks.taskRunLogs.mockResolvedValue([])
  mocks.taskReleaseParse.mockResolvedValue({
    rows: [{ ordinal: 0, serviceName: 'order-service', imageHint: 'harbor/ns/order', designatedTag: null }],
    appTars: [],
    tablesSeen: 1,
    headerSeen: true,
    truncated: false,
  })
  mocks.taskRunCreate.mockResolvedValue({ id: 'r-9', taskKey: 'release', env: 'test', status: 'preparing', cancelRequested: false, createdBy: 'u1' })
  mocks.taskRunPrepare.mockResolvedValue({ id: 'r-9', taskKey: 'release', env: 'test', status: 'ready', cancelRequested: false, createdBy: 'u1' })
  mocks.taskRunPublish.mockResolvedValue(detail('running').run)
  mocks.taskRunCancel.mockResolvedValue(detail('running').run)
  mocks.taskRunRetry.mockResolvedValue({ id: 'r-1', taskKey: 'release', env: 'test', status: 'preparing', cancelRequested: false, createdBy: 'u1' })
})

describe('微服务发布页', () => {
  it('没有查看权限时不发起任何任务侧取数，只说明缺哪一枚权限', async () => {
    mocks.myPermissions.mockResolvedValue([PERM.MENU_ACCOUNTS])
    renderPage()
    expect(await screen.findByText(/没有「查看发布任务」权限/)).toBeTruthy()
    expect(mocks.taskSessionStatus).not.toHaveBeenCalled()
    expect(mocks.taskRunList).not.toHaveBeenCalled()
  })

  it('导入 → 读取发布信息：建一轮再读，条目表跟着这一轮走', async () => {
    renderPage()
    await screen.findByRole('button', { name: /导入发布说明/ })

    picked.mockResolvedValue('/tmp/发布说明.docx')
    fireEvent.click(screen.getByRole('button', { name: /导入发布说明/ }))
    await waitFor(() => expect(mocks.taskReleaseParse).toHaveBeenCalledWith('/tmp/发布说明.docx'))
    expect(await screen.findByText(/已从发布说明读到 1 个服务待读取/)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /读取发布信息/ }))
    await waitFor(() => expect(mocks.taskRunCreate).toHaveBeenCalledTimes(1))
    const createdArg = mocks.taskRunCreate.mock.calls[0]
    expect(createdArg[0]).toBe('release')
    expect(createdArg[1]).toBe('test')
    expect(createdArg[2]).toEqual([{ itemKey: 'order-service', displayName: 'order-service', desiredTag: null }])
    await waitFor(() => expect(mocks.taskRunPrepare).toHaveBeenCalledWith('r-9'))
    // 换了新轮次，条目按新 runId 取
    await waitFor(() => expect(mocks.taskRunGet).toHaveBeenCalledWith('r-9'))
    expect(await screen.findByText('harbor/ns/order:20261030')).toBeTruthy()
  })

  it('用户取消文件对话框时不发起解析，也不产生新一轮', async () => {
    renderPage()
    picked.mockResolvedValue(null)
    fireEvent.click(await screen.findByRole('button', { name: /导入发布说明/ }))
    await waitFor(() => expect(picked).toHaveBeenCalledTimes(1))
    expect(mocks.taskReleaseParse).not.toHaveBeenCalled()
    expect(mocks.taskRunCreate).not.toHaveBeenCalled()
  })

  it('测试环境直接发布；没有生产权限时生产档的发布按钮是禁的并说出缺什么', async () => {
    renderPage()
    // 等到页面接上"最近一轮"（条目表出来了）再按
    await screen.findByText('harbor/ns/order:20261030')
    const publish = await screen.findByRole('button', { name: /^开始发布/ })
    fireEvent.click(publish)
    await waitFor(() => expect(mocks.taskRunPublish).toHaveBeenCalledWith('r-1'))

    pointerTap(screen.getByRole('tab', { name: '生产环境' }))
    const prodPublish = await screen.findByRole('button', { name: /^开始发布/ })
    expect((prodPublish as HTMLButtonElement).disabled).toBe(true)
    expect(prodPublish.getAttribute('title')).toMatch(/生产/)
  })

  it('生产发布要先逐条核对镜像，确认才发出去', async () => {
    mocks.myPermissions.mockResolvedValue(PROD_RUN)
    renderPage()
    pointerTap(await screen.findByRole('tab', { name: '生产环境' }))
    const publish = await screen.findByRole('button', { name: /^开始发布/ })
    await waitFor(() => expect((publish as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(publish)
    // 确认弹窗里逐条列出镜像与线上时间，且此时还没发出去
    const dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toContain('harbor/ns/order:20261030')
    expect(dialog.textContent).toContain('不可撤回')
    expect(mocks.taskRunPublish).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('button', { name: /确认发布 1 个服务/ }))
    await waitFor(() => expect(mocks.taskRunPublish).toHaveBeenCalledTimes(1))
  })

  it('有失败项才给重试，重试只回到读取、不代替人发布', async () => {
    renderPage()
    const retry = await screen.findByRole('button', { name: /重试失败项/ })
    await waitFor(() => expect((retry as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(retry)
    await waitFor(() => expect(mocks.taskRunRetry).toHaveBeenCalledWith('r-1'))
    expect(mocks.taskRunPublish).not.toHaveBeenCalled()
  })

  it('没绑定凭据时不摆状态卡片带，缺什么直接写在按钮的理由上', async () => {
    mocks.taskSessionStatus.mockResolvedValue(session({ bound: false, credentialLabel: null, loginUrl: null }))
    renderPage()
    // 导入只是读本机文件，不该被"没绑定"挡住；挡的是要撞控制台的那两颗
    const importBtn = await screen.findByRole('button', { name: /导入发布说明/ })
    expect((importBtn as HTMLButtonElement).disabled).toBe(false)
    const prepareBtn = screen.getByRole('button', { name: /读取发布信息/ })
    // 状态读回来之前不该断言"缺绑定"：加载中说成缺配置是另一种不诚实
    await waitFor(() => expect(prepareBtn.getAttribute('title')).toMatch(/还没绑定登录凭据.*环境配置/))
    expect((prepareBtn as HTMLButtonElement).disabled).toBe(true)
    expect(screen.queryByText(/并发与尝试|读取并发/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '环境配置' }))
    expect(await screen.findByRole('dialog')).toBeTruthy()
  })
})

describe('浮层「切到生产那一档」的落点', () => {
  /**
   * 任务中心在浮层里是两行（同一枚定义的测试档与生产档），Enter 落到哪一行就该把页面上
   * 那个环境开关切到哪一档。判据取切档之后真的发出去的那条查询：
   * tab 的 aria-selected 只是外观，环境没真切的话历史与在跑视图还留在 test 上，那才是错位。
   */
  it('导航带 prod 时切到生产档，并重新取那一档的历史', async () => {
    renderPage()
    await waitFor(() => expect(mocks.taskRunList).toHaveBeenCalledWith('release', 'test', 20))

    useLauncherNav.getState().open({ page: 'tasks', taskKey: 'release', env: 'prod' })
    await waitFor(() => expect(mocks.taskRunList).toHaveBeenCalledWith('release', 'prod', 20))
    expect(screen.getByRole('tab', { name: '生产环境' })).toHaveAttribute('aria-selected', 'true')
    // 切档顺带撤掉当前视图：那一次运行属于另一档环境，留在屏上就是拿测试的进度讲生产
    expect(useLauncherNav.getState().pending).toBeNull()
  })

  /** 这一枚 store 现在五种落点共用，本页只认 page === 'tasks' 的那一条。 */
  it('别页的导航载荷不动本页的环境开关', async () => {
    renderPage()
    await waitFor(() => expect(mocks.taskRunList).toHaveBeenCalledWith('release', 'test', 20))

    useLauncherNav.getState().open({ page: 'notes', noteId: 'n-9' })
    await new Promise((r) => setTimeout(r, 0))
    expect(mocks.taskRunList).toHaveBeenLastCalledWith('release', 'test', 20)
    expect(useLauncherNav.getState().pending).toEqual({ page: 'notes', noteId: 'n-9' })
  })
})
