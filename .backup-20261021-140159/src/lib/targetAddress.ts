import type { CreateTargetInput, TargetMeta } from './types'

/**
 * 新增系统弹窗只有一个地址输入框（原型 994-997 那一格，也是 Chrome / Edge 的形状），
 * 但后端把地址拆成 url / host / port / protocol / 库名 分列存储，而且
 * `quick_launcher::actions::connect_terminal` 只认 host（src-tauri/src/quick_launcher/actions.rs）：
 * 只填一栏就得在这里派生出其余几栏，否则终端类系统建出来后「连接终端」点下去是死的。
 */
export interface DerivedAddress {
  url: string
  host: string
  port: string
  protocol: string
  databaseName: string
  allowedOrigin: string
}

const EMPTY: DerivedAddress = { url: '', host: '', port: '', protocol: '', databaseName: '', allowedOrigin: '' }

/** host[:port]；IPv6 按方括号那一档认，端口位不是纯数字就整串当主机名。 */
function splitHostPort(raw: string): { host: string; port: string } {
  const bracket = /^\[([^\]]+)\](?::(\d+))?$/.exec(raw)
  if (bracket) return { host: bracket[1], port: bracket[2] ?? '' }
  const i = raw.lastIndexOf(':')
  if (i < 0) return { host: raw, port: '' }
  const port = raw.slice(i + 1)
  if (!/^\d+$/.test(port)) return { host: raw, port: '' }
  return { host: raw.slice(0, i), port }
}

/** 去掉 `scheme://` 与 `user@`，只留 authority 之前的那截。 */
function stripSchemeAndUser(raw: string): { protocol: string; rest: string } {
  const m = /^([A-Za-z][\w+.-]*):\/\/(.*)$/s.exec(raw)
  if (!m) return { protocol: '', rest: raw }
  const rest = m[2].replace(/^[^\s/?@]+@/, '')
  return { protocol: m[1].toLowerCase(), rest }
}

function fromWeb(addr: string): DerivedAddress {
  let u: URL | null = null
  try {
    u = new URL(/^[A-Za-z][\w+.-]*:\/\//.test(addr) ? addr : `https://${addr}`)
  } catch {
    u = null
  }
  if (!u) {
    const { host, port } = splitHostPort(addr)
    return { ...EMPTY, url: addr, host, port, protocol: 'https' }
  }
  // allowedOrigin 必须派生：填充时拿 origin 逐字比对（ipc.rs:146），
  // 粘的是带路径的深链时 url != origin，留空这一栏会让「打开并填充」整条链断掉。
  return {
    url: addr,
    host: u.hostname,
    port: u.port,
    protocol: u.protocol.replace(':', ''),
    databaseName: '',
    allowedOrigin: `${u.protocol}//${u.host}`,
  }
}

function fromAuthority(addr: string, fallbackProtocol: string): DerivedAddress {
  const { protocol, rest } = stripSchemeAndUser(addr)
  const { host, port } = splitHostPort(rest.replace(/[/?#].*$/, ''))
  return { url: addr, host, port, protocol: protocol || fallbackProtocol, databaseName: '', allowedOrigin: '' }
}

function fromJdbc(addr: string): DerivedAddress {
  const body = addr.replace(/^jdbc:/i, '')
  const m = /^([A-Za-z][\w+.-]*):\/\/(.*)$/s.exec(body)
  const protocol = m ? m[1].toLowerCase() : ''
  const after = m ? m[2] : body.replace(/^\/\//, '')
  const at = after.search(/[/?#]/)
  const authority = (at < 0 ? after : after.slice(0, at)).replace(/^[^\s/?@]+@/, '')
  const tail = at < 0 ? '' : after.slice(at + 1)
  const database = tail.split(/[?&#]/)[0]
  const { host, port } = splitHostPort(authority)
  return { url: addr, host, port, protocol, databaseName: database, allowedOrigin: '' }
}

/** 一栏地址 → 后端需要的那几栏。空串原样返回空，交给弹窗自己的必填校验。 */
export function deriveAddress(targetType: string, raw: string): DerivedAddress {
  const addr = raw.trim()
  if (!addr) return EMPTY
  if (targetType === 'web') return fromWeb(addr)
  if (targetType === 'database') return fromJdbc(addr)
  if (targetType === 'terminal') return fromAuthority(addr, 'ssh')
  return fromAuthority(addr, '')
}

/** 弹窗提交体：界面只给两栏（名称 + 地址），其余全部由此派生。 */
export function buildTargetInput(displayName: string, targetType: string, rawAddress: string, groupId: string | null): CreateTargetInput {
  const d = deriveAddress(targetType, rawAddress)
  return {
    displayName: displayName.trim(),
    targetType,
    url: d.url,
    allowedOrigin: d.allowedOrigin,
    host: d.host,
    port: d.port,
    databaseName: d.databaseName,
    tenant: '',
    vendor: '',
    protocol: d.protocol,
    groupId,
  }
}

/**
 * 编辑系统时那一栏地址的初值。创建时用户填的那串原文就存在 url 栏，直接回显。
 * 导入进来的系统可能只有分列的 host/port（url 栏是空的），这时按类型把分栏拼回一栏：
 * 否则「编辑系统」打开是空地址，保存时会把后端已有的主机信息覆盖成空串。
 */
export function initialAddress(targetType: string, meta: TargetMeta): string {
  if (meta.url.trim()) return meta.url
  const host = meta.host.trim()
  if (!host) return ''
  const authority = meta.port.trim() ? `${host}:${meta.port.trim()}` : host
  if (targetType === 'database') {
    const db = meta.databaseName.trim()
    return `${meta.protocol.trim() || 'jdbc'}://${authority}${db ? `/${db}` : ''}`
  }
  if (targetType === 'web') return `${meta.protocol.trim() || 'https'}://${authority}`
  return authority
}

/** 原型那三种 label / placeholder 联动，逐字照抄 design/prototype.html:1352-1361。 */
export const ADDRESS_FIELD_BY_TYPE: Record<string, { label: string; placeholder: string }> = {
  web: { label: '登录地址 (URL)', placeholder: 'https://oa.example.cn' },
  terminal: { label: '连接地址 (IP:Port)', placeholder: '例如: 192.168.1.100:22' },
  database: { label: '连接字符串', placeholder: 'jdbc:mysql://127.0.0.1:3306/db' },
}

/** 新增系统只给这三类（交付方 2026-10-18 指定）；其余五类仍可导入与展示，见 lib/types.ts KNOWN_TARGET_TYPES。 */
export const CREATABLE_TARGET_TYPES = ['web', 'terminal', 'database'] as const
