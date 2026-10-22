import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { LoginProfile } from '../../lib/types';

/**
 * 认证场景的可访问性与身份测试：外壳（企业标识 + 主题切换 + 铁塔）与首装/解锁两屏。
 * 用 role/label 查询驱动，不依赖 class 名——查询能命中即证明语义标签真实存在：
 * label 与输入框有关联、错误走 role="alert"、状态走 role="status" + aria-live、
 * 使用者选择器与主题切换都是 radiogroup/radio。同时锁死需求 §9.1 的身份口径：
 * 全站不得出现用户名/邮箱/手机号字段，昵称不出现在界面上，授权用的是内部 ID。
 */

vi.mock('../../lib/api', () => ({
  api: { setTheme: vi.fn(), get_theme: vi.fn(), theme: vi.fn() },
  ApiError: class ApiError extends Error {},
  isTauri: () => false,
}));

import { api } from '../../lib/api';
import { useSession, type SessionState } from '../../state/session';
import { useTheme } from '../../state/theme';
import { AuthShell } from './AuthShell';
import { InitScreen } from './InitScreen';
import { UnlockScreen } from './UnlockScreen';

function seedSession(patch: Partial<SessionState>) {
  useSession.setState({
    status: null,
    profile: null,
    phase: 'init',
    errorCode: null,
    errorMessage: null,
    errorDetail: null,
    pending: false,
    initialize: vi.fn().mockResolvedValue(true),
    unlock: vi.fn().mockResolvedValue(true),
    ...patch,
  });
}

function profileOf(users: LoginProfile['users'], lockout: LoginProfile['lockout'] = null): LoginProfile {
  return {
    initialized: true,
    singleUser: users.length === 1,
    users,
    lockout,
  };
}

beforeEach(() => {
  vi.mocked(api.setTheme).mockReset().mockResolvedValue(undefined);
  // 切换器的档位来自 store，测试之间不互相污染
  useTheme.setState({ style: 'enterprise-blue', mode: 'system', glassIntensity: 60, reduceMotion: false });
});

describe('认证外壳（企业标识 + 主题切换 + 铁塔）', () => {
  it('企业标识是不可聚焦的说明，铁塔整幅对读屏隐藏', () => {
    render(
      <AuthShell>
        <p>占位</p>
      </AuthShell>,
    );
    expect(screen.getByLabelText('内蒙古电力（集团）有限责任公司')).toBeInTheDocument();
    const tower = document.querySelector('.auth-tower');
    expect(tower).not.toBeNull();
    expect(tower).toHaveAttribute('aria-hidden', 'true');
  });

  it('主题切换是 radiogroup，三档各自有可读名称，当前档 aria-checked', () => {
    render(
      <AuthShell>
        <p>占位</p>
      </AuthShell>,
    );
    const group = screen.getByRole('radiogroup', { name: '主题切换' });
    const radios = within(group).getAllByRole('radio');
    expect(radios).toHaveLength(3);
    expect(radios.map((r) => r.getAttribute('aria-label'))).toEqual(['内蒙古电力绿色主题', '浅色主题', '深色主题']);
    expect(radios.filter((r) => r.getAttribute('aria-checked') === 'true')).toHaveLength(1);
  });

  it('三档各是一个完整落位：点浅/深都要真的离开当前档，滑块位移与 aria-checked 一起走', () => {
    useTheme.setState({ style: 'power-grid-green', mode: 'dark' });
    render(
      <AuthShell>
        <p>占位</p>
      </AuthShell>,
    );
    const group = screen.getByRole('radiogroup', { name: '主题切换' });
    const radios = within(group).getAllByRole('radio');
    const index = () => group.style.getPropertyValue('--scene-switch-index');
    const checked = () => radios.map((r) => r.getAttribute('aria-checked'));
    expect(checked()).toEqual(['true', 'false', 'false']);
    expect(index()).toBe('0');

    // 浅档只改外观模式：风格仍是绿色
    fireEvent.click(radios[1]);
    expect(useTheme.getState().style).toBe('power-grid-green');
    expect(useTheme.getState().mode).toBe('light');
    expect(checked()).toEqual(['false', 'true', 'false']);
    expect(index()).toBe('1');

    // 深档在绿色风格下必须落到中性暗色风格：绿色+深色本身就是第 0 档，
    // 不挪风格的话这一档按下去会被重新算回第 0 档，滑块原地不动。
    fireEvent.click(radios[2]);
    expect(useTheme.getState().style).toBe('graphite-dark');
    expect(useTheme.getState().mode).toBe('dark');
    expect(checked()).toEqual(['false', 'false', 'true']);
    expect(index()).toBe('2');
    expect(radios[2]).toHaveAttribute('tabindex', '0');
    expect(radios[0]).toHaveAttribute('tabindex', '-1');

    fireEvent.click(radios[0]);
    expect(useTheme.getState().style).toBe('power-grid-green');
    expect(useTheme.getState().mode).toBe('dark');
    expect(index()).toBe('0');
    expect(api.setTheme).toHaveBeenLastCalledWith('power-grid-green', 'dark', 60);
  });

  it('其余七套风格下浅/深仍只改明暗，不抢第 0 档', () => {
    useTheme.setState({ style: 'enterprise-blue', mode: 'light' });
    render(
      <AuthShell>
        <p>占位</p>
      </AuthShell>,
    );
    const group = screen.getByRole('radiogroup', { name: '主题切换' });
    const radios = within(group).getAllByRole('radio');
    expect(radios[1]).toHaveAttribute('aria-checked', 'true');
    expect(group.style.getPropertyValue('--scene-switch-index')).toBe('1');

    fireEvent.click(radios[2]);
    expect(useTheme.getState().style).toBe('enterprise-blue');
    expect(useTheme.getState().mode).toBe('dark');
    expect(group.style.getPropertyValue('--scene-switch-index')).toBe('2');
  });

  it('方向键在切换器里换档，焦点跟到新的那一档', () => {
    useTheme.setState({ style: 'power-grid-green', mode: 'dark' });
    render(
      <AuthShell>
        <p>占位</p>
      </AuthShell>,
    );
    const group = screen.getByRole('radiogroup', { name: '主题切换' });
    fireEvent.keyDown(group, { key: 'ArrowRight' });
    expect(useTheme.getState().mode).toBe('light');
    expect(within(group).getAllByRole('radio')[1]).toHaveFocus();
  });
});

