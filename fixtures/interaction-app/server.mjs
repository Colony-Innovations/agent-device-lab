// Minimal dev server for the interaction fixture. No dependencies, no state: every page is a
// static document whose interactions only change text in its #status element.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const port = Number(process.env.PORT ?? 5351);
const host = process.env.HOST ?? '127.0.0.1';
const publicDir = join(fileURLToPath(new URL('.', import.meta.url)), 'public');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };

const pages = {
  '/': 'index.html',
  '/form': 'form.html',
  '/scroll': 'scroll.html',
  '/pointer': 'pointer.html',
  '/tabs': 'tabs.html',
  '/help': 'help.html',
  '/popup': 'popup.html',
  '/upload': 'upload.html',
  '/keys': 'keys.html',
};

async function sendFile(res, file) {
  const body = await readFile(join(publicDir, file));
  res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
  res.end(body);
}

const server = createServer(async (req, res) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (pathname === '/health') return void res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
    const page = pages[pathname.length > 1 ? pathname.replace(/\/$/, '') : pathname];
    if (page) return await sendFile(res, page);
    if (/^\/[\w-]+\.(js|css)$/.test(pathname)) return await sendFile(res, pathname.slice(1));
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
  } catch (err) {
    res.writeHead(500, { 'content-type': 'text/plain' }).end(String(err));
  }
});

server.on('error', (err) => {
  console.error(`[interaction-fixture] failed to listen on ${host}:${port}: ${err.message}`);
  process.exit(1);
});
server.listen(port, host, () => console.log(`[interaction-fixture] listening on http://${host}:${port}`));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.close(() => process.exit(0)));
