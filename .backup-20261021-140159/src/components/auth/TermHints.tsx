/** 三类身份的固定区分提示，避免"本软件用户 / 台账账号 / 主密码"混淆。
 * 2026-10 首装页照原型重绘后，创建前的大段安全说明不再出现在界面上；
 * 忘记主密码的后果与恢复策略以 docs/密钥生命周期与加密边界.md §4.6 为唯一出处。 */

export function MasterPasswordHint() {
  return (
    <p className="text-xs text-ink-muted">
      它是这台机器上唯一的钥匙：<strong>不是</strong>任何外部网站/终端/数据库的登录密码，也不会被明文保存在任何地方。
    </p>
  );
}

export function LedgerAccountHint() {
  return (
    <p className="text-xs text-ink-muted">
      此处「用户名/密码」是<strong>外部系统的台账账号</strong>（凭据保险库内容），与本软件的登录身份无关。
    </p>
  );
}