describe('InitScreen 首次初始化', () => {
  beforeEach(() => seedSession({ phase: 'init' }));

  it('只要两个密码框，绝不出现昵称/用户名/邮箱/手机号字段', () => {
    render(<InitScreen />);
    expect(screen.getByLabelText('设置密码')).toBeInTheDocument();
    expect(screen.getByLabelText('确认密码')).toBeInTheDocument();
    // 输入框总数就是 2 个密码框，多一个字段就说明需求被越界实现
    expect(screen.queryAllByRole('textbox')).toHaveLength(0);
    for (const banned of ['用户名', '邮箱', '手机', '账号名', '登录名', '昵称']) {
      expect(screen.queryByLabelText(new RegExp(banned)), `不应出现「${banned}」字段`).toBeNull();
    }
  });

  it('不在界面上预告位数，也不做实时强度预览：主密码没有任何强度要求（L 轮）', () => {
    render(<InitScreen />);
    expect(screen.queryByText(/不少于|由后端策略判定|后端强度评估/)).toBeNull();
    fireEvent.change(screen.getByLabelText('设置密码'), { target: { value: 'Ab#1234567890' } });
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('主密码可见性切换是按钮语义，aria-pressed 与输入类型同步', () => {
    render(<InitScreen />);
    const pw = screen.getByLabelText('设置密码');
    expect(pw).toHaveAttribute('type', 'password');
    const toggle = screen.getAllByRole('button', { name: '显示密码' })[0];
    fireEvent.click(toggle);
    expect(pw).toHaveAttribute('type', 'text');
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getAllByRole('button', { name: '隐藏密码' }).length).toBeGreaterThan(0);
  });

  it('错误走 role="alert"，可被读屏播报；空密码与两次不一致各给明确文案', () => {
    render(<InitScreen />);
    const form = screen.getByRole('form', { name: '设置主密码' });
    // 直接派发 submit：绕过浏览器原生 required 校验，测的是 JS 侧的守卫与播报
    fireEvent.submit(form);
    expect(screen.getByRole('alert')).toHaveTextContent('请输入主密码');

    fireEvent.change(screen.getByLabelText('设置密码'), { target: { value: 'Ab#1234567890' } });
    fireEvent.change(screen.getByLabelText('确认密码'), { target: { value: 'Ab#1234567899' } });
    fireEvent.submit(form);
    expect(screen.getByRole('alert')).toHaveTextContent('不一致');
    expect(useSession.getState().initialize).not.toHaveBeenCalled();
  });

  it('提交时昵称交给后端按设备名生成，前端只传空值与密码', async () => {
    const initialize = vi.fn().mockResolvedValue(true);
    seedSession({ phase: 'init', initialize });
    render(<InitScreen />);
    fireEvent.change(screen.getByLabelText('设置密码'), { target: { value: 'Ab#1234567890' } });
    fireEvent.change(screen.getByLabelText('确认密码'), { target: { value: 'Ab#1234567890' } });
    fireEvent.click(screen.getByRole('button', { name: '开启助手' }));
    await waitFor(() => expect(initialize).toHaveBeenCalledWith('', 'Ab#1234567890'));
  });

  it('后端报错原样摆出，并带上错误码与 detail（L 轮起主密码只剩"不能为空"这一条后端要求）', () => {
    seedSession({
      phase: 'init',
      errorMessage: '口令不满足要求',
      errorCode: 'WEAK_PASSWORD',
      errorDetail: '主密码不能为空，也不能只输入空格。',
    });
    render(<InitScreen />);
    expect(screen.getByRole('alert')).toHaveTextContent('口令不满足要求');
    expect(screen.getByRole('alert')).toHaveTextContent('WEAK_PASSWORD');
    expect(screen.getByRole('alert')).toHaveTextContent('主密码不能为空');
  });
});

describe('UnlockScreen 解锁', () => {
  it('单使用者只输密码，不出现使用者选择器，且展示内部标识', () => {
    seedSession({ phase: 'login', profile: profileOf([{ id: 'u-single', nickname: '张三', internalCode: 'MDA-AAAA' }]) });
    render(<UnlockScreen />);
    expect(screen.queryByRole('radiogroup', { name: '选择使用者' })).toBeNull();
    // M 轮：问候语就是这一屏的标题，页面上不再有"打开你的保险库"那一级标题
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('又见面了，张三');
    expect(screen.queryByText('打开你的保险库')).toBeNull();
    expect(screen.getByText(/MDA-AAAA/)).toBeInTheDocument();
    expect(screen.getByLabelText('主密码')).toBeEnabled();
  });

  it('多使用者先用 radio 选，昵称可重复靠内部标识区分，授权携带的是内部 ID', async () => {
    const unlock = vi.fn().mockResolvedValue(true);
    seedSession({
      phase: 'login',
      unlock,
      profile: profileOf([
        { id: 'u-1', nickname: '张三', internalCode: 'MDA-AAAA' },
        { id: 'u-2', nickname: '张三', internalCode: 'MDA-BBBB' },
      ]),
    });
    render(<UnlockScreen />);
    const group = screen.getByRole('radiogroup', { name: '选择使用者' });
    const radios = within(group).getAllByRole('radio');
    expect(radios).toHaveLength(2);
    // 两个昵称相同，靠内部标识区分
    expect(radios[0]).toHaveTextContent('MDA-AAAA');
    expect(radios[1]).toHaveTextContent('MDA-BBBB');
    expect(radios[0]).toHaveAttribute('aria-checked', 'false');

    fireEvent.click(radios[1]);
    expect(radios[1]).toHaveAttribute('aria-checked', 'true');
    fireEvent.change(screen.getByLabelText('主密码'), { target: { value: 'Ab#1234567890' } });
    fireEvent.click(screen.getByRole('button', { name: '解锁' }));
    await waitFor(() => expect(unlock).toHaveBeenCalledWith('u-2', 'Ab#1234567890'));
  });

  it('没选使用者时主密码框与提交按钮都禁用，不会发出空授权', () => {
    seedSession({ phase: 'login', profile: profileOf([{ id: 'u-1', nickname: '张三', internalCode: 'MDA-AAAA' }]) });
    useSession.setState({ profile: profileOf([]) });
    render(<UnlockScreen />);
    expect(screen.getByText('没有可用的启用使用者。')).toBeInTheDocument();
    expect(screen.getByLabelText('主密码')).toBeDisabled();
    expect(screen.getByRole('button', { name: '解锁' })).toBeDisabled();
  });

  it('锁定状态是 aria-live 的 role="status"，并给出后端给的剩余秒数', () => {
    seedSession({
      phase: 'login',
      profile: profileOf([{ id: 'u-single', nickname: '张三', internalCode: 'MDA-AAAA' }], {
        locked: true,
        failedCount: 5,
        secondsRemaining: 42,
        attemptsRemaining: 0,
      }),
    });
    render(<UnlockScreen />);
    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(status).toHaveTextContent('42 秒后重试');
    expect(status).toHaveTextContent('后端给出');
  });

  it('一次都没失败过时整条锁定提示不渲染（lockout 恒非空不等于有话要说）', () => {
    seedSession({
      phase: 'login',
      profile: profileOf([{ id: 'u-single', nickname: '张三', internalCode: 'MDA-AAAA' }], {
        locked: false,
        failedCount: 0,
        secondsRemaining: 0,
        attemptsRemaining: 5,
      }),
    });
    render(<UnlockScreen />);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('后端没给秒数时不写"0 秒后重试"，改说剩余次数（max=0 即不启用锁定）', () => {
    seedSession({
      phase: 'login',
      profile: profileOf([{ id: 'u-single', nickname: '张三', internalCode: 'MDA-AAAA' }], {
        locked: true,
        failedCount: 3,
        secondsRemaining: 0,
        attemptsRemaining: 0,
      }),
    });
    render(<UnlockScreen />);
    const status = screen.getByRole('status');
    expect(status).not.toHaveTextContent('0 秒后重试');
    expect(status).toHaveTextContent('刚才 3 次没对上');
  });

  it('后端错误可读，且解锁页不再显示任何位数策略提示（L 轮起主密码无强度要求）', () => {
    seedSession({
      phase: 'login',
      profile: profileOf([{ id: 'u-single', nickname: '张三', internalCode: 'MDA-AAAA' }]),
      errorMessage: '主密码不正确',
      errorCode: 'AUTH_BAD_PASSWORD',
      errorDetail: '连续失败会触发锁定',
    });
    render(<UnlockScreen />);
    expect(screen.getByRole('alert')).toHaveTextContent('主密码不正确');
    expect(screen.getByRole('alert')).toHaveTextContent('AUTH_BAD_PASSWORD');
    expect(screen.queryByText(/策略提示|至少 \d+ 位|不少于/)).toBeNull();
  });
});
