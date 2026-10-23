// -----------------------------------------------------------------------------
// The integration: one session with the controller (ISY994, or IoX on an
// eisy or a Polisy): its REST API (src/isy/http.js) and its event stream
// (src/isy/websocket.js), the catalogue of nodes, variables and programs,
// the Gladys devices and states (src/devices.js), the control events as a
// scene trigger, the commands. index.js only wires the SDK handlers to it.
//
// - Identity: the identifier of the controller (`/rest/config`, root id) is
//   pinned in /data at the first session (or typed in the configuration).
//   Another controller at the same address (a DHCP swap) stops everything;
//   an unreadable identity is not "another controller": it is read again.
//   Read at each connection, each status round, and every 10 minutes.
// - Catalogue: `/rest/nodes`, the programs of the "Gladys" folder and the
//   variables, read at the first session of a place, then on "Scan" or when
//   the controller says its nodes changed, at most every 10 minutes (its
//   start written in /data before it starts). Kept in /data.
// - States: the event stream (the controller replays every status when it
//   opens), and a status round every `poll_interval` minutes, never sooner
//   (its start is written in /data before it starts, so a restart or a
//   reconnection does not read again).
// - Commands: lights and switches only for the nodes declared safe; the
//   "Turn on" / "Turn off" buttons of the other ones, and the "Run" buttons
//   of the programs, only when their option allows them. A command leaves
//   within 3.5 s of the request or not at all (the deadline, the option and
//   the identity checked once the connection is made, right before the
//   request is written), is confirmed only by the status of the node equal
//   to the one asked (an event of the controller, or a read of the node), and
//   is otherwise "sent, without confirmation" with a read back. Its ack never
//   waits for the publication. Commands never wait behind a background read.
// - A refused password stops for good (persisted, a salted hash of the
//   refused pair only); other failures retry at 10 s, 30 s, 1, 2, then 5 min,
//   the next try persisted so a restart never tries sooner.
// - Every await of a session is followed by a check that it is still the
//   current one: a late answer of an old session publishes nothing.
// - The password is never logged.
// -----------------------------------------------------------------------------

import { DEVICE_TRANSPORTS, createLogger } from '@gladysassistant/integration-sdk';
import { addressKey, normalizeConfig, placeKey, sessionKey } from './config.js';
import { CONTROL_EVENTS, LIMITS, PROGRAM_FOLDER, SCENE_TRIGGERS, TIMINGS } from './constants.js';
import {
  SAFE_KEYS,
  buildDevices,
  buildStates,
  entries,
  kindOf,
  levelOf,
  nodePlatformId,
  parseFeatureId,
} from './devices.js';
import { COMMAND_NAMES, T, fill, word } from './i18n.js';
import { IsyError, httpTransport, restPath } from './isy/http.js';
import {
  parseConfig,
  parseEvent,
  parseNodeStatus,
  parseNodes,
  parsePrograms,
  parseStatus,
  parseVariableNames,
  parseVariables,
  succeeded,
} from './isy/parse.js';
import { openEventStream } from './isy/websocket.js';
import { StatePublisher } from './publisher.js';
import { fileStore, newSalt, normalizeMemory, refusedHash } from './store.js';

/** A command refused before anything was sent. */
export class Refused extends Error {}

/** A strict 0 / 1 (null, '' and the rest are not 0). */
function binaryOf(value) {
  if (value === 0 || value === '0') return 0;
  if (value === 1 || value === '1') return 1;
  return undefined;
}

