import { useSession } from '../../state/session';
import { bootFailurePresentation } from '../../lib/errors';
import { AuthShell } from './AuthShell';

/**
 * 启动装配失败页。
 *
 * 为什么要有这一页：装配失败时后端只挂了一条 `BootFailure` 状态、并没有建起共享状态，
 * 以前这条路径向 Tauri 返回 Err，在 release 的 `panic = "abort"` 下表现为进程直接消失——
 * 运维什么都看不到，只能靠日志。现在事件循环照常起来，这一页把错误码、后端原话与数据目录如实摆出来。
 *
 * 这里没有任何按钮：按钮背后必须有真动作（重新装配要重跑系统安全存储与建库，属下一条功能而非本页）。
 * 唯一诚实的指引是"修好后退出并重开"，所以页面上不摆假的重试入口。
 */
export function BootFailedScreen() {
  const failure = useSession((s) => s.bootFailure);
  const stage = failure?.stage ?? '';
  const code = failure?.code ?? '';
  const { title, hint } = bootFailurePresentation(stage, code);
  /** 装配阶段已经逐条提交过迁移，所以不能说"没有被改动"；前两个阶段确实一个字节都没写。 */
  const note =
    stage === 'assembly'
      ? '程序没能走到最后一步：保险库没有被打开，应用也不会带着半套结构继续跑。迁移是逐条事务，已提交的条目会保留。'
      : '程序没能走到最后一步。保险库没有被打开，也没有被改动。';

  return (
    <AuthShell note={note}>
      <div role="region" aria-label={title}>
        <h2 className="auth-title">{title}</h2>
        <p className="auth-sub">
          先别慌，保险库没有打开，界面停在这里。后端给出的错误码是 <span className="mono">{code || 'UNKNOWN'}</span>
          {failure?.message ? <>，原文：<span className="mono">{failure.message}</span></> : null}。
        </p>

        <div className="auth-note" role="note" aria-label="启动失败的排查说明">
          <p className="mb-1 text-xs font-semibold">接下来可以这样做</p>
          <ul className="flex flex-col gap-1 text-xs text-ink-muted">
            <li>{hint}</li>
            {failure?.dataDir ? (
              <li>
                涉及的数据目录：<span className="mono break-all">{failure.dataDir}</span>
              </li>
            ) : null}
            {stage === 'assembly' ? (
              <li>结构迁移按条事务执行，失败的这一条整条回滚；没跑完迁移时启动会停在本页，不会带着半套 schema 继续运行。</li>
            ) : (
              <li>本次启动没有写入任何密钥文件，也没有改动保险库里的数据。</li>
            )}
            <li>修好之后退出本应用再重新打开即可；这期间不要删除数据目录里的任何文件。</li>
          </ul>
        </div>
      </div>
    </AuthShell>
  );
}
