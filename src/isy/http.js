// -----------------------------------------------------------------------------
// HTTP to the REST API of the controller (basic authentication with the
// user name and password of the ISY Admin Console), on node:http.
//
// - One new connection per request (an agent without keep-alive): pyisy
//   saw an ISY994 answer the next request of a kept-alive socket with the
//   body of a previous 404. No `createConnection`.
// - Every answer is bounded in size (per request) and in time (the whole
//   request, not only an idle socket); the chunks are joined once.
// - `beforeSend`: called once the connection is made, right before the
//   request is written; false withdraws it (nothing was sent). `sent` tells
//   whether the request may have reached the controller.
// - Redirections are not followed. The password is never in an error.
// -----------------------------------------------------------------------------

import http from 'node:http';

export class IsyError extends Error {
  /**
   * kind: 'auth' (401/403), 'busy' (503), 'status' (another HTTP status),
   * 'network', 'timeout', 'too_large', 'withdrawn' (beforeSend said no).
   */
  constructor(kind, message, { sent = false, status } = {}) {
    super(message);
    this.kind = kind;
    this.sent = sent;
    this.status = status;
  }
}

/** The Authorization header: latin-1 like pyisy when it fits, UTF-8 otherwise. */
export function basicAuth(username, password) {
  const pair = `${username}:${password}`;
  // eslint-disable-next-line no-control-regex
  const encoding = /^[\u0000-ÿ]*$/.test(pair) ? 'latin1' : 'utf8';
  return `Basic ${Buffer.from(pair, encoding).toString('base64')}`;
}

/** A path of the REST API with every segment encoded. */
export const restPath = (...segments) =>
  `/rest/${segments.map((s) => encodeURIComponent(String(s))).join('/')}`;

export function httpTransport({ host, port, username, password }) {
  const agent = new http.Agent({ keepAlive: false });
  const authorization = basicAuth(username, password);
  /**
   * GET `path`; resolves { status: 200 | 404, body } (404 only with ok404).
   */
  const get = (path, { timeout = 15_000, maxBytes = 64 * 1024, ok404 = false, beforeSend } = {}) =>
    new Promise((resolve, reject) => {
      let sent = false;
      let settled = false;
      const chunks = [];
      let size = 0;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn(value);
      };
      const req = http.request({
        host,
        port,
        path,
        method: 'GET',
        agent,
        headers: { authorization, accept: 'text/xml' },
      });
      const timer = setTimeout(() => {
        finish(reject, new IsyError('timeout', 'the controller did not answer in time', { sent }));
        req.destroy();
      }, timeout);
      const write = () => {
        if (settled) return;
        if (beforeSend && !beforeSend()) {
          finish(reject, new IsyError('withdrawn', 'withdrawn before sending'));
          req.destroy();
          return;
        }
        sent = true;
        req.end();
      };
      req.on('socket', (socket) => {
        if (!socket.connecting) write();
        else socket.once('connect', write);
      });
      req.on('error', (err) => {
        finish(reject, new IsyError('network', String(err.code ?? 'connection failed'), { sent }));
      });
      req.on('response', (res) => {
        const status = res.statusCode;
        if (status !== 200 && !(status === 404 && ok404)) {
          res.resume();
          const kind =
            status === 401 || status === 403 ? 'auth' : status === 503 ? 'busy' : 'status';
          finish(reject, new IsyError(kind, `HTTP ${status}`, { sent: true, status }));
          req.destroy();
          return;
        }
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > maxBytes) {
            finish(reject, new IsyError('too_large', 'answer too large', { sent: true }));
            req.destroy();
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () =>
          finish(resolve, { status, body: Buffer.concat(chunks, size).toString('utf8') }),
        );
        res.on('error', () =>
          finish(reject, new IsyError('network', 'answer cut', { sent: true })),
        );
      });
    });
  return { get, close: () => agent.destroy() };
}
