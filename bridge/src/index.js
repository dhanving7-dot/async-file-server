/**
 * Async File Server bridge.
 *
 * Translates browser HTTP/WebSocket traffic into the C server's TCP
 * protocol. Every file operation is executed by the C workers; this
 * process never opens, reads or writes files in the files/ directory.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

import { AfsBackend, BackendError } from './backend.js';
import { isValidFilename } from './protocol.js';

const BRIDGE_PORT = Number(process.env.BRIDGE_PORT ?? 7070);
const BRIDGE_HOST = process.env.BRIDGE_HOST ?? '127.0.0.1';
const AFS_HOST = process.env.AFS_HOST ?? '127.0.0.1';
const AFS_PORT = Number(process.env.AFS_PORT ?? 8080);

const MAX_BODY_BYTES = 12 * 1024 * 1024;
const MAX_WRITE_BYTES = 8 * 1024 * 1024; // matches MAX_WRITE_BYTES in server.c
const MAX_BATCH = 64;
const SNAPSHOT_INTERVAL_MS = 1000;

const here = path.dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = path.resolve(here, '../../frontend/dist');
const startedAt = Date.now();

const backend = new AfsBackend({ host: AFS_HOST, port: AFS_PORT });

let latestSnapshot = null;

// ---------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------

const STATUS_TO_HTTP = {
  OK: 200,
  ENOENT: 404,
  EEXIST: 409,
  EINVAL: 400,
  EACCES: 403,
  ETOOBIG: 413,
  ENOSPC: 507,
  EBUSY: 503,
  ENOMEM: 503,
};

function httpStatusFor(backendStatus) {
  return STATUS_TO_HTTP[backendStatus] ?? 500;
}

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
  });
  res.end(data);
}

function sendError(res, err) {
  if (err instanceof BackendError) {
    sendJson(res, err.httpStatus, { ok: false, code: err.code, error: err.message });
    return;
  }
  console.error('[bridge] unexpected error', err);
  sendJson(res, 500, { ok: false, code: 'EINTERNAL', error: 'Internal bridge error.' });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new BackendError('Request body too large.', 'ETOOBIG', 413));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const body = await readBody(req);
  if (body.length === 0) return {};
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    throw new BackendError('Body must be valid JSON.', 'EINVAL', 400);
  }
}

function requireFilename(name) {
  if (!isValidFilename(name)) {
    throw new BackendError(
      'Invalid filename. Use 1-128 characters: letters, digits, ".", "_" or "-", not starting with ".".',
      'EINVAL',
      400,
    );
  }
}

const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

function decodeContent(buffer) {
  if (!buffer.includes(0)) {
    try {
      return { content: utf8Decoder.decode(buffer), encoding: 'utf8' };
    } catch {
      /* fall through to base64 */
    }
  }
  return { content: buffer.toString('base64'), encoding: 'base64' };
}

function encodeContent(body) {
  if (typeof body.content !== 'string') {
    throw new BackendError('"content" must be a string.', 'EINVAL', 400);
  }
  const buffer =
    body.encoding === 'base64' ? Buffer.from(body.content, 'base64') : Buffer.from(body.content, 'utf8');
  if (buffer.length > MAX_WRITE_BYTES) {
    throw new BackendError(`Content exceeds ${MAX_WRITE_BYTES} bytes.`, 'ETOOBIG', 413);
  }
  return buffer;
}

async function backendJson(command) {
  const response = await backend.request(command);
  if (!response.ok) {
    throw new BackendError(response.payload.toString('utf8'), response.status, httpStatusFor(response.status));
  }
  return JSON.parse(response.payload.toString('utf8'));
}

/** Converts a backend file-operation response into an API result. */
function operationResult(op, file, response, { includeContent = false, bytesSent = 0 } = {}) {
  const result = {
    ok: response.ok,
    op,
    file,
    requestId: response.id,
    status: response.status,
    // READ: bytes returned by the server. WRITE: bytes the server confirmed writing.
    bytes: op === 'READ' ? (response.ok ? response.payload.length : 0) : response.ok ? bytesSent : 0,
    roundTripMs: Number(response.roundTripMs.toFixed(3)),
  };

  if (op === 'READ' && response.ok) {
    if (includeContent) Object.assign(result, decodeContent(response.payload));
  } else {
    result.message = response.payload.toString('utf8');
  }

  return result;
}

