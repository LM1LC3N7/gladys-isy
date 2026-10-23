// -----------------------------------------------------------------------------
// A fake ISY / IoX controller on 127.0.0.1: a real HTTP server with the REST
// endpoints the integration uses (basic authentication checked) and the
// WebSocket event stream (/rest/subscribe, server frames written by hand
// here, not with the client under test). It records every request, can
// refuse the password, stay silent after a command, and push any event.
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import http from 'node:http';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** Lets the pending callbacks run. */
export const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

export async function until(check, ms = 5_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await settle(10);
  }
  throw new Error('condition never met');
}

export const quietLogger = () => {
  const lines = [];
  const log = (level) => (message) => lines.push(`${level} ${message}`);
  return { lines, debug: log('debug'), info: log('info'), warn: log('warn'), error: log('error') };
};

/** A server text frame (never masked). */
export function textFrame(text) {
  const payload = Buffer.from(text, 'utf8');
  const length = payload.length;
  let header;
  if (length < 126) header = Buffer.from([0x81, length]);
  else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(length, 6);
  }
  return Buffer.concat([header, payload]);
}

const prop = (p) =>
  `<property id="${p.id}" value="${p.value}" formatted="${p.value}" uom="${p.uom}"${p.prec ? ` prec="${p.prec}"` : ''}/>`;

export const event = (control, action, node = '', { uom, prec, info = '' } = {}) =>
  `<?xml version="1.0"?><Event seqnum="1" sid="uuid:1"><control>${control}</control>` +
  `<action${uom ? ` uom="${uom}"` : ''}${prec ? ` prec="${prec}"` : ''}>${action}</action>` +
  `<node>${node}</node><eventInfo>${info}</eventInfo></Event>`;

export class FakeIsy {
  constructor({
    uuid = '00:21:b9:02:aa:bb',
    username = 'admin',
    password = 'secret',
    nodes = [],
    programs = [],
    variables = { 1: [], 2: [] },
  } = {}) {
    this.uuid = uuid;
    this.username = username;
    this.password = password;
    this.nodes = nodes;
    this.programs = programs;
    this.variables = variables;
    this.requests = [];
    this.sockets = new Set();
    this.silent = false;
    this.refuseCommands = false;
    this.server = http.createServer((req, res) => this.handle(req, res));
    this.server.on('upgrade', (req, socket) => this.upgrade(req, socket));
  }

