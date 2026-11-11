(() => {
  "use strict";
  const adapter = globalThis.DouyinPlusOneAdapter;
  if (!adapter || document.querySelector("[data-dy-plus-one-ui]")) return;
  let enabled = true;
  let selected = null;
  let pendingPress = null;
  let requestNumber = 0;
  let pendingRequest = null;
  let submitting = false;
  let lastSubmit = 0;
  let contextTimer;
  let hideTimer;
  let bridgeStatus = null;
  let statusRequestId = 0;

  const host = document.createElement("div");
  host.setAttribute("data-dy-plus-one-ui", "");
  host.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483647;";
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `
    <style>
      :host{all:initial}*{box-sizing:border-box}.panel{position:fixed;pointer-events:auto;width:290px;max-width:calc(100vw - 24px);padding:15px;background:#1c1d26;color:#f5f6fa;border:1px solid #444653;border-radius:14px;box-shadow:0 10px 40px #0008;font:13px/1.5 system-ui,-apple-system,"Microsoft YaHei",sans-serif}.panel[hidden]{display:none}.heading{display:flex;align-items:center;justify-content:space-between;color:#aeb1c2;font-size:11px;letter-spacing:.05em}.close{border:0;background:none;color:#bfc1cc;font-size:20px;cursor:pointer;padding:0 4px}.quote{margin:10px 0 14px;white-space:pre-wrap;overflow-wrap:anywhere;max-height:108px;overflow:auto;font-size:15px;color:#fff}.send{width:100%;border:0;border-radius:9px;padding:10px;background:#fe2c55;color:white;font:600 14px system-ui;cursor:pointer}.send:hover{background:#ff466c}.send:disabled{background:#4b4e5c;color:#c8cbd5;cursor:default}.status{margin:10px 0 0;color:#c6c9d6;font-size:12px;overflow-wrap:anywhere}.status:empty{display:none}button:focus-visible{outline:2px solid #69e5df;outline-offset:3px}
    </style>
    <style>.badge{position:fixed;left:16px;bottom:16px;padding:5px 10px;border:1px solid #555865;border-radius:20px;background:#1c1d26e6;color:#c6c9d6;font:12px/1.5 system-ui;pointer-events:none}.badge[data-ready='true']{color:#75e5c2}.badge[hidden]{display:none}</style>
    <span class="badge" role="status">+1 等待弹幕</span>
    <section class="panel" role="dialog" aria-label="弹幕加一" hidden>
      <div class="heading"><span>发送相同弹幕</span><button class="close" aria-label="关闭">×</button></div>
      <p class="quote"></p><button class="send">+1 发送</button><p class="status" role="status" aria-live="polite"></p>
    </section>`;
  const panel = shadow.querySelector(".panel");
  const quote = shadow.querySelector(".quote");
  const sendButton = shadow.querySelector(".send");
  const status = shadow.querySelector(".status");
  const badge = shadow.querySelector(".badge");
  const attachHost = () => (document.fullscreenElement || document.documentElement).append(host);
  attachHost();

  document.addEventListener("dy-plus-one:status-result", event => {
    try {
      const result = JSON.parse(event.detail);
      if (result.id === `status-${statusRequestId}`) bridgeStatus = result;
    } catch { /* Ignore malformed page events. */ }
  });
  function getStatus() {
    bridgeStatus = null;
    document.dispatchEvent(new CustomEvent("dy-plus-one:status-request", { detail: JSON.stringify({ id: `status-${++statusRequestId}` }) }));
    const domCount = document.querySelectorAll("[data-danmu-id],xg-danmu div").length;
    return { version: "0.1.1", enabled, bridge: bridgeStatus, domCount };
  }
  function updateBadge() {
    const info = getStatus();
    const ready = Boolean(info.bridge?.records || info.domCount);
    badge.hidden = !enabled;
    badge.dataset.ready = String(ready);
    badge.textContent = ready ? "+1 已就绪" : info.bridge ? "+1 等待弹幕" : "+1 请刷新页面";
    return info;
  }
  updateBadge();
  setInterval(() => { if (!document.hidden) updateBadge(); }, 3000);
  globalThis.chrome?.runtime?.onMessage?.addListener((request, _sender, respond) => {
    if (request?.type === "dy-plus-one:status") respond(updateBadge());
  });

  function close() {
    panel.hidden = true;
    selected = null;
    clearInterval(contextTimer);
    clearTimeout(hideTimer);
  }
  function message(text) { status.textContent = text; }
  function sameContext(selection) {
    return Boolean(selection && selection.player.isConnected &&
      selection.key === adapter.getContextKey(selection.player) &&
      selection.video === selection.player.querySelector("video"));
  }
  function show(hit, x, y) {
    const player = adapter.playerFor(hit.element);
    if (!player || !hit.text || hit.text.length > 500) return;
    close();
    selected = { text: hit.text, player, key: adapter.getContextKey(player), video: player.querySelector("video") };
    quote.textContent = hit.text;
    status.textContent = "";
    sendButton.disabled = submitting;
    sendButton.textContent = "+1 发送";
    panel.hidden = false;
    panel.style.left = `${Math.max(12, Math.min(x + 12, innerWidth - panel.offsetWidth - 12))}px`;
    panel.style.top = `${Math.max(12, Math.min(y + 12, innerHeight - panel.offsetHeight - 12))}px`;
    contextTimer = setInterval(() => { if (!sameContext(selected)) close(); }, 250);
    sendButton.focus({ preventScroll: true });
  }

  document.addEventListener("dy-plus-one:hit-result", event => {
    if (!pendingRequest || typeof event.detail !== "string") return;
    try {
      const result = JSON.parse(event.detail);
      if (result.id === pendingRequest.id) pendingRequest.result = result;
    } catch { /* Page events are untrusted. */ }
  });

  function canvasHit(x, y) {
    const request = { id: `hit-${++requestNumber}`, result: null };
    pendingRequest = request;
    document.dispatchEvent(new CustomEvent("dy-plus-one:hit-request", { detail: JSON.stringify({ id: request.id, x, y }) }));
    pendingRequest = null;
    const hit = request.result;
    if (!hit || typeof hit.text !== "string" || !hit.text.trim() || hit.text.length > 500 || typeof hit.canvasId !== "string") return null;
    const element = [...document.querySelectorAll("canvas[data-dy-plus-one-canvas]")]
      .find(canvas => canvas.getAttribute("data-dy-plus-one-canvas") === hit.canvasId);
    if (!element || !element.closest(".CanvasDanmakuPlugin,xg-danmu,[data-e2e='danmaku-container']")) return null;
    const rect = element.getBoundingClientRect();
    if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return null;
    return { text: hit.text, element, rect: hit.rect };
  }

  function hitAt(event) {
    if (event.composedPath().includes(host)) return null;
    const hit = canvasHit(event.clientX, event.clientY) || adapter.findDomHit(event.clientX, event.clientY);
    if (!hit) return null;
    const player = adapter.playerFor(hit.element);
    // Ignore matching text behind an unrelated modal or page panel.
    if (!player || !player.contains(event.target)) return null;
    const control = event.target.closest?.("button,a,input,textarea,[contenteditable='true'],[role='button'],[role='dialog']");
    if (control && control !== player && player.contains(control)) return null;
    return hit;
  }
  function stop(event) { event.preventDefault(); event.stopImmediatePropagation(); }

  window.addEventListener("pointerdown", event => {
    if (!enabled || !event.isTrusted || event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.composedPath().includes(host)) return;
    const hit = hitAt(event);
    if (!hit) { close(); pendingPress = null; return; }
    const player = adapter.playerFor(hit.element);
    pendingPress = { hit, player, key: adapter.getContextKey(player), video: player.querySelector("video"), x: event.clientX, y: event.clientY, time: performance.now(), pointerId: event.pointerId };
    stop(event);
  }, true);
  window.addEventListener("pointerup", event => {
    if (!pendingPress || event.pointerId !== pendingPress.pointerId) return;
    if (performance.now() - pendingPress.time > 1000 || Math.hypot(event.clientX - pendingPress.x, event.clientY - pendingPress.y) > 12) {
      pendingPress = null;
      return;
    }
    stop(event);
  }, true);
  window.addEventListener("pointercancel", () => { pendingPress = null; }, true);
  window.addEventListener("click", event => {
    if (!event.isTrusted || !pendingPress || event.composedPath().includes(host)) return;
    const press = pendingPress;
    pendingPress = null;
    if (!enabled || performance.now() - press.time > 1100 || !sameContext(press)) return;
    stop(event);
    show(press.hit, press.x, press.y);
  }, true);
  window.addEventListener("keydown", event => {
    if (event.key === "Escape" && !panel.hidden) { stop(event); close(); }
  }, true);
  window.addEventListener("resize", close);
  window.addEventListener("popstate", close);
  document.addEventListener("fullscreenchange", () => { close(); attachHost(); });
  shadow.querySelector(".close").addEventListener("click", close);

  function unavailable(button) {
    return !button || !button.isConnected || button.hasAttribute("disabled") ||
      button.getAttribute("aria-disabled") === "true" || button.classList.contains("disable") ||
      button.classList.contains("disabled");
  }
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  sendButton.addEventListener("click", async event => {
    if (!event.isTrusted || !enabled || submitting || !selected) return;
    const selection = selected;
    if (!sameContext(selection)) { close(); return; }
    if (Date.now() - lastSubmit < 1500) { message("稍等一下再发送下一条。"); return; }
    const composer = adapter.findComposer(selection.player);
    if (!composer) { message("未找到弹幕发送框。请先登录、开启弹幕，或退出全屏后重试。"); return; }
    if (adapter.readEditor(composer.editor).trim()) { message("输入框里已有草稿，请先发送或清空后再 +1。"); return; }
    if (composer.editor.matches(":disabled,[aria-disabled='true'],[readonly]")) { message("当前不能发言，请查看抖音提示。"); return; }
    const maxLength = Number(composer.editor.getAttribute("maxlength"));
    if (maxLength > 0 && selection.text.length > maxLength) { message("这条弹幕超过输入框字数限制，未发送。"); return; }
    submitting = true;
    sendButton.disabled = true;
    message("正在填入弹幕…");
    try {
      if (!adapter.writeEditor(composer.editor, selection.text)) {
        message("未能填入弹幕，请在原聊天框中检查。");
        return;
      }
      // Let React/Slate update the native send control. Never submit with both click and Enter.
      for (let i = 0; i < 12; i++) {
        await wait(50);
        if (!enabled || selected !== selection || !sameContext(selection)) return;
        const current = adapter.findComposer(selection.player);
        if (!current || current.editor !== composer.editor || current.scope !== composer.scope) {
          message("聊天框已变化，请在原聊天框中检查，未点击发送。");
          return;
        }
        if (adapter.readEditor(current.editor) !== selection.text) {
          message("输入内容已变化，未点击发送。请在原聊天框中检查。");
          return;
        }
        if (unavailable(current.send)) continue;
        lastSubmit = Date.now();
        if (typeof current.send.click === "function") current.send.click();
        else current.send.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
        message("已点击发送，请留意抖音的发送结果。");
        sendButton.textContent = "已提交";
        hideTimer = setTimeout(close, 3000);
        return;
      }
      message("已填入聊天框，但发送按钮不可用。请检查登录状态或发言限制，再手动发送。");
    } catch {
      message("操作未完成，请检查原聊天框；不会自动重发。");
    } finally {
      submitting = false;
      // One selection is used at most once, even if the website rejects it.
      sendButton.disabled = selected === selection;
    }
  });

  if (globalThis.chrome?.storage?.local) {
    chrome.storage.local.get({ enabled: true }).then(settings => { enabled = settings.enabled !== false; if (!enabled) close(); updateBadge(); }).catch(() => {});
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes.enabled) {
        enabled = changes.enabled.newValue !== false;
        if (!enabled) { close(); pendingPress = null; }
        updateBadge();
      }
    });
  }
})();
