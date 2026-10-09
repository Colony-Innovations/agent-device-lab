// Minimal dev server for the invoice fixture. No dependencies, no persistent state:
// invoices live in the browser's localStorage, so every fresh browser context starts clean.
import { createServer } from 'node:http';
import { appendFile, readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const port = Number(process.env.PORT ?? 5199);
const host = process.env.HOST ?? '127.0.0.1';
const publicDir = join(fileURLToPath(new URL('.', import.meta.url)), 'public');
// Optional audit trail for benchmarks: completion is judged from what the app actually received,
// not from what an agent says it did.
const eventLog = process.env.FIXTURE_EVENT_LOG;
const audit = (type, data) => eventLog && appendFile(eventLog, JSON.stringify({ at: new Date().toISOString(), type, ...data }) + '\n');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };

const pages = [
  [/^\/invoices\/?$/, 'invoices.html'],
  [/^\/invoices\/[\w-]+\/?$/, 'invoice.html'],
  [/^\/reports\/?$/, 'reports.html'],
];

async function sendFile(res, file) {
  const body = await readFile(join(publicDir, file));
  res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
  res.end(body);
}

const server = createServer(async (req, res) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (pathname === '/health') return void res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
    if (pathname === '/') return void res.writeHead(302, { location: '/invoices' }).end();
    if (pathname === '/api/invoices' && req.method === 'POST') {
      // Simulated latency so the lab's settle logic has an in-flight request to wait for.
      let body = '';
      for await (const chunk of req) body += chunk;
      await new Promise((r) => setTimeout(r, 350));
      await audit('invoice.created', { invoice: safeJson(body) });
      res.writeHead(201, { 'content-type': 'application/json' });
      return void res.end(body || '{}');
    }
    if (pathname === '/api/events' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const event = safeJson(body);
      if (event && typeof event.type === 'string') await audit(event.type, event);
      return void res.writeHead(204).end();
    }
    for (const [pattern, file] of pages) if (pattern.test(pathname)) return await sendFile(res, file);
    if (/^\/[\w-]+\.(js|css)$/.test(pathname)) return await sendFile(res, pathname.slice(1));
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
  } catch (err) {
    res.writeHead(500, { 'content-type': 'text/plain' }).end(String(err));
  }
});

function safeJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

server.on('error', (err) => {
  console.error(`[invoice-fixture] failed to listen on ${host}:${port}: ${err.message}`);
  process.exit(1);
});
server.listen(port, host, () => console.log(`[invoice-fixture] listening on http://${host}:${port}`));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.close(() => process.exit(0)));
