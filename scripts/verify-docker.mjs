// Proves the packed tarball installs and runs on clean Linux images: one fresh container per image, nothing from the repo
// except the tarball, a dependency-free fixture and a small MCP client script.
//   node scripts/verify-docker.mjs [--tarball <file.tgz>] [--images a,b,...] [--out verify-results/docker] [--keep]
// Per supported image (node:22-bookworm-slim, node:24-bookworm-slim) and the informational one (node:22-alpine, musl):
//   npm install -g <tgz>; agentlab install-browser --with-deps; version; doctor (with launch; as root and as the image's `node` user);
//   headless `agentlab test` on fixtures/invoice-app (/invoices: exit 0, /reports: exit 1); an MCP round trip over stdio with the SDK
//   resolved from the global install; npm uninstall -g.
// node:20-bookworm-slim only checks the Node gate (`agentlab version` refuses, non-zero). The host's nvm Node 18 and 20 get the same check.
// Every step is recorded as {step, ok, ms, detail}. Containers are labelled, named after this process and removed at the end; nothing else is touched.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({ options: {
  tarball: { type: 'string' },
  images: { type: 'string', default: 'node:22-bookworm-slim,node:24-bookworm-slim,node:22-alpine,node:20-bookworm-slim' },
  out: { type: 'string', default: 'verify-results/docker' },
  keep: { type: 'boolean', default: false },
} });
const repo = resolve(import.meta.dirname, '..');
const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
const outDir = resolve(repo, args.out);
mkdirSync(outDir, { recursive: true });
const tmp = mkdtempSync(join(tmpdir(), 'agentlab-docker-'));
const npmEnv = { ...process.env, npm_config_fund: 'false', npm_config_audit: 'false', npm_config_update_notifier: 'false' };

// What each image is for. `gate` images only check the Node.js version gate; `info` images record an outcome without failing the run.
const ROLE = { 'node:22-bookworm-slim': 'supported', 'node:24-bookworm-slim': 'supported', 'node:22-alpine': 'info', 'node:20-bookworm-slim': 'gate' };

const MCP_CHECK = `
// Runs inside the container: the MCP SDK comes from the global install of agent-device-lab.
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.argv[2];           // $(npm root -g)/agent-device-lab
const project = process.argv[3];
const sdk = join(root, 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm', 'client');
const { Client } = await import(pathToFileURL(join(sdk, 'index.js')).href);
const { StdioClientTransport } = await import(pathToFileURL(join(sdk, 'stdio.js')).href);
const client = new Client({ name: 'verify-docker', version: '0.0.0' });
await client.connect(new StdioClientTransport({ command: 'agentlab', args: ['mcp', '--headless', '--no-ui'], cwd: project, env: { ...process.env }, stderr: 'pipe' }));  // the SDK's default env would drop PLAYWRIGHT_BROWSERS_PATH
const out = {};
try {
  const { tools } = await client.listTools();
  out.tools = tools.length;
  for (const t of ['bundle', 'start', 'observe', 'stop', 'scan']) if (!tools.some((x) => x.name === t)) throw new Error('tools/list lacks ' + t);
  const call = async (name, a = {}) => {
    const r = await client.callTool({ name, arguments: a });
    if (r.isError) throw new Error(name + ': ' + r.content?.[0]?.text);
    return r.structuredContent;
  };
  const started = await call('start', { project });
  out.startRoute = started.observation?.route;
  const obs = await call('observe');
  out.observeRoute = obs.route;
  out.controls = obs.controls?.length;
  if (obs.route !== '/invoices' || !(obs.controls?.length > 0)) throw new Error('unexpected observation ' + JSON.stringify(obs).slice(0, 200));
  await call('stop');
  out.ok = true;
} finally {
  await client.close();
}
console.log(JSON.stringify(out));
`;

// ---------- helpers ----------

