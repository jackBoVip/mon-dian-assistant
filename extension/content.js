'use strict';
/**
 * 蒙电信产助手 —— 内容脚本（注入 http / https 页面）
 *
 * 流程：向 service worker 索取本次填充挑战（桌面应用只有在用户点击
 * 「打开并安全填充」且页面 Origin 与台账精确匹配时才签发一次性票据）。
 * 无票据 → 完全静默；有票据 → （按需）先向用户确认，再填充，绝不提交表单。
 *
 * 安全约束：
 * - 用户名/口令只存在于局部变量，填完立即置空；不写 DOM 属性、
 *   不写 localStorage/sessionStorage、不打印到 console。
 * - 确认面板可键盘操作：Esc 取消，焦点默认在「取消」上，aria-live 播报。
 */

(() => {
  if (window.__mdaFillLoaded) return;
  window.__mdaFillLoaded = true;

  const PROTOCOL = 'mda-fill/1';
  const FIELD_WAIT_MS = 20000; // 票据 TTL 约 60s，这里留足裕量又不过期
  const FIELD_POLL_MS = 400;
  let grant = null; // 仅当前一次填充生命周期内存在；结束即置空

  function send(msg) {
    return chrome.runtime.sendMessage({ v: PROTOCOL, ...msg }).catch(() => ({ ok: false, error: 'CHANNEL_MISSING' }));
  }

  // ———— 字段定位 ————

  function isVisible(el) {
    if (!el || el.disabled || el.readOnly || !el.isConnected) return false;
    if (el.closest('[hidden], [aria-hidden="true"]')) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const cs = window.getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none';
  }

  function labelOf(el) {
    const parts = [el.name, el.id, el.getAttribute('autocomplete'), el.getAttribute('placeholder'), el.getAttribute('aria-label')];
    if (el.labels && el.labels.length) {
      for (const lb of el.labels) parts.push(lb.textContent);
    }
    return parts.filter(Boolean).join(' ');
  }

  const USER_HINT = /(user|username|login|account|email|mail|账号|帐号|用户|邮箱)/i;

  function findFields() {
    const inputs = Array.from(document.querySelectorAll('input, textarea'));
    const password = inputs.find((el) => el.tagName === 'INPUT' && el.type === 'password' && isVisible(el));
    if (!password) return null;

    const textish = inputs.filter(
      (el) =>
        el !== password &&
        isVisible(el) &&
        el.tagName === 'INPUT' &&
        ['text', 'email', 'tel'].includes((el.getAttribute('type') || 'text').toLowerCase()),
    );
    if (textish.length === 0) return null;

    let username =
      textish.find((el) => (el.getAttribute('autocomplete') || '').toLowerCase() === 'username') ||
      textish.find((el) => USER_HINT.test(labelOf(el)));
    if (!username) {
      // 兜底：文档顺序上离密码框最近的前一个文本输入
      username =
        [...textish].reverse().find((el) => el.compareDocumentPosition(password) & Node.DOCUMENT_POSITION_FOLLOWING) ||
        textish[0];
    }
    return { username, password };
  }

  function waitForFields() {
    return new Promise((resolve) => {
      const started = Date.now();
      const tick = () => {
        const f = findFields();
        if (f) return resolve(f);
        if (Date.now() - started >= FIELD_WAIT_MS) return resolve(null);
        setTimeout(tick, FIELD_POLL_MS);
      };
      tick();
    });
  }

  // ———— 填充（兼容 React 等受控组件）————

  function setNativeValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (!desc || typeof desc.set !== 'function') {
      el.value = String(value);
    } else {
      desc.set.call(el, String(value));
    }
    el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true }));
    el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
  }

  async function fillInto(fields, username, password) {
    for (const el of [fields.username, fields.password]) {
      el.focus({ preventScroll: false });
    }
    setNativeValue(fields.username, username);
    setNativeValue(fields.password, password);
    // 绝不提交：不调用 form.submit / requestSubmit，不派发 submit/Enter。
    flashNote('已由蒙电信产助手完成填充，表单未提交，请自行核对后登录。');
  }

  // ———— 页面内提示（不承载任何秘密信息）————

  function ensureLiveRegion() {
    let region = document.getElementById('mda-fill-live');
    if (!region) {
      region = document.createElement('div');
      region.id = 'mda-fill-live';
      region.setAttribute('aria-live', 'polite');
      region.setAttribute('role', 'status');
      Object.assign(region.style, { position: 'fixed', left: '-9999px', top: '0', width: '1px', height: '1px', overflow: 'hidden' });
      document.documentElement.appendChild(region);
    }
    return region;
  }

  function flashNote(text) {
    ensureLiveRegion().textContent = text;
    const note = document.createElement('div');
    note.textContent = text;
    note.setAttribute('role', 'status');
    Object.assign(note.style, {
      position: 'fixed', bottom: '16px', right: '16px', zIndex: '2147483647',
      background: '#1f2937', color: '#f9fafb', padding: '10px 14px',
      borderRadius: '8px', font: '13px/1.5 system-ui, sans-serif',
      maxWidth: '320px', boxShadow: '0 2px 10px rgba(0,0,0,.25)',
    });
    document.documentElement.appendChild(note);
    setTimeout(() => note.remove(), 6000);
  }

  // ———— 确认面板（confirmRequired 时）————

  function showConfirmPanel(onConfirm, onCancel) {
    const overlay = document.createElement('div');
    overlay.setAttribute('role', 'alertdialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'mda-fill-panel-title');
    overlay.setAttribute('aria-describedby', 'mda-fill-panel-desc');
    Object.assign(overlay.style, {
      position: 'fixed', inset: '0', zIndex: '2147483647',
      background: 'rgba(15,23,42,.45)', display: 'flex',
      alignItems: 'center', justifyContent: 'center',
    });

    const panel = document.createElement('div');
    Object.assign(panel.style, {
      background: '#ffffff', color: '#111827', borderRadius: '10px',
      padding: '20px 22px', width: 'min(380px, 90vw)',
      font: '14px/1.6 system-ui, "Microsoft YaHei", sans-serif',
      boxShadow: '0 8px 30px rgba(0,0,0,.25)',
    });

    const title = document.createElement('div');
    title.id = 'mda-fill-panel-title';
    title.textContent = '蒙电信产助手 · 填充确认';
    Object.assign(title.style, { fontWeight: '600', fontSize: '15px', marginBottom: '8px' });

    const desc = document.createElement('div');
    desc.id = 'mda-fill-panel-desc';
    // 只展示 Origin，不展示用户名/口令
    desc.textContent = `即将把你在桌面应用绑定的账号填入当前站点：\n${location.origin}\n填充后不会自动提交。按 Esc 可取消。`;
    Object.assign(desc.style, { whiteSpace: 'pre-line', marginBottom: '16px' });

    const btnRow = document.createElement('div');
    Object.assign(btnRow.style, { display: 'flex', gap: '10px', justifyContent: 'flex-end' });

    const mkBtn = (text, primary) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = text;
      Object.assign(b.style, {
        padding: '7px 16px', borderRadius: '6px', cursor: 'pointer', font: 'inherit',
        border: primary ? '1px solid #2563eb' : '1px solid #9ca3af',
        background: primary ? '#2563eb' : '#ffffff',
        color: primary ? '#ffffff' : '#111827',
      });
      return b;
    };
    const cancelBtn = mkBtn('取消', false);
    const okBtn = mkBtn('确认填充', true);
    btnRow.append(cancelBtn, okBtn);
    panel.append(title, desc, btnRow);
    overlay.append(panel);
    document.documentElement.appendChild(overlay);

    const live = ensureLiveRegion();
    live.textContent = '蒙电信产助手请求确认：按 Tab 选择按钮，按 Enter 确认，按 Esc 取消。';

    const close = (confirmed) => {
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      if (confirmed) onConfirm();
      else onCancel();
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close(false);
      }
    };
    document.addEventListener('keydown', onKey, true);
    cancelBtn.addEventListener('click', () => close(false));
    okBtn.addEventListener('click', () => close(true));
    // 默认焦点给「取消」：回车误触最多导致不填充，不会导致填充。
    cancelBtn.focus();
  }

  // ———— 主流程 ————

  async function doFill() {
    const g = grant;
    if (!g) return;
    grant = null; // 票据一次性，无论成败都不再复用

    // 先等输入框出现，再去兑换凭据：缩短秘密在内存中的存活时间，
    // 也避免页面上根本没有表单时白白消费掉一次性票据。
    const fields = await waitForFields();
    if (!fields) {
      flashNote('蒙电信产助手：页面上未找到登录输入框，本次未填充。');
      return;
    }
    const resp = await send({
      kind: 'fill',
      request: {
        ticketId: g.ticketId,
        ticketSecret: g.ticketSecret,
        targetId: g.targetId,
        credentialId: g.credentialId,
        origin: location.origin, // 以真实页面 Origin 上报，与票据绑定不符由桌面端拒绝
      },
    });
    if (!resp || resp.ok !== true) return; // TICKET_INVALID 等：静默，不重试

    await fillInto(fields, resp.username, resp.password);
    // 用后立即清掉对秘密的本地引用
    resp.username = undefined;
    resp.password = undefined;
    g.ticketSecret = undefined;
  }

  async function startCheck() {
    if (grant) return; // 已有进行中的流程
    if (location.protocol !== 'https:' && location.protocol !== 'http:') return;
    const resp = await send({ kind: 'challenge', origin: location.origin });
    if (!resp || resp.ok !== true || !resp.grant) return; // NO_PENDING_GRANT 等：完全静默
    grant = resp.grant;
    if (Date.now() / 1000 > Number(grant.expiresAt || 0)) {
      grant = null;
      return;
    }
    if (grant.confirmRequired) {
      showConfirmPanel(
        () => doFill(),
        () => {
          grant = null; // 取消即丢弃票据
          ensureLiveRegion().textContent = '已取消填充。';
        },
      );
    } else {
      await doFill();
    }
  }

  // popup / 后台可在扩展加载后（或注入 content.js 后）主动触发一次检测。
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.v === PROTOCOL) {
      if (msg.kind === 'mda-ping') {
        sendResponse({ pong: true });
        return false;
      }
      if (msg.kind === 'mda-check-now') {
        startCheck().finally(() => sendResponse({ ok: true }));
        return true;
      }
    }
    return false;
  });

  startCheck();
})();