/** Builds the TCP request for one operation. */
function buildOperation(op, file, body) {
  requireFilename(file);

  switch (op) {
    case 'READ':
      return { line: `READ ${file}`, payload: null };
    case 'CREATE':
      return { line: `CREATE ${file}`, payload: null };
    case 'WRITE': {
      const payload = encodeContent(body);
      return { line: `WRITEB ${file} ${payload.length}`, payload };
    }
    default:
      throw new BackendError(`Unsupported operation "${op}".`, 'EINVAL', 400);
  }
}

// ---------------------------------------------------------------------
// API routes
// ---------------------------------------------------------------------

async function handleApi(req, res, url) {
  const { pathname } = url;
  const method = req.method;

  if (pathname === '/api/status' && method === 'GET') {
    sendJson(res, 200, {
      bridge: { ok: true, startedAt, uptimeMs: Date.now() - startedAt, port: BRIDGE_PORT },
      backend: backend.status(),
    });
    return;
  }

  if (pathname === '/api/stats' && method === 'GET') {
    sendJson(res, 200, await backendJson('STATS'));
    return;
  }

  if (pathname === '/api/logs' && method === 'GET') {
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 500) || 500, 1), 2000);
    sendJson(res, 200, await backendJson(`LOGS ${limit}`));
    return;
  }

  if (pathname === '/api/files' && method === 'GET') {
    sendJson(res, 200, await backendJson('LIST'));
    return;
  }

  // Create a file (optionally with initial content, as a second request).
  if (pathname === '/api/files' && method === 'POST') {
    const body = await readJson(req);
    const file = body.name;
    const create = buildOperation('CREATE', file, body);
    const write = typeof body.content === 'string' && body.content.length > 0
      ? buildOperation('WRITE', file, body)
      : null;

    const created = await backend.request(create.line, create.payload);
    const createResult = operationResult('CREATE', file, created);

    if (!created.ok || !write) {
      sendJson(res, created.ok ? 201 : httpStatusFor(created.status), createResult);
      return;
    }

    const written = await backend.request(write.line, write.payload);
    const writeResult = operationResult('WRITE', file, written, { bytesSent: write.payload.length });

    sendJson(res, written.ok ? 201 : httpStatusFor(written.status), {
      ...writeResult,
      ok: written.ok,
      create: createResult,
    });
    return;
  }

  const fileMatch = pathname.match(/^\/api\/files\/([^/]+)$/);

  if (fileMatch) {
    let file;
    try {
      file = decodeURIComponent(fileMatch[1]);
    } catch {
      throw new BackendError('Malformed filename encoding.', 'EINVAL', 400);
    }

    if (method === 'GET') {
      const op = buildOperation('READ', file);
      const response = await backend.request(op.line);
      sendJson(res, httpStatusFor(response.status), operationResult('READ', file, response, { includeContent: true }));
      return;
    }

    if (method === 'PUT') {
      const body = await readJson(req);
      const op = buildOperation('WRITE', file, body);
      const response = await backend.request(op.line, op.payload);
      sendJson(res, httpStatusFor(response.status), operationResult('WRITE', file, response, { bytesSent: op.payload.length }));
      return;
    }
  }

  // Submit several operations at once. They are pipelined on the same
  // connection without waiting, exactly like the CLI client's batch mode,
  // so the 4 workers pick them up concurrently.
  if (pathname === '/api/batch' && method === 'POST') {
    const body = await readJson(req);
    const requests = body.requests;

    if (!Array.isArray(requests) || requests.length === 0 || requests.length > MAX_BATCH) {
      throw new BackendError(`"requests" must be an array of 1-${MAX_BATCH} operations.`, 'EINVAL', 400);
    }

    const ops = requests.map((r) => {
      const op = String(r.op ?? '').toUpperCase();
      return { op, file: r.file, ...buildOperation(op, r.file, r) };
    });

    const settled = await Promise.allSettled(ops.map((o) => backend.request(o.line, o.payload)));

    const results = settled.map((s, i) =>
      s.status === 'fulfilled'
        ? operationResult(ops[i].op, ops[i].file, s.value, { bytesSent: ops[i].payload?.length ?? 0 })
        : { ok: false, op: ops[i].op, file: ops[i].file, code: s.reason.code, error: s.reason.message },
    );

    sendJson(res, 200, {
      ok: results.every((r) => r.ok),
      submitted: results.length,
      succeeded: results.filter((r) => r.ok).length,
      results,
    });
    return;
  }

  sendJson(res, 404, { ok: false, code: 'ENOTFOUND', error: 'Unknown API route.' });
}

