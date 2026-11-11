const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const bridge = fs.readFileSync(path.join(__dirname, '../extension/canvas-bridge.js'), 'utf8');

// A small Canvas contract fixture: no DOM library and no browser/profile access.
// Native drawing is represented by calls; only the bridge's observable hit results
// are asserted. Each test gets fresh prototypes, just like a fresh page document.
function fixture() {
  class Context {
    constructor(canvas) {
      this.canvas = canvas;
      this.font = '20px sans-serif';
      this.globalAlpha = 1;
      this.globalCompositeOperation = 'source-over';
      this.transform = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
    }
    getTransform() { return this.transform; }
    measureText(text) {
      return {
        width: text.length * 10, actualBoundingBoxLeft: 0,
        actualBoundingBoxRight: text.length * 10,
        actualBoundingBoxAscent: 15, actualBoundingBoxDescent: 5,
      };
    }
    fillText(text) {
      if (text === 'THROW') throw new TypeError('native drawing failure');
      return 'native return value';
    }
    strokeText() {}
    drawImage() {}
    clearRect() {}
    fillRect() {}
    strokeRect() {}
    fill() {}
    stroke() {}
    putImageData() {}
    reset() {}
  }
  class Canvas {
    constructor(width = 400, height = 200) {
      this._width = width;
      this._height = height;
      this.offsetWidth = width * 2;
      this.offsetHeight = height * 2;
      this.attributes = new Map();
      this.style = { display: 'block', visibility: 'visible', opacity: '1' };
      this.context = new Context(this);
    }
    get width() { return this._width; }
    set width(value) { this._width = value; }
    get height() { return this._height; }
    set height(value) { this._height = value; }
    getBoundingClientRect() {
      return {
        left: 100, top: 50, right: 100 + this.offsetWidth, bottom: 50 + this.offsetHeight,
        width: this.offsetWidth, height: this.offsetHeight,
      };
    }
    getAttribute(name) { return this.attributes.get(name) || null; }
    setAttribute(name, value) { this.attributes.set(name, value); }
    matches(selector) {
      assert.equal(selector, '.CanvasDanmakuPlugin canvas, xg-danmu canvas, [data-e2e="danmaku-container"] canvas');
      return canvases.includes(this);
    }
    transferControlToOffscreen() {
      if (!(this instanceof Canvas) || this.transferred) throw new TypeError('native canvas transfer failure');
      this.transferred = true;
      return new Offscreen(this.width, this.height);
    }
  }
  class Bitmap {
    constructor(width, height) { this.width = width; this.height = height; }
    close() { this.width = 0; this.height = 0; }
  }
  class Offscreen extends Canvas {
    transferToImageBitmap() { return new Bitmap(this.width, this.height); }
  }
  const canvases = [];
  const listeners = new Map();
  let response;
  let statusResponse;
  let nativeBitmapPromise;
  let rejectBitmap = false;
  const document = {
    querySelectorAll(selector) {
      assert.equal(selector, '.CanvasDanmakuPlugin canvas, xg-danmu canvas, [data-e2e="danmaku-container"] canvas');
      return canvases;
    },
    addEventListener(name, listener) { listeners.set(name, listener); },
    dispatchEvent(event) {
      if (event.type === 'dy-plus-one:hit-result') response = JSON.parse(event.detail);
      else if (event.type === 'dy-plus-one:status-result') statusResponse = JSON.parse(event.detail);
      else listeners.get(event.type)?.(event);
    },
  };
  const sandbox = {
    CanvasRenderingContext2D: Context, HTMLCanvasElement: Canvas,
    OffscreenCanvas: Offscreen, ImageBitmap: Bitmap, document,
    performance: { now: () => 0 },
    getComputedStyle: canvas => canvas.style,
    CustomEvent: class {
      constructor(type, { detail }) { this.type = type; this.detail = detail; }
    },
    createImageBitmap(...args) {
      const source = args[0];
      const cropped = args.length >= 5;
      const options = (cropped ? args[5] : args[1]) || {};
      const width = options.resizeWidth || Math.abs(cropped ? args[3] : source.width);
      const height = options.resizeHeight || Math.abs(cropped ? args[4] : source.height);
      nativeBitmapPromise = rejectBitmap
        ? Promise.reject(new TypeError('native bitmap failure'))
        : Promise.resolve(new Bitmap(width, height));
      return nativeBitmapPromise;
    },
  };
  vm.runInNewContext(bridge, sandbox);
  const visible = new Canvas();
  canvases.push(visible);
  return {
    sandbox, visible, Canvas, Offscreen, Bitmap, canvases,
    get nativeBitmapPromise() { return nativeBitmapPromise; },
    rejectBitmap() { rejectBitmap = true; },
    hit(x, y) {
      response = undefined;
      document.dispatchEvent({ type: 'dy-plus-one:hit-request', detail: JSON.stringify({ id: 'test', x, y }) });
      return response;
    },
    rawRequest(detail) {
      response = undefined;
      document.dispatchEvent({ type: 'dy-plus-one:hit-request', detail });
      return response;
    },
    status(detail = JSON.stringify({ id: 'status-test' })) {
      statusResponse = undefined;
      document.dispatchEvent({ type: 'dy-plus-one:status-request', detail });
      return statusResponse;
    },
  };
}

