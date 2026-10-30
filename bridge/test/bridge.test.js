/**
 * End-to-end test: browser-facing bridge API + WebSocket against the
 * running C server.
 *
 *   node test/bridge.test.js            (bridge on 127.0.0.1:7070)
 *   node test/bridge.test.js --offline  also stops/restarts the C server
 *                                       via WSL to verify offline status
 */

import { spawn, execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const BASE = process.env.BRIDGE_URL ?? 'http://127.0.0.1:7070';
const WS_URL = BASE.replace(/^http/, 'ws') + '/ws';
const OFFLINE = process.argv.includes('--offline');

let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures++;
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${!ok && detail !== undefined ? `  -- ${JSON.stringify(detail).slice(0, 300)}` : ''}`);
}

async function api(method, route, body) {
  const res = await fetch(BASE + route, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeoutMs, label) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return true;
    await sleep(100);
  }
  console.log(`       (timed out waiting for ${label})`);
  return false;
}

async function main() {
  // ---------------------------------------------------------- WebSocket
  const messages = [];
  const ws = new WebSocket(WS_URL);
  ws.on('message', (data) => messages.push(JSON.parse(data.toString())));
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });

  await waitFor(() => messages.some((m) => m.type === 'snapshot'), 3000, 'snapshot');
  const status = messages.find((m) => m.type === 'status');
  check('WS: status message says backend online', status?.backend?.online === true, status);
  const snap = messages.find((m) => m.type === 'snapshot')?.data;
  check('WS: snapshot has 4 workers from the C server', snap?.workers?.length === 4);

  const st = await api('GET', '/api/status');
  check('HTTP status: backend online', st.body.backend.online === true, st.body);

  // ---------------------------------------------------------- file ops
  const name = `e2e_${Date.now()}.txt`;
  const text = 'Line 1\nLine 2 — ünïcødé ✓ 漢字\n\ttab\n';

  let r = await api('POST', '/api/files', { name });
  check('CREATE returns 201 with a real request id', r.status === 201 && r.body.requestId > 0 && r.body.status === 'OK', r.body);

  r = await api('POST', '/api/files', { name });
  check('CREATE duplicate -> 409 EEXIST (no false success)', r.status === 409 && r.body.ok === false && r.body.status === 'EEXIST', r.body);

  r = await api('PUT', `/api/files/${name}`, { content: text });
  check('WRITE returns OK with bytes written', r.status === 200 && r.body.ok && r.body.bytes === Buffer.byteLength(text), r.body);

  r = await api('GET', `/api/files/${name}`);
  check('READ returns exactly the written UTF-8 content', r.status === 200 && r.body.content === text, r.body);

  r = await api('GET', '/api/files');
  const entry = r.body.files.find((f) => f.name === name);
  check('LIST shows the file with size and mtime', entry && entry.size === Buffer.byteLength(text) && entry.modified > 0, entry);

  r = await api('GET', '/api/files/does_not_exist.txt');
  check('READ missing file -> 404 ENOENT', r.status === 404 && r.body.status === 'ENOENT', r.body);

  r = await api('GET', `/api/files/${encodeURIComponent('../backend/src/server.c')}`);
  check('Traversal blocked at bridge -> 400', r.status === 400, r.body);

  r = await api('PUT', '/api/files/.hidden', { content: 'x' });
  check('Hidden filename blocked -> 400', r.status === 400, r.body);

  r = await api('PUT', `/api/files/${name}`, { content: 42 });
  check('Non-string content rejected -> 400', r.status === 400, r.body);

  const staticTraversal = await fetch(`${BASE}/%2e%2e/%2e%2e/backend/src/server.c`);
  const staticBody = await staticTraversal.text();
  check('Static server does not leak files outside dist', !staticBody.includes('#include'), staticBody.slice(0, 80));

  // ---------------------------------------------------------- concurrency
  const before = messages.length;
  const requests = [
    ...Array.from({ length: 12 }, () => ({ op: 'READ', file: 'large.txt' })),
    ...Array.from({ length: 4 }, (_, i) => ({ op: 'WRITE', file: `e2e_load_${i}.txt`, content: `load ${i}\n` })),
  ];
  r = await api('POST', '/api/batch', { requests });
  check('Batch of 16 requests all succeed', r.body.submitted === 16 && r.body.succeeded === 16, r.body);
  const ids = r.body.results.map((x) => x.requestId);
  check('Batch results carry 16 distinct server request ids', new Set(ids).size === 16, ids);

  await sleep(400);
  const events = messages.slice(before).filter((m) => m.type === 'event').map((m) => m.event);
  const started = events.filter((e) => e.type === 'request_started' && ids.includes(e.request_id));
  const finished = events.filter((e) => e.type === 'request_finished' && ids.includes(e.request_id));
  const delivered = events.filter((e) => e.type === 'completion_delivered' && ids.includes(e.request_id));
  check('WS: request_started received for every batch request', started.length === 16, started.length);
  check('WS: request_finished received for every batch request', finished.length === 16, finished.length);
  check('WS: completion_delivered received for every batch request', delivered.length === 16, delivered.length);

  const workersUsed = new Set(started.map((e) => e.worker));
  let busy = 0;
  let maxBusy = 0;
  for (const e of events.filter((e) => ids.includes(e.request_id))) {
    if (e.type === 'request_started') busy++;
    if (e.type === 'request_finished') busy--;
    maxBusy = Math.max(maxBusy, busy);
  }
  check('All 4 worker threads participated', workersUsed.size === 4, [...workersUsed]);
  check('Workers ran requests concurrently (overlap >= 2)', maxBusy >= 2, maxBusy);
  console.log(`       workers used ${[...workersUsed].sort()}, max concurrent ${maxBusy}`);

  const perf = finished.every((e) => typeof e.processing_ms === 'number' && e.processing_ms > 0);
  check('Every completion carries a measured processing time', perf);

  // ---------------------------------------------------------- stats + logs
  await sleep(1200);
  const stats = (await api('GET', '/api/stats')).body;
  check('STATS totals include the batch', stats.totals.completed >= 16 + 4, stats.totals);
  const lastSecondBuckets = stats.timeline.slice(-10).reduce((n, b) => n + b.completed, 0);
  check('Timeline buckets reflect recent completions', lastSecondBuckets >= 16, lastSecondBuckets);

  const logs = (await api('GET', '/api/logs?limit=400')).body.logs;
  const id = ids[0];
  check('LOGS contain worker lines for a batch request id', logs.some((l) => l.request_id === id && /WORKER \d PROCESSING REQUEST/.test(l.message)), id);
  const liveLogs = messages.filter((m) => m.type === 'event' && m.event.type === 'log');
  check('Live log lines streamed over WebSocket', liveLogs.length > 20, liveLogs.length);

  // ---------------------------------------------------------- offline
  if (OFFLINE) {
    console.log('       stopping C server (SIGINT via WSL)…');
    execFileSync('wsl', ['-d', 'Ubuntu', '--', 'pkill', '-INT', '-x', 'server']);

    const wentOffline = await waitFor(
      () => messages.some((m) => m.type === 'status' && m.backend.online === false),
      5000,
      'offline status',
    );
    check('WS: offline status pushed after server stops', wentOffline);

    r = await api('GET', '/api/files/small.txt');
    check('Requests while offline -> 503, never success', r.status === 503 && r.body.ok === false, r.body);
    const st2 = (await api('GET', '/api/status')).body;
    check('HTTP status reports backend offline with reason', st2.backend.online === false && !!st2.backend.lastError, st2.backend);

    console.log('       restarting C server…');
    const here = path.dirname(fileURLToPath(import.meta.url));
    const backendDir = path.resolve(here, '../../backend');
    const wslDir = '/mnt/' + backendDir[0].toLowerCase() + backendDir.slice(2).replace(/\\/g, '/');
    const child = spawn('wsl', ['-d', 'Ubuntu', '--cd', wslDir, '--', './server'], { detached: true, stdio: 'ignore' });
    child.unref();

    const cameBack = await waitFor(
      () => messages.filter((m) => m.type === 'status').at(-1)?.backend.online === true,
      8000,
      'online status',
    );
    check('WS: online status pushed after server restarts', cameBack);
    r = await api('GET', '/api/files/small.txt');
    check('READ works again after reconnect', r.status === 200 && r.body.ok, r.body);
  }

  ws.close();
  console.log(failures ? `\n${failures} TEST(S) FAILED` : '\nALL BRIDGE TESTS PASSED');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
