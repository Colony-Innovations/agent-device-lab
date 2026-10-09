// Agent Device Lab dashboard: monitoring, plus supervision (pause, take over, stop) when the page was
// opened with the person's control link. Page text from the app under test is untrusted: everything
// is rendered with textContent, never as HTML.
'use strict';

const token = new URLSearchParams(location.hash.slice(1)).get('token') || '';
const api = (path) => `${path}${path.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
const $ = (id) => document.getElementById(id);

const model = {
  status: null, timeline: [], findings: new Map(), serverLog: [], sweeps: [], scans: [], selected: null, device: 'all',
  runIndex: null, confidence: 'all', scenario: 'all', group: null, expanded: new Set(), suppressedOpen: false,
  canControl: null, control: null, controlEpoch: 0,
};
const frames = new Map(); // finding id (or "F12-0" for an extra evidence frame) → object URL
const sweepFrames = new Map(); // "S1/mobile-320" → object URL
const scanFrames = new Map(); // "R1/0/s0" → object URL (fetched when a thumbnail is first drawn)
let source = null;

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) if (c !== undefined && c !== null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}

/** replaceChildren, but skipping the null and false placeholders that conditional parts leave (they would render as text). */
const setChildren = (el, ...kids) => el.replaceChildren(...kids.flat().filter((c) => c !== undefined && c !== null && c !== false));

const time = (iso) => new Date(iso).toLocaleTimeString([], { hour12: false }) + '.' + String(new Date(iso).getMilliseconds()).padStart(3, '0');
const q = (s) => JSON.stringify(s);

// ---------- connection ----------

function setConn(state, text) {
  const el = $('conn');
  el.dataset.conn = state;
  el.textContent = text;
}

function connect() {
  if (!token) {
    setConn('denied', 'no token');
    notice('This page needs its access link. Run `agentlab ui` (or read the `dashboard` URL from the start result) and open that URL.');
    return;
  }
  loadCapabilities();
  source = new EventSource(api('/api/events'));
  source.addEventListener('open', () => setConn('live', 'live'));
  source.addEventListener('snapshot', (e) => {
    const snap = JSON.parse(e.data);
    model.timeline = snap.timeline;
    model.findings = new Map(snap.findings.map((f) => [f.id, f]));
    model.serverLog = snap.serverLog;
    model.sweeps = snap.sweeps || [];
    model.scans = snap.scans || [];
    for (const f of snap.findings) if (f.hasFrame) fetchFrame(f.id);
    for (const sw of model.sweeps) for (const d of sw.devices) if (d.hasFrame) fetchSweepFrame(sw.id, d.id);
    renderSweep();
    renderScan();
    setStatus(snap.status);
    renderTimeline();
    renderFindings();
    renderLog();
  });
  source.addEventListener('feed', (e) => apply(JSON.parse(e.data).event));
  source.addEventListener('error', () => {
    const s = model.status && model.status.state;
    if (source.readyState === EventSource.CLOSED) {
      // The server refused the stream (e.g. 401 after a new session rotated the token) or went away.
      if (s === 'ended' || s === 'failed') return setConn('closed', 'session over');
      setConn('denied', 'disconnected');
      checkAccess();
    } else {
      setConn('reconnecting', 'reconnecting…');
    }
  });
}

async function checkAccess() {
  try {
    const res = await fetch(api('/api/state'));
    if (res.status === 401) notice('This link belongs to an earlier session, so access was revoked. Run `agentlab ui` for the current one.');
  } catch {
    notice('The session process has exited. Its run directory still has actions.jsonl, findings.json and evidence frames.');
  }
}

function notice(text) {
  const el = $('notice');
  el.hidden = false;
  el.textContent = text;
}

function apply(ev) {
  switch (ev.type) {
    case 'reset':
      model.timeline = []; model.findings = new Map(); model.serverLog = []; model.sweeps = []; model.scans = []; model.selected = null; model.device = 'all';
      model.runIndex = null; model.confidence = 'all'; model.scenario = 'all'; model.group = null; model.expanded = new Set();
      model.control = null; model.controlEpoch++;
      renderControl();
      renderTimeline(); renderFindings(); renderLog(); renderSweep(); renderScan();
      break;
    case 'status': setStatus(ev.status); break;
    case 'timeline': model.timeline.push(ev.entry); if (model.timeline.length > 500) model.timeline.shift(); appendEntry(ev.entry); break;
    case 'finding': {
      const known = model.findings.has(ev.finding.id);
      model.findings.set(ev.finding.id, ev.finding);
      if (ev.finding.hasFrame) fetchFrame(ev.finding.id);
      renderFindings(known ? undefined : ev.finding.id);
      renderTimeline(); // entries show finding chips with severity
      if (ev.finding.scenario) renderScan(); // the matrix counts findings per scenario and device
      break;
    }
    case 'sweep': {
      const i = model.sweeps.findIndex((x) => x.id === ev.sweep.id);
      if (i >= 0) model.sweeps[i] = ev.sweep; else model.sweeps.push(ev.sweep);
      for (const d of ev.sweep.devices) if (d.hasFrame) fetchSweepFrame(ev.sweep.id, d.id);
      renderSweep();
      renderFindings();
      break;
    }
    case 'scan': {
      const prev = model.scans[model.scans.length - 1];
      const i = model.scans.findIndex((x) => x.id === ev.scan.id);
      if (i >= 0) model.scans[i] = ev.scan; else model.scans.push(ev.scan);
      if (!prev || prev.id !== model.scans[model.scans.length - 1].id) model.runIndex = null;
      renderScan();
      renderFindings();
      break;
    }
    case 'server-log':
      model.serverLog.push(ev.line);
      if (model.serverLog.length > 500) model.serverLog.shift();
      renderLog();
      break;
  }
}

async function fetchFrame(id) {
  if (frames.has(id)) return;
  frames.set(id, null);
  try {
    const res = await fetch(api(`/api/frames/${id}.jpg`));
    if (!res.ok) throw new Error(String(res.status));
    frames.set(id, URL.createObjectURL(await res.blob()));
    if (model.selected && id.split('-')[0] === model.selected) renderDetail();
  } catch {
    frames.delete(id);
  }
}

async function fetchSweepFrame(sweepId, device) {
  const key = `${sweepId}/${device}`;
  if (sweepFrames.has(key)) return;
  sweepFrames.set(key, null);
  try {
    const res = await fetch(api(`/api/sweeps/${sweepId}/${device}.jpg`));
    if (!res.ok) throw new Error(String(res.status));
    sweepFrames.set(key, URL.createObjectURL(await res.blob()));
    renderSweep();
  } catch {
    sweepFrames.delete(key);
  }
}

/** The object URL of a scan state's frame, or null while it loads (a re-render follows). */
function scanFrameUrl(scanId, runIndex, stateId) {
  const key = `${scanId}/${runIndex}/${stateId}`;
  if (scanFrames.has(key)) return scanFrames.get(key);
  scanFrames.set(key, null);
  fetch(api(`/api/scans/${key}.jpg`))
    .then((res) => { if (!res.ok) throw new Error(String(res.status)); return res.blob(); })
    .then((blob) => { scanFrames.set(key, URL.createObjectURL(blob)); renderScan(); renderDetail(); })
    .catch(() => { scanFrames.delete(key); });
  return null;
}

// ---------- sweep + device selection ----------

/** Select a device (clicking the selected one again returns to all). */
function setDevice(id) {
  model.device = id === 'all' || model.device === id ? 'all' : id;
  if (model.selected && model.device !== 'all' && model.findings.get(model.selected)?.device !== model.device) model.selected = null;
  renderSweep();
  renderFindings();
}

function renderSweep() {
  renderStage();
  const box = $('sweep');
  const sw = model.sweeps[model.sweeps.length - 1];
  if (!sw) { box.hidden = true; return; }
  box.hidden = false;
  const done = sw.devices.filter((d) => d.state === 'done' || d.state === 'error').length;
  $('sweep-caption').textContent = `${sw.id} · ${sw.route} · ${sw.state === 'running' ? `${done}/${sw.devices.length} widths` : `done in ${sw.ms} ms`}`;
  $('sweep-devices').replaceChildren(...sw.devices.map((d) => {
    const state = d.state === 'done' ? (d.findings.length ? 'bad' : 'clean') : d.state;
    const label = d.state === 'pending' ? 'waiting' : d.state === 'running' ? 'measuring…' : d.state === 'error' ? `error: ${d.error || ''}`
      : d.findings.length ? `${d.findings.length} finding${d.findings.length === 1 ? '' : 's'} (${d.confirmed} confirmed)` : 'clean';
    const frame = sweepFrames.get(`${sw.id}/${d.id}`);
    return h('li', {}, h('button', { type: 'button', 'data-device': d.id, 'aria-pressed': model.device === d.id ? 'true' : 'false', onclick: () => setDevice(d.id) },
      h('div', {}, h('strong', { text: d.id }), ` ${d.width}×${d.height}`),
      h('div', { class: `state ${state}`, text: label }),
      frame ? h('img', { src: frame, alt: `${sw.route} at ${d.width}px` }) : null));
  }));
}

/** Devices seen in findings or sweeps, narrowest first. */
function knownDevices() {
  const widths = new Map();
  for (const f of model.findings.values()) widths.set(f.device, f.viewportWidth);
  for (const sw of model.sweeps) for (const d of sw.devices) widths.set(d.id, d.width);
  if (model.status && model.status.device) widths.set(model.status.device.id, model.status.device.viewport.width);
  return [...widths.entries()].sort((a, b) => a[1] - b[1]).map(([id]) => id);
}

function renderDeviceFilter() {
  const devices = knownDevices();
  const count = (id) => [...model.findings.values()].filter((f) => id === 'all' || f.device === id).length;
  $('device-filter').replaceChildren(...(devices.length > 1 ? ['all', ...devices] : []).map((id) =>
    h('button', { type: 'button', 'data-device': id, 'aria-pressed': model.device === id ? 'true' : 'false', onclick: () => setDevice(id), text: `${id === 'all' ? 'All' : id} (${count(id)})` })));
}

// ---------- status + viewport ----------

function setStatus(s) {
  const prev = model.status;
  model.status = s;
  $('state').dataset.state = s.state;
  $('state').textContent = s.state;
  $('session').textContent = s.sessionId || '';
  $('s-project').textContent = s.project || '–';
  const d = s.device;
  $('s-device').textContent = d ? `${d.id} · ${d.viewport.width}×${d.viewport.height} @${d.deviceScaleFactor}x${d.hasTouch ? ' touch' : ''} · ${s.headed ? 'headed' : 'headless'}` : '–';
  $('s-url').textContent = s.url || '–';
  $('s-url').title = s.title ? `${s.title} — ${s.url}` : (s.url || '');
  for (const [id, n] of [['s-console', s.consoleErrors], ['s-failed', s.failedRequests], ['s-findings', s.findings]]) {
    $(id).textContent = String(n);
    $(id).classList.toggle('bad', n > 0);
  }
  const srv = s.server;
  const services = s.services || [];
  $('s-server').textContent = services.length > 1
    ? services.map((x) => `${x.name} ${x.owned ? `started${x.pid ? ` (pid ${x.pid})` : ''}` : 'reused'}${x.url ? ` ${x.url}` : ''}, ready in ${x.readyMs} ms`).join(' · ')
    : srv
      ? `${srv.url} · ${srv.owned ? `started by the lab${srv.pid ? ` (pid ${srv.pid})` : ''}, ready in ${srv.readyMs} ms` : 'reused, not owned'}${srv.command ? ` · ${srv.command}` : ''}`
      : (s.state === 'starting' ? (services.length ? `starting… ${services.map((x) => `${x.name} ready`).join(', ')}` : 'starting…') : '–');
  if (s.tab) $('s-url').textContent = `[${s.tab}] ${$('s-url').textContent}`;

  const box = $('start-error');
  if (s.startError) {
    const e = s.startError;
    const tail = e.details && Array.isArray(e.details.logTail) ? e.details.logTail : [];
    box.replaceChildren(
      h('h3', { text: `Start failed: ${e.code}` }),
      h('div', { text: e.message }),
      e.hint ? h('div', { text: `Hint: ${e.hint}` }) : null,
      tail.length ? h('pre', { text: tail.join('\n') }) : null,
    );
    box.hidden = false;
  } else {
    box.hidden = true;
  }
  if (s.state === 'ended' || s.state === 'failed') {
    setConn('closed', 'session over');
    if (source) source.close();
  }
  if (s.control) { model.control = s.control; model.controlEpoch++; }
  renderControl();
  if (!prev || prev.state !== s.state) updateViewport();
  renderStage();
}

/** Stream frames only while the session is live and this tab is visible. */
/**
 * What the viewport is showing right now: the width a sweep or scan is measuring, otherwise the
 * session's own page. Sizes the device frame to match, so a change of width is visible.
 */
function renderStage() {
  const sw = model.sweeps[model.sweeps.length - 1];
  const sd = sw && sw.state === 'running' ? sw.devices.find((d) => d.state === 'running') : undefined;
  const scan = latestScan();
  const cur = scan && scan.state === 'running' ? scan.current : undefined;
  const run = cur ? scan.runs.find((r) => r.scenario === cur.scenario && r.device === cur.device) : undefined;
  const d = model.status && model.status.device;
  let what, id, w, h;
  if (sd) { what = `Sweep of ${sw.route}`; id = sd.id; w = sd.width; h = sd.height; }
  else if (run) { what = `Scan: ${cur.scenario}${cur.state ? ` — ${cur.state}` : ''}`; id = run.device; w = run.width; h = run.height; }
  else if (d) { what = 'The agent\'s page'; id = d.id; w = d.viewport.width; h = d.viewport.height; }
  const now = $('vp-now');
  if (!w || !h) { now.replaceChildren(); return; }
  $('device').style.setProperty('--vp-w', String(w));
  $('device').style.setProperty('--vp-h', String(h));
  now.replaceChildren(h_('strong', what), ` · ${id} · ${w}×${h}`);
}
const h_ = (tag, text) => h(tag, { text });

function updateViewport() {
  const img = $('viewport');
  const s = model.status && model.status.state;
  const live = (s === 'active' || s === 'starting') && document.visibilityState === 'visible';
  if (live && !img.getAttribute('src')) {
    img.src = api('/api/viewport');
    $('vp-caption').textContent = 'live · capped at 5 fps';
  } else if (!live && img.getAttribute('src') && s !== 'ended' && s !== 'failed') {
    img.removeAttribute('src'); // ends the stream, so capture stops
    $('vp-caption').textContent = 'paused while this tab is hidden';
  } else if (s === 'ended' || s === 'failed') {
    $('vp-caption').textContent = 'session over · last frame';
  }
}
// A multipart (MJPEG) image never fires `load` per frame; poll whether one has been decoded.
setInterval(() => {
  const img = $('viewport');
  $('vp-empty').hidden = img.naturalWidth > 0;
  // A frame of another shape than the device named above it belongs to the previous width.
  const w = Number($('device').style.getPropertyValue('--vp-w')), ht = Number($('device').style.getPropertyValue('--vp-h'));
  const stale = img.naturalWidth > 0 && w > 0 && Math.abs(img.naturalWidth / img.naturalHeight - w / ht) > 0.02;
  $('device').classList.toggle('switching', stale);
}, 200);
document.addEventListener('visibilitychange', updateViewport);

// ---------- timeline ----------

function renderTimeline() {
  const list = $('timeline');
  const stick = list.scrollTop + list.clientHeight >= list.scrollHeight - 40;
  list.replaceChildren(...model.timeline.map(entryNode));
  $('tl-count').textContent = model.timeline.length ? `${model.timeline.length} steps` : '';
  if (stick) list.scrollTop = list.scrollHeight;
}

function appendEntry(entry) {
  const list = $('timeline');
  const stick = list.scrollTop + list.clientHeight >= list.scrollHeight - 40;
  list.append(entryNode(entry));
  $('tl-count').textContent = `${model.timeline.length} steps`;
  if (stick) list.scrollTop = list.scrollHeight;
}

/**
 * What an action changed, kept short: where it went, what opened and what was typed stay in view; the
 * list of controls and headings that appeared or went is folded under one line.
 */
const openChanges = new Set();
function changesNode(seq, changes) {
  const isDetail = (c) => /^([+-] |… |\.\.\. |focus |\d+ unchanged controls)/.test(c);
  const detail = changes.filter(isDetail);
  const main = changes.filter((c) => !isDetail(c));
  const fold = detail.length > 3;
  const added = detail.filter((c) => c.startsWith('+ ')).length;
  const removed = detail.filter((c) => c.startsWith('- ')).length;
  const more = detail.some((c) => /^(… |\.\.\. )/.test(c));
  const li = (c) => h('li', { class: 'small', text: c });
  return h('div', { class: 'changes' },
    main.length || !fold ? h('ul', {}, [...main, ...(fold ? [] : detail)].map(li)) : null,
    fold ? h('details', { class: 'small', ...(openChanges.has(seq) ? { open: '' } : {}), ontoggle: (ev) => { if (ev.target.open) openChanges.add(seq); else openChanges.delete(seq); } },
      h('summary', { text: `Page content changed: ${added}${more ? '+' : ''} appeared, ${removed}${more ? '+' : ''} went` }),
      h('ul', {}, detail.map(li))) : null);
}

function entryNode(e) {
  if (e.kind === 'control') {
    // A full-width marker row: who held the session changed here. The summary is written by the server.
    return h('li', { class: `entry marker${/stop/i.test(e.summary) ? ' stopped' : ''}`, 'data-seq': e.seq, 'data-kind': 'control' },
      h('span', { class: 'time', text: time(e.at) }), h('span', { class: 'marker-text', text: e.summary }));
  }
  if (e.kind === 'human') {
    return h('li', { class: 'entry human', 'data-seq': e.seq, 'data-kind': 'human' },
      h('div', { class: 'head' },
        h('span', { class: 'time', text: time(e.at) }),
        h('span', { class: 'pico', title: 'a person did this', 'aria-hidden': 'true' }),
        h('span', { class: 'what', text: e.summary })));
  }
  if (e.kind === 'refused') {
    return h('li', { class: 'entry refused error', 'data-seq': e.seq, 'data-kind': 'refused' },
      h('div', { class: 'head' },
        h('span', { class: 'time', text: time(e.at) }),
        h('span', { class: 'chip refused', text: 'not run' }),
        h('span', { class: 'what', text: e.summary }),
        e.error ? h('span', { class: 'outcome mono', text: e.error.code }) : null),
      e.error ? h('div', { class: 'err' }, e.error.message, e.error.hint ? h('div', { class: 'muted small', text: `hint: ${e.error.hint}` }) : null) : null);
  }
  const findings = e.findings.map((id) => model.findings.get(id)).filter(Boolean);
  const pan = e.target && e.outcome === 'success' && findings.some((f) => f.kind === 'horizontal-pan-required');
  const meta = e.kind === 'observe' || e.kind === 'stop';
  const cls = ['entry', pan ? 'pan' : e.outcome, meta ? 'meta' : ''].join(' ');
  const t = e.target;
  const what = t && t.role ? `${e.kind} ${t.role} ${q(t.name)}${e.detail ? ` ${e.detail}` : ''}` : e.summary;
  const changes = e.changes || [];
  return h('li', { class: cls, 'data-seq': e.seq },
    h('div', { class: 'head' },
      h('span', { class: 'time', text: time(e.at) }),
      h('span', { class: 'what', text: what }),
      t && t.ref ? h('span', { class: 'muted mono', text: t.ref }) : null,
      e.value !== undefined ? h('span', { class: 'mono', text: `= ${e.value}` }) : null,
      h('span', { class: 'outcome', text: e.outcome === 'success' ? 'ok' : `error ${e.error ? e.error.code : ''}` }),
      e.durationMs !== undefined ? h('span', { class: 'dur', text: `${e.durationMs} ms${e.method ? ` · ${e.method}` : ''}` }) : null,
      e.settle ? h('span', { class: `chip ${e.settle.reason === 'timeout' ? 'timeout' : ''}`, text: e.settle.reason === 'timeout' ? `settle timeout ${e.settle.ms} ms` : `settled ${e.settle.ms} ms` }) : null,
    ),
    pan ? h('div', { class: 'banner', text: 'The action succeeded, but a person would first have to pan sideways to find this control.' }) : null,
    e.settleText ? h('div', { class: 'settle small', text: e.settleText }) : null,
    e.error ? h('div', { class: 'err' }, h('strong', { text: `${e.error.code}: ` }), e.error.message, e.error.hint ? h('div', { class: 'muted small', text: `hint: ${e.error.hint}` }) : null) : null,
    changes.length && !meta ? changesNode(e.seq, changes) : null,
    e.notes.length ? h('div', { class: 'notes small' }, e.notes.map((n) => h('div', { text: n }))) : null,
    (e.newConsoleErrors || e.newFailedRequests) ? h('div', { class: 'small', text: `${e.newConsoleErrors || 0} new console errors · ${e.newFailedRequests || 0} new failed requests` }) : null,
    findings.length ? h('div', {}, findings.map(findingChip)) : null,
  );
}

function findingChip(f) {
  return h('button', { class: `fchip sev-${f.severity}`, type: 'button', title: f.message, onclick: () => select(f.id), text: `${f.id} ${f.severity} ${f.kind}` });
}

function renderLog() {
  const pre = $('serverlog');
  pre.textContent = model.serverLog.join('\n');
  $('log-count').textContent = model.serverLog.length ? `(${model.serverLog.length} lines)` : '';
}

// ---------- scan ----------

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const latestScan = () => model.scans[model.scans.length - 1];

function selectedRun() {
  const scan = latestScan();
  return scan && model.runIndex !== null ? scan.runs.find((r) => r.index === model.runIndex) : undefined;
}

function selectRun(index) {
  model.runIndex = model.runIndex === index ? null : index;
  renderScan();
  renderFindings();
}

/** What a run cell says. A run that never got to its checks must not read like a clean or a failed check. */
function runLabel(run) {
  switch (run.state) {
    case 'pending': return 'pending';
    case 'running': return 'running…';
    case 'ok': {
      // Width-comparison findings are attached after the run finishes, so count what the findings list holds.
      const listed = [...model.findings.values()].filter((f) => f.scenario === run.scenario && f.device === run.device).length;
      return `ok · ${plural(run.states.length, 'state')} · ${plural(Math.max(listed, run.findings.length), 'finding')}`;
    }
    default:
      if (['context', 'load', 'setup'].includes(run.failedAt)) return 'failed before checks completed';
      if (run.failedAt === 'cleanup') return 'cleanup failed';
      if (run.failedAt === 'checks') return 'failed during checks';
      return 'failed';
  }
}

function renderScan() {
  renderStage();
  const scan = latestScan();
  $('scan').hidden = !scan;
  if (!scan) return;
  const cur = scan.current;
  $('scan-caption').textContent = scan.state === 'running'
    ? `${scan.id} · running${cur ? ` (${cur.scenario} @ ${cur.device}${cur.state ? ` — ${cur.state}` : ''})` : ''}`
    : `${scan.id} · done in ${scan.ms} ms`;

  const v = scan.verdict;
  setChildren($('scan-verdict'),
    v ? h('span', { class: `verdict ${v.result}`, text: v.result.toUpperCase() }) : null,
    h('span', { class: 'muted small', text: `exploration ${scan.explore ? 'on' : 'off'}` }),
    v && v.reasons.length ? h('ul', { class: 'reasons' }, v.reasons.map((r) => h('li', { text: r }))) : null,
  );

  const devices = new Map();
  for (const r of scan.runs) devices.set(r.device, r.width);
  const cols = [...devices.entries()].sort((a, b) => a[1] - b[1]);
  const scenarios = [...new Set(scan.runs.map((r) => r.scenario))];
  $('scan-matrix').replaceChildren(
    h('thead', {}, h('tr', {}, h('th', { text: 'Scenario' }), cols.map(([id, w]) => h('th', { text: `${id} · ${w}px` })))),
    h('tbody', {}, scenarios.map((name) => h('tr', {},
      h('th', { scope: 'row', text: name }),
      cols.map(([id]) => {
        const run = scan.runs.find((r) => r.scenario === name && r.device === id);
        if (!run) return h('td', { class: 'muted', text: '–' });
        const before = run.state === 'failed' && ['context', 'load', 'setup'].includes(run.failedAt);
        return h('td', {}, h('button', {
          type: 'button', class: `cell cell-${run.state}${before ? ' cell-before' : ''}`, 'data-run': run.index,
          'aria-pressed': model.runIndex === run.index ? 'true' : 'false', onclick: () => selectRun(run.index),
        }, h('span', { class: 'cell-state', text: runLabel(run) }),
        run.state === 'failed' && run.error ? h('span', { class: 'cell-error', text: run.error }) : null));
      })))),
  );
  renderRun();
}

function stateNode(scan, run, st) {
  const frame = st.hasFrame ? scanFrameUrl(scan.id, run.index, st.id) : null;
  const chips = st.findings.map((id) => model.findings.get(id)).filter(Boolean).map(findingChip);
  return h('li', { class: 'state', 'data-state': st.id },
    st.hasFrame ? (frame ? h('img', { class: 'thumb', src: frame, alt: `${run.scenario} at ${run.device}: ${st.label}` }) : h('div', { class: 'thumb ph muted small', text: 'loading…' })) : h('div', { class: 'thumb ph muted small', text: 'no frame' }),
    h('div', { class: 'state-body' },
      h('div', {}, h('strong', { text: `${st.id} · ${st.label}` }), ` `, h('span', { class: `chip state-${st.status}`, text: st.status })),
      h('div', { class: 'small mono', text: st.path.length ? st.path.join(' → ') : '(as loaded)' }),
      h('div', { class: 'small muted', text: [st.route ? `route ${st.route}` : '', st.restore ? `restore: ${st.restore}` : '', st.dialog ? `dialog: ${st.dialog}` : ''].filter(Boolean).join(' · ') }),
      chips.length ? h('div', {}, chips) : null,
      st.blocked && st.blocked.length ? h('div', { class: 'small', text: `blocked requests: ${st.blocked.join(', ')}` }) : null,
      st.error ? h('div', { class: 'small err-text', text: st.error }) : null));
}

function renderRun() {
  const box = $('scan-run');
  const scan = latestScan();
  const run = selectedRun();
  if (!scan || !run) { box.hidden = true; return; }
  const skipped = run.decisions.filter((d) => d.verdict === 'skip');
  const explored = run.decisions.filter((d) => d.verdict === 'explore');
  setChildren(box,
    h('h3', {}, `${run.scenario} @ ${run.device} `, h('span', { class: 'muted small', text: `${run.width}×${run.height} · ${runLabel(run)}${run.ms !== undefined ? ` · ${run.ms} ms` : ''}` })),
    run.state === 'failed' && run.error ? h('div', { class: `run-error${['context', 'load', 'setup'].includes(run.failedAt) ? ' before' : ''}`, text: run.error }) : null,
    h('div', { class: 'k', text: `States (${run.states.length})` }),
    run.states.length ? h('ul', { class: 'states' }, run.states.map((st) => stateNode(scan, run, st))) : h('div', { class: 'muted small', text: 'No state was measured.' }),
    h('div', { class: 'k', text: `Skipped controls (${skipped.length}${run.decisionsOmitted ? ` shown, ${run.decisionsOmitted} more not listed` : ''})` }),
    skipped.length
      ? h('table', { class: 'skipped' }, h('thead', {}, h('tr', {}, ['Role', 'Name', 'Context', 'Reason'].map((t) => h('th', { text: t })))),
        h('tbody', {}, skipped.map((d) => h('tr', {}, h('td', { text: d.role }), h('td', { text: d.name }), h('td', { text: d.context || '' }), h('td', { text: d.reason })))))
      : h('div', { class: 'muted small', text: run.decisionsOmitted ? `None listed; ${run.decisionsOmitted} decisions not listed.` : 'None.' }),
    explored.length ? h('div', { class: 'k', text: `Explored controls (${explored.length})` }) : null,
    explored.length ? h('ul', { class: 'explored' }, explored.map((d) => h('li', { class: 'small', text: `${d.role} ${q(d.name)}${d.context ? ` in ${d.context}` : ''}${d.kind ? ` (${d.kind})` : ''} — ${d.reason}` }))) : null,
    run.limits.length ? h('div', { class: 'k', text: 'Limits' }) : null,
    run.limits.length ? h('ul', { class: 'limits' }, run.limits.map((l) => h('li', { class: 'small', text: l }))) : null,
  );
  box.hidden = false;
}

// ---------- findings ----------

const SEV_RANK = { high: 3, medium: 2, low: 1 };

function matchesFilters(f) {
  if (model.device !== 'all' && f.device !== model.device) return false;
  if (model.confidence !== 'all' && f.confidence !== model.confidence) return false;
  if (model.scenario !== 'all' && f.scenario !== model.scenario) return false;
  const run = selectedRun();
  return !run || (f.scenario === run.scenario && f.device === run.device);
}

const grouping = () => (model.group === null ? model.scans.length > 0 : model.group);

function chipRow(id, items, current, set) {
  const box = $(id);
  box.hidden = !items.length;
  box.replaceChildren(...items.map(([value, label]) =>
    h('button', { type: 'button', 'data-value': value, 'aria-pressed': current === value ? 'true' : 'false', onclick: () => set(value), text: label })));
}

function renderFilters() {
  const all = [...model.findings.values()];
  const n = (pred) => all.filter(pred).length;
  chipRow('confidence-filter', all.length ? [['all', `All (${all.length})`], ['confirmed', `Confirmed (${n((f) => f.confidence === 'confirmed')})`], ['heuristic', `Heuristic (${n((f) => f.confidence === 'heuristic')})`]] : [],
    model.confidence, (v) => { model.confidence = v; renderFindings(); });
  const names = [...new Set(all.map((f) => f.scenario).filter(Boolean))];
  chipRow('scenario-filter', names.length ? [['all', 'All scenarios'], ...names.map((x) => [x, `${x} (${n((f) => f.scenario === x)})`])] : [],
    model.scenario, (v) => { model.scenario = model.scenario === v ? 'all' : v; renderFindings(); });
  $('group-row').hidden = !model.scans.length;
  $('group-toggle').setAttribute('aria-pressed', grouping() ? 'true' : 'false');
  const run = selectedRun();
  $('run-filter').hidden = !run;
  if (run) {
    $('run-filter').replaceChildren(`Showing ${run.scenario} @ ${run.device} only. `, h('button', { type: 'button', class: 'link', onclick: () => selectRun(run.index), text: 'Show all runs' }));
  }
}

function findingItem(f, freshId) {
  const s = f.suppressed;
  return h('li', {
    class: `item${f.id === freshId ? ' fresh' : ''}`, role: 'option', tabindex: 0, 'data-id': f.id, 'aria-selected': model.selected === f.id ? 'true' : 'false',
    onclick: () => select(f.id), onkeydown: (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); select(f.id); } },
  },
  // The spaces keep the words apart in the option's accessible name ("overflow heuristic", not "overflowheuristic").
  h('span', { class: `sev sev-${f.severity}`, text: f.severity }), ' ',
  h('span', { class: 'kind' }, `${f.id} ${f.kind}${f.target ? ` · ${f.target.role} ${q(f.target.name)}` : ''} `, h('span', { class: `conf conf-${f.confidence}`, text: f.confidence })), ' ',
  h('span', { class: 'msg', text: `${f.device} · ${f.scenario ? `${f.scenario} · ` : ''}${f.route} · ${f.source}` }),
  s ? h('span', { class: 'msg why', text: `suppressed by rule ${s.rule}: ${s.reason}${s.expires ? ` (until ${s.expires})` : ''}` }) : null);
}

/** Findings that share a fingerprint are one problem seen on several devices, scenarios or states. */
function buildGroups(items) {
  const by = new Map();
  for (const f of items) {
    const key = f.fingerprint || f.id;
    if (!by.has(key)) by.set(key, []);
    by.get(key).push(f);
  }
  const meta = (fp) => { for (let i = model.scans.length - 1; i >= 0; i--) { const g = (model.scans[i].groups || []).find((x) => x.fingerprint === fp); if (g) return g; } return undefined; };
  return [...by.entries()].map(([fingerprint, members]) => {
    const first = members[0];
    const uniq = (xs) => [...new Set(xs)];
    return {
      fingerprint, members, kind: first.kind,
      title: (meta(fingerprint) && meta(fingerprint).title) || `${first.kind}${first.target ? ` · ${first.target.role} ${q(first.target.name)}` : ''}`,
      severity: members.reduce((m, f) => (SEV_RANK[f.severity] > SEV_RANK[m] ? f.severity : m), 'low'),
      confirmed: members.filter((f) => f.confidence === 'confirmed').length,
      heuristic: members.filter((f) => f.confidence === 'heuristic').length,
      devices: uniq([...members].sort((a, b) => a.viewportWidth - b.viewportWidth).map((f) => f.device)),
      scenarios: uniq(members.map((f) => f.scenario).filter(Boolean)),
    };
  }).sort((a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity]);
}

function groupNode(g, freshId) {
  const open = model.expanded.has(g.fingerprint);
  return h('li', { class: 'group', 'data-fingerprint': g.fingerprint },
    h('button', {
      type: 'button', class: 'group-head', 'aria-expanded': open ? 'true' : 'false',
      onclick: () => { if (open) model.expanded.delete(g.fingerprint); else model.expanded.add(g.fingerprint); renderFindings(); },
    },
    h('span', { class: `sev sev-${g.severity}`, text: g.severity }),
    h('span', { class: 'kind' }, g.title,
      g.confirmed ? h('span', { class: 'conf conf-confirmed', text: `${g.confirmed} confirmed` }) : null,
      g.heuristic ? h('span', { class: 'conf conf-heuristic', text: `${g.heuristic} heuristic` }) : null),
    h('span', { class: 'msg', text: `${g.kind} · ${plural(g.members.length, 'finding')} · ${g.devices.join(', ')}${g.scenarios.length ? ` · ${g.scenarios.join(', ')}` : ''}` })),
    open ? h('ul', { class: 'members' }, g.members.map((f) => findingItem(f, freshId))) : null);
}

function renderFindings(freshId) {
  renderDeviceFilter();
  renderFilters();
  const list = $('findings');
  const shown = [...model.findings.values()].filter(matchesFilters);
  const live = shown.filter((f) => !f.suppressed);
  const suppressed = shown.filter((f) => f.suppressed);
  if (model.selected && !shown.some((f) => f.id === model.selected)) model.selected = null;
  if (!live.length) {
    const others = model.confidence !== 'all' || model.scenario !== 'all' || selectedRun();
    list.replaceChildren(h('li', { class: 'muted empty', text: suppressed.length ? 'Only suppressed findings match (listed below)'
      : others ? 'No findings match these filters' : model.device === 'all' ? 'None recorded' : `None recorded at ${model.device}` }));
  } else if (grouping()) {
    list.replaceChildren(...buildGroups(live).map((g) => groupNode(g, freshId)));
  } else {
    list.replaceChildren(...live.map((f) => findingItem(f, freshId)));
  }
  // Suppressed findings are never dropped: they are listed apart, with the reason.
  const box = $('suppressed');
  box.hidden = !suppressed.length;
  box.open = model.suppressedOpen;
  $('suppressed-summary').textContent = `Suppressed (${suppressed.length})`;
  $('suppressed-list').replaceChildren(...suppressed.map((f) => findingItem(f, freshId)));
  renderDetail();
}

$('suppressed').addEventListener('toggle', () => { model.suppressedOpen = $('suppressed').open; });
$('group-toggle').addEventListener('click', () => { model.group = !grouping(); renderFindings(); });

function select(id) {
  const f = model.findings.get(id);
  if (f && !matchesFilters(f)) {
    model.device = 'all'; model.confidence = 'all'; model.scenario = 'all'; model.runIndex = null;
    renderSweep(); renderScan();
  }
  if (f && f.fingerprint) model.expanded.add(f.fingerprint);
  if (f && f.suppressed) { model.suppressedOpen = true; }
  model.selected = id;
  renderFindings();
}

const WRAP_HARM = {
  none: 'No harm measured: wrapping by itself is not a defect.',
  cosmetic: 'Cosmetic: nothing is hidden or covered, but the label grows taller or sits uneven beside its neighbour.',
  functional: 'Functional harm: the label is cut off or truncated, or the control overlaps something.',
  expectation: 'Violates an expectation the project declared (scan.noWrap): this control should never wrap.',
};

function evidenceFigure(key, label, alt) {
  fetchFrame(key);
  const url = frames.get(key);
  return h('figure', { class: 'ev', 'data-frame': key },
    url ? h('img', { src: url, alt }) : h('div', { class: 'muted small', text: 'loading frame…' }),
    h('figcaption', { text: label }));
}

function evidenceBlock(f) {
  const extra = f.frames || [];
  if (extra.length) {
    return h('div', {},
      h('div', { class: 'k', text: f.kind === 'layout-shift' ? 'Before and after it settled' : 'Side-by-side evidence' }),
      h('div', { class: `pair${f.kind === 'layout-shift' ? ' before-after' : ''}` }, extra.map((x, i) => evidenceFigure(`${f.id}-${i}`, x.label, `${f.id}: ${x.label}`))));
  }
  if (!f.hasFrame) return h('div', { class: 'muted small', text: 'No evidence frame (captured only while a dashboard is attached to the session).' });
  const frame = frames.get(f.id);
  return h('figure', {},
    frame ? h('img', { src: frame, alt: `Viewport when ${f.id} was recorded` }) : h('div', { class: 'muted small', text: 'loading frame…' }),
    h('figcaption', { text: f.kind === 'horizontal-pan-required' ? 'Viewport before the lab panned sideways to reach the control.' : 'Viewport when the finding was recorded.' }));
}

/** The same state in every run of the scenario, so a developer sees how it changes with the width. */
function otherWidthsBlock(f) {
  if (!f.scenario) return null;
  const labels = new Set([f.state, ...(f.states || [])].filter(Boolean));
  for (let i = model.scans.length - 1; i >= 0; i--) {
    const scan = model.scans[i];
    const items = [];
    for (const run of scan.runs) {
      if (run.scenario !== f.scenario) continue;
      const st = run.states.find((x) => labels.has(x.label) && x.hasFrame);
      if (st) items.push({ scan, run, st });
    }
    if (items.length < 2) continue;
    items.sort((a, b) => a.run.width - b.run.width);
    return h('div', {},
      h('div', { class: 'k', text: 'Same state at other widths' }),
      h('div', { class: 'pair widths' }, items.map(({ run, st }) => {
        const url = scanFrameUrl(scan.id, run.index, st.id);
        return h('figure', { class: 'ev', 'data-run': run.index },
          url ? h('img', { src: url, alt: `${run.scenario} at ${run.device}: ${st.label}` }) : h('div', { class: 'muted small', text: 'loading frame…' }),
          h('figcaption', { text: `${run.device} · ${run.width}px` }));
      })));
  }
  return null;
}

function wrapBlock(f) {
  const e = f.evidence;
  const px = (v) => (v === undefined ? '–' : `${v} px`);
  const row = (device, w, lines, height, neighbour) => h('tr', {}, h('td', { text: device }), h('td', { text: px(w) }), h('td', { text: lines === undefined ? '–' : String(lines) }), h('td', { text: px(height) }), h('td', { text: px(neighbour) }));
  const lines = (n) => (n === 1 ? '1 line' : `${n} lines`);
  return h('div', { class: 'wrap' },
    h('div', { class: 'k', text: 'Label measurements' }),
    h('table', { class: 'measure' },
      h('thead', {}, h('tr', {}, ['Device', 'Width', 'Lines', 'Height', 'Neighbour height'].map((t) => h('th', { text: t })))),
      h('tbody', {}, row(f.device, e.widthNarrow, e.linesNarrow, e.heightNarrow, e.rowNeighbourHeight), row(e.comparedWith || 'wider', e.widthWide, e.linesWide, e.heightWide, undefined))),
    h('div', { class: 'small', text: `At ${e.widthNarrow} px it takes ${lines(e.linesNarrow)} (${e.heightNarrow} px tall); at ${e.widthWide} px it takes ${lines(e.linesWide)} (${e.heightWide} px tall).` }),
    h('div', { class: `small harm harm-${e.harm}`, text: `Harm: ${e.harm}. ${WRAP_HARM[e.harm] || ''}` }));
}

function confidenceText(f) {
  if (f.confidenceScore === undefined) return f.confidence === 'confirmed' ? 'confirmed (measured reach problem)' : 'heuristic (layout warning)';
  return `${f.confidence} (score ${Number(f.confidenceScore).toFixed(2)}; basis: ${(f.basis || []).join(', ') || 'none'})`;
}

function renderDetail() {
  const box = $('finding-detail');
  const f = model.selected && model.findings.get(model.selected);
  if (!f) { box.hidden = true; return; }
  const states = f.states && f.states.length ? f.states : f.state ? [f.state] : [];
  const rows = [
    ['confidence', confidenceText(f)],
    ...(f.suppressed ? [['suppressed', `rule ${f.suppressed.rule}: ${f.suppressed.reason}${f.suppressed.expires ? ` (until ${f.suppressed.expires})` : ''}`]] : []),
    ...(f.detector ? [['detector', `${f.detector.name}@${f.detector.version}`]] : []),
    ...(f.scenario ? [['scenario', f.scenario]] : []),
    ...(states.length ? [[states.length > 1 ? 'states' : 'state', states.join(', ')]] : []),
    ['route', f.route], ['device', `${f.device} (${f.viewportWidth}px wide)`], ['source', f.source],
    ['target', f.target ? `${f.target.role} ${q(f.target.name)}${f.target.ref ? ` (${f.target.ref})` : ''}${f.target.context ? ` in ${f.target.context}` : ''}` : '–'],
    ...(f.target && f.target.selector ? [['selector', f.target.selector]] : []),
    ['seen', `${f.occurrences}× (gen ${f.firstSeen.gen}–${f.lastSeenGen}), first at ${time(f.firstSeen.at)}`],
    ...Object.entries(f.evidence).map(([k, v]) => [k, String(v)]),
  ];
  setChildren(box,
    h('h3', {}, h('span', { class: `fchip sev-${f.severity}`, text: f.severity }), ` ${f.id} ${f.kind}`),
    h('div', { text: f.message }),
    h('table', {}, h('tbody', {}, rows.map(([k, v]) => h('tr', {}, h('td', { text: k }), h('td', { class: 'mono', text: v }))))),
    f.kind === 'text-wrap-change' ? wrapBlock(f) : null,
    h('div', { class: 'k', text: 'Reproduction' }),
    h('ol', {}, f.reproduction.map((s) => h('li', { text: s }))),
    evidenceBlock(f),
    otherWidthsBlock(f),
  );
  box.hidden = false;
}

// ---------- supervision ----------
// Requests go out with the token in an Authorization header (never in a URL). What a person types is sent
// and forgotten: it is never stored, echoed or shown here, and the server records descriptions only.

const CTL_OPS = ['pause', 'pause-next', 'resume', 'takeover', 'return', 'stop', 'emergency-stop'];
const CONFIRM = { 'stop': 'Confirm stop run', 'emergency-stop': 'Confirm emergency stop' };
const CONFIRM_MS = 5000;
let confirming = null; // { op, timer }
let wheelDy = 0;
let wheelTimer = null;

async function post(path, body) {
  try {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    let json = {};
    try { json = await res.json(); } catch { /* no body */ }
    return { ok: res.ok, status: res.status, json };
  } catch {
    return { ok: false, status: 0, json: { error: 'could not reach the session process' } };
  }
}

async function loadCapabilities() {
  try {
    const res = await fetch('/api/state', { headers: { authorization: `Bearer ${token}` } });
    model.canControl = res.ok ? !!(await res.json()).canControl : false;
  } catch {
    model.canControl = false;
  }
  renderControl();
}

function setCtlError(text) {
  const el = $('ctl-error');
  el.hidden = !text;
  el.textContent = text || '';
}

const controlState = () => model.control || { mode: 'agent', interrupt: false, observeRequired: false, humanInteractions: 0 };
const humanActive = () => model.canControl === true && controlState().mode === 'human' && model.status && model.status.state === 'active';

/** Mirrors the session's own transition rules; the server still decides and explains a refusal. */
function opEnabled(op, c) {
  const m = c.mode;
  const live = model.status && (model.status.state === 'active' || model.status.state === 'starting');
  if (!live) return false;
  switch (op) {
    case 'pause': return m === 'agent' || (m === 'pausing' && c.pending === 'paused' && !c.interrupt);
    case 'pause-next': return m === 'agent';
    case 'resume': return m === 'paused' || (m === 'pausing' && c.pending === 'paused');
    case 'takeover': return m === 'agent' || m === 'paused' || (m === 'pausing' && c.pending !== 'human');
    case 'return': return m === 'human' || (m === 'pausing' && c.pending === 'human');
    case 'stop': return m !== 'stopping' && m !== 'stopped';
    case 'emergency-stop': return m !== 'stopped';
    default: return false;
  }
}

function badgeText(c) {
  const after = c.busy && c.busy.command ? ` after ${c.busy.command}` : '';
  switch (c.mode) {
    case 'agent': return 'Agent in control';
    case 'pausing': return c.pending === 'human' ? `Taking over${after}…` : `Pausing${after}…`;
    case 'paused': return 'Paused';
    case 'human': return 'You have control';
    case 'stopping': return `Stopping${after}…`;
    case 'stopped': return 'Stopped';
    default: return c.mode;
  }
}

function clearConfirm() {
  if (!confirming) return;
  clearTimeout(confirming.timer);
  confirming = null;
  renderControl();
}

function renderControl() {
  const can = model.canControl === true;
  $('supervision').hidden = !can;
  $('ctl-viewonly').hidden = model.canControl !== false;
  const human = humanActive();
  $('human-panel').hidden = !human;
  $('device').classList.toggle('human', !!human);
  $('viewport').dataset.interactive = human ? 'true' : 'false';
  if (!human) $('human-text').value = '';
  $('human-headed').hidden = !(model.status && model.status.headed);
  if (!can) return;

  const c = controlState();
  const badge = $('ctl-badge');
  badge.dataset.mode = c.mode;
  badge.textContent = badgeText(c);
  $('ctl-detail').textContent = c.observeRequired && c.mode !== 'human' && c.mode !== 'stopped' ? 'agent must observe before acting' : '';
  for (const op of CTL_OPS) {
    const btn = $(`ctl-${op}`);
    const on = opEnabled(op, c);
    btn.setAttribute('aria-disabled', on ? 'false' : 'true');
    if (btn.hasAttribute('aria-pressed')) {
      btn.setAttribute('aria-pressed', String((op === 'pause' && (c.mode === 'paused' || (c.mode === 'pausing' && c.pending === 'paused'))) || (op === 'takeover' && c.mode === 'human')));
    }
    const asking = confirming && confirming.op === op && on;
    btn.classList.toggle('confirming', !!asking);
    btn.textContent = asking ? CONFIRM[op] : BUTTON_LABEL[op];
  }
}

const BUTTON_LABEL = {
  'pause': 'Pause after this action', 'pause-next': 'Pause before next action', 'resume': 'Resume', 'takeover': 'Take over',
  'return': 'Return control to agent', 'stop': 'Stop run', 'emergency-stop': 'Emergency stop',
};

async function sendControl(op) {
  const epoch = model.controlEpoch;
  const r = await post('/api/control', { op });
  if (r.ok && r.json.control) {
    // A newer state from the event stream wins over this (older) reply.
    if (epoch === model.controlEpoch) { model.control = r.json.control; model.controlEpoch++; }
    setCtlError('');
    renderControl();
  } else {
    setCtlError(r.json.error || `request failed (${r.status})`);
  }
}

function onControlClick(op) {
  if (!opEnabled(op, controlState())) return;
  setCtlError('');
  if (CONFIRM[op]) {
    if (!confirming || confirming.op !== op) {
      // First click only asks; a second click within 5 s does it.
      if (confirming) clearTimeout(confirming.timer);
      confirming = { op, timer: setTimeout(clearConfirm, CONFIRM_MS) };
      renderControl();
      return;
    }
  }
  if (confirming) { clearTimeout(confirming.timer); confirming = null; }
  sendControl(op);
}

for (const op of CTL_OPS) {
  $(`ctl-${op}`).addEventListener('click', () => {
    // Any other button cancels a pending confirmation.
    if (confirming && confirming.op !== op) { clearTimeout(confirming.timer); confirming = null; renderControl(); }
    onControlClick(op);
  });
}

async function sendInput(body) {
  setCtlError('');
  const r = await post('/api/input', body);
  if (!r.ok) setCtlError(r.json.error || `input was not accepted (${r.status})`);
  return r.ok;
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

$('viewport').addEventListener('click', (e) => {
  if (!humanActive()) return;
  const img = e.currentTarget;
  if (!img.clientWidth || !img.clientHeight) return;
  sendInput({ type: 'tap', x: clamp(e.offsetX / img.clientWidth, 0, 1), y: clamp(e.offsetY / img.clientHeight, 0, 1) });
});

$('viewport').addEventListener('wheel', (e) => {
  if (!humanActive()) return;
  e.preventDefault();
  const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? e.currentTarget.clientHeight : 1;
  wheelDy = clamp(wheelDy + e.deltaY * unit, -5000, 5000);
  if (wheelTimer) return;
  // One scroll request per 120 ms, however fast the wheel spins.
  wheelTimer = setTimeout(() => {
    const dy = Math.round(wheelDy);
    wheelDy = 0;
    wheelTimer = null;
    if (dy !== 0 && humanActive()) sendInput({ type: 'scroll', dy });
  }, 120);
}, { passive: false });

$('human-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const box = $('human-text');
  const text = box.value;
  if (!text || !humanActive()) return;
  if (text.length > 500) return setCtlError('Type at most 500 characters at a time.');
  if (await sendInput({ type: 'text', text })) box.value = '';
  box.focus();
});

$('human-hide').addEventListener('change', (e) => { $('human-text').type = e.currentTarget.checked ? 'password' : 'text'; });

for (const btn of document.querySelectorAll('#human-panel [data-key]')) {
  btn.addEventListener('click', () => { if (humanActive()) sendInput({ type: 'key', key: btn.dataset.key }); });
}

connect();
