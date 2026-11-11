import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const port = Number(process.env.PORT || 4173);
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml' };
const server = http.createServer(async (req, res) => {
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end('Method not allowed');
      return;
    }
    const url = new URL(req.url, 'http://127.0.0.1');
    const decoded = decodeURIComponent(url.pathname);
    const target = path.resolve(root, '.' + (decoded === '/' ? '/tests/fixture.html' : decoded));
    const relative = path.relative(root, target);
    if (relative.startsWith('..') || path.isAbsolute(relative) || decoded.includes('\0') || relative.split(path.sep).some(part => part.startsWith('.'))) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    if (!(await stat(target)).isFile()) {
      res.writeHead(404).end('Not found');
      return;
    }
    const bytes = await readFile(target);
    res.writeHead(200, { 'Content-Type': mime[path.extname(target)] || 'application/octet-stream', 'Content-Length': bytes.length, 'Cache-Control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : bytes);
  } catch (error) {
    res.writeHead(error.code === 'ENOENT' ? 404 : 400).end('Not found');
  }
});
server.listen(port, '127.0.0.1', () => console.log(`Local fixture: http://127.0.0.1:${port}/tests/fixture.html`));
