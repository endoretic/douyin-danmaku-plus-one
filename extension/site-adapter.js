(() => {
  "use strict";

  const DOM_ITEMS = "[data-danmu-id], xg-danmu div";
  const LIVE_CANVAS = ".CanvasDanmakuPlugin, [class*='CanvasDanmakuPlugin']";
  const LIVE_EDITOR = ".zone-container[contenteditable='true'], [data-slate-editor='true'][contenteditable='true']";
  const LIVE_SEND = ".webcast-chatroom___send-btn, [data-e2e='chat-send-btn']";
  const INTERACTIVE = "button, a, input, textarea, select, [role='button'], [role='dialog'], [contenteditable='true']";
  const EXCLUDED_TEXT = "script, style, svg, button, [role='button'], [aria-hidden='true'], .webcast-chatroom___nickname, .webcast-chatroom___badge";

  function isElement(node) {
    return node?.nodeType === 1;
  }

  function containsPoint(rect, x, y) {
    return rect.width > 0 && rect.height > 0 && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
  }

  function isVisible(element, x, y) {
    if (!isElement(element) || !element.isConnected) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0 || rect.right <= 0 || rect.bottom <= 0 || rect.left >= innerWidth || rect.top >= innerHeight) return false;
    const checkPoint = Number.isFinite(x) && Number.isFinite(y);
    if (checkPoint && !containsPoint(rect, x, y)) return false;
    for (let node = element; isElement(node); node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || Number(style.opacity) === 0) return false;
      if (checkPoint && node !== element) {
        const bounds = node.getBoundingClientRect();
        if (/(hidden|clip|auto|scroll)/.test(style.overflowX) && (x < bounds.left || x > bounds.right)) return false;
        if (/(hidden|clip|auto|scroll)/.test(style.overflowY) && (y < bounds.top || y > bounds.bottom)) return false;
      }
    }
    return true;
  }

  // Read only visible message text. Image alt text retains native emoji names.
  function readText(node, editor = false) {
    if (node?.nodeType === 3) return node.nodeValue || "";
    if (!isElement(node)) return "";
    if (!editor && node.matches(EXCLUDED_TEXT)) return "";
    if (node.tagName === "IMG") return node.getAttribute("alt") || "";
    if (node.tagName === "BR") return "\n";
    if (!editor) {
      const style = getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden") return "";
    }
    return Array.from(node.childNodes, child => readText(child, editor)).join("");
  }

  function playerFor(element) {
    if (!isElement(element)) return null;
    let node = element;
    for (let depth = 0; node && depth < 14; depth++, node = node.parentElement) {
      if (node === document.body || node === document.documentElement) break;
      if (node.querySelector("video")) return node;
    }
    return null;
  }

  function isLivePlayer(player) {
    return Boolean(player && (
      location.hostname === "live.douyin.com" ||
      /\/live(?:\/|$)/.test(location.pathname) ||
      player.matches(LIVE_CANVAS) || player.querySelector(LIVE_CANVAS)
    ));
  }

  function findDomHit(x, y) {
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > innerWidth || y > innerHeight) return null;
    const top = document.elementFromPoint(x, y);
    if (!top) return null;
    let best = null;
    let bestArea = Infinity;
    for (const element of document.querySelectorAll(DOM_ITEMS)) {
      if (!isVisible(element, x, y)) continue;
      // A wrapper containing separate danmaku items is not itself a message.
      if (element.querySelector("[data-danmu-id]")) continue;
      if (!element.hasAttribute("data-danmu-id") && Array.from(element.querySelectorAll("div")).some(child => isVisible(child, x, y) && readText(child).trim())) continue;
      const player = playerFor(element);
      if (!player || (!player.contains(top) && top !== player)) continue;
      const control = top.closest(INTERACTIVE);
      if (control && control !== player && player.contains(control)) continue;
      const text = readText(element).replace(/\u200B/g, "").trim();
      if (!text || text.length > 500) continue;
      const rect = element.getBoundingClientRect();
      const area = rect.width * rect.height;
      if (area < bestArea) {
        best = { text, element, rect };
        bestArea = area;
      }
    }
    return best;
  }

  function uniqueVisible(scope, selector) {
    const elements = Array.from(scope.querySelectorAll(selector)).filter(element => isVisible(element));
    // A matched child of a matched button is the same native control.
    const outermost = elements.filter(element => !elements.some(other => other !== element && other.contains(element)));
    return outermost.length === 1 ? outermost[0] : null;
  }

  function findLiveComposer(player) {
    const scopes = Array.from(document.querySelectorAll("#chatInput")).filter(scope => isVisible(scope));
    if (scopes.length !== 1) return null;
    const scope = scopes[0];
    // The player and editor must belong to a shared page section, not two frames
    // or unrelated document roots. Body alone is not sufficient evidence.
    let common = player;
    let depth = 0;
    while (common && common !== document.body && depth++ < 14 && !common.contains(scope)) common = common.parentElement;
    if (!common || common === document.body || common === document.documentElement || !common.contains(scope)) return null;
    const editor = uniqueVisible(scope, LIVE_EDITOR);
    const send = uniqueVisible(scope, LIVE_SEND);
    if (!editor || !send) return null;
    return { editor, send, scope };
  }

  function hasDanmakuMeaning(editor) {
    const labels = ["placeholder", "data-placeholder", "aria-label", "data-e2e"].map(name => editor.getAttribute(name) || "").join(" ");
    return /弹幕|danmaku|danmu/i.test(labels);
  }

  function findVideoComposer(player) {
    const editors = Array.from(player.querySelectorAll("input:not([type]), input[type='text'], textarea, [contenteditable='true']"))
      .filter(editor => isVisible(editor) && hasDanmakuMeaning(editor));
    if (editors.length !== 1) return null;
    const editor = editors[0];
    let scope = editor.parentElement;
    for (let depth = 0; scope && scope !== player && depth < 4; depth++, scope = scope.parentElement) {
      if (scope.querySelectorAll("input, textarea, [contenteditable='true']").length !== 1) return null;
      const sends = Array.from(scope.querySelectorAll("button, [role='button'], [data-e2e*='danmaku-send'], [data-e2e*='danmu-send']"))
        .filter(send => isVisible(send) && (/^(发送|发射|发送弹幕)$/.test((send.textContent || "").trim()) || /发送弹幕|danmaku-send|danmu-send/i.test([send.getAttribute("aria-label"), send.getAttribute("data-e2e")].join(" "))));
      const outermost = sends.filter(send => !sends.some(other => other !== send && other.contains(send)));
      if (outermost.length === 1) return { editor, send: outermost[0], scope };
      if (outermost.length > 1) return null;
    }
    return null;
  }

  function findComposer(player) {
    if (!isElement(player) || !isVisible(player)) return null;
    return isLivePlayer(player) ? findLiveComposer(player) : findVideoComposer(player);
  }

  function readEditor(editor) {
    if (!isElement(editor)) return "";
    if (editor.tagName === "INPUT" || editor.tagName === "TEXTAREA") return editor.value;
    // EditorKit uses U+200B for the empty trailing leaf. Do not remove ZWJ,
    // variation selectors, or other characters belonging to emoji/text.
    return readText(editor, true).replace(/\u200B/g, "");
  }

  function writeEditor(editor, text) {
    if (!isElement(editor) || !editor.isConnected || typeof text !== "string" || !text || editor.disabled || editor.readOnly || editor.getAttribute("aria-disabled") === "true") return false;
    const plain = editor.tagName === "INPUT" || editor.tagName === "TEXTAREA";
    if (!plain && editor.getAttribute("contenteditable") !== "true") return false;
    if (plain && editor.maxLength >= 0 && text.length > editor.maxLength) return false;
    editor.focus({ preventScroll: true });
    if (!plain) {
      const selection = window.getSelection();
      if (!selection) return false;
      const range = document.createRange();
      range.selectNodeContents(editor);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    const before = new InputEvent("beforeinput", { bubbles: true, composed: true, cancelable: true, inputType: "insertText", data: text });
    // Some editors implement insertion themselves and cancel the browser action.
    if (!editor.dispatchEvent(before)) return readEditor(editor) === text;
    if (plain) {
      const prototype = editor.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, "value").set.call(editor, text);
      editor.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: text }));
    } else {
      // Native editing keeps EditorKit/Slate's DOM model and undo history in
      // sync. Direct innerHTML/textContent replacement can break that model.
      let inserted = false;
      let sawInput = false;
      const observeInput = () => { sawInput = true; };
      editor.addEventListener("input", observeInput, { capture: true });
      try {
        inserted = document.execCommand("insertText", false, text);
      } catch (_) {
        inserted = false;
      } finally {
        editor.removeEventListener("input", observeInput, { capture: true });
      }
      if (!inserted && readEditor(editor) !== text) return false;
      if (!sawInput) editor.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: text }));
    }
    return readEditor(editor) === text;
  }

  function getContextKey(player) {
    const pageKey = location.origin + location.pathname + location.search;
    if (isLivePlayer(player)) return pageKey;
    const video = player?.querySelector("video");
    const videoId = player?.getAttribute("data-aweme-id") || player?.getAttribute("data-id") || "";
    return `${pageKey}|${videoId}|${video?.currentSrc || video?.getAttribute("src") || ""}`;
  }

  globalThis.DouyinPlusOneAdapter = Object.freeze({ findDomHit, playerFor, findComposer, readEditor, writeEditor, getContextKey });
})();
