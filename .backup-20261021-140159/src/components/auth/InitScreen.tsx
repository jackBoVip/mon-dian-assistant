import { AuthShell } from './AuthShell';
import { VaultCreateForm } from './VaultCreateForm';

/**
 * 首次启动页：本机还没有保险库时的那一次握手。
 *
 * 这一页只负责创建，不做任何判断——是不是首次、能不能建，全由后端的
 * vault_status / vault_initialize 决定；界面不会在后端答应之前显示"已创建"。
 * 版式与配色来自 AuthShell 与 tokens.css 的 --scene-*；昵称与位数提示不在本页，
 * 三条必说事实（数据只在本机、不是外部系统口令、不明文保存）由上面那句 sub 一次说完。
 */
export function InitScreen() {
  return (
    <AuthShell>
      <h2 className="auth-title">设置你的主密码</h2>
      <p className="auth-sub">
        第一次见面。这道口令只用来打开这台机器上的保险库：数据不出本机，没有任何地方存着它的明文，
        它也不是任何网站或系统的账号密码。
      </p>
      <VaultCreateForm />
    </AuthShell>
  );
}
