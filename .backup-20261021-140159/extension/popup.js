'use strict';
/**
 * 蒙电信产助手 —— 状态弹窗
 * 只做两件事：hello 状态检测 + 触发当前标签页重新走一次填充检测。
 * storage 仅保存最后一次非秘密状态（连接状态与时间戳），绝不保存凭据或票据。
 */

const PROTOCOL = 'mda-fill/1';
const STATE_KEY = 'lastStatus';

const COPY = {
  ready: ['已连接（可填充）', '桌面应用运行中且已解锁。在应用里点「打开并安全填充」即可填充。'],
  locked: ['已连接（已锁定）', '桌面应用正在运行，但会话已锁定。请先在桌面应用解锁后重试。'],
  off: ['未连接', ''],
};

const ERROR_NOTE = {
  HOST_CONNECT_FAILED: '未能拉起宿主进程：请确认桌面应用已安装宿主清单，并已在本页填写扩展 ID。',
  CHANNEL_MISSING: '未找到本机通道文件：桌面应用可能未运行。',
  APP_NOT_RUNNING: '桌面应用未运行，或应用与宿主之间的通道已断开。',
  CHANNEL_CORRUPT: '本机通道文件损坏：请重启桌面应用。',
  FORBIDDEN: '通道令牌不匹配：通常因桌面应用刚重启，重试或重新检测即可。',
  INVALID_REQUEST: '请求格式不正确（不应出现，请联系维护者）。',
  TIMEOUT: '宿主响应超时：请确认桌面应用仍在运行。',
  INTERNAL: '后台内部错误：请重新检测。',
};

function ui() {
  return {
    box: document.getElementById('status'),
    text: document.getElementById('statusText'),
    note: document.getElementById('statusNote'),
    btn: document.getElementById('recheck'),
    extId: document.getElementById('extId'),
  };
}

function render(state, noteExtra) {
  const { box, text, note } = ui();
  box.classList.remove('ready', 'locked', 'off');
  box.classList.add(state);
  const [title, hint] = COPY[state];
  text.textContent = title;
  let n = hint;
  if (noteExtra) n = noteExtra;
  note.textContent = n;
}

async function hello() {
  try {
    const resp = await chrome.runtime.sendMessage({ v: PROTOCOL, kind: 'hello' });
    return resp && typeof resp === 'object' ? resp : { ok: false, error: 'INTERNAL' };
  } catch (_) {
    return { ok: false, error: 'HOST_CONNECT_FAILED' };
  }
}

/** 当前标签页为 https 时，让内容脚本立刻重走一次检测（依赖 activeTab 授权）。 */
async function triggerActiveTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url || !tab.url.startsWith('https://')) return;
    try {
      await chrome.tabs.sendMessage(tab.id, { v: PROTOCOL, kind: 'mda-ping' });
    } catch (_) {
      // 页面在扩展安装前已打开：注入内容脚本后再触发
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    }
    await chrome.tabs.sendMessage(tab.id, { v: PROTOCOL, kind: 'mda-check-now' });
  } catch (_) {
    /* 无法触达该标签页（如浏览器内部页），静默 */
  }
}

async function refresh() {
  const { btn } = ui();
  btn.disabled = true;
  render('off', '正在检测…');
  const resp = await hello();
  let state;
  let note = '';
  if (resp.ok === true && resp.unlocked === true) {
    state = 'ready';
  } else if (resp.ok === false && resp.error === 'SESSION_LOCKED') {
    state = 'locked';
  } else {
    state = 'off';
    note = ERROR_NOTE[resp.error] || `未连接（${resp.error || 'UNKNOWN'}）`;
  }
  render(state, note);
  chrome.storage.local.set({ [STATE_KEY]: { state, checkedAt: Date.now(), note } });
  btn.disabled = false;
  if (state === 'ready') await triggerActiveTab();
}

document.addEventListener('DOMContentLoaded', async () => {
  ui().extId.textContent = chrome.runtime.id;
  ui().btn.addEventListener('click', refresh);
  // 先展示上次状态（非秘密），再实时检测
  const saved = (await chrome.storage.local.get(STATE_KEY))[STATE_KEY];
  if (saved && COPY[saved.state]) render(saved.state, saved.note || COPY[saved.state][1]);
  await refresh();
});
