// Minimal SSE and MJPEG clients for dashboard tests (no browser needed).
import { request } from 'node:http';

/** Open an SSE stream. Collects parsed messages; `next(pred)` waits for a matching one. */
export function sse(url, headers = {}) {
  const messages = [];
  const waiters = [];
  let status;
  let ended = false;
  let buf = '';
  const req = request(url, { headers: { accept: 'text/event-stream', ...headers } });
  const opened = new Promise((resolve, reject) => {
    req.on('response', (res) => {
      status = res.statusCode;
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const msg = {};
          for (const line of block.split('\n')) {
            const m = /^(\w+): ?(.*)$/.exec(line);
            if (m) msg[m[1]] = m[2];
          }
          if (msg.data === undefined) continue;
          msg.json = JSON.parse(msg.data);
          messages.push(msg);
          for (const w of [...waiters]) if (w.pred(msg)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(msg); }
        }
      });
      res.on('end', () => { ended = true; for (const w of waiters) w.reject(new Error('stream ended')); });
      res.on('error', () => { ended = true; });
      resolve(res.statusCode);
    });
    req.on('error', reject);
  });
  req.end();
  return {
    messages, opened,
    get status() { return status; },
    get ended() { return ended; },
    /** Resolve with the first message (already received or future) matching pred. */
    next(pred, timeoutMs = 10_000) {
      const found = messages.find(pred);
      if (found) return Promise.resolve(found);
      if (ended) return Promise.reject(new Error('stream ended'));
      return new Promise((resolve, reject) => {
        const w = { pred, resolve, reject };
        waiters.push(w);
        setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) { waiters.splice(i, 1); reject(new Error(`timed out waiting for message; have ${messages.map((m) => m.json?.event?.type ?? m.event).join(',')}`)); } }, timeoutMs).unref();
      });
    },
    waitEnd(timeoutMs = 5000) {
      return new Promise((resolve, reject) => {
        const t0 = Date.now();
        const tick = () => (ended ? resolve() : Date.now() - t0 > timeoutMs ? reject(new Error('stream did not end')) : setTimeout(tick, 20));
        tick();
      });
    },
    close() { req.destroy(); },
  };
}

/** Open an MJPEG stream and count the JPEG images received. */
export function mjpeg(url) {
  const frames = [];
  let bytes = Buffer.alloc(0);
  let ended = false;
  let status;
  const req = request(url);
  const opened = new Promise((resolve, reject) => {
    req.on('response', (res) => {
      status = res.statusCode;
      res.on('data', (chunk) => {
        bytes = Buffer.concat([bytes, chunk]);
        // Complete JPEGs: SOI (FFD8) … EOI (FFD9).
        for (;;) {
          const soi = bytes.indexOf(Buffer.from([0xff, 0xd8]));
          if (soi < 0) break;
          const eoi = bytes.indexOf(Buffer.from([0xff, 0xd9]), soi + 2);
          if (eoi < 0) break;
          frames.push(bytes.subarray(soi, eoi + 2));
          bytes = bytes.subarray(eoi + 2);
        }
      });
      res.on('end', () => { ended = true; });
      res.on('error', () => { ended = true; });
      resolve(res.statusCode);
    });
    req.on('error', reject);
  });
  req.end();
  return {
    frames, opened,
    get status() { return status; },
    get ended() { return ended; },
    close() { req.destroy(); },
  };
}

export const until = async (cond, timeoutMs = 5000, what = 'condition') => {
  const t0 = Date.now();
  while (!(await cond())) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
};
