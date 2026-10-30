import net from 'node:net';
import { EventEmitter } from 'node:events';
import { FrameParser } from './protocol.js';

/**
 * Error carrying an HTTP status and a machine readable code.
 */
export class BackendError extends Error {
  constructor(message, code, httpStatus) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

/**
 * Maintains two TCP connections to the C server:
 *
 *  - "main":   pipelined, tagged requests ("@b17 READ x\n"). Responses
 *              arrive out of order (completion thread) and are matched by
 *              the tag the server echoes in the RESP header.
 *  - "events": a SUBSCRIBE stream of live server events with heartbeats.
 *
 * The backend counts as online only while both connections are healthy.
 */
export class AfsBackend extends EventEmitter {
  constructor({
    host = '127.0.0.1',
    port = 8080,
    requestTimeoutMs = 30_000,
    heartbeatTimeoutMs = 7_000,
    reconnectMs = 1_000,
  } = {}) {
    super();
    this.host = host;
    this.port = port;
    this.requestTimeoutMs = requestTimeoutMs;
    this.heartbeatTimeoutMs = heartbeatTimeoutMs;
    this.reconnectMs = reconnectMs;

    this.main = null;
    this.mainReady = false;
    this.events = null;
    this.eventsReady = false;
    this.lastEventData = 0;

    this.pending = new Map(); // tag -> { resolve, reject, timer, sentAt }
    this.tagCounter = 0;

    this.isOnline = false;
    this.onlineSince = null;
    this.lastError = null;
    this.lastEventSeq = 0;
    this.stopped = false;
  }

  start() {
    this.stopped = false;
    this.#connectMain();
    this.#connectEvents();
    this.livenessTimer = setInterval(() => this.#checkLiveness(), 1000);
  }

  stop() {
    this.stopped = true;
    clearInterval(this.livenessTimer);
    this.main?.destroy();
    this.events?.destroy();
  }

  get online() {
    return this.isOnline;
  }

  status() {
    return {
      online: this.isOnline,
      host: this.host,
      port: this.port,
      onlineSince: this.onlineSince,
      lastError: this.lastError,
      pendingRequests: this.pending.size,
      lastEventSeq: this.lastEventSeq,
    };
  }

  /**
   * Sends one request line (plus optional raw payload) and resolves with
   * the server's framed response. Never resolves without a real RESP.
   */
  request(line, payload = null) {
    if (!this.isOnline || !this.main) {
      return Promise.reject(
        new BackendError('Backend is offline: the C server is not reachable.', 'EOFFLINE', 503),
      );
    }

    if (line.includes('\n') || line.length > 4000) {
      return Promise.reject(new BackendError('Invalid request line.', 'EINVAL', 400));
    }

    const tag = `b${++this.tagCounter}`;
    const sentAt = performance.now();

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(tag);
        reject(
          new BackendError(
            'Timed out waiting for the backend response. The operation may still complete.',
            'ETIMEDOUT',
            504,
          ),
        );
      }, this.requestTimeoutMs);

      this.pending.set(tag, { resolve, reject, timer, sentAt });

