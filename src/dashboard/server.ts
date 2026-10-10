// Local live dashboard. Serves a monitoring page, the session's typed event stream (SSE) and the
// active device's viewport (MJPEG), bound to 127.0.0.1 and gated by per-session access tokens.
// Contains no session logic: state comes from SessionFeed, frames from the Lab's screencast, and
// supervision requests (pause, takeover, stop, a person's input) are forwarded to the session owner.
//
// Two tokens: the view token (in the URL agents receive) reads; only the control token (the URL a
// person gets from `agentlab ui`) may POST control requests and input.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FeedMessage, SessionFeed } from '../core/feed.js';
import type { ScreencastOptions } from '../core/lab.js';
import type { ControlState } from '../core/control.js';
import { LabError } from '../core/schema.js';

/** What the dashboard needs from a session to show its viewport. The Lab satisfies it. */
export interface FrameSource {
  readonly active: boolean;
  screencast(onFrame: (jpeg: Buffer) => void, opts: ScreencastOptions): Promise<() => Promise<void>>;
}

export interface DashboardOptions {
  feed: SessionFeed;
  /** The current session's frame source (it changes when a new session starts). */
  source: () => FrameSource | undefined;
  /** Default 0: an ephemeral port. */
  port?: number;
  screencast?: Partial<ScreencastOptions>;
  /** Apply a person's supervision request (pause, resume, takeover, return, stop, emergency-stop). */
  control?: (op: string, by: string) => ControlState | Promise<ControlState>;
  /** Forward a person's input (tap, key, text, scroll) while they have taken control. */
  input?: (input: unknown) => Promise<void>;
}

export interface DashboardStats {
  viewers: { events: number; frames: number };
  screencast: { running: boolean; starts: number; stops: number; framesCaptured: number; framesSent: number; bytesSent: number };
}

// Preserve desktop text at 1× CSS resolution; Lab never upscales smaller devices.
// Keep the rate conservative: clearer frames need more encoding and bandwidth.
export const DEFAULT_SCREENCAST: ScreencastOptions = { maxFps: 5, maxWidth: 1920, quality: 85 };
const BOUNDARY = 'agentlab-frame';
const PART = `\r\n--${BOUNDARY}\r\nContent-Type: image/jpeg\r\n\r\n`;
/** A slow viewer skips frames rather than buffering them without limit. */
const MAX_BUFFERED = 512 * 1024;
const HEARTBEAT_MS = 15_000;
/** Open streams per dashboard; more are refused (503) rather than served without limit. */
const MAX_EVENT_STREAMS = 32;
const MAX_VIEWERS = 8;
const MAX_BODY = 8 * 1024;

const STATIC_DIR = new URL('../../assets/dashboard/', import.meta.url);
const STATIC: Record<string, { file: string; type: string }> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/app.css': { file: 'app.css', type: 'text/css; charset=utf-8' },
};
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const newToken = () => randomBytes(24).toString('base64url');

export class Dashboard {
  private readonly server: Server;
  private readonly assets = new Map<string, Buffer>();
  /** Full access, including control; only ever given to the person (`agentlab ui`). */
  private token = newToken();
  /** Read-only access; this is the URL placed in start and status results that agents see. */
  private viewToken = newToken();
  private readonly events = new Set<ServerResponse>();
  private readonly viewers = new Set<ServerResponse>();
  private lastFrame?: Buffer;
  private cast?: Promise<(() => Promise<void>) | undefined>;
  private readonly castOpts: ScreencastOptions;
  private readonly stats: DashboardStats['screencast'] = { running: false, starts: 0, stops: 0, framesCaptured: 0, framesSent: 0, bytesSent: 0 };
  private readonly unsubscribe: () => void;
  private heartbeat?: ReturnType<typeof setInterval>;
  private closed = false;
  private port = 0;

  private constructor(private readonly opts: DashboardOptions) {
    this.castOpts = { ...DEFAULT_SCREENCAST, ...opts.screencast };
    for (const { file } of Object.values(STATIC)) this.assets.set(file, readFileSync(new URL(file, STATIC_DIR)));
    this.server = createServer((req, res) => this.route(req, res));
    this.unsubscribe = opts.feed.subscribe((m) => this.onMessage(m));
  }

