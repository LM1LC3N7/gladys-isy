// -----------------------------------------------------------------------------
// The configuration of the manifest `config_schema`, normalized.
// -----------------------------------------------------------------------------

import { DEFAULT_PORT, LIMITS } from './constants.js';

/** Defaults, mirrored by the manifest (checked by test/manifest.test.js). */
export const DEFAULTS = {
  port: DEFAULT_PORT,
  poll_interval: 10,
  allow_output_buttons: false,
  allow_programs: false,
  language: 'fr',
};

export const LANGUAGES = ['fr', 'en'];

const bool = (value, fallback) => (typeof value === 'boolean' ? value : fallback);

const integer = (value, fallback, min, max) => {
  const number = Number(value);
  return value !== null && value !== '' && value !== undefined && Number.isFinite(number)
    ? Math.round(Math.max(min, Math.min(max, number)))
    : fallback;
};

/** `192.168.1.9`, `eisy.local:8080`, `http://192.168.1.9` -> { host, port?, https? }. */
export function parseHost(raw) {
  let text = String(raw ?? '').trim();
  const scheme = /^([a-z]+):\/\//i.exec(text)?.[1]?.toLowerCase();
  // HTTPS is not supported yet (it needs a pinned certificate): refused, never downgraded.
  if (scheme && scheme !== 'http') return { host: '', https: scheme === 'https' };
  text = text.replace(/^[a-z]+:\/\//i, '').replace(/\/.*$/, '');
  // `user:password@host` is not taken: they have their own fields.
  if (text.includes('@')) return { host: '' };
  const match = /^(\[[0-9a-f:.]+\]|[^:\s]+)(?::(\d{1,5}))?$/i.exec(text);
  if (!match) return { host: '' };
  const port = match[2] ? Number(match[2]) : undefined;
  return {
    host: match[1].replace(/^\[|\]$/g, ''),
    port: port >= 1 && port <= 65535 ? port : undefined,
  };
}

/**
 * A node address as a key: upper case, one space between the parts; an
 * Insteon address without its sub-node ("1A 2B 3C", "1A.2B.3C") is its
 * first node ("1A 2B 3C 1").
 */
export function addressKey(raw) {
  const text = String(raw ?? '')
    .trim()
    .toUpperCase()
    .replace(/[.\s]+/g, ' ');
  if (!/^[\w :-]{1,64}$/.test(text)) return undefined;
  if (/^[0-9A-F]{1,2} [0-9A-F]{1,2} [0-9A-F]{1,2}$/.test(text)) return `${text} 1`;
  return text;
}

/**
 * Nodes declared safe: `1A 2B 3C 1, 4D 5E 6F: light` -> Map(key -> 'switch' | 'light').
 * A dimmer declared becomes a light whatever the kind; a relay a switch, or a
 * light with `light`. Wrong entries are reported, not fatal.
 */
export function parseSafeNodes(raw) {
  const safe = new Map();
  const errors = [];
  for (const entry of String(raw ?? '').split(/[,;\n]+/)) {
    const text = entry.trim();
    if (text === '') continue;
    const match = /^(.{1,64}?)(?:\s*[:=]\s*|\s+)(switch|light)$/i.exec(text);
    const key = addressKey(match ? match[1] : text);
    const kind = (match?.[2] ?? 'switch').toLowerCase();
    if (!key || safe.size >= LIMITS.maxSafe) {
      errors.push(text.slice(0, 40));
      continue;
    }
    safe.set(key, kind);
  }
  return { safe, errors };
}

export function normalizeConfig(raw = {}) {
  const { host, port: hostPort, https } = parseHost(raw?.host);
  const language = String(raw?.language ?? DEFAULTS.language)
    .trim()
    .toLowerCase();
  const nodes = parseSafeNodes(raw?.safe_nodes);
  const typed = String(raw?.controller_id ?? '')
    .trim()
    .toLowerCase();
  const controllerId = /^[0-9a-z][0-9a-z:.-]{3,63}$/.test(typed) ? typed : undefined;
  return {
    host,
    https: https === true,
    // A port typed with the address wins over the port field (which has a default).
    port: hostPort ?? integer(raw?.port, DEFAULTS.port, 1, 65535),
    username: typeof raw?.username === 'string' ? raw.username.trim() : '',
    // As typed.
    password: typeof raw?.password === 'string' ? raw.password : '',
    controllerId,
    controllerIdInvalid: typed !== '' && controllerId === undefined,
    safe: nodes.safe,
    safeErrors: nodes.errors,
    interval:
      integer(raw?.poll_interval, DEFAULTS.poll_interval, LIMITS.minInterval, LIMITS.maxInterval) *
      60_000,
    allowButtons: bool(raw?.allow_output_buttons, DEFAULTS.allow_output_buttons),
    allowPrograms: bool(raw?.allow_programs, DEFAULTS.allow_programs),
    language: LANGUAGES.includes(language) ? language : DEFAULTS.language,
  };
}

/** What the session depends on: a change reconnects. */
export const sessionKey = (config) =>
  JSON.stringify([
    config.host,
    config.port,
    config.username,
    config.password,
    config.controllerId ?? null,
  ]);

/** Where the session goes, without the credentials. */
export const placeKey = (config) => `${config.host}:${config.port}`;
