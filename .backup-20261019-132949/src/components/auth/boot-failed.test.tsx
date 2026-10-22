import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { BootFailureStatus } from '../../lib/types';

/**
 * 启动装配失败页。
 * 这一页存在的意义是"release 下进程原本会静默消失"，所以锁死四件事：
 * ① 后端错误码与原文逐字摆出来，不翻译成好消息；② 页面没有任何按钮——重试要重跑系统安全存储与建库，
 * 那是下一条功能，本页不摆假入口；③ 排查说明按阶段给，不承诺任何找回；④ 数据目录如实回显。
 */

vi.mock('../../lib/api', () => ({
  api: {},
  ApiError: class ApiError extends Error {},
  isTauri: () => false,
}));

import { useSession } from '../../state/session';
import { BootFailedScreen } from './BootFailedScreen';

function seed(failure: BootFailureStatus | null) {
  useSession.setState({
    status: null,
    profile: null,
    phase: 'bootFailed',
    errorCode: null,
    errorMessage: null,
    errorDetail: null,
    pending: false,
    deviceKeyGate: null,
    bootFailure: failure,
  });
}

const assembly: BootFailureStatus = {
  failed: true,
  stage: 'assembly',
  code: 'DB_ERROR',
  message: '保险库初始化失败（DB_ERROR）',
  dataDir: '/Users/x/Library/Application Support/com.mda.assistant',
};

beforeEach(() => seed(assembly));

describe('BootFailedScreen', () => {
  it('后端错误码与原文逐字显示，不写任何"已就绪/成功"口径', () => {
    render(<BootFailedScreen />);
    const region = screen.getByRole('region', { name: '保险库没能打开' });
    expect(region).toHaveTextContent('DB_ERROR');
    expect(region).toHaveTextContent('保险库初始化失败（DB_ERROR）');
    expect(screen.getByText(/保险库没有打开，界面停在这里/)).toBeInTheDocument();
    expect(region.textContent).not.toMatch(/已自动恢复|已修复|成功/);
  });

  it('没有任何按钮或输入项：重试不是本页能做的真动作', () => {
    render(<BootFailedScreen />);
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByLabelText(/口令|密码|用户名/)).toBeNull();
    // 唯一的指引是"退出后重新打开"，且提醒不要删数据目录
    const note = screen.getByRole('note', { name: '启动失败的排查说明' });
    expect(note).toHaveTextContent('退出本应用再重新打开');
    expect(note).toHaveTextContent('不要删除数据目录里的任何文件');
  });

  it('迁移阶段如实说明整条回滚、不带半套 schema 继续跑', () => {
    render(<BootFailedScreen />);
    expect(screen.getByRole('note', { name: '启动失败的排查说明' })).toHaveTextContent('整条回滚');
  });

  it('取密钥阶段改为说明本次启动没写入任何密钥文件，并回显数据目录', () => {
    seed({ ...assembly, stage: 'device-key', code: 'DEVICE_KEY_LOST_VAULT_INTACT', dataDir: '/data/mda' });
    render(<BootFailedScreen />);
    const note = screen.getByRole('note', { name: '启动失败的排查说明' });
    expect(note).not.toHaveTextContent('整条回滚');
    expect(note).toHaveTextContent('本次启动没有写入任何密钥文件');
    expect(note).toHaveTextContent('换一把新密钥');
    expect(screen.getByText('/data/mda')).toBeInTheDocument();
  });

  it('后端没给数据目录时不编造一个路径', () => {
    seed({ ...assembly, dataDir: '' });
    render(<BootFailedScreen />);
    expect(screen.getByRole('note', { name: '启动失败的排查说明' })).not.toHaveTextContent('涉及的数据目录');
  });
});
