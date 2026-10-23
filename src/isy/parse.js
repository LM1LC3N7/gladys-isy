// -----------------------------------------------------------------------------
// The answers and events of the controller -> plain objects (ported from the
// parsers of pyisy: configuration.py, nodes/__init__.py, helpers.py
// parse_xml_properties, programs/__init__.py, variables/__init__.py,
// events/websocket.py _route_message). Everything taken from the network is
// checked and bounded here; what does not fit is dropped, never guessed.
// -----------------------------------------------------------------------------

import { LIMITS } from '../constants.js';
import { child, childText, descendants, parseXml } from './xml.js';

/** Printable text, without control characters, bounded. */
export function cleanText(value, max = 80) {
  if (typeof value !== 'string') return '';
  let out = '';
  for (const ch of value) {
    const code = ch.codePointAt(0);
    if (code < 0x20 || (code >= 0x7f && code < 0xa0) || code === 0x2028 || code === 0x2029) {
      out += ' ';
    } else {
      out += ch;
    }
    if (out.length >= max) break;
  }
  return out.replace(/\s+/g, ' ').trim();
}

/** A node address as the controller writes it ("1A 2B 3C 1", "ZW002_1", "n003_temp"). */
export const isAddress = (value) =>
  typeof value === 'string' && /^[\w .:-]{1,64}$/.test(value) && value.trim() === value;

/** A property id ("ST", "CLITEMP", "BATLVL", "GV1"). */
export const isPropertyId = (value) =>
  typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,15}$/.test(value);

const isUom = (value) => typeof value === 'string' && /^\d{1,4}$/.test(value);

/** An integer value of the controller ("", "-", "101.5" are not one). */
function integerOf(text) {
  if (typeof text !== 'string' || !/^\s*-?\d{1,15}\s*$/.test(text)) return undefined;
  const n = Number(text);
  return Number.isSafeInteger(n) ? n : undefined;
}

const precisionOf = (text) => {
  const n = integerOf(text ?? '0');
  return n !== undefined && n >= 0 && n <= 8 ? n : 0;
};

/** A property from `<property id value uom prec formatted>` (or the action of an event). */
function property(id, valueText, uom, prec) {
  if (!isPropertyId(id)) return undefined;
  const raw = integerOf(valueText);
  return {
    id,
    // Unknown ("" or " "): kept as null, never 0.
    raw: raw ?? null,
    uom: isUom(uom) ? uom : '',
    prec: precisionOf(prec),
  };
}

/** raw + precision -> the value (null stays null). */
export const scaled = (p) => (p.raw === null ? null : p.raw / 10 ** p.prec);

/** /rest/config -> { uuid, name, model, firmware }. */
export function parseConfig(text) {
  const doc = parseXml(text);
  const root = child(doc, 'root');
  const uuid = String(childText(root, 'id') ?? '').toLowerCase();
  return {
    uuid: /^[0-9a-z][0-9a-z:.-]{3,63}$/.test(uuid) ? uuid : undefined,
    name: cleanText(childText(root, 'name') ?? ''),
    model: cleanText(childText(child(doc, 'product'), 'desc') ?? '') || 'ISY',
    firmware: cleanText(
      childText(doc, 'app_full_version') ?? childText(doc, 'app_version') ?? '',
      32,
    ),
  };
}

function properties(el) {
  const out = [];
  for (const p of el.children) {
    if (p.name !== 'property') continue;
    const prop = property(p.attrs.id, p.attrs.value, p.attrs.uom, p.attrs.prec);
    if (prop && !out.some((q) => q.id === prop.id)) out.push(prop);
    if (out.length >= LIMITS.maxProperties) break;
  }
  return out;
}

/**
 * /rest/nodes -> [{ address, name, family, type, nodeDefId, zwaveCategory, pnode, props }]
 * (the folders and the scenes of the controller are not nodes).
 */
export function parseNodes(text) {
  const doc = parseXml(text);
  const nodes = [];
  const seen = new Set();
  for (const el of doc.children) {
    if (el.name !== 'node') continue;
    const address = childText(el, 'address');
    if (!isAddress(address) || seen.has(address)) continue;
    seen.add(address);
    const devtype = child(el, 'devtype');
    const type = childText(el, 'type') ?? '';
    const family = childText(el, 'family') ?? '';
    const pnode = childText(el, 'pnode');
    nodes.push({
      address,
      name: cleanText(childText(el, 'name') ?? '') || address,
      family: /^\d{1,3}$/.test(family) ? family : '',
      type: /^[\d.]{1,32}$/.test(type) ? type : '',
      nodeDefId: /^[\w.-]{1,64}$/.test(el.attrs.nodeDefId ?? '') ? el.attrs.nodeDefId : '',
      zwaveCategory: /^\d{1,4}$/.test(childText(devtype, 'cat') ?? '')
        ? childText(devtype, 'cat')
        : '',
      pnode: isAddress(pnode) ? pnode : address,
      props: properties(el),
    });
    if (nodes.length >= LIMITS.maxNodes) break;
  }
  return nodes;
}

/** /rest/status -> Map(address -> [props]). */
export function parseStatus(text) {
  const doc = parseXml(text);
  const out = new Map();
  for (const el of doc.children) {
    if (el.name !== 'node' || !isAddress(el.attrs.id)) continue;
    out.set(el.attrs.id, properties(el));
    if (out.size >= LIMITS.maxNodes * 2) break;
  }
  return out;
}

