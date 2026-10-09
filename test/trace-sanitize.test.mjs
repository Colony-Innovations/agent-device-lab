// Trace sanitizer: unit tests for the zip layer and an end-to-end check against a real Playwright trace.
// The end-to-end test doubles as the compatibility test for Playwright's trace format.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { sanitizeTrace } from '../dist/core/trace-sanitize.js';
import { readZip, writeZip, crc32 } from '../dist/core/zip.js';

const MARKERS = {
  cookie: 'SECRET_COOKIE_1a2b3c',
  response: 'SECRET_RESPONSE_4d5e6f',
  query: 'SECRET_QUERY_7g8h9i',
  state: 'SECRET_STATE_0j1k2l',
  header: 'SECRET_HEADER_3m4n5o',
  password: 'SECRET_PASSWORD_6p7q8r',
  file: 'SECRET_FILE_9s0t1u',
  body: 'SECRET_BODY_2v3w4x',
  bearer: 'SECRET_BEARER_5y6z7a',
  // Extras beyond the oracle: credentials and cookies added at runtime.
  httpCredentials: 'SECRET_HTTPCRED_8b9c0d',
  added: 'SECRET_ADDED_1e2f3g',
};

function forms(marker) {
  const out = new Set([marker, JSON.stringify(marker).slice(1, -1), encodeURIComponent(marker)]);
  const bytes = Buffer.from(marker);
  for (let k = 0; k < 3; k++) {
    const padded = Buffer.concat([Buffer.alloc(k), bytes]);
    let e = padded.toString('base64').replace(/=+$/, '');
    if (padded.length % 3) e = e.slice(0, -1);
    out.add(e.slice([0, 2, 3][k]));
  }
  return [...out];
}

function present(entries, marker) {
  const hits = [];
  for (const e of entries) {
    for (const f of forms(marker)) if (e.data.includes(Buffer.from(f))) hits.push(`${e.name} (${f === marker ? 'raw' : f.length})`);
  }
  return hits;
}

