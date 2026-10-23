// The HTTP client and the WebSocket client against real local servers:
// bounds, authentication, the request withdrawn before it is written, frames.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { httpTransport } from '../src/isy/http.js';
import { openEventStream } from '../src/isy/websocket.js';
import { settle, textFrame, until } from './helpers/fakeIsy.js';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

async function server(t, handler, onUpgrade) {
  const s = http.createServer(handler);
  const sockets = new Set();
  if (onUpgrade) {
    s.on('upgrade', (req, socket) => {
      sockets.add(socket);
      const accept = createHash('sha1')
        .update(`${req.headers['sec-websocket-key']}${GUID}`)
        .digest('base64');
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
      socket.on('error', () => {});
      onUpgrade(socket);
    });
  }
  await new Promise((resolve) => s.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    s.closeAllConnections?.();
    await new Promise((resolve) => s.close(resolve));
  });
  return s.address().port;
}

test('HTTP: bounded answers, refused credentials, a request withdrawn is never written', async (t) => {
  const seen = [];
  const port = await server(t, (req, res) => {
    seen.push(req.url);
    if (req.url === '/big') return res.end('x'.repeat(10_000));
    if (req.url === '/auth') return res.writeHead(401).end();
    if (req.url === '/busy') return res.writeHead(503).end();
    if (req.url === '/slow') return undefined;
    return res.end('<ok/>');
  });
  const client = httpTransport({ host: '127.0.0.1', port, username: 'admin', password: 'secret' });
  t.after(() => client.close());
  assert.equal((await client.get('/fine')).body, '<ok/>');
  await assert.rejects(client.get('/big', { maxBytes: 1_000 }), { kind: 'too_large', sent: true });
  await assert.rejects(client.get('/auth'), { kind: 'auth', sent: true });
  await assert.rejects(client.get('/busy'), { kind: 'busy', sent: true });
  await assert.rejects(client.get('/slow', { timeout: 100 }), { kind: 'timeout', sent: true });
  await assert.rejects(client.get('/never', { beforeSend: () => false }), {
    kind: 'withdrawn',
    sent: false,
  });
  await settle(50);
  assert.ok(!seen.includes('/never'));
  const closed = httpTransport({ host: '127.0.0.1', port: 1, username: 'a', password: 'b' });
  await assert.rejects(closed.get('/x', { timeout: 2_000 }), { kind: 'network', sent: false });
});

test('WebSocket: fragments, a byte at a time, then a message too large closes before buffering', async (t) => {
  let socket;
  const port = await server(
    t,
    () => {},
    (s) => {
      socket = s;
    },
  );
  const messages = [];
  let closed;
  const stream = await openEventStream({
    host: '127.0.0.1',
    port,
    username: 'admin',
    password: 'secret',
    timeoutMs: 2_000,
    maxMessageBytes: 1_000,
    onMessage: (text) => text !== undefined && messages.push(text),
    onClose: (err) => {
      closed = err;
    },
  });
  t.after(() => stream.close());
  // One message in two fragments.
  socket.write(
    Buffer.concat([
      Buffer.from([0x01, 3]),
      Buffer.from('abc'),
      Buffer.from([0x80, 3]),
      Buffer.from('def'),
    ]),
  );
  // One message, a byte at a time.
  for (const byte of textFrame('<Event/>')) socket.write(Buffer.from([byte]));
  await until(() => messages.length === 2);
  assert.deepEqual(messages, ['abcdef', '<Event/>']);
  // A header announcing 1 MB: closed at once.
  const header = Buffer.alloc(10);
  header[0] = 0x81;
  header[1] = 127;
  header.writeUInt32BE(0, 2);
  header.writeUInt32BE(1024 * 1024, 6);
  socket.write(header);
  await until(() => closed);
  assert.equal(closed.kind, 'too_large');
});

test('WebSocket: a masked server frame or a refused upgrade', async (t) => {
  let socket;
  const port = await server(
    t,
    (req, res) => res.writeHead(401).end(),
    (s) => {
      socket = s;
    },
  );
  let closed;
  const stream = await openEventStream({
    host: '127.0.0.1',
    port,
    username: 'admin',
    password: 'secret',
    timeoutMs: 2_000,
    maxMessageBytes: 1_000,
    onMessage: () => {},
    onClose: (err) => {
      closed = err;
    },
  });
  t.after(() => stream.close());
  socket.write(Buffer.from([0x81, 0x81, 1, 2, 3, 4, 5]));
  await until(() => closed);
  assert.equal(closed.kind, 'bad_answer');
  // A plain HTTP answer to the upgrade.
  const plain = await server(t, (req, res) => res.writeHead(401).end());
  await assert.rejects(
    openEventStream({
      host: '127.0.0.1',
      port: plain,
      username: 'a',
      password: 'b',
      timeoutMs: 2_000,
      maxMessageBytes: 1_000,
    }),
    { kind: 'auth' },
  );
});
