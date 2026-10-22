import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

/**
 * 设置密码表单的真实交互测试（原型重绘版）。
 *
 * 与 auth-a11y.test.tsx 的分工：那份守语义标签与"不得越界出现用户名字段"，
 * 这份守四条容易在改样式时被改坏的契约——
 * ① 位数与字符类别既不在界面上预告、也不在前端拦（L 轮起主密码没有任何强度要求），
 *    前端只做"非空"与"两次一致"两件事，剩下的以后端返回为准；
 * ② 提交中真禁用、只发一次请求（防重复建库）；
 * ③ 后端说失败就摆失败，带真实错误码，并把焦点交给错误摘要；
 * ④ 明文密码只出现在该出现的地方（输入框与后端入参），不进 DOM 文本、不进其它调用。
 */

vi.mock('../../lib/api', () => ({
  api: { passwordStrength: vi.fn(), loginProfile: vi.fn(), initialize: vi.fn() },
  ApiError: class ApiError extends Error {},
  isTauri: () => false,
}));

import { api } from '../../lib/api';
import { useSession, type SessionState } from '../../state/session';
import { VaultCreateForm } from './VaultCreateForm';

const PW = 'Ab#1234567890';

function seed(patch: Partial<SessionState> = {}) {
  useSession.setState({
    status: null,
    profile: null,
    phase: 'init',
    errorCode: null,
    errorMessage: null,
    errorDetail: null,
    pending: false,
    deviceKeyGate: null,
    bootFailure: null,
    initialize: vi.fn().mockResolvedValue(true),
    ...patch,
  });
}

/** 像 session.ts 的 initialize 那样先把 pending 立起来，才能测出"提交中真禁用"。 */
function pendingAwareInitialize(gate: Promise<unknown>) {
  return vi.fn().mockImplementation(async () => {
    useSession.setState({ pending: true });
    await gate;
    useSession.setState({ pending: false });
    return true;
  });
}

function fillForm() {
  fireEvent.change(screen.getByLabelText('设置密码'), { target: { value: PW } });
  fireEvent.change(screen.getByLabelText('确认密码'), { target: { value: PW } });
}

beforeEach(() => {
  vi.mocked(api.passwordStrength).mockReset();
  vi.mocked(api.loginProfile).mockReset();
});

describe('界面既不预告位数、也不替后端拦位数', () => {
  it('页面里没有任何写死或取来的位数文案，也不为策略/强度发请求', () => {
    seed();
    render(<VaultCreateForm />);
    fireEvent.change(screen.getByLabelText('设置密码'), { target: { value: 'abc' } });
    expect(document.body.textContent).not.toMatch(/不少于 \d+ 位|至少 \d+ 位|后端强度评估/);
    expect(api.loginProfile).not.toHaveBeenCalled();
    expect(api.passwordStrength).not.toHaveBeenCalled();
  });

  /** L 轮口径：三位口令照样交给后端。这条守住"取消策略"没有被前端偷偷留一半。 */
  it('三位纯小写口令不会被前端拦下，直接交给 initialize', async () => {
    const initialize = vi.fn().mockResolvedValue(true);
    seed({ initialize });
    render(<VaultCreateForm />);
    fireEvent.change(screen.getByLabelText('设置密码'), { target: { value: 'abc' } });
    fireEvent.change(screen.getByLabelText('确认密码'), { target: { value: 'abc' } });
    fireEvent.click(screen.getByRole('button', { name: '开启助手' }));
    await waitFor(() => expect(initialize).toHaveBeenCalledWith('', 'abc'));
  });

  it('后端报错误把具体要求原样摆出来（只有空口令这一条还会被后端拒）', () => {
    seed({
      errorCode: 'WEAK_PASSWORD',
      errorMessage: '口令不满足要求',
      errorDetail: '主密码不能为空，也不能只输入空格。',
    });
    render(<VaultCreateForm />);
    expect(screen.getByRole('alert')).toHaveTextContent('主密码不能为空');
  });
});

