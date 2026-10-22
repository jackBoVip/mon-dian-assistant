import { useSession } from '../../state/session';
import { AuthShell } from './AuthShell';
import { Button } from '../ui/Button';

/**
 * 数据库主密钥落到本机文件之前的显式同意闸门。
 * 本包按操作者的决定（2026-10-17）默认使用本机 0600 文件密钥，不再把系统安全存储当首选存放位置，
 * 但闸门本身一条没松：未获同意时后端不写任何字节。需求 §4.1 要求"敏感密钥不得被静默落到普通
 * 文件里"，所以这里必须把 0600 挡不住什么如实写清楚。
 * 两种问法分开：fresh=全新安装（同意后新生成一把），legacy-vault=旧版本把密钥放在系统安全存储里，
 * 同意后原样迁移、旧条目不删。
 * 这里没有任何输入项——只有"同意"和"退出"两个选择。
 */
export function DeviceKeyConsentScreen() {
  const gate = useSession((s) => s.deviceKeyGate);
  const pending = useSession((s) => s.pending);
  const errorMessage = useSession((s) => s.errorMessage);
  const errorCode = useSession((s) => s.errorCode);
  const errorDetail = useSession((s) => s.errorDetail);
  const grant = useSession((s) => s.grantDeviceKeyFallback);
  const decline = useSession((s) => s.declineDeviceKeyFallback);

  const legacy = gate?.reason === 'legacy-vault';
  const backend = gate?.legacyBackend || '系统安全存储';

  return (
    <AuthShell note="这一步得由你当场拍板。你点头之前，这台机器不会偷偷写下任何密钥。">
      <div role="region" aria-label={legacy ? '旧版本保险库需要迁移主密钥，需要你的显式同意' : '数据库主密钥需要落到本机文件，需要你的显式同意'}>
        <h2 className="auth-title">{legacy ? '这份保险库的密钥还在系统安全存储里' : '数据库主密钥要落在本机文件'}</h2>
        <p className="auth-sub">
          {legacy ? (
            <>
              检测到已存在的保险库，但它的主密钥只保存在旧版本的存放位置（<span className="mono">{backend}</span>）里，
              本机还没有密钥文件。继续会把它<strong>原样复制</strong>成本机 <span className="mono">0600</span> 文件，
              <span className="mono">{backend}</span> 里那条<strong>保留不删</strong>，此后本包不再访问它。
            </>
          ) : (
            <>
              本包不使用系统安全存储，数据库主密钥会写进数据目录里的一个 <span className="mono">0600</span> 权限文件。
              保险库还没有被打开，<strong>本机尚未写入任何密钥文件</strong>。
            </>
          )}
        </p>

        <div className="auth-note" role="note" aria-label="本机文件密钥的风险说明">
          <p className="mb-1 text-xs font-semibold">继续会发生什么（请在选择前读完）</p>
          <ul className="flex flex-col gap-1 text-xs text-ink-muted">
            <li>只有那一个 <span className="mono">0600</span> 文件是新的：保险库里的数据本身仍是密文，密钥文件里也不含你的主密码。</li>
            <li><span className="mono">0600</span> 只挡住<strong>其他系统账户</strong>；同一个账户下运行的任何程序都能读到这个文件。这是本包不用系统安全存储换来的代价——需要这层隔离时，请改用系统安全存储的构建。</li>
            <li>删除该文件等于永久无法打开数据库，<strong>不存在任何后门或"超级口令"可以找回</strong>。</li>
            <li>选择「退出」不会写入任何文件，也不会留下半成品库。</li>
            <li>本次选择会连同时间戳记录到本机，并在审计日志里留下"数据库主密钥来源"，不记录任何密钥内容。</li>
          </ul>
        </div>

        <p className="mb-4 text-xs text-ink-muted">
          两个选择都不算做错：读完上面这几条，按你的判断点就行；选「退出」今天到此为止，数据不会有任何变化。
        </p>

        {errorMessage ? (
          <div className="auth-alert" role="alert">
            <span>
              {errorMessage}
              {errorCode ? `（${errorCode}）` : ''}
            </span>
            {errorDetail ? <span className="auth-alert-detail">{errorDetail}</span> : null}
          </div>
        ) : null}

        <div className="auth-actions">
          <Button variant="primary" className="auth-submit" disabled={pending} onClick={() => void grant()}>
            {pending ? '正在按你的选择准备保险库…' : legacy ? '我了解风险，迁移到本机文件密钥' : '我了解风险，使用本机文件密钥'}
          </Button>
          <Button variant="default" disabled={pending} onClick={() => void decline()}>
            退出（不写入任何文件）
          </Button>
        </div>
      </div>
    </AuthShell>
  );
}
