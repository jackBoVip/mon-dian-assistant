import { describe, expect, it } from 'vitest'
import { ADDRESS_FIELD_BY_TYPE, buildTargetInput, deriveAddress } from './targetAddress'

/**
 * 一栏地址 → 后端分列字段的派生表。
 * 锁的是两条只有这里能违反的东西：
 *  1) 「连接终端」只认 host（src-tauri/src/quick_launcher/actions.rs），终端类必须从 IP:Port 里拆出 host；
 *  2) 「打开并填充」按 origin 逐字比对（src-tauri/src/ipc.rs:146），网页类粘带路径的深链时
 *     必须派生出 allowedOrigin，否则 url != origin，填充整条链是死的。
 * url 一律原样保留用户输入：派生不出来也不能把用户写的东西改掉。
 */

describe('deriveAddress · 网页', () => {
  it('带路径的深链派生出精确 Origin，主机与端口分开', () => {
    expect(deriveAddress('web', 'https://oa.example.cn/login')).toMatchObject({
      url: 'https://oa.example.cn/login',
      host: 'oa.example.cn',
      port: '',
      protocol: 'https',
      allowedOrigin: 'https://oa.example.cn',
    })
  })

  it('非默认端口保留在 Origin 里', () => {
    expect(deriveAddress('web', 'http://10.0.0.8:8080/portal')).toMatchObject({
      host: '10.0.0.8',
      port: '8080',
      protocol: 'http',
      allowedOrigin: 'http://10.0.0.8:8080',
    })
  })

  it('没写协议头时按 https 补，Origin 仍取得到', () => {
    expect(deriveAddress('web', 'oa.example.cn')).toMatchObject({
      url: 'oa.example.cn',
      host: 'oa.example.cn',
      protocol: 'https',
      allowedOrigin: 'https://oa.example.cn',
    })
  })

  it('带账号的 URL 不把账号混进主机', () => {
    expect(deriveAddress('web', 'https://ops:pw@oa.example.cn/x')).toMatchObject({ host: 'oa.example.cn' })
  })
})

describe('deriveAddress · 终端', () => {
  it('原型的 IP:Port 写法拆得出主机与端口', () => {
    expect(deriveAddress('terminal', '192.168.1.100:22')).toMatchObject({
      url: '192.168.1.100:22',
      host: '192.168.1.100',
      port: '22',
      // 连接终端要协议；界面这一栏没写协议时按 ssh 补，这是终端类的默认口径
      protocol: 'ssh',
    })
  })

  it('ssh://user@host 去掉协议头与用户名，只留主机', () => {
    expect(deriveAddress('terminal', 'ssh://root@10.0.0.9')).toMatchObject({
      host: '10.0.0.9',
      port: '',
      protocol: 'ssh',
    })
  })

  it('IPv6 方括号写法不被端口冒号切碎', () => {
    expect(deriveAddress('terminal', '[fd00::1]:22')).toMatchObject({ host: 'fd00::1', port: '22' })
  })

  it('纯冒号无端口时整串当主机，不猜端口', () => {
    expect(deriveAddress('terminal', 'terminal.example.cn')).toMatchObject({
      host: 'terminal.example.cn',
      port: '',
    })
  })
})

describe('deriveAddress · 数据库', () => {
  it('原型的 jdbc 写法派生出主机、端口与库名', () => {
    expect(deriveAddress('database', 'jdbc:mysql://127.0.0.1:3306/db')).toMatchObject({
      url: 'jdbc:mysql://127.0.0.1:3306/db',
      host: '127.0.0.1',
      port: '3306',
      protocol: 'mysql',
      databaseName: 'db',
    })
  })

  it('连接参数留在 url 里，不进库名', () => {
    expect(deriveAddress('database', 'jdbc:oracle://c.example.internal:1521/orcl?tps=2')).toMatchObject({
      host: 'c.example.internal',
      port: '1521',
      databaseName: 'orcl',
      url: 'jdbc:oracle://c.example.internal:1521/orcl?tps=2',
    })
  })
})

describe('deriveAddress · 边界', () => {
  it('空串与全空格都派生出一整组空值，不抛异常', () => {
    for (const t of ['web', 'terminal', 'database', 'cloud_service']) {
      expect(deriveAddress(t, '   ')).toEqual({
        url: '',
        host: '',
        port: '',
        protocol: '',
        databaseName: '',
        allowedOrigin: '',
      })
    }
  })

  it('界面不再提供的类型（如云平台）也尽力拆主机，url 原样保留', () => {
    expect(deriveAddress('cloud_service', 'https://console.example.cn/x')).toMatchObject({
      url: 'https://console.example.cn/x',
      host: 'console.example.cn',
    })
  })
})

describe('buildTargetInput', () => {
  it('提交体带全后端字段：被界面撤掉的 tenant/vendor 是空串而不是缺键', () => {
    const input = buildTargetInput('  营销系统A  ', 'web', 'https://a.example.cn/login', null)
    expect(input).toEqual({
      displayName: '营销系统A',
      targetType: 'web',
      url: 'https://a.example.cn/login',
      allowedOrigin: 'https://a.example.cn',
      host: 'a.example.cn',
      port: '',
      databaseName: '',
      tenant: '',
      vendor: '',
      protocol: 'https',
      groupId: null,
    })
  })
})

describe('ADDRESS_FIELD_BY_TYPE', () => {
  it('三档 label 与占位逐字照原型 1352-1361', () => {
    expect(ADDRESS_FIELD_BY_TYPE.web).toEqual({ label: '登录地址 (URL)', placeholder: 'https://oa.example.cn' })
    expect(ADDRESS_FIELD_BY_TYPE.terminal).toEqual({ label: '连接地址 (IP:Port)', placeholder: '例如: 192.168.1.100:22' })
    expect(ADDRESS_FIELD_BY_TYPE.database).toEqual({ label: '连接字符串', placeholder: 'jdbc:mysql://127.0.0.1:3306/db' })
  })
})