test('native return values and exceptions survive interception; text maps to CSS pixels', () => {
  const f = fixture();
  assert.equal(f.visible.context.fillText('hello', 10, 30), 'native return value');
  assert.throws(() => f.visible.context.fillText('THROW', 10, 30), /native drawing failure/);
  const result = f.hit(130, 90);
  assert.equal(result.text, 'hello');
  assert.deepEqual(result.rect, { left: 120, top: 80, right: 220, bottom: 120 });
  assert.equal(result.canvasId, f.visible.getAttribute('data-dy-plus-one-canvas'));
  assert.equal(f.hit(20, 90).hit, null);
});

test('only appended danmaku canvases select the site main-thread fallback', () => {
  const f = fixture();
  assert.equal(f.visible.transferControlToOffscreen(), null);
  assert.equal(f.visible.transferred, undefined);
  assert.equal(f.visible.getAttribute('data-dy-plus-one-renderer'), 'main-thread');
  f.visible.context.fillText('main thread', 10, 30);
  assert.equal(f.hit(130, 90).text, 'main thread');

  const unrelated = new f.Canvas();
  const transferred = unrelated.transferControlToOffscreen();
  assert.ok(transferred instanceof f.Offscreen);
  assert.equal(unrelated.getAttribute('data-dy-plus-one-renderer'), null);
  assert.throws(() => unrelated.transferControlToOffscreen(), /native canvas transfer failure/);
  assert.throws(() => f.Canvas.prototype.transferControlToOffscreen.call({ matches: () => true }), /native canvas transfer failure/);
});

test('main-thread renderer still tracks OffscreenCanvas bitmap caches and reports text-free status', () => {
  const f = fixture();
  const transferred = f.visible.transferControlToOffscreen();
  // Mirrors the verified renderer choice: falsy transfer selects the native
  // MainThreadManager, which draws cache bitmaps into the original canvas.
  const destination = transferred || f.visible;
  const cache = new f.Offscreen();
  cache.context.fillText('cached fallback', 10, 30);
  const bitmap = cache.transferToImageBitmap();
  destination.context.drawImage(bitmap, 20, 20);
  assert.equal(f.hit(170, 130).text, 'cached fallback');
  assert.deepEqual(f.status(), {
    id: 'status-test', bridgeVersion: '0.1.1', canvases: 1,
    trackedCanvases: 1, records: 1, fallbackCanvases: 1,
  });
  destination.context.clearRect(0, 0, 400, 200);
  assert.equal(f.status().records, 0);
  assert.equal(f.status().trackedCanvases, 0);
  for (const detail of ['{', '{}', '{"id":{}}', 'x'.repeat(301), null]) {
    assert.equal(f.status(detail), undefined);
  }
});

test('clear, same-size resize, reset, and opaque repaints remove obsolete hits', () => {
  const f = fixture();
  const context = f.visible.context;
  const repaint = () => { context.fillText('old', 10, 30); assert.equal(f.hit(130, 90).text, 'old'); };
  for (const clear of [
    () => context.clearRect(0, 0, 400, 200),
    () => { f.visible.width = f.visible.width; },
    () => { f.visible.height = f.visible.height; },
    () => context.reset(),
    () => context.fillRect(0, 0, 400, 200),
    () => context.putImageData({ width: 400, height: 200 }, 0, 0),
    () => context.fill(),
    () => context.drawImage({ width: 400, height: 200 }, 0, 0),
  ]) {
    repaint(); clear(); assert.equal(f.hit(130, 90).hit, null);
  }
});

test('stationary or paused canvas remains clickable without an arbitrary expiration', () => {
  const f = fixture();
  f.visible.context.fillText('paused', 10, 30);
  f.sandbox.performance.now = () => 60 * 60 * 1000;
  assert.equal(f.hit(130, 90).text, 'paused');
  f.visible.context.clearRect(0, 0, 400, 200);
  assert.equal(f.hit(130, 90).hit, null);
});

test('cached text propagates through three, five, and nine argument drawImage forms', () => {
  const f = fixture();
  const cache = new f.Offscreen();
  cache.context.fillText('cached', 10, 30);
  f.visible.context.drawImage(cache, 20, 20);
  assert.equal(f.hit(170, 130).text, 'cached');
  f.visible.context.clearRect(0, 0, 400, 200);
  f.visible.context.drawImage(cache, 20, 20, 800, 400);
  assert.equal(f.hit(200, 170).text, 'cached');
  f.visible.context.clearRect(0, 0, 400, 200);
  f.visible.context.drawImage(cache, 10, 15, 60, 20, 40, 50, 120, 40);
  assert.equal(f.hit(200, 170).text, 'cached');
  assert.deepEqual(f.hit(200, 170).rect, { left: 180, top: 150, right: 420, bottom: 230 });
});