  async start() {
    await new Promise((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.port = this.server.address().port;
    return this;
  }

  async close() {
    for (const socket of this.sockets) socket.destroy();
    this.server.closeAllConnections?.();
    await new Promise((resolve) => this.server.close(resolve));
  }

  authorized(req) {
    const expected = `Basic ${Buffer.from(`${this.username}:${this.password}`).toString('base64')}`;
    return req.headers.authorization === expected;
  }

  paths(prefix = '') {
    return this.requests.filter((p) => p.startsWith(prefix));
  }

  node(address) {
    return this.nodes.find((n) => n.address === address);
  }

  handle(req, res) {
    this.requests.push(req.url);
    if (!this.authorized(req)) {
      res.writeHead(401);
      res.end();
      return;
    }
    const xml = (body) => {
      res.writeHead(200, { 'content-type': 'text/xml' });
      res.end(`<?xml version="1.0" encoding="UTF-8"?>${body}`);
    };
    const ok = (yes = true) =>
      xml(`<RestResponse succeeded="${yes}"><status>200</status></RestResponse>`);
    const url = new URL(req.url, 'http://x');
    const parts = url.pathname.split('/').slice(1).map(decodeURIComponent);
    if (url.pathname === '/rest/config') {
      return xml(
        `<configuration><app_full_version>5.8.4</app_full_version><root><id>${this.uuid}</id><name>Home</name></root><product><id>1120</id><desc>eisy</desc></product></configuration>`,
      );
    }
    if (url.pathname === '/rest/nodes') {
      const body = this.nodes
        .map(
          (n) =>
            `<node flag="128" nodeDefId="${n.nodeDefId ?? 'X'}"><address>${n.address}</address><name>${n.name}</name>` +
            `<type>${n.type ?? ''}</type>${n.family ? `<family>${n.family}</family>` : ''}` +
            `${n.cat ? `<devtype><cat>${n.cat}</cat></devtype>` : ''}<enabled>true</enabled>` +
            `${n.props.map(prop).join('')}</node>`,
        )
        .join('');
      return xml(
        `<nodes><root>Network</root><folder><address>1</address><name>F</name></folder>${body}</nodes>`,
      );
    }
    if (url.pathname === '/rest/status') {
      return xml(
        `<nodes>${this.nodes.map((n) => `<node id="${n.address}">${n.props.map(prop).join('')}</node>`).join('')}</nodes>`,
      );
    }
    if (parts[1] === 'status' && parts[2]) {
      const n = this.node(parts[2]);
      return n
        ? xml(`<properties>${n.props.map(prop).join('')}</properties>`)
        : res.writeHead(404).end();
    }
    if (url.pathname === '/rest/programs') {
      const body = this.programs
        .map(
          (p) =>
            `<program id="${p.id}"${p.parent ? ` parentId="${p.parent}"` : ''} status="${p.status ?? false}" folder="${p.folder ?? false}"><name>${p.name}</name></program>`,
        )
        .join('');
      return xml(`<programs>${body}</programs>`);
    }
    if (parts[1] === 'vars' && parts[2] === 'definitions') {
      const list = this.variables[parts[3]] ?? [];
      if (list.length === 0) return res.writeHead(404).end();
      return xml(
        `<CList type="VAR_INT">${list.map((v) => `<e id="${v.id}" name="${v.name}"/>`).join('')}</CList>`,
      );
    }
    if (parts[1] === 'vars' && parts[2] === 'get') {
      const list = this.variables[parts[3]] ?? [];
      if (list.length === 0) return res.writeHead(404).end();
      return xml(
        `<vars>${list.map((v) => `<var type="${parts[3]}" id="${v.id}"><init>0</init><prec>0</prec><val>${v.value}</val><ts>20261023 12:00:00</ts></var>`).join('')}</vars>`,
      );
    }
    if (parts[1] === 'nodes' && parts[3] === 'cmd') {
      const n = this.node(parts[2]);
      if (!n) return res.writeHead(404).end();
      if (this.refuseCommands) return res.writeHead(503).end();
      const st = n.props.find((p) => p.id === 'ST');
      if (parts[4] === 'DOF') st.value = 0;
      else if (parts[4] === 'DON') st.value = parts[5] === undefined ? 255 : Number(parts[5]);
      ok();
      if (!this.silent)
        setTimeout(() => this.push(event('ST', st.value, n.address, { uom: st.uom })), 20);
      return undefined;
    }
    if (parts[1] === 'programs' && parts[3] === 'run') return ok();
    res.writeHead(404);
    res.end();
    return undefined;
  }

  upgrade(req, socket) {
    this.requests.push(`WS ${req.url}`);
    if (
      req.url !== '/rest/subscribe' ||
      !this.authorized(req) ||
      req.headers['sec-websocket-protocol'] !== 'ISYSUB' ||
      req.headers.origin !== 'com.universal-devices.websockets.isy'
    ) {
      socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return;
    }
    const accept = createHash('sha1')
      .update(`${req.headers['sec-websocket-key']}${GUID}`)
      .digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: ISYSUB\r\n\r\n`,
    );
    socket.on('data', () => {});
    socket.on('error', () => {});
    socket.on('close', () => this.sockets.delete(socket));
    this.sockets.add(socket);
    // The replay of every status, as the controller does when the stream opens.
    socket.write(textFrame(event('_0', '120')));
    for (const n of this.nodes) {
      for (const p of n.props)
        socket.write(
          textFrame(
            event(p.id === 'ST' ? 'ST' : p.id, p.value, n.address, { uom: p.uom, prec: p.prec }),
          ),
        );
    }
  }

  push(text) {
    for (const socket of this.sockets) socket.write(textFrame(text));
  }

  pushRaw(buffer) {
    for (const socket of this.sockets) socket.write(buffer);
  }

  dropStreams() {
    for (const socket of this.sockets) socket.destroy();
  }
}