function numberOf(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

const emptyModel = () => ({ nodes: new Map(), variables: new Map(), programs: new Map() });

export class IsyApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'isy' }),
    transportFactory = httpTransport,
    openStream = openEventStream,
    now = Date.now,
    timers = globalThis,
    store = fileStore(),
    timings = {},
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.transportFactory = transportFactory;
    this.openStream = openStream;
    this.now = now;
    this.timers = timers;
    this.store = store;
    this.T = { ...TIMINGS, ...timings };
    this.publisher = new StatePublisher({ gladys, logger, now, timers });
    this.config = normalizeConfig();
    this.key = undefined;
    this.session = 0;
    this.memory = undefined;
    this.model = emptyModel();
    this.byAddress = new Map();
    this.duplicates = [];
    this.identity = 'unknown';
    this.seenId = undefined;
    this.started = false;
    this.http = undefined;
    this.stream = undefined;
    this.connected = false;
    this.syncing = false;
    this.lastStatus = undefined;
    this.lastTransport = undefined;
    this.published = undefined;
    this.chains = new Map();
    this.timersSet = new Set();
    this.waiters = new Set();
    this.pendingEvents = [];
    this.flushScheduled = false;
    this.devicesChanged = false;
    this.starting = Promise.resolve();
    this.background = Promise.resolve();
    this.persistedAt = 0;
    this.catalogWanted = false;
    this.identityDueAt = 0;
  }

  /** What talks to Gladys runs one after the other, in order. */
  guard(fn) {
    this.chain = (this.chain ?? Promise.resolve())
      .then(fn)
      .catch((err) => this.logger.error(`ISY event failed: ${err.message}`));
    return this.chain;
  }

  refused(entry) {
    return new Refused(word(entry, this.config.language));
  }

  error(entry) {
    return new Error(word(entry, this.config.language));
  }

  later(fn, ms) {
    const timer = this.timers.setTimeout(
      () => {
        this.timersSet.delete(timer);
        fn();
      },
      Math.max(0, ms),
    );
    this.timersSet.add(timer);
    return timer;
  }

  cancel(timer) {
    if (timer === undefined) return;
    this.timers.clearTimeout(timer);
    this.timersSet.delete(timer);
  }

  // --- /data -------------------------------------------------------------------

  async loadMemory() {
    if (this.memory) return this.memory;
    try {
      this.memory = normalizeMemory(await this.store.load());
    } catch {
      this.memory = normalizeMemory(null);
    }
    return this.memory;
  }

  async saveMemory() {
    try {
      await this.store.save(this.memory);
    } catch (err) {
      this.logger.warn(`Saving the state to /data failed: ${err.message}`);
    }
  }

  /** The catalogue -> the model (ids from the addresses; a second address with the same id is left out). */
  setCatalog({ nodes, variables, programs }) {
    const model = emptyModel();
    const byAddress = new Map();
    const duplicates = [];
    for (const n of nodes) {
      const id = nodePlatformId(n.address);
      if (!id || model.nodes.has(id)) {
        duplicates.push(n.address);
        continue;
      }
      const node = { ...n, props: new Map(n.props.map((p) => [p.id, { ...p }])) };
      model.nodes.set(id, node);
      byAddress.set(n.address, node);
    }
    for (const v of variables) model.variables.set(`v${v.type}_${v.id}`, { ...v });
    for (const p of programs) model.programs.set(`p_${p.id}`, { ...p });
    this.model = model;
    this.byAddress = byAddress;
    this.duplicates = duplicates;
  }

  catalogOfModel() {
    return {
      nodes: [...this.model.nodes.values()].map((n) => ({ ...n, props: [...n.props.values()] })),
      variables: [...this.model.variables.values()],
      programs: [...this.model.programs.values()],
    };
  }

  // --- Lifecycle -----------------------------------------------------------------

  /** Starts (or restarts); two starts never overlap. */
  start(raw = {}) {
    const run = this.starting.then(() => this.startNow(raw));
    this.starting = run.catch(() => undefined);
    return run;
  }

  async startNow(raw = {}) {
    this.stop();
    const session = ++this.session;
    const next = normalizeConfig(raw);
    const memory = await this.loadMemory();
    if (session !== this.session) return;
    const place = placeKey(next);
    if (memory.place && memory.place !== place) {
      // Another address: what /data knew belongs to the old controller.
      Object.assign(memory, {
        place: '',
        catalog: { nodes: [], variables: [], programs: [] },
        lastCatalogAt: 0,
        lastRoundAt: 0,
      });
      await this.saveMemory();
      if (session !== this.session) return;
    }
    if (!this.started || placeKey(this.config) !== place) {
      this.setCatalog(
        memory.place === place ? memory.catalog : { nodes: [], variables: [], programs: [] },
      );
    }
    this.started = true;
    this.config = next;
    this.key = sessionKey(next);
    this.seenId = undefined;
    this.identity = 'unknown';
    if (next.safeErrors.length > 0) {
      this.logger.warn(`Nodes declared safe not understood: ${next.safeErrors.join(', ')}`);
    }
    await this.publishDevices();
    await this.publishStates();
    const problem = this.configProblem();
    if (problem) {
      await this.setStatus(false, problem);
      return;
    }
    const stop = memory.stop;
    if (
      stop &&
      stop.place === place &&
      refusedHash(stop.salt, next.username, next.password) === stop.refused
    ) {
      this.logger.warn(
        'ISY: the controller refused these credentials before: no connection until they change or "Test the connection" succeeds',
      );
      await this.setStatus(false, T.refused);
      return;
    }
    const wait = Math.min(memory.retryAt - this.now(), this.T.retries.at(-1));
    if (wait > 0) {
      this.logger.info(`ISY: paused after failures, next try in ${Math.round(wait / 1000)} s`);
      await this.setStatus(false, fill(T.unreachable, 'pause', Math.round(wait / 1000)));
      this.retryTimer = this.later(() => this.connect(session), wait);
      return;
    }
    await this.setStatus(false, T.connecting);
    this.connect(session);
  }

  configProblem() {
    if (this.config.https) return T.httpsNotYet;
    if (this.config.credentialsInHost) return T.credentialsInHost;
    if (!this.config.host || !this.config.username || !this.config.password) return T.noConfig;
    if (this.config.controllerIdInvalid) return T.badControllerId;
    return undefined;
  }

  stop() {
    this.session += 1;
    this.connected = false;
    this.syncing = false;
    const stream = this.stream;
    this.stream = undefined;
    stream?.close();
    this.http?.close();
    this.http = undefined;
    this.connecting = false;
    this.publisher.stop();
    for (const timer of this.timersSet) this.timers.clearTimeout(timer);
    this.timersSet.clear();
    this.retryTimer = undefined;
    this.wakeWork?.();
  }

  /** First connection to Gladys: start; a reconnection (Gladys restarted): resend everything. */
  async onConnected(raw = {}) {
    if (!this.started) {
      await this.start(raw);
      return;
    }
    // Gladys keeps the connection status and the discovered devices in memory.
    this.published = undefined;
    this.lastTransport = undefined;
    const status = this.lastStatus;
    this.lastStatus = undefined;
    await this.configUpdated(raw);
    if (status && this.lastStatus === undefined) {
      const [connected, message] = JSON.parse(status);
      await this.setStatus(connected, message ?? undefined);
    }
    this.publisher.forget();
    await this.publishDevices();
    await this.publishStates();
    await this.publishTransports(
      this.connected ? DEVICE_TRANSPORTS.LOCAL : DEVICE_TRANSPORTS.UNREACHABLE,
    );
  }

  /** New address, credentials or identifier: a new session; the rest applies at once. */
  async configUpdated(raw = {}) {
    const next = normalizeConfig(raw);
    if (sessionKey(next) !== this.key || next.https !== this.config.https) {
      // The options hold at once, even while the restart waits.
      this.config = {
        ...this.config,
        allowButtons: next.allowButtons,
        allowPrograms: next.allowPrograms,
        safe: next.safe,
      };
      return this.start(raw);
    }
    this.config = next;
    await this.publishDevices();
    await this.publishStates();
    if (this.connected && this.identity === 'ok')
      await this.setStatus(true, this.connectedMessage());
    return undefined;
  }

  async setStatus(connected, message) {
    const key = JSON.stringify([connected, message ?? null]);
    if (key === this.lastStatus) return;
    this.lastStatus = key;
    await this.gladys
      .setConnectionStatus(connected, message)
      .catch((err) => this.logger.warn(`setConnectionStatus failed: ${err.message}`));
  }

  connectedMessage() {
    const parts = [];
    const list = (items) =>
      items
        .slice(0, 5)
        .join(', ')
        .concat(items.length > 5 ? '…' : '');
    if (this.duplicates.length > 0) parts.push(fill(T.duplicates, list(this.duplicates)));
    if (this.config.safeErrors.length > 0)
      parts.push(fill(T.safeErrors, list(this.config.safeErrors)));
    if (this.model.nodes.size > 0) {
      const known = new Set([...this.model.nodes.values()].map((n) => addressKey(n.address)));
      const unmatched = [...this.config.safe.keys()].filter((key) => !known.has(key));
      if (unmatched.length > 0) parts.push(fill(T.safeUnknown, list(unmatched)));
    }
    const count = entries(this.config, this.model, addressKey).length;
    return Object.fromEntries(
      ['en', 'fr'].map((lang) => [
        lang,
        word(T.connected, lang)(count, parts.map((p) => p[lang]).join('')),
      ]),
    );
  }

  // --- Session ---------------------------------------------------------------------

  connect(session) {
    if (session !== this.session || this.connecting) return;
    this.cancel(this.retryTimer);
    this.retryTimer = undefined;
    // Every connection reads the identity again before any command.
    this.identity = 'unknown';
    this.seenId = undefined;
    this.http?.close();
    this.http = this.transportFactory({
      host: this.config.host,
      port: this.config.port,
      username: this.config.username,
      password: this.config.password,
    });
    this.connecting = true;
    this.link(session).finally(() => {
      if (session === this.session) this.connecting = false;
    });
  }

  /** Identity, the catalogue when due, then the event stream. */
  async link(session) {
    const alive = () => session === this.session;
    try {
      const ok = await this.checkIdentity(session, { first: true });
      if (!alive() || !ok) return;
      if (this.catalogDue()) {
        await this.readCatalog(session);
        if (!alive()) return;
      }
      await this.openEvents(session);
    } catch (err) {
      if (!alive()) return;
      await this.guard(() => this.onDown(this.failureOf(err), session));
    }
  }

  failureOf(err) {
    if (err?.kind === 'auth') return { refused: true };
    const reason =
      err instanceof IsyError || err?.kind ? String(err.message).slice(0, 80) : 'error';
    return { reason };
  }

  async openEvents(session) {
    const stream = await this.openStream({
      host: this.config.host,
      port: this.config.port,
      username: this.config.username,
      password: this.config.password,
      timeoutMs: this.T.wsTimeout,
      maxMessageBytes: LIMITS.eventBytes,
      onMessage: (text) => this.onFrame(session, text),
      onClose: (err) => this.onStreamClosed(session, err),
    });
    if (session !== this.session) {
      stream.close();
      return;
    }
    this.stream = stream;
    this.connected = true;
    this.lastFrameAt = this.now();
    this.heartbeatMs = this.T.heartbeat;
    this.startSync(session);
    this.armWatchdog(session);
    await this.guard(() => this.onUp(session));
  }

  /** The replay of every status after the opening: no scene event until it is quiet (pyisy). */
  startSync(session) {
    this.syncing = true;
    const started = this.now();
    let seen = this.frames ?? 0;
    const check = () => {
      if (session !== this.session || !this.syncing) return;
      const quiet = (this.frames ?? 0) === seen;
      seen = this.frames ?? 0;
      if (quiet || this.now() - started >= this.T.syncMax) this.syncing = false;
      else this.later(check, this.T.syncQuiet);
    };
    this.later(check, this.T.syncQuiet);
  }

  /** No frame for the heartbeat announced + a grace: the stream is taken for dead. */
  armWatchdog(session) {
    const limit = this.heartbeatMs + this.T.heartbeatGrace;
    const wait = this.lastFrameAt + limit - this.now();
    this.later(
      () => {
        if (session !== this.session || !this.stream) return;
        if (this.now() - this.lastFrameAt >= this.heartbeatMs + this.T.heartbeatGrace) {
          const stream = this.stream;
          stream.close();
          this.onStreamClosed(session, { kind: 'timeout', message: 'no heartbeat' }, stream);
          return;
        }
        this.armWatchdog(session);
      },
      Math.max(1_000, wait),
    );
  }

  onStreamClosed(session, err, stream = this.stream) {
    if (session !== this.session || !stream || stream !== this.stream) return;
    this.stream = undefined;
    this.connected = false;
    this.syncing = false;
    this.wakeWork?.();
    this.guard(() => this.onDown(this.failureOf(err), session));
  }

  async onUp(session) {
    if (session !== this.session) return;
    const memory = await this.loadMemory();
    if (memory.stop) {
      // The credentials were accepted: the refusal is erased.
      memory.stop = null;
      await this.saveMemory();
    }
    if (session !== this.session) return;
    // The pause and the count of failures are erased only once the stream
    // has lived a while: a stream that opens and drops at once keeps its pace.
    this.later(() => this.markStable(session), this.T.stableAfter);
    this.logger.info('ISY: connected to the controller');
    await this.setStatus(true, this.connectedMessage());
    await this.publishTransports(DEVICE_TRANSPORTS.LOCAL);
    if (session !== this.session) return;
    this.work(session);
  }

  async markStable(session) {
    if (session !== this.session || !this.connected) return;
    const memory = await this.loadMemory();
    if (!memory.retryAt && !memory.failures) return;
    memory.retryAt = 0;
    memory.failures = 0;
    this.persistedAt = this.now();
    await this.saveMemory();
  }

  async onDown({ reason, refused }, session) {
    if (session !== this.session) return;
    this.connected = false;
    // Whatever answers at the next connection is checked again first.
    this.identity = 'unknown';
    this.seenId = undefined;
    const stream = this.stream;
    this.stream = undefined;
    stream?.close();
    const memory = await this.loadMemory();
    if (refused) {
      this.logger.error('ISY: the controller refused the user name or the password; no new try');
      const salt = newSalt();
      memory.stop = {
        place: placeKey(this.config),
        kind: 'credentials_refused',
        at: this.now(),
        salt,
        refused: refusedHash(salt, this.config.username, this.config.password),
      };
      await this.saveMemory();
      if (session !== this.session) return;
      await this.setStatus(false, T.refused);
    } else {
      memory.failures = Math.min(memory.failures + 1, 99);
      const delay = this.T.retries[Math.min(memory.failures, this.T.retries.length) - 1];
      memory.retryAt = this.now() + delay;
      // Written at most once a minute, unless the pause itself is that long.
      if (delay >= this.T.persistGap || this.now() - this.persistedAt >= this.T.persistGap) {
        this.persistedAt = this.now();
        await this.saveMemory();
      }
      if (session !== this.session) return;
      this.logger.warn(`ISY: ${reason}; next try in ${Math.round(delay / 1000)} s`);
      await this.setStatus(false, fill(T.unreachable, reason, Math.round(delay / 1000)));
      this.retryTimer = this.later(() => this.connect(session), delay);
    }
    await this.publishTransports(DEVICE_TRANSPORTS.UNREACHABLE);
  }

  /** One background read at a time (commands never wait behind them). */
  read(path, options) {
    const http = this.http;
    const run = this.background.then(() => {
      if (!http || http !== this.http) throw new IsyError('network', 'session closed');
      return http.get(path, options);
    });
    this.background = run.catch(() => undefined);
    return run;
  }

  // --- Identity, catalogue, rounds ---------------------------------------------------

  /** The identifier the controller must have: typed, else pinned for this place. */
  expectedId() {
    if (this.config.controllerId) return this.config.controllerId;
    const pinned = this.memory?.controller;
    return pinned && pinned.place === placeKey(this.config) ? pinned.uuid : undefined;
  }

  /**
   * Reads /rest/config. First check of a session: a failure throws (the
   * session is retried). Later checks: unreadable is not "another
   * controller", read again a minute later. Returns true when the identity is ok.
   */
  async checkIdentity(session, { first = false } = {}) {
    let info;
    try {
      const answer = await this.read(restPath('config'), {
        timeout: this.T.httpTimeout,
        maxBytes: LIMITS.configBytes,
      });
      info = parseConfig(answer.body);
    } catch (err) {
      if (session !== this.session) return false;
      if (first || err?.kind === 'auth') throw err;
      info = undefined;
    }
    if (session !== this.session) return false;
    if (!info?.uuid) {
      if (first) throw new IsyError('status', 'identity not readable');
      this.identityDueAt = this.now() + 60_000;
      return this.identity === 'ok';
    }
    this.identityDueAt = this.now() + this.T.identity;
    const expected = this.expectedId();
    if (expected && expected !== info.uuid) {
      this.identity = 'other';
      this.seenId = undefined;
      this.logger.error(
        `ISY: another controller answers (${info.uuid}, expected ${expected}): stopped`,
      );
      const stream = this.stream;
      this.stream = undefined;
      this.connected = false;
      stream?.close();
      // Read again later (only the identity), the time persisted so a restart waits too.
      const memory = await this.loadMemory();
      memory.retryAt = this.now() + this.T.otherRetry;
      this.persistedAt = this.now();
      await this.saveMemory();
      if (session !== this.session) return false;
      this.cancel(this.retryTimer);
      this.retryTimer = this.later(() => this.connect(session), this.T.otherRetry);
      await this.guard(async () => {
        await this.setStatus(
          false,
          fill(T.otherController, info.uuid, expected, Math.round(this.T.otherRetry / 60_000)),
        );
        await this.publishTransports(DEVICE_TRANSPORTS.UNREACHABLE);
      });
      return false;
    }
    this.identity = 'ok';
    this.seenId = info.uuid;
    const memory = await this.loadMemory();
    if (
      memory.controller?.uuid !== info.uuid ||
      memory.controller?.place !== placeKey(this.config)
    ) {
      this.logger.info(`ISY: controller ${info.uuid} (${info.model} ${info.firmware}) pinned`);
      memory.controller = { place: placeKey(this.config), uuid: info.uuid };
      await this.saveMemory();
    }
    return session === this.session;
  }

  catalogDue() {
    const memory = this.memory;
    if (memory.place !== placeKey(this.config)) {
      return this.now() - memory.lastCatalogAt >= this.T.catalogGap || memory.lastCatalogAt === 0;
    }
    return this.catalogWanted && this.now() - memory.lastCatalogAt >= this.T.catalogGap;
  }

  /** Nodes, then the programs of the "Gladys" folder and the variables (optional parts). */
  async readCatalog(session) {
    const alive = () => session === this.session;
    const memory = this.memory;
    this.catalogWanted = false;
    // Written before the read: a restart or a reconnection does not read again sooner.
    memory.lastCatalogAt = this.now();
    await this.saveMemory();
    if (this.connected) await this.guard(() => this.setStatus(true, T.reading));
    const nodesAnswer = await this.read(`${restPath('nodes')}?members=false`, {
      timeout: this.T.catalogTimeout,
      maxBytes: LIMITS.nodesBytes,
    });
    if (!alive()) return;
    const nodes = parseNodes(nodesAnswer.body);
    const previous = this.catalogOfModel();
    let programs = previous.programs;
    try {
      const answer = await this.read(`${restPath('programs')}?subfolders=true`, {
        timeout: this.T.catalogTimeout,
        maxBytes: LIMITS.programsBytes,
        ok404: true,
      });
      programs = answer.status === 404 ? [] : parsePrograms(answer.body, PROGRAM_FOLDER);
    } catch (err) {
      if (err?.kind === 'auth') throw err;
      this.logger.warn(`ISY: the programs could not be read (${err.message})`);
    }
    if (!alive()) return;
    let variables = previous.variables;
    try {
      variables = await this.readVariableCatalog(session);
    } catch (err) {
      if (err?.kind === 'auth') throw err;
      this.logger.warn(`ISY: the variables could not be read (${err.message})`);
    }
    if (!alive()) return;
    this.setCatalog({ nodes, variables, programs });
    memory.place = placeKey(this.config);
    memory.catalog = this.catalogOfModel();
    await this.saveMemory();
    if (!alive()) return;
    this.logger.info(
      `ISY: ${nodes.length} node(s), ${variables.length} variable(s), ${programs.length} program(s) in the "Gladys" folder`,
    );
    await this.guard(async () => {
      await this.publishDevices();
      await this.publishStates();
      if (this.connected) {
        await this.publishTransports(DEVICE_TRANSPORTS.LOCAL, { force: true });
        if (alive()) await this.setStatus(true, this.connectedMessage());
      }
    });
  }

  async readVariableCatalog(session) {
    const out = [];
    for (const type of [1, 2]) {
      const names = await this.read(restPath('vars', 'definitions', type), {
        timeout: this.T.httpTimeout,
        maxBytes: LIMITS.variablesBytes,
        ok404: true,
      });
      if (session !== this.session) return out;
      const definitions = names.status === 404 ? new Map() : parseVariableNames(names.body);
      if (definitions.size === 0) continue;
      const values = await this.read(restPath('vars', 'get', type), {
        timeout: this.T.httpTimeout,
        maxBytes: LIMITS.variablesBytes,
        ok404: true,
      });
      if (session !== this.session) return out;
      const byId = new Map(
        (values.status === 404 ? [] : parseVariables(values.body))
          .filter((v) => v.type === type)
          .map((v) => [v.id, v]),
      );
      for (const [id, name] of definitions) {
        if (out.length >= LIMITS.maxVariables) break;
        const v = byId.get(id);
        out.push({ type, id, name, raw: v?.raw ?? null, prec: v?.prec ?? 0 });
      }
    }
    return out;
  }

  sleepWork(ms) {
    return new Promise((resolve) => {
      const timer = this.later(() => done(), Math.max(0, ms));
      const done = () => {
        this.cancel(timer);
        if (this.wakeWork === done) this.wakeWork = undefined;
        resolve();
      };
      this.wakeWork = done;
    });
  }

  /** One loop per session; a reconnection never restarts a read in progress (its start is in /data). */
  async work(session) {
    const alive = () => session === this.session && this.connected;
    while (alive()) {
      try {
        if (this.now() >= this.identityDueAt) {
          await this.checkIdentity(session);
          continue;
        }
        if (this.catalogDue()) {
          await this.readCatalog(session);
          continue;
        }
        const roundAt = this.memory.lastRoundAt + this.config.interval;
        if (this.now() >= roundAt) {
          await this.round(session);
          continue;
        }
        let wake = Math.min(roundAt, this.identityDueAt);
        if (this.catalogWanted)
          wake = Math.min(wake, this.memory.lastCatalogAt + this.T.catalogGap);
        await this.sleepWork(wake - this.now());
      } catch (err) {
        if (!alive()) return;
        if (err?.kind === 'auth') {
          await this.guard(() => this.onDown({ refused: true }, session));
          return;
        }
        this.logger.warn(`ISY: background read failed (${err.message})`);
        // The next try waits like a round: never faster than the interval.
        await this.sleepWork(Math.min(this.config.interval, 5 * 60_000));
      }
    }
  }

  /** The status round: identity first, then every status, the variables, the programs. */
  async round(session) {
    const alive = () => session === this.session && this.connected;
    // Written before the round: a restart or a reconnection does not read again sooner.
    this.memory.lastRoundAt = this.now();
    await this.saveMemory();
    const ok = await this.checkIdentity(session);
    if (!alive() || !ok) return;
    const status = await this.read(restPath('status'), {
      timeout: this.T.catalogTimeout,
      maxBytes: LIMITS.statusBytes,
    });
    if (!alive()) return;
    for (const [address, props] of parseStatus(status.body)) {
      const node = this.byAddress.get(address);
      if (node) for (const prop of props) this.setProperty(node, prop);
    }
    this.noteChange([]);
    for (const type of [1, 2]) {
      if (![...this.model.variables.values()].some((v) => v.type === type)) continue;
      try {
        const answer = await this.read(restPath('vars', 'get', type), {
          timeout: this.T.httpTimeout,
          maxBytes: LIMITS.variablesBytes,
        });
        if (!alive()) return;
        for (const v of parseVariables(answer.body)) this.setVariable(v);
      } catch (err) {
        if (err?.kind === 'auth') throw err;
        // A secondary part that fails never stops the rest.
        this.logger.warn(`ISY: the variables could not be read (${err.message})`);
      }
    }
    try {
      const answer = await this.read(`${restPath('programs')}?subfolders=true`, {
        timeout: this.T.catalogTimeout,
        maxBytes: LIMITS.programsBytes,
        ok404: true,
      });
      if (!alive()) return;
      // The list read now replaces the known one: a program moved, deleted or
      // whose folder was renamed is no longer offered; one put in it appears.
      await this.replacePrograms(
        answer.status === 404 ? [] : parsePrograms(answer.body, PROGRAM_FOLDER),
      );
    } catch (err) {
      if (err?.kind === 'auth') throw err;
      this.logger.warn(`ISY: the programs could not be read (${err.message})`);
    }
    this.noteChange([]);
  }

  /**
   * The programs of the "Gladys" folder as just read: statuses updated, the
   * absent ones removed, a changed list kept in /data and sent to Gladys.
   */
  async replacePrograms(list) {
    const next = new Map(list.map((p) => [`p_${p.id}`, { ...p }]));
    const same =
      next.size === this.model.programs.size &&
      [...next].every(([id, p]) => this.model.programs.get(id)?.name === p.name);
    this.model.programs = next;
    if (same) return;
    this.logger.info(`ISY: ${next.size} program(s) in the "Gladys" folder now`);
    this.devicesChanged = true;
    this.noteChange([]);
    const memory = await this.loadMemory();
    if (memory.place === placeKey(this.config)) {
      memory.catalog = this.catalogOfModel();
      await this.saveMemory();
    }
  }

  /** "Scan" in Gladys: the devices sent again; the catalogue read again, not more than every 10 min. */
  async scan() {
    await this.publishDevices({ force: true });
    this.catalogWanted = true;
    this.wakeWork?.();
  }

  // --- Events ---------------------------------------------------------------------

  onFrame(session, text) {
    if (session !== this.session) return;
    this.lastFrameAt = this.now();
    this.frames = (this.frames ?? 0) + 1;
    if (text === undefined || this.identity === 'other') return;
    const event = parseEvent(text, CONTROL_EVENTS);
    if (!event) return;
    if (event.kind === 'heartbeat') {
      if (event.seconds) {
        this.heartbeatMs = Math.min(10 * 60_000, Math.max(10_000, event.seconds * 1000));
      }
      return;
    }
    if (event.kind === 'property') {
      const node = this.byAddress.get(event.address);
      if (!node) return;
      this.setProperty(node, event.prop);
      this.noteChange([]);
      return;
    }
    if (event.kind === 'control') {
      const node = this.byAddress.get(event.address);
      if (!node || this.syncing || !this.publisher.reserveEvent()) return;
      this.noteChange([{ address: node.address, control: event.control, name: node.name }]);
      return;
    }
    if (event.kind === 'variable') {
      if (this.setVariable(event)) this.noteChange([]);
      return;
    }
    if (event.kind === 'program') {
      const program = this.model.programs.get(`p_${event.id}`);
      if (program) {
        program.status = event.status;
        this.noteChange([]);
      }
      return;
    }
    if (event.kind === 'catalog') {
      this.catalogWanted = true;
      this.wakeWork?.();
    }
  }

  /** A property of a node: kept (bounded), the waiters of a command told. */
  setProperty(node, prop) {
    if (!node.props.has(prop.id)) {
      if (node.props.size >= LIMITS.maxProperties) return;
      this.devicesChanged = true;
    } else if (node.props.get(prop.id).uom !== prop.uom) {
      this.devicesChanged = true;
    }
    node.props.set(prop.id, prop);
    if (prop.id === 'ST') {
      for (const waiter of this.waiters) if (waiter.address === node.address) waiter.check(prop);
    }
  }

  setVariable(v) {
    const known = this.model.variables.get(`v${v.type}_${v.id}`);
    if (!known) return false;
    known.raw = v.raw;
    known.prec = v.prec;
    return true;
  }

  noteChange(events) {
    this.pendingEvents.push(...events);
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    setImmediate(() => {
      this.flushScheduled = false;
      this.guard(() => this.flushChanges());
    });
  }

  async flushChanges() {
    const events = this.pendingEvents.splice(0);
    if (this.devicesChanged) {
      this.devicesChanged = false;
      await this.publishDevices();
    }
    await this.publishStates();
    for (const event of events) await this.publisher.sceneEvent(SCENE_TRIGGERS.CONTROL, event);
  }

  // --- Gladys --------------------------------------------------------------------------

  async publishDevices({ force = false } = {}) {
    const devices = buildDevices(this.gladys, this.config, this.model, addressKey);
    if (devices.length === 0 && !force) return;
    const json = JSON.stringify(devices);
    if (json === this.published && !force) return;
    try {
      await this.gladys.publishDiscoveredDevices(devices);
      this.published = json;
    } catch (err) {
      this.logger.warn(`Publishing the devices failed: ${err.message}`);
    }
  }

  publishStates() {
    return this.publisher.publish(buildStates(this.gladys, this.config, this.model, addressKey));
  }

  async publishTransports(transport, { force = false } = {}) {
    if (transport === this.lastTransport && !force) return;
    const devices = buildDevices(this.gladys, this.config, this.model, addressKey);
    if (devices.length === 0) return;
    const list = devices.map((device) => ({ external_id: device.external_id, transport }));
    try {
      for (let i = 0; i < list.length; i += 100) {
        await this.gladys.publishTransports(list.slice(i, i + 100));
      }
      this.lastTransport = transport;
    } catch (err) {
      this.logger.warn(`Publishing the transports failed: ${err.message}`);
    }
  }

  /** The user created or updated a device: Gladys has none of its states yet. */
  async deviceChanged(device) {
    this.publisher.forget(device?.external_id);
    await this.publishStates();
  }

  // --- Commands ----------------------------------------------------------------------

  /** One turn at a time per target; a failed one never blocks the next. */
  serial(key, fn) {
    const previous = this.chains.get(key) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    const tail = run.catch(() => undefined);
    this.chains.set(key, tail);
    tail.then(() => {
      if (this.chains.get(key) === tail) this.chains.delete(key);
    });
    return run;
  }

  async setValue(_device, feature, value) {
    const target = parseFeatureId(feature?.external_id);
    if (!target) throw new Error(`${feature?.external_id} is not an ISY feature`);
    const asked = this.now();
    if (target.platformId.startsWith('p_')) return this.runProgram(target, value, asked);
    const node = this.model.nodes.get(target.platformId);
    if (!node) throw this.refused(T.unknownDevice);
    const { key } = target;
    const kind = kindOf(node);
    let level;
    let gate;
    let closed;
    if (SAFE_KEYS.has(key)) {
      closed = T.notSafe;
      const lightKeys = kind === 'dimmer' ? ['binary', 'brightness'] : ['switch', 'light'];
      if (!lightKeys.includes(key) || (kind !== 'dimmer' && kind !== 'relay')) {
        throw this.refused(T.readOnly);
      }
      gate = () => this.config.safe.has(addressKey(node.address));
      if (!gate()) {
        this.logger.warn(`Command REFUSED on ${node.address}: not declared safe`);
        throw this.refused(T.notSafe);
      }
      if (key === 'brightness') {
        const n = numberOf(value);
        if (n === undefined || n < 0 || n > 100) {
          throw this.refused(fill(T.badValue, JSON.stringify(value)));
        }
        level = Math.round((Math.round(n) * 255) / 100);
      } else {
        const on = binaryOf(value);
        if (on === undefined) throw this.refused(fill(T.badValue, JSON.stringify(value)));
        level = on ? 'on' : 0;
      }
    } else if (key === 'turn_on' || key === 'turn_off') {
      if (kind !== 'dimmer' && kind !== 'relay') throw this.refused(T.readOnly);
      closed = T.buttonsOff;
      gate = () => this.config.allowButtons;
      if (!gate()) {
        this.logger.warn(`Command REFUSED on ${node.address}: buttons disabled`);
        throw this.refused(T.buttonsOff);
      }
      if (binaryOf(value) !== 1) throw this.refused(fill(T.badValue, JSON.stringify(value)));
      level = key === 'turn_on' ? 'on' : 0;
    } else {
      throw this.refused(T.readOnly);
    }
    this.checkSession();
    return this.nodeCommand(node, level, asked, gate, closed);
  }

  checkSession() {
    if (this.identity === 'other') throw this.refused(T.otherControllerCommand);
    if (!this.http || !this.connected) throw this.refused(T.offline);
    // Read in this very connection (it is reset at every connection and every loss).
    if (this.identity !== 'ok') throw this.refused(T.identityUnknown);
  }

  /** Right before the request: the deadline, the gate, the identity, the same connection. */
  beforeSend(asked, gate, http) {
    return (
      this.now() <= asked + this.T.sendBy &&
      gate() &&
      this.identity === 'ok' &&
      this.connected &&
      this.http === http
    );
  }

  /** Why a request was withdrawn before it was sent. */
  withdrawnReason(asked, gate, closed) {
    if (this.identity === 'other') return T.otherControllerCommand;
    if (this.now() > asked + this.T.sendBy) return T.tooLate;
    if (!gate()) return closed;
    if (this.identity !== 'ok') return T.identityUnknown;
    return T.offline;
  }

  /**
   * One command to a node: written in the node's turn (the turn ends when the
   * request is written), confirmed by the status of the node equal to the
   * one asked (`on`: above 0), from the event stream or a read of the node.
   */
  async nodeCommand(node, level, asked, gate, closed) {
    const what =
      level === 'on'
        ? fill(COMMAND_NAMES.on, node.name)
        : fill(COMMAND_NAMES.level, node.name, Math.round((level * 100) / 255));
    const path =
      level === 'on'
        ? restPath('nodes', node.address, 'cmd', 'DON')
        : level === 0
          ? restPath('nodes', node.address, 'cmd', 'DOF')
          : restPath('nodes', node.address, 'cmd', 'DON', level);
    const wanted = level === 'on' ? undefined : Math.round((level * 100) / 255);
    const matches = (prop) => {
      const got = levelOf(prop);
      if (got === undefined) return false;
      return wanted === undefined ? got > 0 : got === wanted;
    };
    const http = this.http;
    let confirmed;
    const waiter = {
      address: node.address,
      active: false,
      check: (prop) => {
        if (waiter.active && matches(prop)) confirmed?.();
      },
    };
    const event = new Promise((resolve) => {
      confirmed = () => resolve(true);
    });
    let done;
    await this.serial(node.address, async () => {
      let markWritten;
      const written = new Promise((resolve) => {
        markWritten = resolve;
      });
      this.logger.info(`Command from Gladys: ${what.en}`);
      done = http.get(path, {
        timeout: Math.max(500, asked + this.T.answerBy - this.now()),
        maxBytes: LIMITS.commandBytes,
        beforeSend: () => {
          if (!this.beforeSend(asked, gate, http)) return false;
          // Only what the controller says after the request counts.
          waiter.active = true;
          this.waiters.add(waiter);
          markWritten();
          return true;
        },
      });
      done.catch(() => undefined);
      await Promise.race([written, done.catch(() => undefined)]);
    });
    try {
      let answer;
      try {
        answer = await done;
      } catch (err) {
        throw this.sendError(err, what, node, asked, gate, closed);
      }
      if (!succeeded(answer.body)) {
        this.logger.warn(`Command REFUSED by the controller (${what.en})`);
        this.scheduleReadBack(node);
        throw this.error(
          fill(T.controllerRefused, word(what, this.config.language), 'succeeded=false'),
        );
      }
      const byEvent = await Promise.race([
        event,
        new Promise((resolve) => {
          this.later(() => resolve(false), asked + this.T.eventBy - this.now());
        }),
      ]);
      if (byEvent) {
        this.logger.info(`Command confirmed by the controller (${what.en})`);
        return;
      }
      // No event in time: one read of the node, within what Gladys waits.
      let prop;
      try {
        const status = await http.get(restPath('status', node.address), {
          timeout: Math.max(200, asked + this.T.answerBy - this.now()),
          maxBytes: LIMITS.commandBytes,
        });
        prop = parseNodeStatus(status.body).find((p) => p.id === 'ST');
      } catch {
        prop = undefined;
      }
      if (prop) {
        this.setProperty(node, prop);
        this.noteChange([]);
      }
      if (prop && matches(prop)) {
        this.logger.info(`Command confirmed by a read of the node (${what.en})`);
        return;
      }
      this.logger.warn(`Command sent, NOT confirmed (${what.en})`);
      this.scheduleReadBack(node);
      throw this.error(fill(T.unconfirmed, word(what, this.config.language)));
    } finally {
      this.waiters.delete(waiter);
    }
  }

  sendError(err, what, node, asked, gate, closed) {
    if (err instanceof IsyError && !err.sent) {
      this.logger.warn(`Command NOT sent (${what.en}): ${err.message}`);
      if (err.kind === 'withdrawn') return this.refused(this.withdrawnReason(asked, gate, closed));
      return this.refused(T.offline);
    }
    if (err instanceof IsyError && err.kind === 'status' && err.status === 404) {
      // An ISY994 answers 404 when its Insteon network is busy (PyISY): it may
      // have taken the command all the same.
      this.logger.warn(`Command sent, answered 404, NOT confirmed (${what.en})`);
      if (node) this.scheduleReadBack(node);
      return this.error(fill(T.unconfirmed, word(what, this.config.language)));
    }
    if (err instanceof IsyError && ['auth', 'busy', 'status'].includes(err.kind)) {
      // The controller answered: it did not take the command.
      this.logger.warn(`Command REFUSED by the controller (${what.en}): ${err.message}`);
      if (node) this.scheduleReadBack(node);
      return this.error(fill(T.controllerRefused, word(what, this.config.language), err.message));
    }
    this.logger.warn(`Command sent, NOT confirmed (${what.en}): ${err.message}`);
    if (node) this.scheduleReadBack(node);
    return this.error(fill(T.unconfirmed, word(what, this.config.language)));
  }

  scheduleReadBack(node) {
    const session = this.session;
    this.later(async () => {
      if (session !== this.session || !this.connected) return;
      try {
        const status = await this.read(restPath('status', node.address), {
          timeout: this.T.httpTimeout,
          maxBytes: LIMITS.commandBytes,
        });
        if (session !== this.session) return;
        for (const prop of parseNodeStatus(status.body)) this.setProperty(node, prop);
        this.noteChange([]);
      } catch {
        // The next round catches up.
      }
    }, this.T.readBack);
  }

  /** "Run" of a program of the "Gladys" folder: the controller runs it (its If decides Then or Else). */
  async runProgram(target, value, asked) {
    const program = this.model.programs.get(target.platformId);
    if (!program) throw this.refused(T.unknownDevice);
    if (target.key !== 'run') throw this.refused(T.readOnly);
    const gate = () => this.config.allowPrograms && this.model.programs.has(target.platformId);
    if (!this.config.allowPrograms) {
      this.logger.warn(`Program ${program.id} REFUSED: programs disabled`);
      throw this.refused(T.programsOff);
    }
    if (binaryOf(value) !== 1) throw this.refused(fill(T.badValue, JSON.stringify(value)));
    this.checkSession();
    const what = fill(COMMAND_NAMES.run, program.name);
    const http = this.http;
    this.logger.info(`Command from Gladys: ${what.en}`);
    let answer;
    try {
      answer = await this.serial(target.platformId, async () => {
        // A fresh read of the programs, in the budget of the command: the
        // program must still be in the "Gladys" folder, under the same name
        // (a deleted program's id may be reused elsewhere).
        let list;
        try {
          const fresh = await http.get(`${restPath('programs')}?subfolders=true`, {
            timeout: Math.max(200, asked + this.T.sendBy - this.now()),
            maxBytes: LIMITS.programsBytes,
          });
          list = parsePrograms(fresh.body, PROGRAM_FOLDER);
        } catch (err) {
          this.logger.warn(`Program ${program.id} NOT sent: the programs could not be read`);
          throw this.refused(err?.kind === 'timeout' ? T.tooLate : T.programCheckFailed);
        }
        const found = list.find((p) => p.id === program.id);
        if (!found || found.name !== program.name) {
          this.logger.warn(`Program ${program.id} REFUSED: no longer in the "Gladys" folder`);
          await this.replacePrograms(list);
          throw this.refused(T.programGone);
        }
        return http.get(restPath('programs', program.id.toUpperCase(), 'run'), {
          timeout: Math.max(500, asked + this.T.answerBy - this.now()),
          maxBytes: LIMITS.commandBytes,
          beforeSend: () => this.beforeSend(asked, gate, http),
        });
      });
    } catch (err) {
      if (err instanceof Refused) throw err;
      if (
        err instanceof IsyError &&
        err.kind === 'withdrawn' &&
        this.model.programs.has(target.platformId) === false
      ) {
        throw this.refused(T.programGone);
      }
      throw this.sendError(err, what, undefined, asked, gate, T.programsOff);
    }
    if (!succeeded(answer.body)) {
      this.logger.warn(`Program REFUSED by the controller (${what.en})`);
      throw this.error(
        fill(T.controllerRefused, word(what, this.config.language), 'succeeded=false'),
      );
    }
    // The controller runs the program itself: its answer is the confirmation.
    this.logger.info(`Program run accepted by the controller (${what.en})`);
  }

  // --- Configuration button -------------------------------------------------------------

  waitForLink(timeout) {
    return new Promise((resolve) => {
      const started = this.now();
      const check = () => {
        if (this.connected) return resolve('up');
        if (!this.connecting && !this.connected) return resolve('down');
        if (this.now() - started >= timeout) return resolve('timeout');
        this.timers.setTimeout(check, 100);
        return undefined;
      };
      check();
    });
  }

  /**
   * "Test the connection": one try when stopped (a refusal is erased only by
   * a success), never during a pause except after "another controller" (the
   * identity is then read again once); never a read of the nodes.
   */
  async testConnection() {
    const problem = this.configProblem();
    if (problem) throw this.error(problem);
    const lastMessage = () => (this.lastStatus ? JSON.parse(this.lastStatus)[1] : undefined);
    const memory = await this.loadMemory();
    if (!this.connected && !this.connecting) {
      if (memory.retryAt > this.now() && this.identity !== 'other') {
        throw this.error(lastMessage() ?? T.offline);
      }
      await this.setStatus(false, T.connecting);
      this.connect(this.session);
    }
    const result = await this.waitForLink(this.T.testWait);
    await this.chain;
    if (result === 'timeout') throw this.error(T.stillConnecting);
    if (result !== 'up') throw this.error(lastMessage() ?? T.offline);
    return fill(T.testOk, this.seenId ?? '?', entries(this.config, this.model, addressKey).length);
  }
}