/** /rest/status/<address> (`<properties>` or `<nodeInfo>`) -> [props]. */
export function parseNodeStatus(text) {
  const doc = parseXml(text);
  if (doc.name === 'properties') return properties(doc);
  const props = child(doc, 'properties');
  return props ? properties(props) : properties(doc);
}

const isProgramId = (value) => typeof value === 'string' && /^[0-9A-Fa-f]{1,4}$/.test(value);
const programId = (value) => value.toLowerCase().padStart(4, '0');

/**
 * /rest/programs?subfolders=true -> the programs whose parent folder is named
 * like `folderName` (case-insensitive, the whole name): [{ id, name, status }].
 */
export function parsePrograms(text, folderName) {
  const doc = parseXml(text);
  const folders = new Set();
  const all = [];
  for (const el of doc.children) {
    if (el.name !== 'program' || !isProgramId(el.attrs.id)) continue;
    const id = programId(el.attrs.id);
    const name = cleanText(childText(el, 'name') ?? '');
    if (el.attrs.folder === 'true') {
      if (name.toLowerCase() === folderName) folders.add(id);
      continue;
    }
    const parent = isProgramId(el.attrs.parentId) ? programId(el.attrs.parentId) : '';
    all.push({ id, name: name || id, parent, status: el.attrs.status === 'true' });
  }
  return all
    .filter((p) => folders.has(p.parent))
    .slice(0, LIMITS.maxPrograms)
    .map(({ id, name, status }) => ({ id, name, status }));
}

/** /rest/vars/definitions/<type> -> Map(id -> name). An empty or 404 answer: none. */
export function parseVariableNames(text) {
  const out = new Map();
  if (!text || !text.includes('<e')) return out;
  const doc = parseXml(text);
  for (const el of descendants(doc, 'e', LIMITS.maxVariables)) {
    const id = integerOf(el.attrs.id);
    if (id === undefined || id < 0 || id > 99_999) continue;
    out.set(id, cleanText(el.attrs.name ?? '') || String(id));
  }
  return out;
}

function variable(el) {
  const type = integerOf(el.attrs.type);
  const id = integerOf(el.attrs.id);
  if ((type !== 1 && type !== 2) || id === undefined || id < 0 || id > 99_999) return undefined;
  return {
    type,
    id,
    raw: integerOf(childText(el, 'val')) ?? null,
    prec: precisionOf(childText(el, 'prec')),
  };
}

/** /rest/vars/get/<type> -> [{ type, id, raw, prec }]. */
export function parseVariables(text) {
  if (!text || !text.includes('<var')) return [];
  const doc = parseXml(text);
  return descendants(doc, 'var', LIMITS.maxVariables * 2)
    .map(variable)
    .filter(Boolean);
}

/** `<RestResponse succeeded="true">`: the controller took the request. */
export function succeeded(text) {
  try {
    const doc = parseXml(text);
    return doc.name === 'RestResponse' && doc.attrs.succeeded === 'true';
  } catch {
    return false;
  }
}

/**
 * One event of /rest/subscribe -> a plain object, or undefined:
 * - { kind: 'heartbeat', seconds }
 * - { kind: 'property', address, prop } (ST, CLITEMP, BATLVL...)
 * - { kind: 'control', address, control } (DON, DOF... a press)
 * - { kind: 'variable', type, id, raw, prec }
 * - { kind: 'program', id, status }
 * - { kind: 'catalog' } (a node or a folder added, removed, renamed...)
 */
export function parseEvent(text, controls) {
  let doc;
  try {
    doc = parseXml(text);
  } catch {
    return undefined;
  }
  if (doc.name !== 'Event') return undefined;
  const control = childText(doc, 'control') ?? '';
  const actionEl = child(doc, 'action');
  const action = actionEl?.text ?? '';
  const node = childText(doc, 'node') ?? '';
  const info = child(doc, 'eventInfo');
  if (control === '_0') {
    const seconds = integerOf(action);
    return {
      kind: 'heartbeat',
      seconds: seconds !== undefined && seconds > 0 ? seconds : undefined,
    };
  }
  if (control === '_1') {
    const v = child(info, 'var');
    if ((action === '6' || action === '7') && v) {
      // 7: the init value changed, not the value.
      if (action === '7') return undefined;
      const parsed = variable(v);
      return parsed ? { kind: 'variable', ...parsed } : undefined;
    }
    const id = childText(info, 'id');
    if (action === '0' && isProgramId(id)) {
      const s = childText(info, 's');
      // pyisy: 21 = ran then (true), 31 = ran else (false); otherwise unchanged.
      const status = s === '21' ? true : s === '31' ? false : undefined;
      return status === undefined ? undefined : { kind: 'program', id: programId(id), status };
    }
    return undefined;
  }
  if (control === '_3') {
    // pyisy NODE_CHANGED_ACTIONS: node and folder added, removed, renamed, moved...
    return ['ND', 'NR', 'NN', 'MV', 'PC', 'GD', 'GR', 'FD', 'FR', 'RV'].includes(action)
      ? { kind: 'catalog' }
      : undefined;
  }
  if (control.startsWith('_') || !isAddress(node)) return undefined;
  if (controls.includes(control)) return { kind: 'control', address: node, control };
  const prop = property(control, action, actionEl?.attrs.uom, actionEl?.attrs.prec);
  return prop ? { kind: 'property', address: node, prop } : undefined;
}
