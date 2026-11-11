const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../extension/site-adapter.js'), 'utf8');

// Small DOM stand-ins exercise composer isolation and editor side effects.
// The real-browser fixture covers browser selection/editing behavior.
function harness() {
  class Element {
    constructor(tag, attrs = {}) {
      this.nodeType = 1;
      this.tagName = tag.toUpperCase();
      this.attrs = attrs;
      this.childNodes = [];
      this.parentElement = null;
      this.isConnected = true;
      this.listeners = new Map();
      this.events = [];
      this.style = { display: 'block', visibility: 'visible', opacity: '1', overflowX: 'visible', overflowY: 'visible' };
    }
    append(...nodes) { for (const node of nodes) { this.childNodes.push(node); node.parentElement = this; } return this; }
    getAttribute(key) { return this.attrs[key] ?? null; }
    hasAttribute(key) { return key in this.attrs; }
    matches(selectors) {
      return selectors.split(',').some(selector => {
        const sel = selector.trim();
        const tag = sel.match(/^[a-z][\w-]*/i)?.[0];
        if (tag && this.tagName !== tag.toUpperCase()) return false;
        for (const match of sel.matchAll(/\.([\w-]+)/g)) if (!(this.attrs.class || '').split(' ').includes(match[1])) return false;
        for (const match of sel.matchAll(/#([\w-]+)/g)) if (this.attrs.id !== match[1]) return false;
        for (const match of sel.matchAll(/\[([\w-]+)(\*?=)?['"]?([^'"\]]*)['"]?\]/g)) {
          if (!this.hasAttribute(match[1])) return false;
          if (match[2] === '=' && this.getAttribute(match[1]) !== match[3]) return false;
          if (match[2] === '*=' && !this.getAttribute(match[1]).includes(match[3])) return false;
        }
        return true;
      });
    }
    querySelectorAll(selector) { return this.childNodes.filter(n => n.nodeType === 1).flatMap(n => [...(n.matches(selector) ? [n] : []), ...n.querySelectorAll(selector)]); }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    contains(other) { return this === other || this.childNodes.some(n => n.nodeType === 1 && n.contains(other)); }
    getBoundingClientRect() { return { left: 10, top: 10, right: 110, bottom: 70, width: 100, height: 60 }; }
    focus() { selectedEditor = this; }
    addEventListener(type, handler) { const listeners = this.listeners.get(type) || new Set(); listeners.add(handler); this.listeners.set(type, listeners); }
    removeEventListener(type, handler) { this.listeners.get(type)?.delete(handler); }
    dispatchEvent(event) { this.events.push(event.type); for (const listener of this.listeners.get(event.type) || []) listener(event); return !event.defaultPrevented; }
  }
  class Input extends Element { constructor() { super('input'); this.maxLength = -1; } get value() { return this._value || ''; } set value(value) { this._value = value; } }
  class Textarea extends Input {}
  class InputEvent {
    constructor(type, options) { Object.assign(this, options); this.type = type; this.defaultPrevented = false; }
    preventDefault() { this.defaultPrevented = true; }
  }
  const text = value => ({ nodeType: 3, nodeValue: value });
  const setText = (element, value) => { element.childNodes = [text(value)]; };
  const html = new Element('html');
  const body = new Element('body');
  html.append(body);
  let selectedEditor;
  const document = {
    body, documentElement: html,
    querySelectorAll: selector => html.querySelectorAll(selector),
    createRange: () => ({ selectNodeContents(element) { selectedEditor = element; } }),
    execCommand(_command, _ui, value) { setText(selectedEditor, value); selectedEditor.dispatchEvent(new InputEvent('input', {})); return true; }
  };
  const location = { hostname: 'www.douyin.com', origin: 'https://www.douyin.com', pathname: '/follow/live/123', search: '' };
  const sandbox = { document, location, innerWidth: 1000, innerHeight: 800, getComputedStyle: element => element.style,
    HTMLInputElement: Input, HTMLTextAreaElement: Textarea, InputEvent,
    window: { getSelection: () => ({ removeAllRanges() {}, addRange() {} }) } };
  vm.runInNewContext(source, sandbox);
  function liveFixture() {
    const section = new Element('section');
    const player = new Element('div');
    const video = new Element('video');
    const plugin = new Element('div', { class: 'CanvasDanmakuPlugin' });
    const canvas = new Element('canvas');
    plugin.append(canvas); player.append(video, plugin);
    const scope = new Element('div', { id: 'chatInput' });
    const editor = new Element('div', { class: 'zone-container editor-kit-container', contenteditable: 'true', 'data-slate-editor': 'true' });
    editor.append(text('\u200B'));
    const send = new Element('svg', { class: 'webcast-chatroom___send-btn disable', disabled: '' });
    scope.append(editor, send); section.append(player, scope); body.append(section);
    return { section, player, video, canvas, scope, editor, send };
  }
  return { api: sandbox.DouyinPlusOneAdapter, Element, Input, InputEvent, text, setText, body, document, location, liveFixture };
}

test('pairs a live player with its sibling chat editor and disabled SVG send control', () => {
  const h = harness(); const f = h.liveFixture();
  assert.equal(h.api.playerFor(f.canvas), f.player);
  const composer = h.api.findComposer(f.player);
  assert.equal(composer.editor, f.editor);
  assert.equal(composer.send, f.send);
  assert.equal(composer.scope, f.scope);
});

test('refuses ambiguous or unrelated chat composers', () => {
  const h = harness(); const f = h.liveFixture();
  const duplicate = new h.Element('div', { id: 'chatInput' });
  f.section.append(duplicate);
  assert.equal(h.api.findComposer(f.player), null);
  duplicate.style.display = 'none';
  assert.ok(h.api.findComposer(f.player));
  f.section.childNodes = [f.player]; h.body.append(f.scope);
  assert.equal(h.api.findComposer(f.player), null);
});

test('stops at the bounded ancestor search without accepting an unrelated composer', () => {
  const h = harness(); const f = h.liveFixture();
  f.section.childNodes = [f.scope];
  let wrapper = f.player;
  for (let i = 0; i < 16; i++) wrapper = new h.Element('div').append(wrapper);
  f.section.append(wrapper);
  assert.equal(h.api.findComposer(f.player), null);
});

test('empty editor markers disappear while emoji ZWJ and image alt text survive', () => {
  const h = harness(); const f = h.liveFixture();
  assert.equal(h.api.readEditor(f.editor), '');
  f.editor.childNodes = [h.text('👩‍💻\u200B'), new h.Element('img', { alt: '[比心]' })];
  assert.equal(h.api.readEditor(f.editor), '👩‍💻[比心]');
});

test('native input setter bypasses an instance tracker and emits no submit event', () => {
  const h = harness(); const input = new h.Input();
  Object.defineProperty(input, 'value', { get() { return this._value || ''; }, set() { throw Error('instance tracker'); } });
  assert.equal(h.api.writeEditor(input, '同一句弹幕'), true);
  assert.equal(input.value, '同一句弹幕');
  assert.deepEqual(input.events, ['beforeinput', 'input']);
});

test('contenteditable insertion does not duplicate the native input event or submit', () => {
  const h = harness(); const f = h.liveFixture();
  assert.equal(h.api.writeEditor(f.editor, '👩‍💻配合很好'), true);
  assert.deepEqual(f.editor.events, ['beforeinput', 'input']);
  assert.deepEqual(f.send.events, []);
});

test('a canceled beforeinput or unsupported native edit does not replace editor DOM', () => {
  const h = harness(); const f = h.liveFixture();
  const cancel = event => event.preventDefault();
  f.editor.addEventListener('beforeinput', cancel);
  assert.equal(h.api.writeEditor(f.editor, '不要发送'), false);
  assert.equal(h.api.readEditor(f.editor), '');
  f.editor.removeEventListener('beforeinput', cancel);
  h.document.execCommand = () => false;
  assert.equal(h.api.writeEditor(f.editor, '不要发送'), false);
  assert.equal(h.api.readEditor(f.editor), '');
  assert.deepEqual(f.send.events, []);
});

test('live identity follows room navigation and ignores rotating blob media URLs', () => {
  const h = harness(); const f = h.liveFixture();
  f.video.currentSrc = 'blob:one';
  const key = h.api.getContextKey(f.player);
  f.video.currentSrc = 'blob:two';
  assert.equal(h.api.getContextKey(f.player), key);
  h.location.pathname = '/follow/live/456';
  assert.notEqual(h.api.getContextKey(f.player), key);
});
