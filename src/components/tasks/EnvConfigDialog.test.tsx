import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { vi } from 'vitest'
import { EnvConfigDialog } from './EnvConfigDialog'
import type { TaskBinding, TaskProfileView, TaskSessionStatus } from '../../lib/types'

const mocks = vi.hoisted(() => ({
  taskProfileGet: vi.fn(),
  taskProfileUpdate: vi.fn(),
  taskBindingGet: vi.fn(),
  taskBindingUpdate: vi.fn(),
  taskBindingDelete: vi.fn(),
  taskSessionStatus: vi.fn(),
  taskProbeLogin: vi.fn(),
  listTargets: vi.fn(),
  targetItems: vi.fn(),
}))

vi.mock('../../lib/api', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../lib/api')>()
  return { ...mod, api: { ...mod.api, ...mocks } }
})

const URL_TEXT = '手动指定的登录地址'

function profile(over: Partial<TaskProfileView> = {}): TaskProfileView {
  return {
    taskKey: 'release',
    env: 'test',
    profileJson: '{"baseUrl":"https://edas.example.com"}',
    configured: true,
    updatedAt: '2026-10-30T06:02:00Z',
    insecureHttpAllowed: false,
    ...over,
  }
}

function binding(over: Partial<TaskBinding> = {}): TaskBinding {
  return {
    taskKey: 'release',
    env: 'test',
    loginUrl: '',
    credentialItemId: 'it-1',
    credentialTargetId: 'tg-1',
    credentialLabel: 'EDAS 运维账号',
    updatedAt: '2026-10-30T06:02:00Z',
    ...over,
  }
}

function session(over: Partial<TaskSessionStatus> = {}): TaskSessionStatus {
  return {
    bound: true,
    configured: true,
    active: false,
    cookieNames: [],
    acquiredSecondsAgo: null,
    ttlMinutes: 30,
    loginUrl: 'https://sso.from-credential.example/login',
    loginUrlSource: 'credential',
    credentialLabel: 'EDAS 运维账号',
    ...over,
  }
}

function renderDialog() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return render(
    <QueryClientProvider client={qc}>
      <EnvConfigDialog taskKey="release" env="test" envLabel="测试环境" onClose={() => undefined} />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  for (const fn of Object.values(mocks)) fn.mockReset()
  mocks.taskProfileGet.mockResolvedValue(profile())
  mocks.taskProfileUpdate.mockResolvedValue(profile())
  mocks.taskBindingGet.mockResolvedValue(binding())
  mocks.taskBindingUpdate.mockResolvedValue(binding())
  mocks.taskBindingDelete.mockResolvedValue(undefined)
  mocks.taskSessionStatus.mockResolvedValue(session())
  mocks.taskProbeLogin.mockResolvedValue({ statuses: [], finalHost: '', cookieNames: [], sawForm: false, authorizeVisited: false, loggedIn: false, apiService: '', apiClass: '', repoIdFound: false })
  mocks.listTargets.mockResolvedValue([{ id: 'tg-1', displayName: 'EDAS 控制台', targetType: 'web', url: '', group: null, itemCount: 1 }])
  mocks.targetItems.mockResolvedValue([
    { id: 'it-1', accountAlias: 'EDAS 运维账号', status: 'active', usernameMasked: 'ops***', hasPassword: true },
    { id: 'it-2', accountAlias: '已停用的', status: 'disabled', usernameMasked: '', hasPassword: true },
  ])
})

describe('环境配置：登录地址跟着凭据走', () => {
  it('已绑定且地址来自凭据时，只显示这一行与来源，不摆输入框', async () => {
    renderDialog()
    expect(await screen.findByText('https://sso.from-credential.example/login')).toBeTruthy()
    expect(screen.getByText(/跟随这条凭据/)).toBeTruthy()
    expect(screen.queryByLabelText(URL_TEXT)).toBeNull()
  })

  it('要改用别的地址才展开输入框，保存时带上已绑定的那枚凭据', async () => {
    renderDialog()
    fireEvent.click(await screen.findByRole('button', { name: '改用别的地址' }))
    const box = await screen.findByLabelText(URL_TEXT)
    fireEvent.change(box, { target: { value: 'https://sso.manual.example/login' } })
    fireEvent.click(screen.getByRole('button', { name: '保存这个地址' }))
    await waitFor(() =>
      expect(mocks.taskBindingUpdate).toHaveBeenCalledWith('release', 'test', 'https://sso.manual.example/login', 'it-1'),
    )
  })

  it('已经是手动指定时给的是「跟随凭据」，点下去存回空串', async () => {
    mocks.taskSessionStatus.mockResolvedValue(session({ loginUrl: 'https://sso.manual.example/login', loginUrlSource: 'manual' }))
    renderDialog()
    fireEvent.click(await screen.findByRole('button', { name: '跟随凭据' }))
    await waitFor(() => expect(mocks.taskBindingUpdate).toHaveBeenCalledWith('release', 'test', '', 'it-1'))
  })

  it('取不到地址时说清下一步：去账号中心补，或在这里手动指定', async () => {
    mocks.taskSessionStatus.mockResolvedValue(session({ loginUrl: null, loginUrlSource: 'missing' }))
    renderDialog()
    expect(await screen.findByText(/都没填登录地址/)).toBeTruthy()
    expect(screen.getByRole('button', { name: '改用别的地址' })).toBeTruthy()
  })

  it('还没绑凭据时不显示地址行；选一条凭据就能保存绑定（地址留空=跟随）', async () => {
    mocks.taskBindingGet.mockResolvedValue(null)
    mocks.taskSessionStatus.mockResolvedValue(session({ bound: false, loginUrl: null, loginUrlSource: 'missing', credentialLabel: null }))
    renderDialog()
    expect(await screen.findByText(/绑好凭据后/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: '改用别的地址' })).toBeNull()

    fireEvent.click(screen.getByRole('combobox'))
    fireEvent.click(await screen.findByRole('option', { name: 'EDAS 控制台' }))
    // 停用的那条不该出现在候选里
    expect(await screen.findByText('EDAS 运维账号')).toBeTruthy()
    expect(screen.queryByText('已停用的')).toBeNull()

    const save = screen.getByRole('button', { name: '保存绑定' })
    expect((save as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('radio', { name: /EDAS 运维账号/ }))
    fireEvent.click(save)
    await waitFor(() => expect(mocks.taskBindingUpdate).toHaveBeenCalledWith('release', 'test', '', 'it-1'))
  })

  it('已绑定时目标下拉落在凭据所属的那个目标上，而不是凭据 id', async () => {
    renderDialog()
    expect(await screen.findByText('EDAS 控制台')).toBeTruthy()
  })
})
