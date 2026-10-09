import { randomBytes } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { LabError, type LabErrorCode } from './schema.js';
import { readZip, writeZip, ZipError, type ZipEntry } from './zip.js';

/**
 * Fail-closed sanitizer for Playwright trace zips, so a trace can leave the machine as a CI artifact or failure
 * bundle. Product rule: it must never contain authentication state, request bodies, password values, sensitive
 * headers or uploaded-file contents.
 *
 * What Playwright 1.63 records (verified by test/trace-sanitize.test.mjs, which is also the format-compatibility
 * test: a Playwright upgrade that changes the format fails there, and unknown entries fail here):
 * - `trace.trace` (JSON lines): `context-options` (extraHTTPHeaders, httpCredentials, storageState with cookie
 *   values and localStorage), `before`/`after` calls with `params` (fill `value`, type `text`, evaluate
 *   `expression`, addCookies `cookies`), `log` lines that repeat those values, `frame-snapshot` DOM arrays where
 *   every input carries `__playwright_value_` (including `<input type=password>`), and `screencast-frame`s.
 * - `trace.network` (JSON lines): `resource-snapshot` HAR-like entries with request/response headers, cookies,
 *   `queryString`, `postData` and a `content._file` blob for every body.
 * - `trace.stacks` (JSON): source locations. `resources/<sha1>.<ext>` blobs and `screencast/*.jpeg` frames.
 *
 * Structural removals come first; then every known secret (the caller's, plus values learned while sanitizing)
 * is searched for in raw, JSON-escaped, URL-encoded, HTML-escaped and base64 forms across every entry. Text
 * entries get the occurrences replaced, binary blobs holding one are dropped, and a residual is an error.
 *
 * Deliberate limits, all fail-closed except where noted: `evaluate*` expressions, arguments and results are
 * masked wholesale (code cannot be sanitized structurally); an entry this module does not know is an error;
 * screenshots are kept (they show what the page showed, and password fields render as dots); console text and
 * page-owned DOM text are only covered by the known-secret pass; keys pressed one at a time are masked only
 * when they are a single character.
 */

const REDACTED = '\u2039redacted\u203A';
const MIN_SECRET = 4;
/** Values learned from the trace itself are replaced everywhere only above this length, to avoid mangling text. */
const MIN_LEARNED = 6;

export interface TraceSanitizeReport {
  /** Entries in the input trace. */
  entries: number;
  /** Entries left out of the output: recorded sources, dropped bodies and blobs that held a secret. */
  removedEntries: number;
  /** Values replaced with a marker: typed text, cookie and header values, input values, query parameters. */
  maskedValues: number;
  /** Request bodies and response bodies dropped. */
  droppedBodies: number;
  /** Sensitive request, response and context headers removed. */
  strippedHeaders: number;
}

type Rec = Record<string, unknown>;

const UNSANITIZABLE: LabErrorCode = 'trace_unsanitizable';

function unsanitizable(message: string): never {
  throw new LabError(UNSANITIZABLE, message, { hint: 'The trace was not written. Do not attach the raw trace to an artifact.' });
}

const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);

const SECRET_NAME = /token|secret|session|auth|key|cookie|signature|credential|csrf|xsrf|passw/i;
const SENSITIVE_HEADERS = new Set([
  'authorization', 'proxy-authorization', 'cookie', 'set-cookie', 'x-api-key', 'x-auth-token', 'x-csrf-token', 'x-xsrf-token',
]);
const isSensitiveName = (name: string): boolean => SENSITIVE_HEADERS.has(name.toLowerCase()) || SECRET_NAME.test(name);

/** Response bodies are kept only for these resource types; everything else (xhr, fetch, websocket, ...) is dropped. */
const KEEP_BODY_TYPES = new Set(['document', 'stylesheet', 'script', 'image', 'font', 'media']);
const CODE_METHOD = /evaluate|waitForFunction|addInitScript|addScriptTag|addStyleTag|exposeBinding|exposeFunction/i;
const KEY_DELETE = new Set(['storageState', 'httpCredentials', 'clientCertificates']);
const KEY_MASK = /^(password|passwd|pwd|secret|authorization|postData|jsonData|formData|multipartData|accessToken|refreshToken|idToken|apiKey)$/i;