  static async listen(opts: DashboardOptions): Promise<Dashboard> {
    const d = new Dashboard(opts);
    await new Promise<void>((resolve, reject) => {
      d.server.once('error', reject);
      d.server.listen(opts.port ?? 0, '127.0.0.1', () => resolve());
    });
    d.port = (d.server.address() as AddressInfo).port;
    d.heartbeat = setInterval(() => { for (const res of d.events) res.write(': ping\n\n'); }, HEARTBEAT_MS);
    d.heartbeat.unref();
    return d;
  }

  /** The person's URL (control and view). The token is in the fragment, so it is never sent in requests or Referer headers. */
  get url(): string {
    return `http://127.0.0.1:${this.port}/#token=${this.token}`;
  }

  /** A view-only URL: monitoring works, control requests are refused. This is what agents are given. */
  get viewUrl(): string {
    return `http://127.0.0.1:${this.port}/#token=${this.viewToken}`;
  }

  get origin(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  getStats(): DashboardStats {
    return { viewers: { events: this.events.size, frames: this.viewers.size }, screencast: { ...this.stats } };
  }

  /** Stop frame capture, end every stream and close the listening socket. Idempotent. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribe();
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.endStreams();
    await this.stopCast();
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  // ---------- feed ----------

  private onMessage(m: FeedMessage): void {
    if (m.event.type === 'reset') {
      // A new session: previous viewers and the old tokens lose access.
      this.token = newToken();
      this.viewToken = newToken();
      this.lastFrame = undefined;
      this.endStreams();
      void this.stopCast();
      return;
    }
    const frame = `id: ${m.seq}\nevent: feed\ndata: ${JSON.stringify(m)}\n\n`;
    for (const res of this.events) res.write(frame);
    if (m.event.type === 'status') {
      const state = m.event.status.state;
      if (state === 'active') void this.ensureCast();
      if (state === 'ended' || state === 'failed') {
        void this.stopCast().then(() => { for (const res of this.viewers) res.end(); this.viewers.clear(); });
      }
    }
  }

  private endStreams(): void {
    for (const res of [...this.events, ...this.viewers]) res.end();
    this.events.clear();
    this.viewers.clear();
  }

  // ---------- screencast ----------

  private async ensureCast(): Promise<void> {
    if (this.cast || this.closed || !this.viewers.size) return;
    const source = this.opts.source();
    if (!source?.active) return;
    const pending = source.screencast((jpeg) => this.onFrame(jpeg), this.castOpts).catch(() => undefined);
    this.cast = pending;
    const stop = await pending;
    if (!stop) {
      if (this.cast === pending) this.cast = undefined;
      return;
    }
    this.stats.starts++;
    this.stats.running = true;
    // Every viewer left while capture was starting (a concurrent stopCast already handled a replaced one).
    if (this.cast === pending && !this.viewers.size) await this.stopCast(pending);
  }

  private async stopCast(which = this.cast): Promise<void> {
    if (!which) return;
    if (this.cast === which) this.cast = undefined;
    const stop = await which;
    if (!stop) return;
    await stop();
    this.stats.stops++;
    this.stats.running = !!this.cast;
  }

  private onFrame(jpeg: Buffer): void {
    this.lastFrame = jpeg;
    this.stats.framesCaptured++;
    for (const res of this.viewers) this.sendFrame(res, jpeg);
  }

  /**
   * Chromium shows a multipart part only once the next part has begun, so every frame is followed at
   * once by the next part's boundary and headers (otherwise an idle page's last frame never shows).
   */
  private sendFrame(res: ServerResponse, jpeg: Buffer): void {
    if (res.writableLength > MAX_BUFFERED) return;
    res.write(jpeg);
    res.write(PART);
    this.stats.framesSent++;
    this.stats.bytesSent += jpeg.length;
  }

  // ---------- HTTP ----------

  private route(req: IncomingMessage, res: ServerResponse): void {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // DNS rebinding and cross-site requests: only this exact loopback origin may talk to the dashboard.
    const hosts = [`127.0.0.1:${this.port}`, `localhost:${this.port}`];
    if (!hosts.includes(req.headers.host ?? '')) return void res.writeHead(403).end('forbidden host\n');
    const origin = req.headers.origin;
    if (origin !== undefined && !hosts.some((h) => origin === `http://${h}`)) return void res.writeHead(403).end('forbidden origin\n');
    const url = new URL(req.url ?? '/', this.origin);
    if (req.method === 'POST' && (url.pathname === '/api/control' || url.pathname === '/api/input')) return void this.post(req, res, url.pathname);
    if (req.method !== 'GET') return void res.writeHead(405, { allow: 'GET' }).end();

    const asset = STATIC[url.pathname];
    if (asset) {
      // Static code only; no session data is served without the token.
      res.writeHead(200, { 'content-type': asset.type, 'content-security-policy': CSP, 'x-frame-options': 'DENY' });
      return void res.end(this.assets.get(asset.file));
    }
    if (!url.pathname.startsWith('/api/')) return void res.writeHead(404).end();
    if (!this.authorized(req, url)) {
      return void res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'missing or invalid dashboard token; open the URL printed by `agentlab ui`' }));
    }

    if (url.pathname === '/api/state') return this.json(res, { ...this.opts.feed.snapshot(), stats: this.getStats(), canControl: this.canControl(req, url) });
    if (url.pathname === '/api/events') return this.openEvents(req, res, url);
    if (url.pathname === '/api/viewport') return this.openViewport(res);
    const frame = /^\/api\/frames\/(F\d{1,6})(?:-(\d{1,2}))?\.jpg$/.exec(url.pathname);
    if (frame) return void this.sendFile(res, frame[2] === undefined ? this.opts.feed.frameFile(frame[1]!) : this.opts.feed.extraFrameFile(frame[1]!, Number(frame[2])));
    const scanFrame = /^\/api\/scans\/(R\d{1,6})\/(\d{1,4})\/(s\d{1,4})\.jpg$/.exec(url.pathname);
    if (scanFrame) return void this.sendFile(res, this.opts.feed.scanFrameFile(scanFrame[1]!, Number(scanFrame[2]), scanFrame[3]!));
    const sweep = /^\/api\/sweeps\/(S\d{1,6})\/([a-z0-9-]{1,40})\.jpg$/.exec(url.pathname);
    if (sweep) return void this.sendFile(res, this.opts.feed.sweepFrameFile(sweep[1]!, sweep[2]!));
    res.writeHead(404).end();
  }

  private authorized(req: IncomingMessage, url: URL): boolean {
    const header = req.headers.authorization;
    const given = header?.startsWith('Bearer ') ? header.slice(7) : url.searchParams.get('token');
    return !!given && (same(given, this.token) || same(given, this.viewToken));
  }

  /** Whether this request carries the control token (the page shows control buttons only then). */
  private canControl(req: IncomingMessage, url: URL): boolean {
    const header = req.headers.authorization;
    const given = header?.startsWith('Bearer ') ? header.slice(7) : url.searchParams.get('token');
    return !!given && !!this.opts.control && same(given, this.token);
  }

  /**
   * POST /api/control {op} and /api/input {type, …}. Only the control token, only in an Authorization
   * header (never a query string), only from this exact origin, only JSON, and bodies of at most 8 KB.
   * A cross-site page cannot send the header without a CORS preflight, which is never answered.
   */
  private post(req: IncomingMessage, res: ServerResponse, path: string): void {
    const reply = (status: number, body: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ') || !same(header.slice(7), this.token)) return void reply(401, { error: 'control needs the dashboard URL from `agentlab ui` (this one is view-only or expired)' });
    if (req.headers.origin !== this.origin && req.headers.origin !== `http://localhost:${this.port}`) return void reply(403, { error: 'forbidden origin' });
    const site = req.headers['sec-fetch-site'];
    if (site !== undefined && site !== 'same-origin') return void reply(403, { error: 'forbidden site' });
    if (!/^application\/json\b/.test(req.headers['content-type'] ?? '')) return void reply(415, { error: 'send application/json' });
    const handler = path === '/api/control' ? this.opts.control : this.opts.input;
    if (!handler) return void reply(404, { error: 'this dashboard has no session to control' });
    let size = 0;
    const chunks: Buffer[] = [];
    let aborted = false;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY && !aborted) { aborted = true; res.setHeader('connection', 'close'); res.once('finish', () => req.destroy()); reply(413, { error: 'request too large' }); return; }
      if (!aborted) chunks.push(c);
    });
    req.on('end', () => {
      if (aborted) return;
      let body: Record<string, unknown>;
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object');
        body = parsed as Record<string, unknown>;
      } catch {
        return void reply(400, { error: 'body must be a JSON object' });
      }
      void (async () => {
        try {
          if (path === '/api/control') {
            if (typeof body.op !== 'string') return reply(400, { error: 'op is required' });
            reply(200, { control: await this.opts.control!(body.op, 'dashboard') });
          } else {
            await this.opts.input!(body);
            reply(200, { ok: true });
          }
        } catch (err) {
          const e = LabError.from(err).toJSON();
          reply(e.code === 'invalid_control' ? 409 : e.code === 'invalid_request' ? 400 : e.code === 'no_session' || e.code === 'browser_closed' ? 410 : 500,
            { error: e.message, code: e.code });
        }
      })();
    });
  }

  private json(res: ServerResponse, body: unknown): void {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  }

  /**
   * Server-sent events. A new connection gets a snapshot; a reconnect with Last-Event-ID gets only the
   * messages it missed, or a fresh snapshot when those are no longer buffered.
   */
  private openEvents(req: IncomingMessage, res: ServerResponse, url: URL): void {
    if (this.events.size >= MAX_EVENT_STREAMS) return void res.writeHead(503, { 'retry-after': '5' }).end('too many open dashboards\n');
    res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.write('retry: 1000\n\n');
    const last = req.headers['last-event-id'] ?? url.searchParams.get('since');
    const missed = last !== undefined && last !== null && /^\d+$/.test(String(last)) ? this.opts.feed.since(Number(last)) : undefined;
    if (missed) {
      for (const m of missed) res.write(`id: ${m.seq}\nevent: feed\ndata: ${JSON.stringify(m)}\n\n`);
    } else {
      const snap = this.opts.feed.snapshot();
      res.write(`id: ${snap.seq}\nevent: snapshot\ndata: ${JSON.stringify(snap)}\n\n`);
    }
    this.events.add(res);
    res.on('close', () => { this.events.delete(res); });
  }

  /** MJPEG stream of the live viewport. Capture runs only while at least one of these is open. */
  private openViewport(res: ServerResponse): void {
    if (this.viewers.size >= MAX_VIEWERS) return void res.writeHead(503, { 'retry-after': '5' }).end('too many viewport viewers\n');
    res.writeHead(200, { 'content-type': `multipart/x-mixed-replace; boundary=${BOUNDARY}`, connection: 'close' });
    res.write(PART);
    this.viewers.add(res);
    res.on('close', () => {
      this.viewers.delete(res);
      if (!this.viewers.size) void this.stopCast();
    });
    if (this.lastFrame) this.sendFrame(res, this.lastFrame);
    const state = this.opts.feed.state;
    if (state === 'ended' || state === 'failed') {
      // Nothing more will come: show the final frame and finish.
      this.viewers.delete(res);
      res.end();
      return;
    }
    void this.ensureCast();
  }

  /** Only files the feed recorded (evidence, sweep and scan frames in the run directory) are ever served. */
  private async sendFile(res: ServerResponse, file: string | undefined): Promise<void> {
    if (!file) return void res.writeHead(404).end();
    try {
      const data = await readFile(file);
      res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': data.length }).end(data);
    } catch {
      res.writeHead(404).end();
    }
  }
}

function same(given: string, token: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}
