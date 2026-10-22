'use strict';
/**
 * 蒙电信产助手 —— MV3 service worker
 *
 * 职责：扩展与 Native Messaging 宿主（com.mda.fillhost）之间的唯一通道。
 * 诚实说明（MV3 限制）：service worker 随时可能被浏览器回收，因此“跨浏览器/会话
 * 常驻端口”并不存在。本文件的实现是：按需连接（lazy connect），端口断开或超时时
 * 明确返回错误码，绝不静默挂起；下一次请求会自动重新拉起宿主。
 *
 * 安全约束：不缓存任何秘密。票据 / 用户名 / 口令只存在于单次调用的局部变量中，
 * 响应送达后立即丢弃；不写 storage，不落任何长期模块级变量。
 */

const HOST_NAME = 'com.mda.fillhost';
const PROTOCOL = 'mda-fill/1';
// 宿主侧 TCP 读超时 8s，这里留裕量；超时即视为通道故障并断开端口重连。
const CALL_TIMEOUT_MS = 12000;

let port = null;
let current = null; // { resolve, timer } —— 同一端口上严格一问一答（与宿主协议一致）
const queue = [];

function attachPort() {
  try {
    port = chrome.runtime.connectNative(HOST_NAME);
  } catch (_) {
    port = null;
    return null;
  }
  port.onMessage.addListener((msg) => {
    settle(typeof msg === 'object' && msg !== null ? msg : { ok: false, error: 'APP_BAD_RESPONSE' });
  });
  port.onDisconnect.addListener(() => {
    // 宿主进程退出 = 桌面应用未运行 / 通道文件缺失被拒：明确报 APP_NOT_RUNNING。
    port = null;
    settle({ ok: false, error: 'APP_NOT_RUNNING' });
  });
  return port;
}

function settle(resp) {
  if (!current) return;
  const { resolve, timer } = current;
  current = null;
  clearTimeout(timer);
  resolve(resp);
  setTimeout(run, 0);
}

function run() {
  const item = queue.shift();
  if (!item) return;
  const p = port || attachPort();
  if (!p) {
    item.resolve({ ok: false, error: 'HOST_CONNECT_FAILED' });
    setTimeout(run, 0);
    return;
  }
  const timer = setTimeout(() => {
    try {
      p.disconnect();
    } catch (_) {
      /* 已断开 */
    }
    settle({ ok: false, error: 'TIMEOUT' });
  }, CALL_TIMEOUT_MS);
  current = { resolve: item.resolve, timer };
  try {
    p.postMessage(item.payload);
  } catch (_) {
    current = null;
    clearTimeout(timer);
    port = null;
    item.resolve({ ok: false, error: 'APP_NOT_RUNNING' });
    setTimeout(run, 0);
  }
}

/** 向宿主发起一次请求-响应；payload 形状与桌面端 ipc.rs 严格一致。 */
function callHost(payload) {
  return new Promise((resolve) => {
    queue.push({ payload, resolve });
    if (!current) run();
  });
}

async function handleRequest(msg) {
  switch (msg.kind) {
    case 'hello':
      return callHost({ type: 'hello' });
    case 'challenge': {
      const origin = String(msg.origin || '');
      if (!origin.startsWith('https://')) {
        return { ok: false, error: 'ORIGIN_NOT_ALLOWED' };
      }
      return callHost({ type: 'challenge', origin });
    }
    case 'fill': {
      const r = msg.request || {};
      // 原样转发五个绑定字段；桌面端任一不符即 TICKET_INVALID，本层不做兜底。
      return callHost({
        type: 'fill',
        request: {
          ticketId: String(r.ticketId || ''),
          ticketSecret: String(r.ticketSecret || ''),
          targetId: String(r.targetId || ''),
          credentialId: String(r.credentialId || ''),
          origin: String(r.origin || ''),
        },
      });
    }
    default:
      return { ok: false, error: 'INVALID_REQUEST' };
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.v !== PROTOCOL) return false;
  handleRequest(msg).then(sendResponse).catch(() => sendResponse({ ok: false, error: 'INTERNAL' }));
  return true; // 异步响应
});
