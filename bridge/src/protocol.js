/**
 * Incremental parser for the Async File Server wire protocol.
 *
 *   RESP <request_id> <length> <status> [<tag>]\n<payload>
 *   EVENT <seq> <length>\n<json>
 *
 * TCP delivers a byte stream, so frames may arrive split across chunks
 * or several per chunk. The parser buffers until a whole frame exists.
 */

const MAX_HEADER = 256;
const MAX_PAYLOAD = 64 * 1024 * 1024;

export class ProtocolError extends Error {}

export class FrameParser {
  constructor() {
    this.chunks = [];
    this.length = 0;
    this.pending = null; // parsed header waiting for its payload
  }

  /** Feeds bytes; returns the list of complete frames. */
  push(chunk) {
    this.chunks.push(chunk);
    this.length += chunk.length;

    const frames = [];

    for (;;) {
      if (!this.pending) {
        const header = this.#takeLine();
        if (header === null) break;
        this.pending = parseHeader(header);
      }

      if (this.length < this.pending.length) break;

      const payload = this.#take(this.pending.length);
      frames.push({ ...this.pending, payload });
      this.pending = null;
    }

    return frames;
  }

  #buffer() {
    if (this.chunks.length > 1) this.chunks = [Buffer.concat(this.chunks, this.length)];
    return this.chunks[0] ?? Buffer.alloc(0);
  }

  #take(n) {
    const buf = this.#buffer();
    const out = buf.subarray(0, n);
    const rest = buf.subarray(n);
    this.chunks = rest.length ? [rest] : [];
    this.length = rest.length;
    return Buffer.from(out);
  }

  #takeLine() {
    const buf = this.#buffer();
    const nl = buf.indexOf(0x0a);

    if (nl === -1) {
      if (buf.length > MAX_HEADER) throw new ProtocolError('Frame header too long');
      return null;
    }

    if (nl > MAX_HEADER) throw new ProtocolError('Frame header too long');

    const line = buf.subarray(0, nl).toString('latin1');
    const rest = buf.subarray(nl + 1);
    this.chunks = rest.length ? [rest] : [];
    this.length = rest.length;
    return line;
  }
}

function parseHeader(line) {
  const parts = line.split(' ');
  const kind = parts[0];

  if (kind === 'RESP' && parts.length >= 3) {
    const id = Number(parts[1]);
    const length = Number(parts[2]);
    checkLength(length, line);
    if (!Number.isInteger(id)) throw new ProtocolError(`Bad request id: ${line}`);

    return {
      kind,
      id,
      length,
      // Servers older than the status extension send only id + length.
      status: parts[3] ?? 'UNKNOWN',
      tag: parts[4] ?? null,
    };
  }

  if (kind === 'EVENT' && parts.length === 3) {
    const length = Number(parts[2]);
    checkLength(length, line);
    return { kind, seq: Number(parts[1]), length };
  }

  throw new ProtocolError(`Unrecognized frame header: ${JSON.stringify(line.slice(0, 80))}`);
}

function checkLength(length, line) {
  if (!Number.isInteger(length) || length < 0 || length > MAX_PAYLOAD) {
    throw new ProtocolError(`Bad payload length: ${line}`);
  }
}

/** Same rule the C server enforces (filename_is_valid). */
export const FILENAME_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/;

export function isValidFilename(name) {
  return typeof name === 'string' && FILENAME_RE.test(name);
}
