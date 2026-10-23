// -----------------------------------------------------------------------------
// What must survive a restart, in /data (the only writable place of the
// container), file readable by the container user only (0600):
// - the stop after the controller refused the user name or password, with a
//   salted SHA-256 of the refused pair only (never of a pair the controller
//   accepted; erased at the first success), so a restart never sends a
//   refused password again while a new password is tried at once;
// - the end of the pause after failures (bounded), so a restart never tries
//   sooner;
// - the identifier of the controller (its identity), so another controller
//   answering at the same address after a DHCP swap is told apart;
// - the catalogue (nodes with their properties, variables, programs of the
//   "Gladys" folder) and when it was read, so a restart needs no new read;
// - when the last status round started (written before it starts), so a
//   restart never reads sooner.
// No password, no secret, no personal data.
// -----------------------------------------------------------------------------

import { createHash, randomBytes } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { LIMITS } from './constants.js';
import { cleanText, isAddress, isPropertyId } from './isy/parse.js';

export const STATE_FILE = '/data/isy-state.json';

export function fileStore(path = STATE_FILE) {
  // One write at a time: two saves never share the temporary file.
  let chain = Promise.resolve();
  return {
    async load() {
      try {
        return JSON.parse(await readFile(path, 'utf8'));
      } catch {
        return null;
      }
    },
    save(data) {
      const text = JSON.stringify(data);
      const write = chain.then(async () => {
        const temporary = `${path}.tmp`;
        await writeFile(temporary, text, { mode: 0o600 });
        await rename(temporary, path);
      });
      chain = write.catch(() => {});
      return write;
    },
  };
}

/** In-memory store, for the tests. */
export function memoryStore(initial = null) {
  let data = initial;
  return {
    saves: 0,
    async load() {
      return data === null ? null : JSON.parse(JSON.stringify(data));
    },
    async save(next) {
      this.saves += 1;
      data = JSON.parse(JSON.stringify(next));
    },
    get data() {
      return data;
    },
  };
}

/** A salted hash of a refused user name and password. */
export function refusedHash(salt, username, password) {
  return createHash('sha256').update(`${salt}\u0000${username}\u0000${password}`).digest('hex');
}

export const newSalt = () => randomBytes(16).toString('hex');

const HEX = (length) => new RegExp(`^[0-9a-f]{${length}}$`);
const isPlace = (value) => typeof value === 'string' && value.length > 0 && value.length <= 300;
const isId = (value) => typeof value === 'string' && /^[0-9a-z][0-9a-z:.-]{3,63}$/.test(value);
const time = (value) => (Number.isFinite(value) && value > 0 ? value : 0);
const short = (value, re) => (typeof value === 'string' && re.test(value) ? value : '');
const raw = (value) => (Number.isSafeInteger(value) ? value : null);
const prec = (value) => (Number.isInteger(value) && value >= 0 && value <= 8 ? value : 0);

function normalizeNode(n) {
  if (!isAddress(n?.address)) return undefined;
  const props = [];
  for (const p of Array.isArray(n.props) ? n.props : []) {
    if (props.length >= LIMITS.maxProperties) break;
    if (!isPropertyId(p?.id) || props.some((q) => q.id === p.id)) continue;
    props.push({ id: p.id, raw: raw(p.raw), uom: short(p.uom, /^\d{1,4}$/), prec: prec(p.prec) });
  }
  return {
    address: n.address,
    name: cleanText(n.name) || n.address,
    family: short(n.family, /^\d{1,3}$/),
    type: short(n.type, /^[\d.]{1,32}$/),
    nodeDefId: short(n.nodeDefId, /^[\w.-]{1,64}$/),
    zwaveCategory: short(n.zwaveCategory, /^\d{1,4}$/),
    pnode: isAddress(n.pnode) ? n.pnode : n.address,
    props,
  };
}

function normalizeCatalog(c) {
  const nodes = [];
  const seen = new Set();
  for (const n of Array.isArray(c?.nodes) ? c.nodes : []) {
    if (nodes.length >= LIMITS.maxNodes) break;
    const node = normalizeNode(n);
    if (!node || seen.has(node.address)) continue;
    seen.add(node.address);
    nodes.push(node);
  }
  const variables = (Array.isArray(c?.variables) ? c.variables : [])
    .filter(
      (v) =>
        (v?.type === 1 || v?.type === 2) && Number.isInteger(v.id) && v.id >= 0 && v.id <= 99_999,
    )
    .slice(0, LIMITS.maxVariables)
    .map((v) => ({
      type: v.type,
      id: v.id,
      name: cleanText(v.name) || String(v.id),
      raw: raw(v.raw),
      prec: prec(v.prec),
    }));
  const programs = (Array.isArray(c?.programs) ? c.programs : [])
    .filter((p) => typeof p?.id === 'string' && HEX(4).test(p.id))
    .slice(0, LIMITS.maxPrograms)
    .map((p) => ({ id: p.id, name: cleanText(p.name) || p.id, status: p.status === true }));
  return { nodes, variables, programs };
}

/** The persisted state, repaired; anything unexpected is dropped. */
export function normalizeMemory(input) {
  const stop = input?.stop;
  const controller = input?.controller;
  const place = isPlace(input?.place) ? input.place : '';
  return {
    stop:
      isPlace(stop?.place) &&
      stop.kind === 'credentials_refused' &&
      HEX(32).test(stop.salt ?? '') &&
      HEX(64).test(stop.refused ?? '')
        ? {
            place: stop.place,
            kind: stop.kind,
            at: time(stop.at),
            salt: stop.salt,
            refused: stop.refused,
          }
        : null,
    retryAt: time(input?.retryAt),
    failures:
      Number.isInteger(input?.failures) && input.failures >= 0 ? Math.min(input.failures, 99) : 0,
    controller:
      isPlace(controller?.place) && isId(controller?.uuid)
        ? { place: controller.place, uuid: controller.uuid }
        : null,
    place,
    catalog: place ? normalizeCatalog(input?.catalog) : { nodes: [], variables: [], programs: [] },
    lastCatalogAt: place ? time(input?.lastCatalogAt) : 0,
    lastRoundAt: time(input?.lastRoundAt),
  };
}
