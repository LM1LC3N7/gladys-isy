// -----------------------------------------------------------------------------
// The event stream of the controller: a WebSocket (RFC 6455) on
// /rest/subscribe, with the subprotocol `ISYSUB` and the origin
// `com.universal-devices.websockets.isy` that the Universal Devices
// WebSocket documentation asks for (pyisy events/websocket.py sends the same
// two headers), and the basic authentication of the REST API.
//
// The client of LM1LC3N7/gladys-system-bridge (same author, same licence),
// on node:http: the upgrade answer is checked (101, the accept key, no
// extension, no other subprotocol), a message larger than `maxMessageBytes`
// closes the connection before it is buffered, frames from the server must
// not be masked, control frames are small, text must be valid UTF-8, the
// bytes are copied once (a queue of chunks, never a concatenation per
// chunk), pings are answered (one pong waiting at most, a peer that does not
// read is dropped). Text frames only.
// -----------------------------------------------------------------------------

import { createHash, randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { basicAuth } from './http.js';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
export const SUBPROTOCOL = 'ISYSUB';
export const ORIGIN = 'com.universal-devices.websockets.isy';
/** Frames one message may be split into (empty continuations included). */
export const MAX_FRAGMENTS = 1_024;
/** Pings answered in a row without a message in between: beyond, the connection is closed. */
export const MAX_PINGS_IN_A_ROW = 100;
/** A pong is written only while less than this waits in the socket. */
export const MAX_PENDING_WRITE_BYTES = 64 * 1024;
const CLOSE_WAIT = 2_000;
/** Bytes received before the first turn after the upgrade (kept in order behind `head`). */
export const MAX_EARLY_BYTES = 4 * 1024 * 1024;
const OPCODES = Object.freeze({
  CONTINUATION: 0x0,
  TEXT: 0x1,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa,
});

export class SocketError extends Error {
  /** kind: 'auth', 'status', 'network', 'timeout', 'bad_answer', 'too_large', 'closed'. */
  constructor(kind, message, { status } = {}) {
    super(message);
    this.kind = kind;
    this.status = status;
  }
}

/**
 * Opens the event stream. Resolves with a WebSocketConnection once the
 * upgrade is accepted; rejects with a SocketError (never holding what the
 * controller sent, nor the password).
 */
export function openEventStream({
  host,
  port,
  username,
  password,
  timeoutMs,
  maxMessageBytes,
  onMessage,
  onClose,
  request = httpRequest,
}) {
  return new Promise((resolve, reject) => {
    const key = randomBytes(16).toString('base64');
    const accept = createHash('sha1').update(`${key}${GUID}`).digest('base64');
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.destroy();
      reject(err);
    };
    const req = request({
      host,
      port,
      path: '/rest/subscribe',
      method: 'GET',
      agent: false,
      headers: {
        Authorization: basicAuth(username, password),
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': key,
        'Sec-WebSocket-Protocol': SUBPROTOCOL,
        Origin: ORIGIN,
      },
    });
    const timer = setTimeout(
      () => fail(new SocketError('timeout', 'no WebSocket upgrade in time')),
      timeoutMs,
    );
    req.on('error', (err) =>
      fail(new SocketError('network', String(err?.code ?? 'connection failed'))),
    );
    req.on('response', (res) => {
      // Not an upgrade: only the status is read, never the body.
      const status = res.statusCode;
      res.destroy();
      if (status === 401 || status === 403) {
        fail(new SocketError('auth', `HTTP ${status}`, { status }));
        return;
      }
      fail(
        new SocketError(
          status === 101 ? 'bad_answer' : 'status',
          `HTTP ${status} instead of a WebSocket`,
          { status },
        ),
      );
    });
    req.on('upgrade', (res, socket, head) => {
      if (settled) {
        socket.destroy();
        return;
      }
      const upgrade = String(res.headers.upgrade ?? '').toLowerCase();
      const connection = String(res.headers.connection ?? '')
        .toLowerCase()
        .split(',')
        .map((token) => token.trim());
      const protocol = res.headers['sec-websocket-protocol'];
      if (
        res.statusCode !== 101 ||
        upgrade !== 'websocket' ||
        !connection.includes('upgrade') ||
        res.headers['sec-websocket-accept'] !== accept ||
        res.headers['sec-websocket-extensions'] !== undefined ||
        (protocol !== undefined && protocol !== SUBPROTOCOL)
      ) {
        socket.destroy();
        fail(new SocketError('bad_answer', 'not a valid WebSocket upgrade'));
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(new WebSocketConnection(socket, head, { maxMessageBytes, onMessage, onClose }));
    });
    req.end();
  });
}

export class WebSocketConnection {
  #socket;
  /** The bytes received and not parsed yet: chunks from #head, the first one from #offset. */
  #chunks = [];
  #head = 0;
  #offset = 0;
  #buffered = 0;
  #fragments = null;
  #fragmentBytes = 0;
  #pongPending = false;
  /** The frame being received: { fin, opcode, payload (its final size), filled }. */
  #partial = null;
  #pingsInARow = 0;
  #closeTimer = null;
  #finished = false;
  #decoder = new TextDecoder('utf-8', { fatal: true });

  constructor(socket, head, { maxMessageBytes, onMessage, onClose }) {
    this.#socket = socket;
    this.maxMessageBytes = maxMessageBytes;
    this.onMessage = onMessage;
    this.onClose = onClose;
    this.open = true;
    socket.setNoDelay?.(true);
    // The bytes that came with the upgrade (`head`) reach the parser once the
    // owner holds the connection, at the next turn; what the socket receives
    // before that waits behind them, in order (bounded), never ahead of them.
    const early = [];
    let earlyBytes = 0;
    let ready = false;
    socket.on('data', (chunk) => {
      if (ready) {
        this.#receive(chunk);
        return;
      }
      earlyBytes += chunk.length;
      if (earlyBytes > MAX_EARLY_BYTES) {
        this.#fail('too_large', 'too much data before the stream was ready');
        return;
      }
      early.push(chunk);
    });
    socket.on('error', (err) =>
      this.#finish(new SocketError('closed', `connection lost (${String(err?.code ?? 'error')})`)),
    );
    socket.on('close', () => this.#finish(new SocketError('closed', 'connection closed')));
    setImmediate(() => {
      ready = true;
      if (head?.length) this.#receive(head);
      for (const chunk of early.splice(0)) this.#receive(chunk);
    });
  }

  /** Close (normal closure), then destroy the socket if the server does not answer. */
  close() {
    if (!this.open) return;
    this.open = false;
    const code = Buffer.alloc(2);
    code.writeUInt16BE(1000);
    try {
      this.#socket.write(this.#frame(OPCODES.CLOSE, code));
      this.#socket.end();
    } catch {
      // The socket is already gone: destroyed below.
    }
    this.#closeTimer = setTimeout(() => this.#socket.destroy(), CLOSE_WAIT);
    this.#finish(new SocketError('closed', 'connection closed by Gladys'), { notify: false });
  }

  #finish(err, { notify = true } = {}) {
    if (this.#finished) return;
    this.#finished = true;
    this.open = false;
    this.#chunks = [];
    this.#head = 0;
    this.#offset = 0;
    this.#buffered = 0;
    this.#fragments = null;
    this.#partial = null;
    if (!this.#closeTimer) this.#socket.destroy();
    else this.#socket.once('close', () => clearTimeout(this.#closeTimer));
    if (!notify) return;
    try {
      this.onClose?.(err);
    } catch {
      // The owner's handler never breaks the socket handling.
    }
  }

  #fail(kind, message) {
    if (this.#finished) return;
    this.open = false;
    this.#socket.destroy();
    this.#finish(new SocketError(kind, message));
  }

  /** A masked client frame (RFC 6455: every client frame is masked). */
  #frame(opcode, payload) {
    const length = payload.length;
    const header = Buffer.alloc(2 + 4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | length; // Control frames only: at most 125 bytes.
    const mask = randomBytes(4);
    mask.copy(header, 2);
    const masked = Buffer.allocUnsafe(length);
    for (let i = 0; i < length; i += 1) masked[i] = payload[i] ^ mask[i & 3];
    return Buffer.concat([header, masked]);
  }

  /** Copies the first `n` buffered bytes; `consume` removes them (index, never Array.shift). */
  #read(n, consume) {
    const out = Buffer.allocUnsafe(n);
    let copied = 0;
    let index = this.#head;
    let offset = this.#offset;
    while (copied < n) {
      const chunk = this.#chunks[index];
      const take = Math.min(chunk.length - offset, n - copied);
      chunk.copy(out, copied, offset, offset + take);
      copied += take;
      offset += take;
      if (offset === chunk.length) {
        index += 1;
        offset = 0;
      }
    }
    if (consume) {
      this.#buffered -= n;
      this.#head = index;
      this.#offset = offset;
      if (this.#head >= 64 && this.#head * 2 >= this.#chunks.length) {
        this.#chunks = this.#chunks.slice(this.#head);
        this.#head = 0;
      }
    }
    return out;
  }

  #receive(chunk) {
    if (this.#finished) return;
    if (this.#partial) {
      const frame = this.#partial;
      const take = Math.min(chunk.length, frame.payload.length - frame.filled);
      chunk.copy(frame.payload, frame.filled, 0, take);
      frame.filled += take;
      if (frame.filled < frame.payload.length) return;
      this.#partial = null;
      this.#frameReceived(frame.fin, frame.opcode, frame.payload);
      if (take === chunk.length) return;
      chunk = chunk.subarray(take);
      if (this.#finished) return;
    }
    this.#chunks.push(chunk);
    this.#buffered += chunk.length;
    while (!this.#finished && this.#buffered >= 2) {
      const head = this.#read(Math.min(this.#buffered, 10), false);
      const fin = (head[0] & 0x80) !== 0;
      const opcode = head[0] & 0x0f;
      if ((head[0] & 0x70) !== 0) return this.#fail('bad_answer', 'reserved bits set');
      if ((head[1] & 0x80) !== 0) return this.#fail('bad_answer', 'masked server frame');
      if (![0x0, 0x1, 0x8, 0x9, 0xa].includes(opcode)) {
        return this.#fail('bad_answer', 'unexpected frame');
      }
      let length = head[1] & 0x7f;
      let headerLength = 2;
      if (length === 126) {
        if (head.length < 4) return undefined;
        length = head.readUInt16BE(2);
        headerLength = 4;
      } else if (length === 127) {
        if (head.length < 10) return undefined;
        if (head.readUInt32BE(2) !== 0) return this.#fail('too_large', 'message too large');
        length = head.readUInt32BE(6);
        headerLength = 10;
      }
      const control = opcode >= 0x8;
      if (control && (!fin || length > 125))
        return this.#fail('bad_answer', 'invalid control frame');
      if (!control && this.#fragmentBytes + length > this.maxMessageBytes) {
        return this.#fail('too_large', 'message too large');
      }
      if (opcode === OPCODES.CONTINUATION && !fin && length === 0) {
        return this.#fail('bad_answer', 'empty continuation');
      }
      if (opcode === OPCODES.CLOSE && length === 1)
        return this.#fail('bad_answer', 'invalid close frame');
      if (this.#buffered < headerLength) return undefined;
      this.#read(headerLength, true);
      if (this.#buffered < length) {
        const payload = Buffer.allocUnsafe(length);
        const filled = this.#buffered;
        if (filled > 0) this.#read(filled, true).copy(payload, 0);
        this.#chunks = [];
        this.#head = 0;
        this.#offset = 0;
        this.#partial = { fin, opcode, payload, filled };
        return undefined;
      }
      const payload = length > 0 ? this.#read(length, true) : Buffer.alloc(0);
      this.#frameReceived(fin, opcode, payload);
    }
    return undefined;
  }

  #frameReceived(fin, opcode, payload) {
    switch (opcode) {
      case OPCODES.TEXT:
        if (this.#fragments) return this.#fail('bad_answer', 'unexpected text frame');
        if (fin) return this.#deliver(payload);
        this.#fragments = [payload];
        this.#fragmentBytes = payload.length;
        return undefined;
      case OPCODES.CONTINUATION:
        if (!this.#fragments) return this.#fail('bad_answer', 'unexpected continuation');
        if (this.#fragments.length >= MAX_FRAGMENTS)
          return this.#fail('too_large', 'too many fragments');
        this.#fragments.push(payload);
        this.#fragmentBytes += payload.length;
        if (fin) {
          const message = Buffer.concat(this.#fragments, this.#fragmentBytes);
          this.#fragments = null;
          this.#fragmentBytes = 0;
          this.#deliver(message);
        }
        return undefined;
      case OPCODES.PING:
        this.#pingsInARow += 1;
        if (this.#pingsInARow > MAX_PINGS_IN_A_ROW)
          return this.#fail('bad_answer', 'too many pings');
        if ((this.#socket.writableLength ?? 0) > MAX_PENDING_WRITE_BYTES) {
          return this.#fail('bad_answer', 'peer does not read');
        }
        if (this.open && !this.#pongPending) {
          this.#pongPending = true;
          this.#socket.write(this.#frame(OPCODES.PONG, payload), () => {
            this.#pongPending = false;
          });
        }
        // Any frame proves the stream alive.
        try {
          this.onMessage?.(undefined);
        } catch {
          // Never breaks the parsing.
        }
        return undefined;
      case OPCODES.PONG:
        return undefined;
      case OPCODES.CLOSE:
        if (this.open) {
          this.open = false;
          try {
            this.#socket.write(this.#frame(OPCODES.CLOSE, payload.subarray(0, 2)));
            this.#socket.end();
          } catch {
            // Gone already.
          }
        }
        this.#socket.destroy();
        return this.#finish(new SocketError('closed', 'connection closed by the controller'));
      default:
        return this.#fail('bad_answer', 'unexpected frame');
    }
  }

  #deliver(payload) {
    let text;
    try {
      text = this.#decoder.decode(payload);
    } catch {
      return this.#fail('bad_answer', 'invalid UTF-8');
    }
    this.#pingsInARow = 0;
    try {
      this.onMessage?.(text);
    } catch {
      // The owner's handler never breaks the frame parsing.
    }
    return undefined;
  }
}
