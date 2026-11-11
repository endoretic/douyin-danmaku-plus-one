/* Runs in the page's MAIN world before the player creates its canvases. */
(() => {
  'use strict';

  const installed = Symbol.for('dy-plus-one.canvas-bridge');
  if (globalThis[installed]) return;
  globalThis[installed] = true;

  const CANVAS_SELECTOR = '.CanvasDanmakuPlugin canvas, xg-danmu canvas, [data-e2e="danmaku-container"] canvas';
  const MAX_RECORDS = 512;
  const MAX_TEXT_LENGTH = 500;
  const states = new WeakMap();
  let nextCanvasId = 1;

  // The current Douyin CanvasDanmakuPlugin appends its canvas, then chooses
  // WorkerManager only when transferControlToOffscreen() returns a canvas.
  // Its own MainThreadManager is otherwise used. Keep this one renderer in
  // the page realm so the text hooks below can observe it. Unrelated canvases
  // retain the browser's native transfer behavior, including its exceptions.
  const canvasPrototype = globalThis.HTMLCanvasElement?.prototype;
  const transferDescriptor = canvasPrototype && Object.getOwnPropertyDescriptor(canvasPrototype, 'transferControlToOffscreen');
  if (typeof transferDescriptor?.value === 'function' && (transferDescriptor.writable || transferDescriptor.configurable)) {
    const originalTransfer = transferDescriptor.value;
    Object.defineProperty(canvasPrototype, 'transferControlToOffscreen', {
      ...transferDescriptor,
      value: function (...args) {
        let isDanmaku = false;
        try { isDanmaku = this instanceof globalThis.HTMLCanvasElement && this.matches(CANVAS_SELECTOR); } catch { /* Use the native operation below. */ }
        if (isDanmaku) {
          try { this.setAttribute('data-dy-plus-one-renderer', 'main-thread'); } catch { /* Diagnostic attribute is optional. */ }
          return null;
        }
        return Reflect.apply(originalTransfer, this, args);
      },
    });
  }

  function dimensions(source) {
    return { width: Number(source.width) || 0, height: Number(source.height) || 0 };
  }

  function stateFor(source) {
    const { width, height } = dimensions(source);
    let state = states.get(source);
    if (!state || state.width !== width || state.height !== height) {
      state = { width, height, records: [] };
      states.set(source, state);
    }
    return state;
  }

  function intersection(a, b) {
    const result = {
      left: Math.max(a.left, b.left), top: Math.max(a.top, b.top),
      right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom),
    };
    return result.right > result.left && result.bottom > result.top ? result : null;
  }

  function transformRect(rect, matrix) {
    const points = [
      [rect.left, rect.top], [rect.right, rect.top],
      [rect.left, rect.bottom], [rect.right, rect.bottom],
    ].map(([x, y]) => ({
      x: matrix.a * x + matrix.c * y + matrix.e,
      y: matrix.b * x + matrix.d * y + matrix.f,
    }));
    return {
      left: Math.min(...points.map(p => p.x)), top: Math.min(...points.map(p => p.y)),
      right: Math.max(...points.map(p => p.x)), bottom: Math.max(...points.map(p => p.y)),
    };
  }

  function canvasBounds(state) {
    return { left: 0, top: 0, right: state.width, bottom: state.height };
  }

  function addRecord(context, record) {
    const state = stateFor(context.canvas);
    const rect = intersection(record.rect, canvasBounds(state));
    if (!rect) return;
    const previous = state.records.at(-1);
    // Players commonly stroke and fill exactly the same text for an outline.
    if (previous && previous.text === record.text &&
        Math.abs(previous.rect.left - rect.left) < 1 &&
        Math.abs(previous.rect.top - rect.top) < 1 &&
        Math.abs(previous.rect.right - rect.right) < 1 &&
        Math.abs(previous.rect.bottom - rect.bottom) < 1) {
      return;
    }
    state.records.push({ ...record, rect });
    if (state.records.length > MAX_RECORDS) {
      state.records.splice(0, state.records.length - MAX_RECORDS);
    }
  }

  function forgetRect(context, rect) {
    const state = stateFor(context.canvas);
    state.records = state.records.filter(record => !intersection(record.rect, rect));
  }

  function rectFromArgs(x, y, width, height) {
    x = Number(x); y = Number(y); width = Number(width); height = Number(height);
    return {
      left: Math.min(x, x + width), top: Math.min(y, y + height),
      right: Math.max(x, x + width), bottom: Math.max(y, y + height),
    };
  }

  function canRecord(context) {
    if (context.globalAlpha === 0) return false;
    if (context.globalCompositeOperation === 'copy') {
      stateFor(context.canvas).records = [];
      return true;
    }
    // Unusual masking/compositing can invalidate previously visible text.
    if (!['source-over', 'destination-over'].includes(context.globalCompositeOperation)) {
      stateFor(context.canvas).records = [];
      return false;
    }
    return true;
  }

  function recordText(context, args) {
    if (!canRecord(context)) return;
    const text = String(args[0]);
    const x = Number(args[1]), y = Number(args[2]);
    if (!text.trim() || text.length > MAX_TEXT_LENGTH || !Number.isFinite(x + y)) return;
    const metrics = context.measureText(text);
    const fontSize = Number.parseFloat(context.font.match(/([\d.]+)px\b/)?.[1]) || 24;
    let left = metrics.actualBoundingBoxLeft;
    let right = metrics.actualBoundingBoxRight;
    let ascent = metrics.actualBoundingBoxAscent;
    let descent = metrics.actualBoundingBoxDescent;

    // Modern Chromium supplies these metrics, including textAlign/textBaseline.
    if (![left, right, ascent, descent].every(Number.isFinite)) {
      let align = context.textAlign;
      const rtl = context.direction === 'rtl';
      if (align === 'start') align = rtl ? 'right' : 'left';
      if (align === 'end') align = rtl ? 'left' : 'right';
      left = align === 'center' ? metrics.width / 2 : align === 'right' ? metrics.width : 0;
      right = metrics.width - left;
      ascent = fontSize * 0.85;
      descent = fontSize * 0.2;
      if (context.textBaseline === 'top' || context.textBaseline === 'hanging') {
        ascent = 0; descent = fontSize;
      } else if (context.textBaseline === 'middle') {
        ascent = fontSize / 2; descent = fontSize / 2;
      } else if (context.textBaseline === 'bottom') {
        ascent = fontSize; descent = 0;
      }
    }
    const maxWidth = args.length > 3 ? Number(args[3]) : Infinity;
    if (maxWidth <= 0) return;
    const horizontalScale = metrics.width > 0 ? Math.min(1, maxWidth / metrics.width) : 1;
    const rect = transformRect({
      left: x - left * horizontalScale, right: x + right * horizontalScale,
      top: y - ascent, bottom: y + descent,
    }, context.getTransform());
    if (!Object.values(rect).every(Number.isFinite)) return;
    addRecord(context, { text, rect });
  }

  function recordImage(context, args) {
    if (!canRecord(context)) return;
    const source = args[0];
    if (!source || typeof source !== 'object') return;
    const sourceState = states.get(source);
    const sourceWidth = Number(source.width || source.videoWidth || source.naturalWidth);
    const sourceHeight = Number(source.height || source.videoHeight || source.naturalHeight);
    let sx = 0, sy = 0, sw = sourceWidth, sh = sourceHeight;
    let dx, dy, dw, dh;
    if (args.length === 3) {
      [, dx, dy] = args; dw = sw; dh = sh;
    } else if (args.length === 5) {
      [, dx, dy, dw, dh] = args;
    } else if (args.length === 9) {
      [, sx, sy, sw, sh, dx, dy, dw, dh] = args;
    } else return;
    [sx, sy, sw, sh, dx, dy, dw, dh] = [sx, sy, sw, sh, dx, dy, dw, dh].map(Number);
    if (![sx, sy, sw, sh, dx, dy, dw, dh].every(Number.isFinite) || !sw || !sh || !dw || !dh) return;
    // Canvas negative image sizes extend the rectangle without mirroring pixels.
    if (sw < 0) { sx += sw; sw = -sw; }
    if (sh < 0) { sy += sh; sh = -sh; }
    if (dw < 0) { dx += dw; dw = -dw; }
    if (dh < 0) { dy += dh; dh = -dh; }
    const matrix = context.getTransform();
    if (!sourceState || !sourceState.records.length) {
      forgetRect(context, transformRect(rectFromArgs(dx, dy, dw, dh), matrix));
      return;
    }
    // Snapshot first: source and destination may be the very same canvas.
    const records = sourceState.records.slice();
    const crop = { left: sx, top: sy, right: sx + sw, bottom: sy + sh };
    for (const record of records) {
      const clipped = intersection(record.rect, crop);
      if (!clipped) continue;
      const rect = transformRect({
        left: dx + (clipped.left - sx) * dw / sw,
        right: dx + (clipped.right - sx) * dw / sw,
        top: dy + (clipped.top - sy) * dh / sh,
        bottom: dy + (clipped.bottom - sy) * dh / sh,
      }, matrix);
      addRecord(context, { text: record.text, rect });
    }
  }

  function wrap(prototype, method, after) {
    const original = prototype?.[method];
    if (typeof original !== 'function') return;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, method);
    if (!descriptor || (!descriptor.writable && !descriptor.configurable)) return;
    Object.defineProperty(prototype, method, {
      ...descriptor,
      value: function (...args) {
        // Native failures and return values remain exactly the browser's own.
        const result = Reflect.apply(original, this, args);
        try { after(this, args, result); } catch { /* Never interrupt player rendering. */ }
        return result;
      },
    });
  }

  function installContext(prototype) {
    if (!prototype) return;
    for (const method of ['fillText', 'strokeText']) wrap(prototype, method, recordText);
    wrap(prototype, 'drawImage', recordImage);
    wrap(prototype, 'clearRect', (context, args) => {
      forgetRect(context, transformRect(rectFromArgs(...args), context.getTransform()));
    });
    // An untracked repaint must not leave old text available for hit-testing.
    wrap(prototype, 'fillRect', (context, args) => {
      if (context.globalAlpha) forgetRect(context, transformRect(rectFromArgs(...args), context.getTransform()));
    });
    wrap(prototype, 'strokeRect', (context, args) => {
      if (context.globalAlpha) forgetRect(context, transformRect(rectFromArgs(...args), context.getTransform()));
    });
    for (const method of ['fill', 'stroke']) {
      // Arbitrary paths cannot be measured without tracing every path command.
      wrap(prototype, method, context => { if (context.globalAlpha) states.delete(context.canvas); });
    }
    wrap(prototype, 'putImageData', (context, args) => {
      const [data, dx, dy, dirtyX = 0, dirtyY = 0, dirtyWidth = data.width, dirtyHeight = data.height] = args;
      forgetRect(context, rectFromArgs(Number(dx) + Number(dirtyX), Number(dy) + Number(dirtyY), dirtyWidth, dirtyHeight));
    });
    wrap(prototype, 'reset', context => { states.delete(context.canvas); });
  }

  function installCanvas(prototype) {
    if (!prototype) return;
    for (const property of ['width', 'height']) {
      const descriptor = Object.getOwnPropertyDescriptor(prototype, property);
      if (!descriptor?.set || !descriptor.configurable) continue;
      const originalSet = descriptor.set;
      Object.defineProperty(prototype, property, {
        ...descriptor,
        set(value) {
          Reflect.apply(originalSet, this, [value]);
          states.delete(this);
        },
      });
    }
  }

  installContext(globalThis.CanvasRenderingContext2D?.prototype);
  installContext(globalThis.OffscreenCanvasRenderingContext2D?.prototype);
  installCanvas(globalThis.HTMLCanvasElement?.prototype);
  installCanvas(globalThis.OffscreenCanvas?.prototype);
  wrap(globalThis.OffscreenCanvas?.prototype, 'transferToImageBitmap', (canvas, _args, bitmap) => {
    const state = states.get(canvas);
    if (state) states.set(bitmap, { ...state, records: state.records.slice() });
    states.delete(canvas);
  });
  wrap(globalThis.ImageBitmap?.prototype, 'close', bitmap => { states.delete(bitmap); });

  function bitmapSnapshot(args) {
    const source = args[0];
    const state = source && states.get(source);
    if (!state?.records.length || state.width !== source.width || state.height !== source.height) return null;
    let sx = 0, sy = 0, sw = state.width, sh = state.height;
    let options = args[1];
    if (args.length >= 5) {
      [, sx, sy, sw, sh, options] = args;
      [sx, sy, sw, sh] = [sx, sy, sw, sh].map(Number);
    }
    if (![sx, sy, sw, sh].every(Number.isFinite) || !sw || !sh) return null;
    if (sw < 0) { sx += sw; sw = -sw; }
    if (sh < 0) { sy += sh; sh = -sh; }
    return {
      sx, sy, sw, sh, flipY: options?.imageOrientation === 'flipY',
      // createImageBitmap captures pixels at invocation, not when its promise resolves.
      records: state.records.map(record => ({ text: record.text, rect: { ...record.rect } })),
    };
  }

  const bitmapDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'createImageBitmap');
  if (typeof bitmapDescriptor?.value === 'function' && (bitmapDescriptor.writable || bitmapDescriptor.configurable)) {
    const original = bitmapDescriptor.value;
    Object.defineProperty(globalThis, 'createImageBitmap', {
      ...bitmapDescriptor,
      value: function (...args) {
        let snapshot;
        try { snapshot = bitmapSnapshot(args); } catch { /* Metadata is optional. */ }
        const promise = Reflect.apply(original, this, args);
        if (snapshot) {
          // Observe resolution without replacing the native promise or changing its result.
          promise.then(bitmap => {
            try {
              const { sx, sy, sw, sh, flipY } = snapshot;
              const crop = { left: sx, top: sy, right: sx + sw, bottom: sy + sh };
              const records = [];
              for (const record of snapshot.records) {
                const clipped = intersection(record.rect, crop);
                if (!clipped) continue;
                let top = (clipped.top - sy) / sh;
                let bottom = (clipped.bottom - sy) / sh;
                if (flipY) [top, bottom] = [1 - bottom, 1 - top];
                records.push({ text: record.text, rect: {
                  left: (clipped.left - sx) * bitmap.width / sw,
                  right: (clipped.right - sx) * bitmap.width / sw,
                  top: top * bitmap.height, bottom: bottom * bitmap.height,
                } });
              }
              states.set(bitmap, { width: bitmap.width, height: bitmap.height, records });
            } catch { /* Never reject the website's bitmap operation. */ }
          }, () => { /* The caller still receives the original rejected promise. */ });
        }
        return promise;
      },
    });
  }

  function canvasContentRect(canvas) {
    const rect = canvas.getBoundingClientRect();
    const style = getComputedStyle(canvas);
    if (!rect.width || !rect.height || style.display === 'none' ||
        style.visibility !== 'visible' || Number(style.opacity) === 0) return null;
    const scaleX = canvas.offsetWidth ? rect.width / canvas.offsetWidth : 1;
    const scaleY = canvas.offsetHeight ? rect.height / canvas.offsetHeight : 1;
    const inset = key => Number.parseFloat(style[key]) || 0;
    const left = rect.left + (inset('borderLeftWidth') + inset('paddingLeft')) * scaleX;
    const top = rect.top + (inset('borderTopWidth') + inset('paddingTop')) * scaleY;
    const right = rect.right - (inset('borderRightWidth') + inset('paddingRight')) * scaleX;
    const bottom = rect.bottom - (inset('borderBottomWidth') + inset('paddingBottom')) * scaleY;
    return right > left && bottom > top ? { left, top, right, bottom } : null;
  }

  function pointIsVisible(canvas, x, y) {
    for (let node = canvas; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden' ||
          style.visibility === 'collapse' || Number(style.opacity) === 0) return false;
      if (node !== canvas && (/(hidden|clip|auto|scroll)/.test(style.overflowX) ||
          /(hidden|clip|auto|scroll)/.test(style.overflowY))) {
        const rect = node.getBoundingClientRect();
        if (/(hidden|clip|auto|scroll)/.test(style.overflowX) && (x < rect.left || x > rect.right)) return false;
        if (/(hidden|clip|auto|scroll)/.test(style.overflowY) && (y < rect.top || y > rect.bottom)) return false;
      }
    }
    return true;
  }

  function hitTest(x, y) {
    for (const canvas of [...document.querySelectorAll(CANVAS_SELECTOR)].reverse()) {
      const state = states.get(canvas);
      if (!state?.records.length || state.width !== canvas.width || state.height !== canvas.height) continue;
      const box = canvasContentRect(canvas);
      if (!box || x < box.left || x > box.right || y < box.top || y > box.bottom) continue;
      if (!pointIsVisible(canvas, x, y)) continue;
      const scaleX = (box.right - box.left) / state.width;
      const scaleY = (box.bottom - box.top) / state.height;
      const localX = (x - box.left) / scaleX;
      const localY = (y - box.top) / scaleY;
      for (let index = state.records.length - 1; index >= 0; index--) {
        // A paused canvas still displays its last frame. Clear/reset/repaint hooks,
        // rather than a clock timeout, invalidate obsolete rectangles.
        const { text, rect } = state.records[index];
        if (localX < rect.left || localX > rect.right || localY < rect.top || localY > rect.bottom) continue;
        let canvasId = canvas.getAttribute('data-dy-plus-one-canvas');
        if (!canvasId) {
          canvasId = String(nextCanvasId++);
          canvas.setAttribute('data-dy-plus-one-canvas', canvasId);
        }
        return {
          text, canvasId,
          rect: {
            left: box.left + rect.left * scaleX, right: box.left + rect.right * scaleX,
            top: box.top + rect.top * scaleY, bottom: box.top + rect.bottom * scaleY,
          },
        };
      }
    }
    return null;
  }

  document.addEventListener('dy-plus-one:hit-request', event => {
    try {
      if (typeof event.detail !== 'string' || event.detail.length > 300) return;
      const request = JSON.parse(event.detail);
      const { id, x, y } = request;
      if (!['string', 'number'].includes(typeof id) || !Number.isFinite(x) || !Number.isFinite(y)) return;
      const hit = hitTest(x, y);
      document.dispatchEvent(new CustomEvent('dy-plus-one:hit-result', {
        detail: JSON.stringify(hit ? { id, ...hit } : { id, hit: null }),
      }));
    } catch { /* Malformed page-originated events cannot affect the player. */ }
  });

  document.addEventListener('dy-plus-one:status-request', event => {
    try {
      if (typeof event.detail !== 'string' || event.detail.length > 300) return;
      const { id } = JSON.parse(event.detail);
      if (!['string', 'number'].includes(typeof id)) return;
      const canvases = [...document.querySelectorAll(CANVAS_SELECTOR)];
      let trackedCanvases = 0;
      let records = 0;
      let fallbackCanvases = 0;
      for (const canvas of canvases) {
        const state = states.get(canvas);
        if (state?.records.length && state.width === canvas.width && state.height === canvas.height) {
          trackedCanvases++;
          records += state.records.length;
        }
        if (canvas.getAttribute('data-dy-plus-one-renderer') === 'main-thread') fallbackCanvases++;
      }
      document.dispatchEvent(new CustomEvent('dy-plus-one:status-result', {
        detail: JSON.stringify({ id, bridgeVersion: '0.1.1', canvases: canvases.length, trackedCanvases, records, fallbackCanvases }),
      }));
    } catch { /* Diagnostics never read pixels, expose text, or change rendering. */ }
  });
})();
