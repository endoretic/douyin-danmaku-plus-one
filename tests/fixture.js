(() => {
  'use strict';
  const canvas = document.querySelector('#danmaku-canvas');
  const workerMode = new URLSearchParams(location.search).get('renderer') === 'worker';
  const rendererStatus = document.querySelector('#renderer-status');
  // Reproduce the site's capability branch before creating a 2D context.
  // The compatibility shim returns null only for this attached danmaku canvas.
  const transferred = workerMode ? canvas.transferControlToOffscreen?.() : null;
  let rendererWorker = null;
  let ctx = null;
  let cache = null;
  if (transferred) {
    rendererWorker = new Worker(new URL('fixture-worker.js', location.href));
    rendererWorker.addEventListener('message', event => {
      if (event.data?.type === 'ready') rendererStatus.textContent = 'Worker 绘制 · 主页面监听无法读取此线程文字';
    });
    rendererWorker.addEventListener('error', () => {
      rendererStatus.textContent = 'Worker 启动失败，请检查本地测试服务';
    });
    rendererWorker.postMessage({ type: 'init', canvas: transferred }, [transferred]);
  } else {
    ctx = canvas.getContext('2d');
    const cacheCanvas = workerMode && typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(620, 76) : document.createElement('canvas');
    cacheCanvas.width = 620;
    cacheCanvas.height = 76;
    const cached = cacheCanvas.getContext('2d');
    cached.font = 'bold 48px sans-serif';
    cached.fillStyle = '#ffffff';
    cached.fillText('这波配合太好了', 4, 57);
    cache = typeof cacheCanvas.transferToImageBitmap === 'function'
      ? cacheCanvas.transferToImageBitmap() : cacheCanvas;
    rendererStatus.textContent = workerMode
      ? '主线程兼容绘制 · OffscreenCanvas → ImageBitmap → 页面 Canvas'
      : '普通主线程绘制 · HTMLCanvas 缓存';
  }
  const editor = document.querySelector('[contenteditable="true"]');
  const send = document.querySelector('.webcast-chatroom___send-btn');
  const status = document.querySelector('#fixture-status');
  const video = document.querySelector('video');
  let moving = false;
  let cleared = false;
  let failing = false;
  let room = 1;
  let count = 0;
  let start = performance.now();
  let lastFrame = 0;
  const value = () => editor.textContent.replace(/\u200B/g, '').trim();
  function syncSend() {
    const empty = !value();
    send.classList.toggle('disable', empty);
    send.toggleAttribute('disabled', empty);
    send.setAttribute('aria-disabled', String(empty));
  }
  function setEditor(text) {
    const line = document.createElement('div');
    line.className = 'ace-line';
    line.dataset.node = 'true';
    const span = document.createElement('span');
    span.dataset.string = 'true';
    span.dataset.leaf = 'true';
    span.textContent = text || '\u200B';
    line.append(span);
    editor.replaceChildren(line);
    editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
  }
  editor.addEventListener('input', syncSend);
  send.addEventListener('click', () => {
    if (send.hasAttribute('disabled') || !value()) return;
    if (failing) {
      status.textContent = '模拟服务端失败：没有发送，输入框保留原文。';
      return;
    }
    const entry = document.createElement('li');
    entry.textContent = value();
    document.querySelector('#sent-log').append(entry);
    document.querySelector('#send-count').textContent = String(++count);
    setEditor('');
    status.textContent = `本地已接收第 ${count} 条。没有向任何网站发送。`;
  });
  send.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') send.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  document.querySelector('#set-draft').addEventListener('click', () => {
    setEditor('这是我还没发送的草稿');
    status.textContent = '已有草稿已填入：+1 不应覆盖它。';
  });
  document.querySelector('#clear-draft').addEventListener('click', () => setEditor(''));
  document.querySelector('#toggle-failure').addEventListener('click', event => {
    failing = !failing;
    event.currentTarget.textContent = `模拟发送失败：${failing ? '开' : '关'}`;
  });
  document.querySelector('#toggle-motion').addEventListener('click', event => {
    moving = !moving;
    start = performance.now();
    rendererWorker?.postMessage({ type: 'motion', moving });
    event.currentTarget.textContent = moving ? '停止移动' : '开启移动';
  });
  document.querySelector('#toggle-canvas').addEventListener('click', event => {
    const holder = canvas.parentElement;
    holder.hidden = !holder.hidden;
    holder.style.display = holder.hidden ? 'none' : '';
    event.currentTarget.textContent = holder.hidden ? '显示 Canvas' : '隐藏 Canvas';
  });
  document.querySelector('#clear-canvas').addEventListener('click', () => {
    cleared = true;
    if (rendererWorker) rendererWorker.postMessage({ type: 'clear' });
    else ctx.clearRect(0, 0, canvas.width, canvas.height);
    status.textContent = 'Canvas 已清空：原来的位置不应再出现 +1。';
  });
  document.querySelector('#restore-canvas').addEventListener('click', () => {
    cleared = false;
    rendererWorker?.postMessage({ type: 'restore' });
    canvas.parentElement.hidden = false;
    canvas.parentElement.style.display = '';
    document.querySelector('#toggle-canvas').textContent = '隐藏 Canvas';
  });
  document.querySelector('#switch-room').addEventListener('click', () => {
    room++;
    const nextUrl = new URL(location.href);
    nextUrl.searchParams.set('room', String(room));
    history.pushState({}, '', nextUrl);
    video.src = `data:video/mp4;base64,AAAA${room}`;
    document.querySelector('.scene strong').textContent = `LIVE / ${String(room).padStart(2, '0')}`;
    status.textContent = `已切换到房间 ${room}：之前选中的弹幕应失效。`;
  });
  function draw(now) {
    if (!cleared && now - lastFrame > 30) {
      lastFrame = now;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const dx = moving ? ((now - start) / 12) % 600 : 0;
      ctx.drawImage(cache, 84 + dx, 70);
      ctx.font = 'bold 48px sans-serif';
      ctx.fillStyle = '#8fe9db';
      ctx.fillText('这句是直接绘制的弹幕', 84 + dx, 320);
    }
    requestAnimationFrame(draw);
  }
  syncSend();
  if (!rendererWorker) requestAnimationFrame(draw);
  window.addEventListener('pagehide', () => {
    rendererWorker?.terminate();
    if (cache && typeof cache.close === 'function') cache.close();
  }, { once: true });
})();