const QUERY_RE = /([?&#;])([^=&#;\s"'\\<>]*(?:token|secret|session|auth|key|cookie|signature|credential|csrf|xsrf|password)[^=&#;\s"'\\<>]*)=([^&#;\s"'\\<>]+)/gi;

interface Body {
  content: Rec;
  ref: string | undefined;
}

class State {
  maskedValues = 0;
  droppedBodies = 0;
  strippedHeaders = 0;
  /** Values learned while sanitizing (cookie values, header values, sensitive input values). */
  readonly learned = new Set<string>();
  /** Blob entry names whose reference was removed; deleted if nothing else refers to them. */
  readonly droppedBlobs = new Set<string>();
  /** Kept response bodies, re-checked against the full secret set before serializing. */
  readonly keptBodies: Body[] = [];
  contextOptions = 0;
  constructor(readonly blobNames: ReadonlyMap<string, string>) {}

  note(value: unknown, min = MIN_LEARNED): void {
    if (typeof value === 'string' && value.length >= min) this.learned.add(value);
  }

  noteHeader(value: unknown): void {
    if (typeof value !== 'string') return;
    this.note(value);
    const scheme = /^(?:bearer|basic|token|digest)\s+(.+)$/i.exec(value);
    if (scheme) this.note(scheme[1]);
    if (value.includes('=')) for (const part of value.split(';')) this.note(part.slice(part.indexOf('=') + 1).trim());
  }

  /** Resolves a `_file` or `_sha1` reference to the zip entry name it points at. */
  blobFor(ref: unknown): string | undefined {
    if (typeof ref !== 'string' || ref === '') return undefined;
    return this.blobNames.get(ref) ?? this.blobNames.get(`resources/${ref}`) ?? this.blobNames.get(basename(ref).split('.')[0] ?? '');
  }
}

function stripHeaders(list: unknown, st: State): unknown {
  if (Array.isArray(list)) {
    return list.filter((h) => {
      if (isRec(h) && typeof h.name === 'string' && isSensitiveName(h.name)) {
        st.noteHeader(h.value);
        st.strippedHeaders++;
        return false;
      }
      return true;
    });
  }
  if (isRec(list)) {
    for (const k of Object.keys(list)) {
      if (!isSensitiveName(k)) continue;
      st.noteHeader(list[k]);
      delete list[k];
      st.strippedHeaders++;
    }
  }
  return list;
}

function maskCookies(list: unknown, st: State): void {
  if (!Array.isArray(list)) return;
  for (const c of list) {
    if (isRec(c) && typeof c.value === 'string' && c.value !== REDACTED) {
      st.note(c.value);
      c.value = REDACTED;
      st.maskedValues++;
    }
  }
}

/** Generic structural pass over any parsed trace JSON: name/value pairs, headers, cookies and secret-named keys. */
function deep(v: unknown, st: State): void {
  if (Array.isArray(v)) {
    for (const x of v) deep(x, st);
    return;
  }
  if (!isRec(v)) return;
  if (typeof v.name === 'string' && typeof v.value === 'string' && v.value !== REDACTED && SECRET_NAME.test(v.name)) {
    st.note(v.value);
    v.value = REDACTED;
    st.maskedValues++;
  }
  for (const k of Object.keys(v)) {
    const val = v[k];
    if (KEY_DELETE.has(k)) {
      delete v[k];
      st.maskedValues++;
      continue;
    }
    if (KEY_MASK.test(k) && val !== undefined && val !== null && val !== '' && val !== REDACTED) {
      st.note(val);
      v[k] = REDACTED;
      st.maskedValues++;
      continue;
    }
    if (k === 'headers' || k === 'extraHTTPHeaders') v[k] = stripHeaders(val, st);
    else if (k === 'cookies') maskCookies(val, st);
    deep(v[k], st);
  }
}

function collectSecrets(v: unknown, st: State): void {
  if (Array.isArray(v)) return void v.forEach((x) => collectSecrets(x, st));
  if (!isRec(v)) return;
  for (const [k, val] of Object.entries(v)) {
    if (typeof val === 'string' && /^(value|password|token)$/i.test(k)) st.note(val, MIN_SECRET);
    else collectSecrets(val, st);
  }
}

function sanitizeContextOptions(ev: Rec, st: State): void {
  st.contextOptions++;
  const opts = ev.options;
  if (!isRec(opts)) return;
  for (const key of KEY_DELETE) {
    if (key in opts) {
      collectSecrets(opts[key], st);
      delete opts[key];
      st.maskedValues++;
    }
  }
  if (isRec(opts.proxy)) {
    st.note(opts.proxy.password, MIN_SECRET);
    delete opts.proxy.username;
    delete opts.proxy.password;
  }
  if ('extraHTTPHeaders' in opts) opts.extraHTTPHeaders = stripHeaders(opts.extraHTTPHeaders, st);
}

function sanitizeBefore(ev: Rec, st: State, callValues: Map<string, string[]>, codeCalls: Set<string>): void {
  const params = ev.params;
  if (!isRec(params)) return;
  const method = typeof ev.method === 'string' ? ev.method : '';
  const values: string[] = [];
  for (const k of ['value', 'text']) {
    const v = params[k];
    if (typeof v === 'string' && v !== '' && v !== REDACTED) {
      values.push(v);
      params[k] = REDACTED;
      st.maskedValues++;
    }
  }
  if (typeof params.key === 'string' && [...params.key].length === 1) {
    values.push(params.key);
    params.key = REDACTED;
    st.maskedValues++;
  }
  if (CODE_METHOD.test(method)) {
    if (typeof ev.callId === 'string') codeCalls.add(ev.callId);
    for (const k of ['expression', 'arg', 'source', 'script', 'content']) {
      if (params[k] !== undefined && params[k] !== REDACTED) {
        params[k] = REDACTED;
        st.maskedValues++;
      }
    }
  }
  if (typeof params.expression === 'string' && /value/i.test(params.expression)) {
    for (const k of ['expectedText', 'expectedValue']) {
      if (params[k] !== undefined && params[k] !== REDACTED) {
        params[k] = REDACTED;
        st.maskedValues++;
      }
    }
  }
  if (Array.isArray(params.payloads)) {
    for (const p of params.payloads) {
      if (isRec(p) && p.buffer !== undefined && p.buffer !== '<Buffer>') {
        p.buffer = '<Buffer>';
        st.maskedValues++;
      }
    }
  }
  if (values.length && typeof ev.callId === 'string') callValues.set(ev.callId, values);
}

function isSensitiveField(attrs: Rec): boolean {
  const type = typeof attrs.type === 'string' ? attrs.type.toLowerCase() : '';
  if (type === 'password' || type === 'hidden') return true;
  if (typeof attrs.autocomplete === 'string' && /password|one-time-code|cc-number|cc-csc|cc-exp/i.test(attrs.autocomplete)) return true;
  for (const k of ['name', 'id']) {
    const v = attrs[k];
    if (typeof v === 'string' && /pass(word|wd)?|pwd|otp|cvv|cvc|secret|token|api[-_]?key|csrf|xsrf|credential/i.test(v)) return true;
  }
  return false;
}

/**
 * A snapshot node is a string (text), `[tag, attrs?, ...children]`, or `[[snapshotsAgo, index]]` (a reference to
 * a node of an earlier snapshot, which was sanitized when that snapshot was processed).
 */
function scrubSnapshot(node: unknown, st: State, onSensitiveTarget: () => void): void {
  if (!Array.isArray(node) || typeof node[0] !== 'string') return;
  const tag = node[0].toLowerCase();
  const attrs = isRec(node[1]) ? node[1] : undefined;
  if (attrs && (tag === 'input' || tag === 'textarea') && isSensitiveField(attrs)) {
    for (const k of ['__playwright_value_', 'value']) {
      const v = attrs[k];
      if (typeof v === 'string' && v !== '' && v !== REDACTED) {
        st.note(v, MIN_SECRET);
        attrs[k] = REDACTED;
        st.maskedValues++;
      }
    }
    if ('__playwright_target__' in attrs) onSensitiveTarget();
  }
  for (let i = attrs ? 2 : 1; i < node.length; i++) scrubSnapshot(node[i], st, onSensitiveTarget);
}

function dropContent(content: Rec, ref: string | undefined, st: State): void {
  delete content._file;
  delete content._sha1;
  delete content.text;
  const blob = st.blobFor(ref);
  if (blob) st.droppedBlobs.add(blob);
  st.droppedBodies++;
}

function sanitizeResource(snap: Rec, st: State): void {
  const req = snap.request;
  if (isRec(req)) {
    req.headers = stripHeaders(req.headers, st);
    if (Array.isArray(req.cookies)) {
      maskCookies(req.cookies, st);
      req.cookies = [];
    }
    if (isRec(req.postData)) {
      const ref = req.postData._file ?? req.postData._sha1;
      const blob = st.blobFor(ref);
      if (blob) st.droppedBlobs.add(blob);
      delete req.postData;
      st.droppedBodies++;
    }
  }
  const res = snap.response;
  if (isRec(res)) {
    res.headers = stripHeaders(res.headers, st);
    if (Array.isArray(res.cookies)) {
      maskCookies(res.cookies, st);
      res.cookies = [];
    }
    const content = res.content;
    if (isRec(content)) {
      const ref = (content._file ?? content._sha1) as string | undefined;
      const type = typeof snap._resourceType === 'string' ? snap._resourceType : 'other';
      if (!KEEP_BODY_TYPES.has(type)) {
        if (ref !== undefined || content.text !== undefined) dropContent(content, ref, st);
      } else if (ref !== undefined || content.text !== undefined) st.keptBodies.push({ content, ref });
    }
  }
}

/** Replaces `value` in every string of an event (used for the log lines and titles that repeat a typed value). */
function replaceInStrings(v: unknown, values: readonly string[]): unknown {
  if (typeof v === 'string') {
    let s = v;
    for (const value of values) {
      s = s.split(JSON.stringify(value)).join(JSON.stringify(REDACTED));
      if (value.length >= 3) s = s.split(value).join(REDACTED);
    }
    return s;
  }
  if (Array.isArray(v)) return v.map((x) => replaceInStrings(x, values));
  if (isRec(v)) {
    for (const k of Object.keys(v)) v[k] = replaceInStrings(v[k], values);
  }
  return v;
}

function parseLines(name: string, data: Buffer): Rec[] {
  const events: Rec[] = [];
  for (const line of data.toString('utf8').split('\n')) {
    if (line.trim() === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return unsanitizable(`${name} has a line that is not valid JSON (unexpected trace format)`);
    }
    if (!isRec(parsed) || typeof parsed.type !== 'string') return unsanitizable(`${name} has an unexpected event shape`);
    events.push(parsed);
  }
  return events;
}

function processEvents(events: Rec[], st: State): void {
  const callValues = new Map<string, string[]>();
  const codeCalls = new Set<string>();
  const sensitiveCalls = new Set<string>();
  for (const ev of events) {
    switch (ev.type) {
      case 'context-options':
        sanitizeContextOptions(ev, st);
        break;
      case 'before':
        sanitizeBefore(ev, st, callValues, codeCalls);
        break;
      case 'after':
        if (typeof ev.callId === 'string' && codeCalls.has(ev.callId) && ev.result !== undefined && ev.result !== REDACTED) {
          ev.result = REDACTED;
          st.maskedValues++;
        }
        break;
      case 'frame-snapshot': {
        const snap = ev.snapshot;
        if (isRec(snap)) {
          const callId = typeof snap.callId === 'string' ? snap.callId : undefined;
          scrubSnapshot(snap.html, st, () => callId && sensitiveCalls.add(callId));
        }
        break;
      }
      case 'resource-snapshot':
        if (isRec(ev.snapshot)) sanitizeResource(ev.snapshot, st);
        break;
      default:
        break;
    }
    deep(ev, st);
  }
  // A value typed into a sensitive field is learned so it is replaced everywhere, not just in its own call.
  for (const callId of sensitiveCalls) for (const v of callValues.get(callId) ?? []) st.note(v, MIN_SECRET);
  for (let i = 0; i < events.length; i++) {
    const ev = events[i] as Rec;
    const callId = typeof ev.callId === 'string' ? ev.callId : undefined;
    const values = callId ? callValues.get(callId) : undefined;
    if (values && ev.type !== 'frame-snapshot') events[i] = replaceInStrings(ev, values) as Rec;
  }
}

// ---------- known-secret search ----------

interface Variants {
  strings: string[];
}

function base64Variants(s: string): string[] {
  const bytes = Buffer.from(s, 'utf8');
  const out: string[] = [];
  for (let k = 0; k < 3; k++) {
    const padded = Buffer.concat([Buffer.alloc(k), bytes]);
    let e = padded.toString('base64').replace(/=+$/, '');
    if (padded.length % 3 !== 0) e = e.slice(0, -1); // the last character also depends on the following byte
    e = e.slice([0, 2, 3][k] as number); // leading characters that also depend on the preceding bytes
    if (e.length >= 4) out.push(e, e.replace(/\+/g, '-').replace(/\//g, '_'));
  }
  return out;
}

function variantsOf(secret: string): string[] {
  const forms = new Set<string>([
    secret,
    JSON.stringify(secret).slice(1, -1),
    encodeURIComponent(secret),
    encodeURIComponent(secret).replace(/%20/g, '+'),
    secret.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
    ...base64Variants(secret),
  ]);
  return [...forms].filter((f) => f.length > 0);
}

function buildVariants(secrets: Iterable<string>): Variants {
  const all = new Set<string>();
  for (const s of secrets) for (const v of variantsOf(s)) all.add(v);
  return { strings: [...all].sort((a, b) => b.length - a.length) };
}

function replaceVariants(text: string, variants: Variants): { text: string; hits: number } {
  let hits = 0;
  let out = text;
  for (const v of variants.strings) {
    if (!out.includes(v)) continue;
    const parts = out.split(v);
    hits += parts.length - 1;
    out = parts.join(REDACTED);
  }
  return { text: out, hits };
}

function bytesContain(data: Buffer, variants: Variants): boolean {
  return variants.strings.some((v) => data.includes(Buffer.from(v, 'utf8')));
}

function asText(data: Buffer): string | undefined {
  if (data.includes(0)) return undefined;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    return undefined;
  }
}

function assertNoSecrets(entries: readonly ZipEntry[], variants: Variants): void {
  for (const e of entries) {
    if (bytesContain(e.data, variants)) unsanitizable(`a known secret is still present in ${e.name}`);
  }
}

// ---------- entry classification ----------

type Kind = 'lines' | 'stacks' | 'blob' | 'source';

function classify(name: string): Kind {
  if (/^resources\/src@/.test(name)) return 'source';
  if (name.endsWith('.trace') || name.endsWith('.network')) return 'lines';
  if (name.endsWith('.stacks')) return 'stacks';
  if (name.startsWith('resources/') || name.startsWith('screencast/')) return 'blob';
  return unsanitizable(`unexpected entry "${name}" in the trace (unknown trace format)`);
}

function sanitizeEntries(entries: ZipEntry[], secrets: readonly string[]): { out: ZipEntry[]; report: TraceSanitizeReport } {
  const kinds = new Map(entries.map((e) => [e.name, classify(e.name)] as const));
  const blobNames = new Map<string, string>();
  for (const e of entries) {
    if (kinds.get(e.name) !== 'blob') continue;
    blobNames.set(e.name, e.name);
    const base = basename(e.name);
    blobNames.set(base, e.name);
    blobNames.set(base.split('.')[0] ?? base, e.name);
  }
  const st = new State(blobNames);
  const known = new Set(secrets.filter((s) => s.length >= MIN_SECRET));

  const lineFiles = new Map<string, Rec[]>();
  const stacks = new Map<string, unknown>();
  for (const e of entries) {
    const kind = kinds.get(e.name);
    if (kind === 'lines') {
      const events = parseLines(e.name, e.data);
      processEvents(events, st);
      lineFiles.set(e.name, events);
    } else if (kind === 'stacks') {
      let parsed: unknown;
      try {
        parsed = JSON.parse(e.data.toString('utf8'));
      } catch {
        return unsanitizable(`${e.name} is not valid JSON (unexpected trace format)`);
      }
      deep(parsed, st);
      stacks.set(e.name, parsed);
    }
  }
  if (st.contextOptions === 0) unsanitizable('the archive has no Playwright trace context (unexpected trace format)');

  const removed = new Set<string>();
  for (const e of entries) if (kinds.get(e.name) === 'source') removed.add(e.name);

  // Documents and other kept bodies that hold a secret are dropped rather than edited.
  const bodyVariants = buildVariants([...known, ...st.learned]);
  const byName = new Map(entries.map((e) => [e.name, e] as const));
  for (const body of st.keptBodies) {
    const blob = st.blobFor(body.ref);
    const data = blob ? byName.get(blob)?.data : undefined;
    if (data && bytesContain(data, bodyVariants)) dropContent(body.content, body.ref, st);
  }

  // Serialize the structured entries, then redact query parameters and known secrets in the text.
  const variants = buildVariants([...known, ...st.learned]);
  const texts = new Map<string, string>();
  for (const [name, events] of lineFiles) texts.set(name, events.map((ev) => JSON.stringify(ev)).join('\n') + '\n');
  for (const [name, value] of stacks) texts.set(name, JSON.stringify(value));
  for (const [name, text] of texts) {
    let next = text.replace(QUERY_RE, (m, sep: string, param: string, value: string) => {
      if (value === 'redacted') return m;
      st.maskedValues++;
      return `${sep}${param}=redacted`;
    });
    next = replaceVariants(next, variants).text;
    for (const line of next.split('\n')) {
      if (line === '') continue;
      try {
        JSON.parse(line);
      } catch {
        unsanitizable(`redaction produced invalid JSON in ${name}`);
      }
    }
    texts.set(name, next);
  }

  // Blobs: drop the ones whose reference was removed (unless something else still refers to them), then apply the
  // known-secret pass, editing text blobs and dropping binary ones.
  const referenced = (blob: string): boolean => {
    const base = basename(blob);
    for (const t of texts.values()) if (t.includes(base)) return true;
    return false;
  };
  for (const blob of st.droppedBlobs) if (!referenced(blob)) removed.add(blob);

  const out: ZipEntry[] = [];
  for (const e of entries) {
    if (removed.has(e.name)) continue;
    const text = texts.get(e.name);
    if (text !== undefined) {
      out.push({ name: e.name, data: Buffer.from(text, 'utf8') });
      continue;
    }
    if (kinds.get(e.name) === 'blob' && bytesContain(e.data, variants)) {
      const asStr = asText(e.data);
      if (asStr === undefined) {
        removed.add(e.name);
        continue;
      }
      out.push({ name: e.name, data: Buffer.from(replaceVariants(asStr, variants).text, 'utf8') });
      continue;
    }
    out.push(e);
  }

  assertNoSecrets(out, variants);
  return {
    out,
    report: {
      entries: entries.length,
      removedEntries: removed.size,
      maskedValues: st.maskedValues,
      droppedBodies: st.droppedBodies,
      strippedHeaders: st.strippedHeaders,
    },
  };
}

/**
 * Reads the Playwright trace at `input` and writes a sanitized copy to `output`. Any failure (unreadable zip,
 * unexpected format, a secret that could not be removed) throws `trace_unsanitizable` and leaves nothing at
 * `output`. The report has counts only; no message or report ever contains a secret value.
 */
export async function sanitizeTrace(input: string, output: string, opts: { secrets?: readonly string[] } = {}): Promise<TraceSanitizeReport> {
  const inPath = resolve(input);
  const outPath = resolve(output);
  if (inPath === outPath) throw new LabError('invalid_request', 'output must differ from the input trace', { hint: 'Write the sanitized trace to a new path.' });
  const tmp = join(dirname(outPath), `.${basename(outPath)}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    let raw: Buffer;
    try {
      raw = await readFile(inPath);
    } catch {
      return unsanitizable('the trace file cannot be read');
    }
    let entries: ZipEntry[];
    try {
      entries = readZip(raw);
    } catch (err) {
      return unsanitizable(err instanceof ZipError ? `the trace is not a usable zip: ${err.message}` : 'the trace is not a usable zip');
    }
    const secrets = (opts.secrets ?? []).filter((s): s is string => typeof s === 'string');
    const { out, report } = sanitizeEntries(entries, secrets);
    const zip = writeZip(out);
    await writeFile(tmp, zip, { mode: 0o600 });
    await rename(tmp, outPath);
    // Verify what is on disk, not what was intended.
    const back = readZip(await readFile(outPath));
    assertNoSecrets(back, buildVariants(secrets.filter((s) => s.length >= MIN_SECRET)));
    return report;
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => undefined);
    await rm(outPath, { force: true }).catch(() => undefined);
    if (err instanceof LabError) throw err;
    // Never forward the original message: parser errors can quote the content that failed to parse.
    return unsanitizable(`the trace could not be sanitized (${err instanceof Error ? err.name : 'unknown error'})`);
  }
}
