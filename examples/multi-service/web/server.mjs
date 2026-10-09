// Web front end for the multi-service example. Serves the page and proxies /api/* to the API,
// adding the bearer token server-side so the browser never sees it.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const port = Number(process.env.PORT ?? 5342);
const host = process.env.HOST ?? '127.0.0.1';
const apiUrl = process.env.API_URL ?? 'http://127.0.0.1:5341';
const token = process.env.DEMO_API_TOKEN;
if (!token) {
  console.error('web: DEMO_API_TOKEN is not set');
  process.exit(1);
}
const publicDir = join(fileURLToPath(new URL('.', import.meta.url)), 'public');

async function apiHealthy() {
  try {
    const res = await fetch(`${apiUrl}/health`, { signal: AbortSignal.timeout(2000) });
    return res.status === 200;
  } catch {
    return false;
  }
}

async function proxy(req, res, path) {
  let body = '';
  for await (const chunk of req) body += chunk;
  const upstream = await fetch(`${apiUrl}${path}`, {
    method: req.method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
  });
  res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json', 'cache-control': 'no-store' });
  res.end(await upstream.text());
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const { pathname } = url;
  try {
    if (pathname === '/health') {
      const ok = await apiHealthy();
      return void res.writeHead(ok ? 200 : 503, { 'content-type': 'text/plain' }).end(ok ? 'ok' : 'api unavailable');
    }
    if (pathname === '/' || pathname === '/index.html') {
      const body = await readFile(join(publicDir, 'index.html'));
      return void res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(body);
    }
    if (pathname.startsWith('/api/')) return await proxy(req, res, pathname.slice(4) + url.search);
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
  } catch (err) {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
    res.end(`web: ${err.message}`);
  }
});

server.on('error', (err) => {
  console.error(`web: failed to listen on ${host}:${port}: ${err.message}`);
  process.exit(1);
});
server.listen(port, host, () => console.log(`web: listening on http://${host}:${port}`));

// WEB_SLOW_SHUTDOWN=1 ignores the first SIGTERM so tests can exercise the SIGKILL-after-grace path.
let ignoredTerm = process.env.WEB_SLOW_SHUTDOWN !== '1';
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    if (sig === 'SIGTERM' && !ignoredTerm) {
      ignoredTerm = true;
      console.log('web: ignoring SIGTERM');
      return;
    }
    console.log('web: shutting down');
    server.close(() => process.exit(0));
    server.closeAllConnections();
  });
}