      const header = Buffer.from(`@${tag} ${line}\n`, 'utf8');
      this.main.write(payload ? Buffer.concat([header, payload]) : header);
    });
  }

  // ------------------------------------------------------------------
  // main connection
  // ------------------------------------------------------------------

  #connectMain() {
    if (this.stopped) return;

    const socket = net.connect({ host: this.host, port: this.port });
    const parser = new FrameParser();
    this.main = socket;

    socket.setNoDelay(true);
    socket.setKeepAlive(true, 5000);

    socket.on('connect', () => {
      this.mainReady = true;
      this.#updateOnline();
    });

    socket.on('data', (chunk) => {
      let frames;
      try {
        frames = parser.push(chunk);
      } catch (err) {
        this.lastError = `Protocol error on main connection: ${err.message}`;
        socket.destroy();
        return;
      }

      for (const frame of frames) this.#handleResponse(frame);
    });

    socket.on('error', (err) => {
      this.lastError = describeSocketError(err, this.host, this.port);
    });

    socket.on('close', () => {
      if (this.main === socket) {
        if (this.mainReady && !this.lastError) this.lastError = 'Backend closed the connection (server stopped?).';
        this.main = null;
        this.mainReady = false;
        this.#failPending();
        this.#updateOnline();
        setTimeout(() => this.#connectMain(), this.reconnectMs);
      }
    });
  }

  #handleResponse(frame) {
    if (frame.kind !== 'RESP') return;

    const entry = frame.tag ? this.pending.get(frame.tag) : undefined;

    if (!entry) {
      // Untagged frames are protocol-level errors the bridge never
      // provokes (it validates input first); late answers to timed-out
      // requests also land here.
      return;
    }

    this.pending.delete(frame.tag);
    clearTimeout(entry.timer);

    entry.resolve({
      id: frame.id,
      status: frame.status,
      ok: frame.status === 'OK',
      tag: frame.tag,
      payload: frame.payload,
      roundTripMs: performance.now() - entry.sentAt,
    });
  }

  #failPending() {
    for (const [tag, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(
        new BackendError(
          'Connection to the backend was lost before a response arrived. ' +
            'The operation may or may not have completed.',
          'ECONNLOST',
          502,
        ),
      );
      this.pending.delete(tag);
    }
  }

  // ------------------------------------------------------------------
  // event stream
  // ------------------------------------------------------------------

  #connectEvents() {
    if (this.stopped) return;

    const socket = net.connect({ host: this.host, port: this.port });
    const parser = new FrameParser();
    let subscribed = false;
    this.events = socket;

    socket.setNoDelay(true);

    socket.on('connect', () => {
      this.lastEventData = Date.now();
      socket.write('SUBSCRIBE\n');
    });

    socket.on('data', (chunk) => {
      this.lastEventData = Date.now();

      let frames;
      try {
        frames = parser.push(chunk);
      } catch (err) {
        this.lastError = `Protocol error on event stream: ${err.message}`;
        socket.destroy();
        return;
      }

      for (const frame of frames) {
        if (!subscribed) {
          if (frame.kind === 'RESP' && frame.status === 'OK') {
            subscribed = true;
            this.eventsReady = true;
            this.#updateOnline();
          } else {
            socket.destroy();
          }
          continue;
        }

        if (frame.kind !== 'EVENT') continue;

        let event;
        try {
          event = JSON.parse(frame.payload.toString('utf8'));
        } catch {
          continue;
        }

        if (event.type === 'heartbeat') continue;

        if (event.seq) this.lastEventSeq = event.seq;
        this.emit('event', event);
      }
    });

    socket.on('error', (err) => {
      this.lastError = describeSocketError(err, this.host, this.port);
    });

    socket.on('close', () => {
      if (this.events === socket) {
        if (this.eventsReady && !this.lastError) this.lastError = 'Backend closed the event stream (server stopped?).';
        this.events = null;
        this.eventsReady = false;
        this.#updateOnline();
        setTimeout(() => this.#connectEvents(), this.reconnectMs);
      }
    });
  }

  #checkLiveness() {
    // The server sends a heartbeat at least every 2 s; silence means the
    // process is hung or the network path is gone.
    if (this.events && this.eventsReady && Date.now() - this.lastEventData > this.heartbeatTimeoutMs) {
      this.lastError = 'No heartbeat from backend event stream.';
      this.events.destroy();
    }
  }

  #updateOnline() {
    const online = this.mainReady && this.eventsReady;

    if (online === this.isOnline) return;

    this.isOnline = online;
    this.onlineSince = online ? Date.now() : null;
    if (online) this.lastError = null;

    // Both connections must go down together so a half-connected
    // backend is never reported as healthy.
    if (!online) {
      if (this.mainReady) this.main?.destroy();
      if (this.eventsReady) this.events?.destroy();
    }

    this.emit('status', this.status());
  }
}

function describeSocketError(err, host, port) {
  if (err.code === 'ECONNREFUSED') return `Connection refused at ${host}:${port} (server not running?)`;
  if (err.code === 'ECONNRESET') return 'Connection reset by backend.';
  return `${err.code ?? 'ERROR'}: ${err.message}`;
}
