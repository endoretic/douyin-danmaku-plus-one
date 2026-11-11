/* Independent fixture renderer. No network requests or site code. */
'use strict';
let canvas;
let ctx;
let cachedBitmap;
let timer;
let moving = false;
let cleared = false;
let startedAt = 0;

function draw() {
  if (cleared) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const dx = moving ? ((performance.now() - startedAt) / 12) % 600 : 0;
  ctx.drawImage(cachedBitmap, 84 + dx, 70);
  ctx.font = 'bold 48px sans-serif';
  ctx.fillStyle = '#8fe9db';
  ctx.fillText('这句是直接绘制的弹幕', 84 + dx, 320);
}

self.addEventListener('message', event => {
  const message = event.data;
  if (message.type === 'init') {
    clearInterval(timer);
    cachedBitmap?.close();
    canvas = message.canvas;
    ctx = canvas.getContext('2d');
    const cache = new OffscreenCanvas(620, 76);
    const cached = cache.getContext('2d');
    cached.font = 'bold 48px sans-serif';
    cached.fillStyle = '#ffffff';
    cached.fillText('这波配合太好了', 4, 57);
    cachedBitmap = cache.transferToImageBitmap();
    startedAt = performance.now();
    draw();
    timer = setInterval(draw, 32);
    self.postMessage({ type: 'ready' });
  } else if (message.type === 'motion') {
    moving = message.moving;
    startedAt = performance.now();
  } else if (message.type === 'clear') {
    cleared = true;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  } else if (message.type === 'restore') {
    cleared = false;
    draw();
  }
});