describe('提交与重复提交', () => {
  it('submit 把空昵称（由后端按设备名生成）与主密码交给 store 的 initialize', async () => {
    const initialize = vi.fn().mockResolvedValue(true);
    seed({ initialize });
    render(<VaultCreateForm />);
    fillForm();
    // 真机上的 Enter 隐式提交在 jsdom 里不会合成，派发的是它最终触发的那个 submit 事件
    fireEvent.submit(screen.getByRole('form', { name: '设置主密码' }));
    await waitFor(() => expect(initialize).toHaveBeenCalledWith('', PW));
  });

  it('提交中按钮真禁用，连点两次只发一次建库请求', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const initialize = pendingAwareInitialize(gate);
    seed({ initialize });
    render(<VaultCreateForm />);
    fillForm();

    const submit = screen.getByRole('button', { name: '开启助手' });
    fireEvent.click(submit);
    await waitFor(() => expect(submit).toBeDisabled());
    expect(submit).toHaveTextContent('开启中');

    fireEvent.click(submit);
    fireEvent.click(submit);
    expect(initialize).toHaveBeenCalledTimes(1);

    release();
    await waitFor(() => expect(submit).toBeEnabled());
  });
});

describe('后端判定失败', () => {
  it('错误摘要带真实错误码与 detail，焦点落在错误区，已输入的密码不丢', async () => {
    const initialize = vi.fn().mockImplementation(async () => {
      useSession.setState({
        errorCode: 'WEAK_PASSWORD',
        errorMessage: '口令不满足要求',
        errorDetail: '主密码不能为空，也不能只输入空格。',
        pending: false,
      });
      return false;
    });
    seed({ initialize });
    render(<VaultCreateForm />);
    fillForm();
    fireEvent.click(screen.getByRole('button', { name: '开启助手' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('口令不满足要求');
    expect(alert).toHaveTextContent('WEAK_PASSWORD');
    expect(alert).toHaveTextContent('主密码不能为空');
    await waitFor(() => expect(document.activeElement).toBe(alert));
    // 失败不把人赶走：改一个字段就能重交
    expect(screen.getByLabelText('设置密码')).toHaveValue(PW);
  });

  it('挂载时就带着后端错误也不抢焦点', async () => {
    seed({ errorCode: 'INTERNAL', errorMessage: '上一次尝试留下的错误。' });
    render(<VaultCreateForm />);
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(document.activeElement).toBe(document.body);
  });
});

describe('明文密码的外泄面', () => {
  it('密码只出现在输入框与 initialize 入参里，不进 DOM 文本、不进其它调用', async () => {
    const initialize = vi.fn().mockResolvedValue(true);
    seed({ initialize });
    const { container } = render(<VaultCreateForm />);
    fillForm();
    fireEvent.submit(screen.getByRole('form', { name: '设置主密码' }));
    await waitFor(() => expect(initialize).toHaveBeenCalled());

    expect(container.textContent).not.toContain(PW);
    expect(initialize).toHaveBeenCalledWith('', PW);
    // 不再有强度预览与策略请求：口令出得去的地方只剩 initialize 这一处
    expect(api.passwordStrength).not.toHaveBeenCalled();
    expect(api.loginProfile).not.toHaveBeenCalled();
  });
});

describe('显示/隐藏密码', () => {
  it('两个密码框各自独立切换，aria-pressed 与 type 同步', () => {
    seed();
    render(<VaultCreateForm />);
    const toggles = screen.getAllByRole('button', { name: '显示密码' });
    expect(toggles).toHaveLength(2);

    fireEvent.click(toggles[0]);
    expect(screen.getByLabelText('设置密码')).toHaveAttribute('type', 'text');
    expect(screen.getByLabelText('确认密码')).toHaveAttribute('type', 'password');
    expect(toggles[0]).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getAllByRole('button', { name: '隐藏密码' })).toHaveLength(1);
  });
});