// ---------------------------------------------------------------------
// static frontend (production build)
// ---------------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
};

function serveStatic(req, res, url) {
  if (!fs.existsSync(STATIC_DIR)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Frontend not built. Run "npm run build" in frontend/, or use the Vite dev server.');
    return;
  }

  let relative;
  try {
    relative = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400).end();
    return;
  }

  let filePath = path.resolve(STATIC_DIR, '.' + relative);

  // Stay inside the dist directory.
  if (filePath !== STATIC_DIR && !filePath.startsWith(STATIC_DIR + path.sep)) {
    res.writeHead(403).end();
    return;
  }

  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(STATIC_DIR, 'index.html'); // SPA fallback
  }

  const ext = path.extname(filePath);
  res.writeHead(200, {
    'Content-Type': MIME[ext] ?? 'application/octet-stream',
    'Cache-Control': filePath.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  fs.createReadStream(filePath).pipe(res);
}

// ---------------------------------------------------------------------
// HTTP + WebSocket server
// ---------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);

  if (url.pathname.startsWith('/api/')) {
    try {
      await handleApi(req, res, url);
    } catch (err) {
      if (!res.headersSent) sendError(res, err);
    }
    return;
  }

  serveStatic(req, res, url);
});

const wss = new WebSocketServer({ server, path: '/ws', perMessageDeflate: true });

function broadcast(message) {
  const data = JSON.stringify(message);
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) client.send(data);
  }
}

function statusMessage() {
  return {
    type: 'status',
    bridge: { ok: true, startedAt, uptimeMs: Date.now() - startedAt },
    backend: backend.status(),
  };
}

wss.on('connection', (socket) => {
  socket.isAlive = true;
  socket.on('pong', () => {
    socket.isAlive = true;
  });

  socket.send(JSON.stringify(statusMessage()));
  if (backend.online && latestSnapshot) {
    socket.send(JSON.stringify({ type: 'snapshot', data: latestSnapshot }));
  }
});

// Drop browser tabs that went away without closing the socket.
setInterval(() => {
  for (const client of wss.clients) {
    if (!client.isAlive) {
      client.terminate();
      continue;
    }
    client.isAlive = false;
    client.ping();
  }
}, 15_000);

backend.on('event', (event) => broadcast({ type: 'event', event }));

backend.on('status', (status) => {
  console.log(`[bridge] backend ${status.online ? 'ONLINE' : 'OFFLINE'}${status.lastError ? ` (${status.lastError})` : ''}`);
  if (!status.online) latestSnapshot = null;
  broadcast(statusMessage());
  if (status.online) pollSnapshot();
});

// Periodic authoritative snapshot; live events animate in between.
let snapshotInFlight = false;

async function pollSnapshot() {
  if (!backend.online || snapshotInFlight) return;
  snapshotInFlight = true;
  try {
    latestSnapshot = await backendJson('STATS');
    broadcast({ type: 'snapshot', data: latestSnapshot });
  } catch {
    /* backend status handling reports the outage */
  } finally {
    snapshotInFlight = false;
  }
}

setInterval(pollSnapshot, SNAPSHOT_INTERVAL_MS);

backend.start();

server.listen(BRIDGE_PORT, BRIDGE_HOST, () => {
  console.log(`[bridge] listening on http://${BRIDGE_HOST}:${BRIDGE_PORT}`);
  console.log(`[bridge] C backend expected at ${AFS_HOST}:${AFS_PORT}`);
  if (fs.existsSync(STATIC_DIR)) console.log(`[bridge] serving dashboard from ${STATIC_DIR}`);
});

function shutdown() {
  backend.stop();
  server.close();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
