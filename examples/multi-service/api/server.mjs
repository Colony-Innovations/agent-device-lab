// Task API for the multi-service example. No dependencies, in-memory state.
// The bearer token comes from DEMO_API_TOKEN; its value is never printed.
import { createServer } from 'node:http';

if (process.env.API_CRASH === '1') {
  console.error('api: simulated startup crash');
  process.exit(3);
}
const token = process.env.DEMO_API_TOKEN;
if (!token) {
  console.error('api: DEMO_API_TOKEN is not set');
  process.exit(1);
}

const port = Number(process.env.PORT ?? 5341);
const host = process.env.HOST ?? '127.0.0.1';
const tasks = [];
let nextId = 1;

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(body === undefined ? '' : JSON.stringify(body));
}

async function readJson(req) {
  let body = '';
  for await (const chunk of req) body += chunk;
  try { return JSON.parse(body || '{}'); } catch { return null; }
}

async function handle(req, res, pathname) {
  if (pathname === '/health' && req.method === 'GET') return send(res, 200, { ok: true });
  if (pathname === '/tasks' || pathname.startsWith('/tasks/')) {
    if (req.headers.authorization !== `Bearer ${token}`) return send(res, 401, { error: 'unauthorized' });
    if (pathname === '/tasks' && req.method === 'GET') return send(res, 200, tasks);
    if (pathname === '/tasks' && req.method === 'POST') {
      const body = await readJson(req);
      const title = typeof body?.title === 'string' ? body.title.trim() : '';
      if (!title) return send(res, 400, { error: 'title is required' });
      const task = { id: String(nextId++), title, status: 'queued' };
      tasks.push(task);
      return send(res, 201, task);
    }
    const done = /^\/tasks\/([\w-]+)\/done$/.exec(pathname);
    if (done && req.method === 'POST') {
      const task = tasks.find((t) => t.id === done[1]);
      if (!task) return send(res, 404, { error: 'not found' });
      task.status = 'done';
      return send(res, 200, task);
    }
  }
  return send(res, 404, { error: 'not found' });
}

const server = createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  try {
    await handle(req, res, pathname);
  } catch (err) {
    send(res, 500, { error: String(err) });
  }
  // One line per request; headers (and so the token) are never logged.
  console.log(`api: ${req.method} ${pathname} ${res.statusCode}`);
});

server.on('error', (err) => {
  console.error(`api: failed to listen on ${host}:${port}: ${err.message}`);
  process.exit(1);
});
server.listen(port, host, () => console.log(`api: listening on http://${host}:${port}`));
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log('api: shutting down');
    server.close(() => process.exit(0));
    server.closeAllConnections();
  });
}
