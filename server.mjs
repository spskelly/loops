import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
const root = process.cwd();
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };
const port = Number(process.env.PORT || 5173);
createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const file = resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!file.startsWith(root + sep) || pathname.split('/').some(p => p.startsWith('.')) || !types[extname(file)]) {
      res.writeHead(404).end('Not found'); return;
    }
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': types[extname(file)], 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' }).end(data);
  } catch { res.writeHead(404).end('Not found'); }
}).listen(port, '127.0.0.1', () => console.log(`Loops is ready at http://localhost:${port}`));