async function captureTrace(path) {
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/') {
      res.setHeader('content-type', 'text/html');
      res.end('<!doctype html><html><body><input id="email" type="email"><input id="pw" type="password" autocomplete="current-password"><input id="f" type="file"></body></html>');
    } else if (url.pathname === '/login' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        JSON.parse(body);
        res.setHeader('set-cookie', `sid=${MARKERS.cookie}; Path=/`);
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ token: MARKERS.response }));
      });
    } else if (url.pathname === '/api/me') {
      res.setHeader('content-type', 'application/json');
      res.end('{"me":1}');
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      storageState: {
        cookies: [{ name: 'state', value: MARKERS.state, domain: '127.0.0.1', path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' }],
        origins: [],
      },
      extraHTTPHeaders: { 'x-api-key': MARKERS.header },
      httpCredentials: { username: 'user', password: MARKERS.httpCredentials },
    });
    await context.tracing.start({ screenshots: true, snapshots: true });
    const page = await context.newPage();
    await page.goto(`${base}/`);
    await page.fill('#email', 'someone@example.com');
    await page.fill('#pw', MARKERS.password);
    await page.setInputFiles('#f', { name: 'upload.txt', mimeType: 'text/plain', buffer: Buffer.from(MARKERS.file) });
    await page.evaluate(
      async ([bearer, body, query]) => {
        await fetch('/login', { method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${bearer}` }, body: JSON.stringify({ password: body }) });
        await fetch(`/api/me?token=${query}`);
      },
      [MARKERS.bearer, MARKERS.body, MARKERS.query],
    );
    await page.evaluate(`fetch('/login', { method: 'POST', headers: { Authorization: 'Bearer ${MARKERS.bearer}' }, body: '{"password":"${MARKERS.body}"}' })`);
    await page.waitForTimeout(300); // response bodies are stored asynchronously
    await context.addCookies([{ name: 'added', value: MARKERS.added, url: base }]);
    await context.tracing.stop({ path });
  } finally {
    await browser.close();
    server.close();
  }
}

test('Playwright 1.63 trace format: sanitizer removes secrets', { timeout: 120_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'trace-sanitize-'));
  try {
    const rawPath = join(dir, 'trace.zip');
    const outPath = join(dir, 'sanitized.zip');
    await captureTrace(rawPath);

    // The raw trace must contain secrets, or the assertions below prove nothing. Record which ones.
    const raw = readZip(readFileSync(rawPath));
    const inRaw = Object.entries(MARKERS).filter(([, m]) => present(raw, m).length > 0).map(([k]) => k);
    console.log(`markers present in the raw trace: ${inRaw.join(', ')}`);
    console.log(`raw entries: ${raw.map((e) => e.name).join(', ')}`);
    assert.ok(inRaw.length >= 5, `expected several markers in the raw trace, found ${inRaw.join(', ')}`);
    assert.ok(inRaw.includes('password') && inRaw.includes('bearer') && inRaw.includes('state'));

    const report = await sanitizeTrace(rawPath, outPath, { secrets: [MARKERS.password] });
    console.log(`report: ${JSON.stringify(report)}`);

    const out = readZip(readFileSync(outPath));
    for (const [key, marker] of Object.entries(MARKERS)) {
      assert.deepEqual(present(out, marker), [], `marker "${key}" survived in the sanitized trace`);
    }

    // Still a useful trace: JSON lines parse, actions and screenshots remain, resources of a kept type remain.
    const traceEntry = out.find((e) => e.name.endsWith('.trace'));
    assert.ok(traceEntry, 'trace file is present');
    const events = [];
    for (const e of out.filter((x) => x.name.endsWith('.trace') || x.name.endsWith('.network'))) {
      for (const line of e.data.toString('utf8').split('\n')) if (line) events.push(JSON.parse(line));
    }
    const methods = events.filter((e) => e.type === 'before').map((e) => e.method);
    assert.ok(methods.includes('fill') && methods.includes('goto') && methods.includes('setInputFiles'), `actions kept: ${methods}`);
    assert.ok(out.some((e) => e.name.startsWith('screencast/') && e.name.endsWith('.jpeg')), 'screenshots kept');
    assert.ok(events.some((e) => e.type === 'frame-snapshot'), 'DOM snapshots kept');
    const resources = events.filter((e) => e.type === 'resource-snapshot').map((e) => e.snapshot);
    assert.ok(resources.length >= 3, 'network entries kept');
    for (const r of resources) {
      const names = [...r.request.headers, ...r.response.headers].map((h) => h.name.toLowerCase());
      for (const bad of ['cookie', 'set-cookie', 'authorization', 'x-api-key']) assert.ok(!names.includes(bad), `header ${bad} removed`);
      assert.deepEqual(r.request.cookies, []);
      assert.deepEqual(r.response.cookies, []);
      assert.equal(r.request.postData, undefined);
      if (r._resourceType === 'fetch') assert.equal(r.response.content._file, undefined, 'fetch bodies dropped');
    }
    assert.ok(resources.some((r) => r._resourceType === 'document' && r.response.content._file), 'document body kept');
    const queryUrl = resources.find((r) => r.request.url.includes('/api/me'));
    assert.ok(queryUrl && /token=redacted/.test(queryUrl.request.url), 'query parameter redacted');
    const context = events.find((e) => e.type === 'context-options');
    assert.equal(context.options.storageState, undefined);
    assert.equal(context.options.httpCredentials, undefined);
    assert.deepEqual(context.options.extraHTTPHeaders ?? [], []);

    for (const key of ['entries', 'removedEntries', 'maskedValues', 'droppedBodies', 'strippedHeaders']) {
      assert.ok(report[key] > 0, `report.${key} > 0 (got ${report[key]})`);
    }
    assert.equal(report.entries, raw.length);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a known secret found in a document body drops the body, and one in a binary blob drops the blob', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'trace-sanitize-'));
  try {
    const secret = 'DOCUMENT_SECRET_zz91';
    const html = `<html><body>${secret}</body></html>`;
    const event = (extra) => JSON.stringify(extra) + '\n';
    const trace = event({ version: 9, type: 'context-options', origin: 'library', options: {} });
    const network = event({
      type: 'resource-snapshot',
      snapshot: {
        request: { method: 'GET', url: 'http://x/', headers: [], cookies: [], queryString: [] },
        response: { status: 200, headers: [], cookies: [], content: { size: html.length, mimeType: 'text/html', _file: 'resources/aaaa.html' } },
        _resourceType: 'document',
      },
    });
    const input = join(dir, 'in.zip');
    writeFileSync(
      input,
      writeZip([
        { name: 'trace.trace', data: Buffer.from(trace) },
        { name: 'trace.network', data: Buffer.from(network) },
        { name: 'resources/aaaa.html', data: Buffer.from(html) },
        { name: 'resources/bbbb.bin', data: Buffer.concat([Buffer.from([0xff, 0x00, 0xfe]), Buffer.from(secret)]) },
        { name: 'resources/cccc.txt', data: Buffer.from(`keep me, but not ${secret}`) },
      ]),
    );
    const output = join(dir, 'out.zip');
    const report = await sanitizeTrace(input, output, { secrets: [secret] });
    const out = readZip(readFileSync(output));
    assert.deepEqual(out.map((e) => e.name).sort(), ['resources/cccc.txt', 'trace.network', 'trace.trace']);
    assert.equal(out.find((e) => e.name === 'resources/cccc.txt').data.toString(), 'keep me, but not \u2039redacted\u203A');
    assert.ok(report.droppedBodies >= 1 && report.removedEntries >= 2);
    assert.deepEqual(present(out, secret), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an unreadable or unexpected trace throws trace_unsanitizable and leaves no output', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'trace-sanitize-'));
  try {
    const output = join(dir, 'out.zip');
    const rejects = async (input, secrets) => {
      await assert.rejects(
        sanitizeTrace(input, output, { secrets }),
        (err) => {
          assert.equal(err.code, 'trace_unsanitizable');
          assert.ok(!String(err.message).includes('TOPSECRET'), 'message must not carry secrets');
          return true;
        },
      );
      assert.equal(existsSync(output), false, 'no output file is left behind');
    };

    const garbage = join(dir, 'garbage.zip');
    writeFileSync(garbage, Buffer.from('this is not a zip file, TOPSECRET'));
    await rejects(garbage, ['TOPSECRET']);
    await rejects(join(dir, 'missing.zip'), []);

    // A valid zip with a flipped byte inside the compressed data fails its CRC or inflate.
    const good = writeZip([{ name: 'trace.trace', data: Buffer.from('{"type":"context-options","options":{}}\n'.repeat(50)) }]);
    const flipped = Buffer.from(good);
    flipped[45] ^= 0xff;
    const corrupt = join(dir, 'corrupt.zip');
    writeFileSync(corrupt, flipped);
    await rejects(corrupt, []);

    // Not a Playwright trace: unknown entry names and unparsable lines fail closed.
    const unknown = join(dir, 'unknown.zip');
    writeFileSync(unknown, writeZip([{ name: 'trace.trace', data: Buffer.from('{"type":"context-options"}\n') }, { name: 'notes.txt', data: Buffer.from('hi') }]));
    await rejects(unknown, []);
    const badLine = join(dir, 'badline.zip');
    writeFileSync(badLine, writeZip([{ name: 'trace.trace', data: Buffer.from('{"type":"context-options"}\nnot json TOPSECRET\n') }]));
    await rejects(badLine, ['TOPSECRET']);
    const noContext = join(dir, 'nocontext.zip');
    writeFileSync(noContext, writeZip([{ name: 'trace.trace', data: Buffer.from('{"type":"log"}\n') }]));
    await rejects(noContext, []);

    // A failed run also removes a stale output from an earlier run.
    writeFileSync(output, 'stale');
    await rejects(garbage, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the input and output paths must differ', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'trace-sanitize-'));
  try {
    const p = join(dir, 'a.zip');
    writeFileSync(p, writeZip([{ name: 'trace.trace', data: Buffer.from('{"type":"context-options"}\n') }]));
    await assert.rejects(sanitizeTrace(p, p), (err) => err.code === 'invalid_request');
    assert.ok(existsSync(p), 'the input is untouched');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('zip: round trip, stored entries and data descriptors', () => {
  const entries = [
    { name: 'a.txt', data: Buffer.from('hello world '.repeat(100)) },
    { name: 'dir/empty', data: Buffer.alloc(0) },
    { name: 'bin', data: Buffer.from([0, 1, 2, 255, 254]) },
    { name: 'unicode-\u00e9.txt', data: Buffer.from('caf\u00e9') },
  ];
  const back = readZip(writeZip(entries));
  assert.deepEqual(back.map((e) => e.name), entries.map((e) => e.name));
  for (let i = 0; i < entries.length; i++) assert.ok(back[i].data.equals(entries[i].data));
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);

  // Hand-built archive: stored entry with a data descriptor and zero sizes in the local header.
  const data = Buffer.from('stored bytes');
  const name = Buffer.from('s.txt');
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x0008, 6);
  local.writeUInt16LE(0, 8);
  local.writeUInt16LE(name.length, 26);
  const desc = Buffer.alloc(16);
  desc.writeUInt32LE(0x08074b50, 0);
  desc.writeUInt32LE(crc32(data), 4);
  desc.writeUInt32LE(data.length, 8);
  desc.writeUInt32LE(data.length, 12);
  const cd = Buffer.alloc(46);
  cd.writeUInt32LE(0x02014b50, 0);
  cd.writeUInt16LE(20, 4);
  cd.writeUInt16LE(20, 6);
  cd.writeUInt16LE(0x0008, 8);
  cd.writeUInt32LE(crc32(data), 16);
  cd.writeUInt32LE(data.length, 20);
  cd.writeUInt32LE(data.length, 24);
  cd.writeUInt16LE(name.length, 28);
  const body = Buffer.concat([local, name, data, desc]);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(cd.length + name.length, 12);
  eocd.writeUInt32LE(body.length, 16);
  const stored = Buffer.concat([body, cd, name, eocd]);
  assert.equal(readZip(stored)[0].data.toString(), 'stored bytes');

  // A descriptor that disagrees with the central directory is rejected.
  const bad = Buffer.from(stored);
  bad.writeUInt32LE(data.length + 1, 30 + name.length + data.length + 8);
  assert.throws(() => readZip(bad), /data descriptor/);
});

test('zip: unsafe names, duplicates, bad CRC, zip64 and bombs are rejected', () => {
  for (const name of ['../evil', 'a/../../evil', '/abs/path', 'C:/x', 'a\\b', 'x/..']) {
    assert.throws(() => writeZip([{ name, data: Buffer.from('x') }]), /zip entry name/, `writer rejects ${name}`);
    // Build an archive that carries the name anyway (the writer refuses, so patch the bytes of a same-length name).
    const good = writeZip([{ name: 'a'.repeat(name.length), data: Buffer.from('x') }]);
    const patched = Buffer.from(good);
    let at = 0;
    while ((at = patched.indexOf(Buffer.from('a'.repeat(name.length)), at)) >= 0) {
      patched.write(name, at);
      at += name.length;
    }
    assert.throws(() => readZip(patched), /zip entry name/, `reader rejects ${name}`);
  }
  assert.throws(() => writeZip([{ name: 'a', data: Buffer.alloc(0) }, { name: 'a', data: Buffer.alloc(0) }]), /duplicate/);
  const dup = writeZip([{ name: 'aa', data: Buffer.from('1') }, { name: 'bb', data: Buffer.from('2') }]);
  const dupPatched = Buffer.from(dup);
  let at = 0;
  while ((at = dupPatched.indexOf(Buffer.from('bb'), at)) >= 0) {
    dupPatched.write('aa', at);
    at += 2;
  }
  assert.throws(() => readZip(dupPatched), /duplicate/);

  const good = writeZip([{ name: 'f', data: Buffer.from('payload payload payload') }]);
  const crcBad = Buffer.from(good);
  crcBad.writeUInt32LE(0x12345678, 14); // local crc
  const cdAt = crcBad.indexOf(Buffer.from([0x50, 0x4b, 1, 2]));
  crcBad.writeUInt32LE(0x12345678, cdAt + 16);
  assert.throws(() => readZip(crcBad), /CRC/);

  const zip64 = Buffer.from(good);
  zip64.writeUInt32LE(0xffffffff, zip64.length - 22 + 16);
  assert.throws(() => readZip(zip64), /zip64/);

  assert.throws(() => readZip(Buffer.from('nope')), /not a zip/);
  const truncated = good.subarray(0, good.length - 5);
  assert.throws(() => readZip(truncated), /zip/);

  // Declared size smaller than the real inflated size: refuse instead of inflating an unbounded stream.
  const lie = Buffer.from(writeZip([{ name: 'f', data: Buffer.alloc(100_000, 1) }]));
  const cd = lie.indexOf(Buffer.from([0x50, 0x4b, 1, 2]));
  lie.writeUInt32LE(10, cd + 24);
  lie.writeUInt32LE(10, 22);
  assert.throws(() => readZip(lie), /zip/);

  // Encryption flag.
  const enc = Buffer.from(good);
  enc.writeUInt16LE(1, enc.indexOf(Buffer.from([0x50, 0x4b, 1, 2])) + 8);
  assert.throws(() => readZip(enc), /encrypted/);
});