test('canvas transforms, negative image extents, and crop boundaries are respected', () => {
  const f = fixture();
  const cache = new f.Offscreen();
  cache.context.fillText('cached', 10, 30);
  f.visible.context.transform = { a: 2, b: 0, c: 0, d: 2, e: 10, f: 10 };
  f.visible.context.drawImage(cache, 70, 35, -60, -20, 140, 90, -120, -40);
  assert.equal(f.hit(240, 290).text, 'cached');
  assert.equal(f.hit(180, 290).hit, null);
  assert.deepEqual(f.hit(240, 290).rect, { left: 200, top: 270, right: 680, bottom: 430 });
});

test('transferToImageBitmap retains text in the bitmap and clears the source', () => {
  const f = fixture();
  const source = new f.Offscreen();
  source.context.fillText('bitmap', 10, 30);
  const bitmap = source.transferToImageBitmap();
  f.visible.context.drawImage(bitmap, 20, 20);
  assert.equal(f.hit(170, 130).text, 'bitmap');
  f.visible.context.clearRect(0, 0, 400, 200);
  f.visible.context.drawImage(source, 20, 20);
  assert.equal(f.hit(170, 130).hit, null);
});

test('createImageBitmap keeps native Promise identity and snapshots text before asynchronous resolution', async () => {
  const f = fixture();
  const source = new f.Offscreen();
  source.context.fillText('snapshot', 10, 30);
  const promise = f.sandbox.createImageBitmap(source);
  assert.equal(promise, f.nativeBitmapPromise);
  source.context.clearRect(0, 0, 400, 200);
  source.context.fillText('new frame', 10, 30);
  const bitmap = await promise;
  f.visible.context.drawImage(bitmap, 20, 20);
  assert.equal(f.hit(170, 130).text, 'snapshot');
});

test('createImageBitmap crop, resize, and vertical flip map text into the resulting bitmap', async () => {
  const f = fixture();
  const source = new f.Offscreen();
  source.context.fillText('crop', 10, 30);
  const bitmap = await f.sandbox.createImageBitmap(source, 10, 10, 100, 50,
    { resizeWidth: 200, resizeHeight: 100, imageOrientation: 'flipY' });
  f.visible.context.drawImage(bitmap, 0, 0);
  assert.equal(f.hit(130, 170).text, 'crop');
  assert.deepEqual(f.hit(130, 170).rect, { left: 100, top: 150, right: 260, bottom: 230 });
  assert.equal(f.hit(130, 100).hit, null);
});

test('createImageBitmap rejection is delivered to the original caller unchanged', async () => {
  const f = fixture();
  const source = new f.Offscreen();
  source.context.fillText('pending', 10, 30);
  f.rejectBitmap();
  const promise = f.sandbox.createImageBitmap(source);
  assert.equal(promise, f.nativeBitmapPromise);
  await assert.rejects(promise, { name: 'TypeError', message: 'native bitmap failure' });
});

test('invisible canvas, unsupported composition, malformed requests do not return a selection', () => {
  const f = fixture();
  f.visible.context.fillText('hidden', 10, 30);
  f.visible.style.opacity = '0';
  assert.equal(f.hit(130, 90).hit, null);
  f.visible.style.opacity = '1';
  f.visible.context.globalCompositeOperation = 'destination-out';
  f.visible.context.fillText('erase', 10, 30);
  assert.equal(f.hit(130, 90).hit, null);
  for (const detail of ['{', '{}', '{"id":"x","x":"1","y":2}', 'x'.repeat(301), null]) {
    assert.equal(f.rawRequest(detail), undefined);
  }
});

test('hidden ancestors and overflow-clipped parts cannot be selected', () => {
  const f = fixture();
  f.visible.context.fillText('clipped', 10, 30);
  const parent = {
    style: { display: 'block', visibility: 'visible', opacity: '0', overflowX: 'visible', overflowY: 'visible' },
    getBoundingClientRect: () => ({ left: 150, top: 100, right: 300, bottom: 300 }),
  };
  f.visible.parentElement = parent;
  assert.equal(f.hit(130, 90).hit, null);
  parent.style.opacity = '1';
  parent.style.overflowX = 'hidden';
  assert.equal(f.hit(130, 90).hit, null);
  assert.equal(f.hit(160, 90).text, 'clipped');
  parent.style.overflowY = 'clip';
  assert.equal(f.hit(160, 90).hit, null);
  assert.equal(f.hit(160, 110).text, 'clipped');
  parent.style.display = 'none';
  assert.equal(f.hit(160, 110).hit, null);
});
