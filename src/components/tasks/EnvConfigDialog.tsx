import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { queryKeys } from '../../lib/queryClient'
import { toNormalisedError } from '../../lib/errors'
import { notify } from '../../state/notify'
import { Button } from '../ui/Button'
import { Modal } from '../ui/Modal'
import { SelectField, TextAreaField, TextField } from '../ui/Field'
import type { TaskEnv } from '../../lib/types'

interface Props {
  taskKey: string
  env: TaskEnv
  envLabel: string
  onClose: () => void
}

/** 地址来源 → 那一句要说清"这个地址是从哪儿来的"的话。 */
const SOURCE_COPY: Record<'manual' | 'credential' | 'missing', string> = {
  manual: '任务侧手动指定',
  credential: '跟随这条凭据（账号中心里填的登录地址）',
  missing: '取不到登录地址',
}

/**
 * 环境配置：一枚保险库凭据 + 站点形状（profile JSON）。
 *
 * 两件事在这里定死：
 * - **没有口令输入框**，也不会有。绑的是 `vault_items` 的 id，口令留在保险库里，由后端在
 *   Rust 内存里解密取用，界面能看见的只有别名。
 * - **登录地址默认跟着凭据走**（凭据的登录地址 → 目标系统地址）。账号中心才是那件事的唯一
 *   事实来源，任务侧再抄一遍就是第二个来源，改一处漏一处。只有"台账里存的是控制台首页、
 *   真正出现账号框的是 SSO 那一页"这种站点（EDAS 正是）才需要展开「改用别的地址」覆盖一次。
 */
