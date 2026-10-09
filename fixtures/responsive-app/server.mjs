// Minimal dev server for the responsive fixture. No dependencies. The only state is the in-memory
// audit log: every consequential control on the pages POSTs its event to /audit, so a test can
// assert that automatic exploration never activated one.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const port = Number(process.env.PORT ?? 5353);
const host = process.env.HOST ?? '127.0.0.1';
const publicDir = join(fileURLToPath(new URL('.', import.meta.url)), 'public');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };

const pages = {
  '/': 'index.html',
  '/about': 'about.html',
  '/checkout': 'checkout.html',
  '/account': 'account.html',
  '/settings': 'settings.html',
  '/news': 'news.html',
  '/contact': 'contact.html',
};

const auditLog = [];

async function sendFile(res, file) {
  const body = await readFile(join(publicDir, file));
  res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
  res.end(body);
}

async function readBody(req) {
  let text = '';
  for await (const chunk of req) text += chunk;
  return text;
}

const server = createServer(async (req, res) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (pathname === '/health') return void res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
    if (pathname === '/audit' && req.method === 'POST') {
      let event;
      try {
        event = JSON.parse(await readBody(req)).event;
      } catch {
        event = undefined;
      }
      if (typeof event !== 'string' || !event) return void res.writeHead(400, { 'content-type': 'text/plain' }).end('bad event');
      auditLog.push(event);
      return void res.writeHead(204).end();
    }
    if (pathname === '/audit-log' && req.method === 'GET') {
      return void res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(auditLog));
    }
    if (pathname === '/audit-reset' && req.method === 'POST') {
      auditLog.length = 0;
      return void res.writeHead(204).end();
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return void res.writeHead(405, { 'content-type': 'text/plain' }).end('method not allowed');
    const page = pages[pathname.length > 1 ? pathname.replace(/\/$/, '') : pathname];
    if (page) return await sendFile(res, page);
    if (/^\/[\w-]+\.(js|css)$/.test(pathname)) return await sendFile(res, pathname.slice(1));
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
  } catch (err) {
    res.writeHead(500, { 'content-type': 'text/plain' }).end(String(err));
  }
});

server.on('error', (err) => {
  console.error(`[responsive-fixture] failed to listen on ${host}:${port}: ${err.message}`);
  process.exit(1);
});
server.listen(port, host, () => console.log(`[responsive-fixture] listening on http://${host}:${port}`));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.close(() => process.exit(0)));
