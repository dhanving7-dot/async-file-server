# Async File Server — Console

A multithreaded C file server (request queue → 4 worker threads → completion
thread) with a live web dashboard that controls and monitors it.

The C server is the processing engine: every READ, WRITE and CREATE is executed by
its worker threads, and every number in the dashboard comes from the server.
The Node bridge only translates HTTP/WebSocket to the server's TCP protocol and
never touches the `files/` directory.

```
 Browser (React dashboard)
    │  HTTP  /api/*            WebSocket /ws
    ▼
 bridge/  (Node, :7070)  ── 1 pipelined TCP connection (tagged requests)
    │                    ── 1 SUBSCRIBE connection (live events + heartbeat)
    ▼
 backend/ (C, :8080, runs in WSL/Linux)
    connection thread per client ─ enqueue() ─▶ RequestQueue (mutex + condvar)
                                                   │ dequeue_by()
                                     worker 1..4 ◀─┘  openat/read/write/renameat in files/
                                                   │ completion_enqueue()
                                     completion thread ─▶ RESP frame to the client
    monitor: observes both queues through lock-held hooks → STATS + event stream
```

## Project layout

| Path | What it is |
|------|------------|
| `backend/src/server.c` | Server: accept loop, connection threads, workers, completion thread, protocol |
| `backend/src/queue.[ch]` | Request / completion queues (your original API + lock-held observer hooks) |
| `backend/src/performance.[ch]` | Per-request CLOCK_MONOTONIC timing and aggregate stats |
| `backend/src/logger.[ch]` | `logs/server.log` + in-memory ring with levels and request ids |
| `backend/src/monitor.[ch]` | Worker state, completion history, per-second timeline, event ring |
| `backend/src/jsonbuf.[ch]` | Small JSON builder for STATS / LIST / LOGS / events |
| `backend/clients/client.c` | Your interactive multi-request CLI client (unchanged) |
| `backend/legacy/` | Untouched copies of the original sources from `~/async_file_server` |
| `backend/files/` | The served directory |
| `backend/tests/protocol_test.py` | Raw TCP protocol test suite |
| `bridge/` | HTTP/WebSocket ↔ TCP bridge (Node, one dependency: `ws`) |
| `bridge/test/bridge.test.js` | End-to-end test of the bridge against the running server |
| `frontend/` | React + Vite + TypeScript + Tailwind + Framer Motion + Recharts dashboard |
| `scripts/` | `start-all.ps1`, `stop-all.ps1` (Windows + WSL), `start-all.sh` (Linux) |

## Requirements

- **WSL (Ubuntu)** with `gcc` and `make` — `sudo apt install build-essential`
- **Node.js 18+** on Windows (tested with Node 24)
- Python 3 (only for `protocol_test.py`)

## Install and run

### One command (Windows PowerShell)

```powershell
cd D:\OS_Project
powershell -ExecutionPolicy Bypass -File .\scripts\start-all.ps1
```

This compiles the C server in WSL, installs npm dependencies on first run, builds the
dashboard, opens three windows (C server, bridge, and Vite with `-Dev`) and opens
**http://127.0.0.1:7070**.

Options:

```powershell
.\scripts\start-all.ps1 -Dev            # hot-reloading dashboard on http://127.0.0.1:5173
.\scripts\start-all.ps1 -IoDelayMs 300  # demo mode: each worker holds every request 300 ms
.\scripts\start-all.ps1 -Rebuild        # force a fresh dashboard build
.\scripts\stop-all.ps1                  # stop everything (server prints its performance summary)
```

### Step by step (three terminals)

```powershell
# 1. C backend (WSL)
wsl --cd /mnt/d/OS_Project/backend -- make
wsl --cd /mnt/d/OS_Project/backend -- ./server            # add --io-delay-ms 300 for demos

# 2. Bridge
cd D:\OS_Project\bridge
npm install
node src/index.js                                         # http://127.0.0.1:7070

# 3a. Dashboard, production build (served by the bridge on :7070)
cd D:\OS_Project\frontend
npm install
npm run build

# 3b. …or dashboard dev server with hot reload
npm run dev                                               # http://127.0.0.1:5173
```

The CLI client still works alongside the dashboard:

```bash
wsl --cd /mnt/d/OS_Project/backend -- ./client
```

### Configuration

| Variable | Default | Used by |
|----------|---------|---------|
| `--port N` | `8080` | C server |
| `--io-delay-ms N` | `0` | C server — opt-in artificial worker delay, shown as a badge in the dashboard |
| `AFS_HOST` / `AFS_PORT` | `127.0.0.1` / `8080` | bridge → C server |
| `BRIDGE_HOST` / `BRIDGE_PORT` | `127.0.0.1` / `7070` | bridge listener |
| `BRIDGE_URL` | `http://127.0.0.1:7070` | Vite dev proxy, bridge tests |