export function EnvConfigDialog({ taskKey, env, envLabel, onClose }: Props) {
  const qc = useQueryClient()
  const profile = useQuery({
    queryKey: queryKeys.taskProfile(taskKey, env),
    queryFn: () => api.taskProfileGet(taskKey, env),
  })
  const binding = useQuery({
    queryKey: queryKeys.taskBinding(taskKey, env),
    queryFn: () => api.taskBindingGet(taskKey, env),
  })
  const session = useQuery({
    queryKey: queryKeys.taskSession(taskKey, env),
    queryFn: () => api.taskSessionStatus(taskKey, env),
  })
  const targets = useQuery({ queryKey: queryKeys.targetsAll, queryFn: () => api.listTargets() })

  const [targetId, setTargetId] = useState<string>('')
  const [itemId, setItemId] = useState<string>('')
  const [draftProfile, setDraftProfile] = useState<string | null>(null)
  // 覆盖地址是"展开才有输入框"的少数情况：默认不摆出来，免得逼人手抄一遍凭据里就有的地址。
  const [overrideOpen, setOverrideOpen] = useState(false)
  const [urlDraft, setUrlDraft] = useState<string | null>(null)

  const bound = binding.data ?? null
  const jsonNow = draftProfile ?? profile.data?.profileJson ?? ''
  const chosenTarget = targetId || bound?.credentialTargetId || ''
  const urlNow = urlDraft ?? bound?.loginUrl ?? ''
  const effectiveUrl = session.data?.loginUrl ?? null
  const urlSource = session.data?.loginUrlSource ?? 'missing'

  const candidates = useQuery({
    queryKey: ['taskBindingCandidates', chosenTarget],
    queryFn: () => api.targetItems(chosenTarget),
    enabled: chosenTarget !== '',
  })
  const candidateItems = useMemo(() => (candidates.data ?? []).filter((row) => row.status === 'active'), [candidates.data])

  const invalidateBinding = () => {
    qc.invalidateQueries({ queryKey: queryKeys.taskBinding(taskKey, env) })
    qc.invalidateQueries({ queryKey: queryKeys.taskSession(taskKey, env) })
  }

  const saveProfile = useMutation({
    mutationFn: () => api.taskProfileUpdate(taskKey, env, jsonNow),
    onSuccess: () => {
      setDraftProfile(null)
      qc.invalidateQueries({ queryKey: queryKeys.taskProfile(taskKey, env) })
      invalidateBinding()
      notify('success', `已保存${envLabel}的站点配置`)
    },
    onError: (raw) => notify('danger', toNormalisedError(raw).message),
  })

  const saveBinding = useMutation({
    // 地址留空 = 跟随凭据；只有展开并填了才作为覆盖存下去。
    mutationFn: () => api.taskBindingUpdate(taskKey, env, urlNow.trim(), itemId),
    onSuccess: () => {
      setItemId('')
      setUrlDraft(null)
      invalidateBinding()
      notify('success', '已绑定登录凭据；下一次读取或发布会自动静默登录')
    },
    onError: (raw) => notify('danger', toNormalisedError(raw).message),
  })

  /** 只改地址：凭据沿用已绑定的那一枚，不让人在改地址时顺手把凭据换掉。 */
  const saveUrl = useMutation({
    mutationFn: (value: string) => api.taskBindingUpdate(taskKey, env, value.trim(), bound?.credentialItemId ?? ''),
    onSuccess: (_data, value) => {
      setUrlDraft(null)
      setOverrideOpen(value.trim() !== '')
      invalidateBinding()
      notify('success', value.trim() === '' ? '已改为跟随这条凭据的登录地址' : '已保存手动指定的登录地址')
    },
    onError: (raw) => notify('danger', toNormalisedError(raw).message),
  })

  const unbind = useMutation({
    mutationFn: () => api.taskBindingDelete(taskKey, env),
    onSuccess: () => {
      invalidateBinding()
      notify('success', '已解除绑定')
    },
    onError: (raw) => notify('danger', toNormalisedError(raw).message),
  })

  const probe = useMutation({
    mutationFn: () => api.taskProbeLogin(taskKey, env, null),
    onSuccess: (report) => {
      const steps = report.statuses.length > 0 ? report.statuses.join(' → ') : '没有响应'
      notify(report.loggedIn ? 'success' : 'warning', `探测结果：${steps}｜Cookie ${report.cookieNames.length} 枚｜最终主机 ${report.finalHost || '未知'}`)
    },
    onError: (raw) => notify('danger', toNormalisedError(raw).message),
  })

  return (
    <Modal
      open
      title={`环境配置 · ${envLabel}`}
      onClose={onClose}
      wide
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            关闭
          </Button>
          <Button variant="danger" disabled={!bound || unbind.isPending} onClick={() => unbind.mutate()}>
            解除凭据绑定
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-medium text-ink">登录凭据（保险库条目）</h3>
          <p className="panel-notice">
            这里只绑一条保险库凭据，界面不出现口令输入框；口令只在后端内存里被取用，不落库、不进日志。
            {bound ? `当前已绑定：${bound.credentialLabel ?? '已绑定'}` : '当前未绑定。'}
          </p>
          <SelectField
            label="目标系统"
            value={chosenTarget}
            options={(targets.data ?? []).map((row) => ({ value: row.id, label: row.displayName }))}
            onValueChange={(v) => {
              setTargetId(v)
              setItemId('')
            }}
          />
          {chosenTarget === '' ? null : candidateItems.length === 0 ? (
            <p className="panel-notice">这个目标下没有可用账号：请到账号中心新建或启用一条凭据。</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {candidateItems.map((row) => (
                <li key={row.id}>
                  <label className="flex items-center gap-2 text-sm text-ink-body">
                    <input type="radio" name="task-credential" checked={itemId === row.id} onChange={() => setItemId(row.id)} />
                    <span className="min-w-0 truncate">{row.accountAlias}</span>
                    <span className="text-xs text-ink-muted">{row.usernameMasked}</span>
                  </label>
                </li>
              ))}
            </ul>
          )}
          <div className="flex justify-end gap-2">
            <Button
              variant="primary"
              disabled={itemId === '' || saveBinding.isPending}
              title={itemId === '' ? '先选一条凭据；登录地址会跟着它走' : '绑定这条凭据'}
              onClick={() => saveBinding.mutate()}
            >
              {saveBinding.isPending ? '保存中…' : '保存绑定'}
            </Button>
          </div>
        </section>

        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-medium text-ink">登录地址</h3>
          {bound === null ? (
            <p className="panel-notice">
              绑好凭据后，这里会显示真正要打开的地址：默认取这条凭据在账号中心里填的登录地址，没填就用目标系统的地址。
            </p>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md bg-sunken px-3 py-2 text-xs">
                <span className="min-w-0 break-all text-ink" title={effectiveUrl ?? ''}>
                  {effectiveUrl ?? '—'}
                </span>
                <span className="text-ink-muted">{SOURCE_COPY[urlSource]}</span>
                {urlSource === 'manual' ? (
                  <Button variant="ghost" disabled={saveUrl.isPending} onClick={() => saveUrl.mutate('')}>
                    跟随凭据
                  </Button>
                ) : (
                  <Button variant="ghost" disabled={overrideOpen} onClick={() => setOverrideOpen(true)}>
                    改用别的地址
                  </Button>
                )}
              </div>
              {urlSource === 'missing' ? (
                <p className="panel-notice">
                  这条凭据和目标系统都没填登录地址：请到账号中心给它补一个，或者在这里手动指定一个。
                </p>
              ) : null}
              {overrideOpen ? (
                <>
                  <TextField
                    label="手动指定的登录地址"
                    value={urlNow}
                    onChange={(e) => setUrlDraft(e.target.value)}
                    placeholder="https://sso.example.com/login"
                    hint={
                      profile.data?.insecureHttpAllowed
                        ? '明文 http 当前被允许：管理员在安全策略里开启了「允许不安全协议」'
                        : '默认只接受 https。生产控制台也是 http 的，请先让管理员开启「允许不安全协议」'
                    }
                  />
                  <div className="flex justify-end gap-2">
                    <Button
                      variant="ghost"
                      onClick={() => {
                        setOverrideOpen(false)
                        setUrlDraft(null)
                      }}
                    >
                      取消
                    </Button>
                    <Button variant="primary" disabled={urlNow.trim() === '' || saveUrl.isPending} onClick={() => saveUrl.mutate(urlNow)}>
                      {saveUrl.isPending ? '保存中…' : '保存这个地址'}
                    </Button>
                  </div>
                </>
              ) : null}
            </>
          )}
        </section>

        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-medium text-ink">站点配置（JSON）</h3>
          <TextAreaField
            label="配置内容"
            className="h-56 font-mono text-xs"
            value={jsonNow}
            onChange={(e) => setDraftProfile(e.target.value)}
          />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" disabled={probe.isPending || !bound} onClick={() => probe.mutate()}>
              探测登录链
            </Button>
            <Button variant="primary" disabled={jsonNow === '' || saveProfile.isPending} onClick={() => saveProfile.mutate()}>
              {saveProfile.isPending ? '保存中…' : '保存站点配置'}
            </Button>
          </div>
        </section>
      </div>
    </Modal>
  )
}
