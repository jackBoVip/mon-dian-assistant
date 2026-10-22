import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { DeviceKeyConsentStatus } from '../../lib/types';

/**
 * 数据库主密钥落到本机文件之前的显式同意界面。
 * 锁死四件事：① 风险如实告知（0600 挡不住同账户进程、无后门、删文件即销毁）；② 界面没有任何输入项，
 * 不采集密码也不伪造数据；③ 同意与退出是两条互斥的真实命令通道，禁用期间真禁用；
 * ④ fresh 与 legacy-vault 两种问法各说各的事，迁移那一种必须讲清旧条目不删。
 */

vi.mock('../../lib/api', () => ({
  api: {},
  ApiError: class ApiError extends Error {},
  isTauri: () => false,
}));

import { useSession, type SessionState } from '../../state/session';
import { DeviceKeyConsentScreen } from './DeviceKeyConsentScreen';

const gate: DeviceKeyConsentStatus = {
  needed: true,
  consent: 'none',
  reason: 'fresh',
  legacyBackend: 'KWallet (DBus)',
  keyFile: '',
};

const grant = vi.fn();
const decline = vi.fn();

function seed(patch: Partial<SessionState> = {}) {
  useSession.setState({
    status: null,
    profile: null,
    phase: 'deviceKeyConsent',
    errorCode: null,
    errorMessage: null,
    errorDetail: null,
    pending: false,
    deviceKeyGate: gate,
    grantDeviceKeyFallback: grant,
    declineDeviceKeyFallback: decline,
    ...patch,
  });
}

beforeEach(() => {
  grant.mockReset().mockResolvedValue(true);
  decline.mockReset().mockResolvedValue(true);
  seed();
});

describe('DeviceKeyConsentScreen', () => {
  it('如实说明落到本机文件的后果：0600 挡不住同账户进程、无后门、数据仍为密文', () => {
    render(<DeviceKeyConsentScreen />);
    const notice = screen.getByRole('note', { name: '本机文件密钥的风险说明' });
    expect(notice).toHaveTextContent('0600');
    expect(notice).toHaveTextContent('同一个账户下运行的任何程序都能读到这个文件');
    expect(notice).toHaveTextContent('不存在任何后门');
    expect(notice).toHaveTextContent('永久无法打开数据库');
    expect(notice).toHaveTextContent('保险库里的数据本身仍是密文');
    expect(screen.getByRole('region', { name: '数据库主密钥需要落到本机文件，需要你的显式同意' })).toHaveTextContent(
      '本包不使用系统安全存储',
    );
    // 不承诺任何"可以找回"的口径
    expect(notice.textContent).not.toMatch(/可以帮您找回|官方重置|随时恢复/);
  });

  it('旧库迁移这种问法说清"原样复制、旧条目不删"，按钮也跟着换措辞', () => {
    seed({ deviceKeyGate: { ...gate, reason: 'legacy-vault' } });
    render(<DeviceKeyConsentScreen />);
    const region = screen.getByRole('region', { name: '旧版本保险库需要迁移主密钥，需要你的显式同意' });
    expect(region).toHaveTextContent('原样复制');
    expect(region).toHaveTextContent('KWallet (DBus)');
    expect(region).toHaveTextContent('保留不删');
    // 迁移不是"再问一次降级"：绝不能顺手生成一把新密钥，所以这话必须在页面上
    expect(region).toHaveTextContent('此后本包不再访问它');
    expect(screen.getByRole('button', { name: '我了解风险，迁移到本机文件密钥' })).toBeInTheDocument();
  });

  it('未同意时界面明确告知本机还没写入任何文件，且没有任何输入项', () => {
    render(<DeviceKeyConsentScreen />);
    expect(screen.getByText('本机尚未写入任何密钥文件')).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByLabelText(/主密码|用户名|邮箱|手机号/)).toBeNull();
    // 本页没有使用者选择器（外壳右上角的主题切换器是另一回事，按名字排除掉）
    expect(screen.queryByRole('radiogroup', { name: '选择使用者' })).toBeNull();
  });

  it('点「使用本机文件密钥」才提交同意；点「退出」只提交退出，绝不提交同意', async () => {
    const { unmount } = render(<DeviceKeyConsentScreen />);
    fireEvent.click(screen.getByRole('button', { name: '我了解风险，使用本机文件密钥' }));
    await waitFor(() => expect(grant).toHaveBeenCalledTimes(1));
    expect(decline).not.toHaveBeenCalled();
    unmount();

    seed();
    render(<DeviceKeyConsentScreen />);
    fireEvent.click(screen.getByRole('button', { name: '退出（不写入任何文件）' }));
    await waitFor(() => expect(decline).toHaveBeenCalledTimes(1));
    expect(grant).toHaveBeenCalledTimes(1);
  });

  it('提交中两个按钮都真禁用，避免重复写密钥文件', () => {
    seed({ pending: true });
    render(<DeviceKeyConsentScreen />);
    expect(screen.getByRole('button', { name: '正在按你的选择准备保险库…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '退出（不写入任何文件）' })).toBeDisabled();
    expect(grant).not.toHaveBeenCalled();
    expect(decline).not.toHaveBeenCalled();
  });

  it('后端报错时只显示后端原文与错误码，不编造成功提示', () => {
    seed({ errorMessage: '保险库装配失败，请查看本机日志', errorCode: 'INTERNAL', errorDetail: '密钥文件写入被拒绝' });
    render(<DeviceKeyConsentScreen />);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('保险库装配失败，请查看本机日志');
    expect(alert).toHaveTextContent('INTERNAL');
    expect(alert).toHaveTextContent('密钥文件写入被拒绝');
    expect(screen.queryByText(/已就绪|成功/)).toBeNull();
  });
});