## Protocol

Requests are newline-terminated. Every original command still works exactly as before.

```
READ <file>\n                          (original)
WRITE <file> <data>\n                  (original, single line)
EXIT\n                                 (original)
WRITEB <file> <length>\n<bytes>        length-prefixed, binary-safe, multi-line write
CREATE <file>\n                        O_CREAT|O_EXCL — fails with EEXIST
LIST\n  STATS\n  LOGS [n]\n  PING\n     monitoring, JSON payloads
SUBSCRIBE\n                            turns the connection into a live event stream
@<tag> <any request>\n                 optional tag echoed in the response
```

Responses:

```
RESP <request_id> <length> <status> [<tag>]\n<payload>
EVENT <seq> <length>\n<json>           (SUBSCRIBE connections only)
```

`status` is `OK` or an error code (`ENOENT`, `EEXIST`, `EINVAL`, `EACCES`,
`ETOOBIG`, `ENOSPC`, `EIO`). The original client parses `RESP %d %zu`, so the extra
fields are ignored and it keeps working unchanged.

## What changed in the C backend and why

| Area | Change |
|------|--------|
| Concurrency | Each client connection gets its own thread. Before, the accept loop served one client at a time, so the dashboard and the CLI client could not both be connected. |
| Response routing | Connections are reference-counted, so a socket closes only after its last pending response. Before, a disconnecting client's fd could be reused and receive another client's response. |
| Frame integrity | A per-connection send lock means error frames and completion frames can no longer interleave on the socket. |
| `SIGPIPE` | Ignored, and sends use `MSG_NOSIGNAL`. A client that vanishes can no longer kill the server. |
| Slow clients | `SO_SNDTIMEO` on client sockets, so a client that stops reading cannot stall the completion thread forever. |
| Security | Filenames are restricted to `[A-Za-z0-9._-]`, 1–128 chars, no leading dot. Files are opened with `openat(files_dirfd, …, O_NOFOLLOW)`, which blocks both `..` and symlink escapes. |
| Shared stats | Performance statistics are updated under a lock. Before, 4 workers raced on `performance_stats`. |
| READ | Loops until EOF (no short reads), streams up to 16 MB from heap buffers (was 1 MB on the stack), and the framing is binary-safe. |
| WRITE | Writes to a temp file and then `renameat`, so readers never see half-written files and concurrent writes cannot interleave. Failures are now also measured. |
| Observability | Lock-held queue hooks feed `STATS` and the event stream, so the dashboard always shows the *real* queue contents, not a copy. |
| Logging | Levels, request ids, `localtime_r`, and an in-memory ring for `LOGS`. |
| Shutdown | Ctrl+C (SIGINT) prints the original performance summary and exits cleanly. |

Lock order (documented in `monitor.c`): request queue → completion queue → monitor
state → event ring; logger → event ring.

## Testing

With the stack running:

```powershell
python backend\tests\protocol_test.py          # 35 checks, raw TCP to the C server
cd bridge; node test\bridge.test.js            # 25 checks through HTTP + WebSocket
node test\bridge.test.js --offline             # also stops/restarts the C server to verify offline status
```

Race detection (inside WSL):

```bash
cd /mnt/d/OS_Project/backend
gcc -O1 -g -fsanitize=thread -std=gnu11 -pthread -D_GNU_SOURCE src/*.c -o /tmp/server_tsan
cd /tmp && mkdir -p files logs && ./server_tsan --port 8091 &
python3 /mnt/d/OS_Project/backend/tests/protocol_test.py 127.0.0.1 8091
```

## Dashboard pages

- **Overview**: totals, failures, average response/processing/queue-wait time, active workers, queue size, uptime, connection status, live pipeline, throughput, activity stream.
- **Worker threads**: the 4 pthreads with live state, current request, elapsed time, recent-request strip, busy time and utilization.
- **Request queue**: FIFO contents of the real `RequestQueue` plus in-flight requests, with the animated pipeline.
- **Completion queue**: every completion with result, status, worker, processing / wait / end-to-end time, and delivery outcome.
- **File manager**: list (`LIST`), open (`READ`), edit and save (`WRITEB`), create (`CREATE` [+ `WRITEB`]). Ctrl+S saves.
- **Performance**: requests over time, average processing time, READ/WRITE mix, pool utilization, per-worker load, throughput, completion-time comparisons, and a per-request scatter.
- **Activity logs**: server log entries with search, level filters, request-id filtering, pause and follow.

Small files complete in microseconds, so the queue usually drains instantly. To watch
requests wait in the queue, start the server with `--io-delay-ms` (the dashboard shows a
"Demo I/O delay" badge whenever it is on).
