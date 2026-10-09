// Background worker for the multi-service example: marks queued tasks done after a short delay.
const apiUrl = process.env.API_URL ?? 'http://127.0.0.1:5341';
const token = process.env.DEMO_API_TOKEN;
if (!token) {
  console.error('worker: DEMO_API_TOKEN is not set');
  process.exit(1);
}
const headers = { authorization: `Bearer ${token}` };
const minQueuedMs = 600;
let timer;
// When each queued task was first seen; the API's task shape has no timestamp.
const firstSeen = new Map();

async function listTasks() {
  const res = await fetch(`${apiUrl}/tasks`, { headers });
  if (!res.ok) throw new Error(`GET /tasks ${res.status}`);
  return res.json();
}

async function waitForApi() {
  for (;;) {
    try {
      await listTasks();
      console.log('worker ready');
      return;
    } catch {
      await new Promise((r) => { timer = setTimeout(r, 200); });
    }
  }
}

async function tick() {
  try {
    const now = Date.now();
    for (const task of await listTasks()) {
      if (task.status !== 'queued') { firstSeen.delete(task.id); continue; }
      if (!firstSeen.has(task.id)) firstSeen.set(task.id, now);
      if (now - firstSeen.get(task.id) < minQueuedMs) continue;
      const res = await fetch(`${apiUrl}/tasks/${encodeURIComponent(task.id)}/done`, { method: 'POST', headers });
      if (res.ok) {
        firstSeen.delete(task.id);
        console.log(`worker: done ${task.id}`);
      }
    }
  } catch (err) {
    console.error(`worker: ${err.message}`);
  }
  timer = setTimeout(tick, 300);
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log('worker: shutting down');
    clearTimeout(timer);
    process.exit(0);
  });
}

await waitForApi();
timer = setTimeout(tick, 300);