function sh(command, argv, opts = {}) {
  const r = spawnSync(command, argv, { encoding: 'utf8', maxBuffer: 256 << 20, timeout: 300_000, ...opts });
  if (r.error) return { status: null, stdout: r.stdout ?? '', stderr: `${r.stderr ?? ''}${r.error.message}` };
  return r;
}
const tail = (text, n = 6, width = 300) => text.trim().split('\n').filter((l) => l.trim() && !/^\s*\|[■ ]+\|/.test(l)).slice(-n).map((l) => l.slice(0, width)).join(' / ');
const brief = (r) => `exit ${r.status}: ${tail(`${r.stdout}\n${r.stderr}`)}`;
function expect(cond, message) { if (!cond) throw new Error(message); }

const containers = [];
const report = { at: new Date().toISOString(), version: pkg.version, host: { node: process.version, docker: sh('docker', ['--version']).stdout.trim() }, images: [], hostGate: [] };

function recorder(rows) {
  return async (name, body) => {
    const t0 = Date.now();
    let ok = true, detail;
    try { detail = await body(); } catch (err) { ok = false; detail = err instanceof Error ? err.message : String(err); }
    const row = { step: name, ok, ms: Date.now() - t0, detail: detail ?? '' };
    rows.push(row);
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${String(row.ms).padStart(7)} ms  ${name}${row.detail ? `  — ${String(row.detail).slice(0, 260)}` : ''}`);
    return ok;
  };
}

// ---------- the tarball and the fixture ----------

let tarball = args.tarball ? resolve(args.tarball) : undefined;
if (!tarball) {
  const r = sh('npm', ['pack', '--pack-destination', tmp], { cwd: repo, env: npmEnv });
  if (r.status !== 0) { console.error(`npm pack failed: ${brief(r)}`); process.exit(1); }
  tarball = join(tmp, r.stdout.trim().split('\n').at(-1));
}
expect(existsSync(tarball), `no tarball at ${tarball}`);
const tarName = tarball.split('/').at(-1);
const mcpFile = join(tmp, 'mcp-check.mjs');
writeFileSync(mcpFile, MCP_CHECK);
report.tarball = tarName;

// ---------- one image ----------

async function verifyImage(image) {
  const role = ROLE[image] ?? 'supported';
  const rows = [];
  const entry = { image, role, digest: undefined, nodeInContainer: undefined, ok: undefined, steps: rows };
  report.images.push(entry);
  const rec = recorder(rows);
  console.log(`\n== ${image} (${role}) ==`);
  const tPull = Date.now();
  const pull = sh('docker', ['pull', '-q', image], { timeout: 900_000 });
  const insp = sh('docker', ['image', 'inspect', '--format', '{{index .RepoDigests 0}}|{{.Size}}|{{.Architecture}}', image]);
  const [digest, size, arch] = insp.stdout.trim().split('|');
  Object.assign(entry, { digest, sizeBytes: Number(size), arch, pullMs: Date.now() - tPull });
  if (pull.status !== 0 || !digest) { await rec('pull', () => { throw new Error(brief(pull)); }); entry.ok = false; return; }

  const name = `adl-verify-${process.pid}-${containers.length}`;
  const created = sh('docker', ['run', '-d', '--name', name, '--label', 'adl.verify=1', '-e', 'PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright', image, 'sleep', '7200']);
  if (created.status !== 0) { await rec('create container', () => { throw new Error(brief(created)); }); entry.ok = false; return; }
  containers.push(name);
  const dx = (argv, opts = {}) => {
    const { user, env = {}, timeout = 300_000 } = opts;
    const a = ['exec'];
    if (user) a.push('-u', user, '-e', `HOME=/home/${user}`);
    for (const [k, v] of Object.entries(env)) a.push('-e', `${k}=${v}`);
    return sh('docker', [...a, name, ...argv], { timeout });
  };
  const sdx = (script, opts) => dx(['sh', '-c', script], opts);
  const cp = (src, dst) => sh('docker', ['cp', src, `${name}:${dst}`]);

  entry.nodeInContainer = dx(['node', '-v']).stdout.trim();
  const osRelease = sdx('. /etc/os-release && echo "$PRETTY_NAME"').stdout.trim();
  Object.assign(entry, { os: osRelease, libc: sdx('ldd --version 2>&1 | head -1').stdout.trim() });
  console.log(`   ${digest}  node ${entry.nodeInContainer}  ${osRelease}  ${entry.libc}`);

  await rec('copy tarball, fixture and MCP client script in', () => {
    for (const [src, dst] of [[tarball, `/tmp/${tarName}`], [join(repo, 'fixtures', 'invoice-app'), '/work/invoice-app'], [mcpFile, '/tmp/mcp-check.mjs']]) {
      if (dst.startsWith('/work')) dx(['mkdir', '-p', '/work']);
      const r = cp(src, dst);
      expect(r.status === 0, brief(r));
    }
    return tarName;
  });

  const installed = await rec('npm install -g ./agent-device-lab-*.tgz', () => {
    // One retry: a slow or dropped registry connection during `npm install` is not a property of the package. The attempts are recorded.
    let r, attempts = 0;
    do {
      attempts++;
      r = sdx('cd /tmp && npm install -g ./agent-device-lab-*.tgz', { timeout: 900_000 });
    } while (r.status !== 0 && attempts < 2);
    const errors = `${r.stdout}\n${r.stderr}`.split('\n').filter((l) => /npm error/.test(l)).slice(0, 6).join(' / ');
    expect(r.status === 0, `npm install -g (attempt ${attempts}): ${errors || brief(r)}`);
    if (attempts > 1) console.log('   npm install needed a retry (first attempt failed)');
    const check = sdx('command -v agentlab');
    expect(check.status === 0, `agentlab not on PATH after install: ${brief(r)}`);
    return `installed at ${sdx('npm root -g').stdout.trim()}/agent-device-lab${attempts > 1 ? ' (second attempt)' : ''}; ${tail(`${r.stdout}\n${r.stderr}`, 2)}`;
  });
  if (!installed) { entry.ok = false; return; }

  if (role === 'gate') {
    await rec('agentlab version: refused by the Node gate (non-zero, "needs Node.js 22")', () => {
      const r = dx(['agentlab', 'version']);
      const text = `${r.stdout}${r.stderr}`;
      expect(r.status !== 0 && r.status !== null && /needs Node\.js 22/.test(text), `expected a refusal: ${brief(r)}`);
      return `exit ${r.status}: ${tail(text, 2)}`;
    });
    await rec('agentlab doctor is refused too', () => {
      const r = dx(['agentlab', 'doctor']);
      expect(r.status !== 0 && /needs Node\.js 22/.test(`${r.stdout}${r.stderr}`), brief(r));
      return `exit ${r.status}`;
    });
    entry.ok = rows.every((x) => x.ok);
    return;
  }

  const root = sdx('npm root -g').stdout.trim() + '/agent-device-lab';
  const browsers = await rec('agentlab install-browser --with-deps', () => {
    // One retry: apt mirrors and the browser CDN are sometimes very slow; the attempt count is recorded.
    let r, attempts = 0;
    do {
      attempts++;
      r = dx(['agentlab', 'install-browser', '--with-deps'], { timeout: 900_000 });
    } while (r.status !== 0 && attempts < 2 && role !== 'info');
    expect(r.status === 0, `attempt ${attempts}: ${brief(r)}`);
    return `exit 0${attempts > 1 ? ' (second attempt)' : ''}; browsers in ${sdx('ls /opt/ms-playwright | tr "\\n" " "').stdout.trim()}`;
  });
  if (!browsers && role === 'info') {
    // Document what happens without the dependency step on a platform Playwright does not support.
    await rec('agentlab install-browser (without --with-deps), for the record', () => {
      const r = dx(['agentlab', 'install-browser'], { timeout: 1_200_000 });
      if (r.status !== 0) throw new Error(brief(r));
      return `exit 0; browsers in ${sdx('ls /opt/ms-playwright | tr "\\n" " "').stdout.trim()}`;
    });
  }

  await rec('agentlab version', () => {
    const r = dx(['agentlab', 'version']);
    expect(r.status === 0 && r.stdout.includes(`agentlab ${pkg.version}`), brief(r));
    expect(/chromium installed/.test(r.stdout), `chromium not installed: ${r.stdout}`);
    return r.stdout.trim().split('\n').slice(0, 3).join(' | ');
  });

  await rec('agentlab doctor (with launch), as root', () => {
    const r = dx(['agentlab', 'doctor', '--json']);
    let data; try { data = JSON.parse(r.stdout); } catch { /* not JSON */ }
    expect(r.status === 0 && data?.ok === true, `doctor: exit ${r.status}: ${(data?.checks ?? []).filter((c) => c.status === 'fail').map((c) => `${c.name}: ${c.detail}`).join(' / ') || brief(r)}`);
    return data.checks.map((c) => `${c.name}:${c.status}`).join(', ');
  });

  await rec('agentlab doctor (with launch), as the non-root `node` user', () => {
    const r = dx(['agentlab', 'doctor', '--json'], { user: 'node' });
    let data; try { data = JSON.parse(r.stdout); } catch { /* not JSON */ }
    expect(r.status === 0 && data?.ok === true, `doctor: exit ${r.status}: ${(data?.checks ?? []).filter((c) => c.status === 'fail').map((c) => `${c.name}: ${c.detail}`).join(' / ') || brief(r)}`);
    return data.checks.find((c) => c.name === 'browser')?.detail ?? 'ok';
  });

  await rec('agentlab test --project invoice-app (/invoices): exit 0', () => {
    const r = dx(['sh', '-c', 'cd /work/invoice-app && agentlab test --project . --out /tmp/out-pass'], { timeout: 600_000 });
    expect(r.status === 0 && /agentlab test: PASS/.test(r.stdout), brief(r));
    const files = sdx('ls /tmp/out-pass | tr "\\n" " "').stdout.trim();
    for (const f of ['ci-result.json', 'junit.xml', 'report.html', 'summary.txt']) expect(files.includes(f), `artifacts: ${files}`);
    return `PASS, 4 widths, artifacts: ${files}`;
  });

  await rec('agentlab test --project invoice-app --routes /reports (seeded defect): exit 1', () => {
    const r = dx(['sh', '-c', 'cd /work/invoice-app && agentlab test --project . --routes /reports --devices mobile-390 --out /tmp/out-fail'], { timeout: 600_000 });
    expect(r.status === 1 && /agentlab test: FAIL/.test(r.stdout), brief(r));
    const rep = dx(['agentlab', 'report', '/tmp/out-fail', '--format', 'junit']);
    expect(rep.status === 0 && /<failure/.test(rep.stdout), `report junit: ${brief(rep)}`);
    return `FAIL exit 1 (${tail(r.stdout.split('failing groups:')[1] ?? '', 1)}); report --format junit has a <failure>`;
  });

  await rec('MCP over stdio: tools/list (bundle), start, observe, stop', () => {
    const r = dx(['node', '/tmp/mcp-check.mjs', root, '/work/invoice-app'], { timeout: 300_000 });
    expect(r.status === 0, brief(r));
    const out = JSON.parse(r.stdout.trim().split('\n').at(-1));
    expect(out.ok === true, r.stdout);
    return `${out.tools} tools; start ${out.startRoute}; observe ${out.observeRoute} (${out.controls} controls); stop`;
  });

  await rec('no session left behind (status: no_session)', () => {
    const r = dx(['sh', '-c', 'cd /work/invoice-app && agentlab status --json']);
    expect(r.status === 1 && JSON.parse(r.stdout).error?.code === 'no_session', `status should report no_session: ${brief(r)}`);
    const left = sdx('ps -eo pid,args | grep -E "daemon/main|chrome|invoice-app/server" | grep -v grep | wc -l').stdout.trim();
    expect(left === '0', `${left} processes left behind`);
    return 'status says no_session; no daemon, chrome or fixture server processes left';
  });

  await rec('npm uninstall -g agent-device-lab', () => {
    const r = dx(['npm', 'uninstall', '-g', 'agent-device-lab']);
    expect(r.status === 0, brief(r));
    const gone = sdx('command -v agentlab || echo gone').stdout.trim();
    expect(gone === 'gone', `agentlab still on PATH: ${gone}`);
    return 'agentlab removed from PATH; /opt/ms-playwright and ~/.local/state/agentlab remain (documented manual cleanup)';
  });

  entry.ok = rows.every((x) => x.ok);
}

// ---------- the host's Node gate ----------

async function hostGate() {
  const rec = recorder(report.hostGate);
  console.log('\n== host Node gate (repo bin/agentlab.js) ==');
  for (const v of ['v20.18.1', 'v18.20.5']) {
    await rec(`host Node ${v}: agentlab version refused`, () => {
      const node = join(homedir(), '.nvm', 'versions', 'node', v, 'bin', 'node');
      expect(existsSync(node), `${node} not found`);
      const r = sh(node, [join(repo, 'bin', 'agentlab.js'), 'version']);
      expect(r.status !== 0 && r.status !== null && /needs Node\.js 22/.test(`${r.stdout}${r.stderr}`), brief(r));
      return `exit ${r.status}: ${tail(`${r.stdout}${r.stderr}`, 1)}`;
    });
  }
}

// ---------- run ----------

try {
  for (const image of args.images.split(',').filter(Boolean)) {
    try { await verifyImage(image); } catch (err) { console.error(err); report.images.find((i) => i.image === image).ok = false; }
  }
  await hostGate();
} finally {
  if (!args.keep) for (const c of containers) sh('docker', ['rm', '-f', c]);
  else console.log(`kept containers: ${containers.join(', ')}`);
}

// What must pass: supported and gate images, and the host gate. Informational images never fail the run.
const failed = report.images.filter((i) => i.role !== 'info' && !i.ok).map((i) => i.image).concat(report.hostGate.filter((x) => !x.ok).map((x) => x.step));
report.ok = failed.length === 0;
writeFileSync(join(outDir, 'verify-docker.json'), JSON.stringify(report, null, 2) + '\n');
const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
const md = [`# Docker install verification (${pkg.name} ${pkg.version})`, '', `Generated by \`node scripts/verify-docker.mjs\` on ${report.at}; ${report.host.docker}; tarball ${tarName}.`, ''];
for (const i of report.images) {
  md.push(`## ${i.image} (${i.role}): ${i.ok ? 'all steps ok' : i.role === 'info' ? 'see the steps: not supported' : 'FAILED'}`, '',
    `- digest: \`${i.digest ?? '?'}\`; ${i.arch ?? '?'}; ${i.os ?? '?'}; ${i.libc ?? '?'}; node ${i.nodeInContainer ?? '?'}; pull ${i.pullMs ?? '?'} ms`, '',
    '| step | result | ms | detail |', '| --- | --- | ---: | --- |',
    ...i.steps.map((s) => `| ${cell(s.step)} | ${s.ok ? 'ok' : 'FAIL'} | ${s.ms} | ${cell(s.detail)} |`), '');
}
md.push('## Host Node gate', '', '| step | result | ms | detail |', '| --- | --- | ---: | --- |', ...report.hostGate.map((s) => `| ${cell(s.step)} | ${s.ok ? 'ok' : 'FAIL'} | ${s.ms} | ${cell(s.detail)} |`), '');
writeFileSync(join(outDir, 'verify-docker.md'), md.join('\n'));
console.log(`\n${report.ok ? 'OK' : `FAILED: ${failed.join(', ')}`}; results in ${outDir}`);
if (!args.keep) rmSync(tmp, { recursive: true, force: true });
process.exit(report.ok ? 0 : 1);
