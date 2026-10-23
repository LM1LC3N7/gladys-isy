// -----------------------------------------------------------------------------
// The model of the controller -> Gladys devices and states (pure).
//
// Ids (forever): `gladys.externalIds('isy', <platform id>)` with
// - a node: `n_` + its address in lower case, every run of other characters
//   than a-z and 0-9 made one `_` ("1A 2B 3C 1" -> `n_1a_2b_3c_1`,
//   "ZW002_1" -> `n_zw002_1`); two addresses giving the same id: the second
//   one is left out (listed in the status);
// - a variable: `v1_<id>` (integer) or `v2_<id>` (state);
// - a program: `p_<id>` (its 4 hex digits, lower case).
// Feature keys are listed in FEATURES; a sensor read from a property is
// `<property id>_<unit of measure of the controller>` ("clitemp_17"), so its
// unit never changes once created.
//
// Kinds (pyisy's lists of Insteon types and Z-Wave categories):
// - Insteon dimmer (type 1.x, first sub-node, level 0-255) or relay (type
//   2.x, first sub-node): a light / a switch only when DECLARED SAFE; else a
//   read-only state (and level) with "Turn on" / "Turn off" buttons behind
//   an option off by default. A light or a switch obeys Google, Alexa, the
//   MCP and the scenes ("turn everything off"): the load behind a node is
//   unknown (a pump, a heater, a garage door...).
// - Locks (Insteon 15.x / 4.64, Z-Wave 111, or the deadbolt unit 11): a
//   read-only "locked" state. Thermostats (Insteon 5.x, Z-Wave 140): their
//   temperature and humidity, read only. I/O Linc (garage doors): read only.
// - Anything else: its state, read only, and the sensors it reports.
// A device published again never loses a feature the user created.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import { FEATURE_NAMES, SENSOR_NAMES, fill, word } from './i18n.js';
import { scaled } from './isy/parse.js';

const command = (category, type, extra = {}) => ({
  category,
  type,
  read_only: false,
  has_feedback: true,
  keep_history: true,
  ...extra,
});

const reading = (category, type, extra = {}) => ({
  category,
  type,
  read_only: true,
  has_feedback: false,
  keep_history: true,
  min: 0,
  max: 1,
  ...extra,
});

const button = () => ({
  category: C.BUTTON,
  type: T.BUTTON.PUSH,
  read_only: false,
  has_feedback: false,
  keep_history: false,
  min: 0,
  max: 1,
});

/** Feature definitions by key (the last part of their external id). */
export const FEATURES = {
  binary: command(C.LIGHT, T.LIGHT.BINARY, { min: 0, max: 1 }),
  brightness: command(C.LIGHT, T.LIGHT.BRIGHTNESS, { min: 0, max: 100 }),
  switch: command(C.SWITCH, T.SWITCH.BINARY, { min: 0, max: 1 }),
  light: command(C.LIGHT, T.LIGHT.BINARY, { min: 0, max: 1 }),
  // A state only: no voice assistant, scene or "turn everything off" can drive it.
  state: reading(C.UNKNOWN, T.SENSOR.BINARY),
  level: reading(C.UNKNOWN, T.SENSOR.UNKNOWN, { max: 100 }),
  locked: reading(C.UNKNOWN, T.SENSOR.BINARY),
  turn_on: button(),
  turn_off: button(),
  value: reading(C.UNKNOWN, T.SENSOR.UNKNOWN, { min: -2_147_483_648, max: 2_147_483_647 }),
  run: button(),
  status: reading(C.UNKNOWN, T.SENSOR.BINARY),
};

/** Keys that obey Gladys as a switch or a light: only for a node declared safe. */
export const SAFE_KEYS = new Set(['binary', 'brightness', 'switch', 'light']);

/** The properties read as sensors, and how (by unit of measure of the controller). */
const SENSOR_PROPS = new Set(['ST', 'CLITEMP', 'CLIHUM', 'BATLVL', 'LUMIN', 'CPW', 'CV', 'CC']);
const sensor = (category, type, unit, min, max, integer = false) => ({
  def: reading(category, type, { unit, min, max }),
  integer,
});
const SENSOR_UOMS = {
  4: sensor(C.TEMPERATURE_SENSOR, T.SENSOR.DECIMAL, U.CELSIUS, -100, 200),
  17: sensor(C.TEMPERATURE_SENSOR, T.SENSOR.DECIMAL, U.FAHRENHEIT, -150, 400),
  26: sensor(C.TEMPERATURE_SENSOR, T.SENSOR.DECIMAL, U.KELVIN, 0, 500),
  22: sensor(C.HUMIDITY_SENSOR, T.SENSOR.DECIMAL, U.PERCENT, 0, 100),
  36: sensor(C.LIGHT_SENSOR, T.SENSOR.DECIMAL, U.LUX, 0, 200_000),
  73: sensor(C.ENERGY_SENSOR, T.ENERGY_SENSOR.POWER, U.WATT, -100_000, 100_000),
  72: sensor(C.ENERGY_SENSOR, T.ENERGY_SENSOR.VOLTAGE, U.VOLT, 0, 1_000),
  1: sensor(C.ENERGY_SENSOR, T.ENERGY_SENSOR.CURRENT, U.AMPERE, -1_000, 1_000),
};
const BATTERY = sensor(C.BATTERY, T.BATTERY.INTEGER, U.PERCENT, 0, 100, true);
const CLIHUM_PERCENT = sensor(C.HUMIDITY_SENSOR, T.SENSOR.DECIMAL, U.PERCENT, 0, 100);

/** How a property is read as a sensor, or undefined. */
function sensorOf(prop) {
  if (!SENSOR_PROPS.has(prop.id)) return undefined;
  if (prop.id === 'BATLVL') return prop.uom === '51' ? BATTERY : undefined;
  if (prop.id === 'CLIHUM' && prop.uom === '51') return CLIHUM_PERCENT;
  return Object.hasOwn(SENSOR_UOMS, prop.uom) ? SENSOR_UOMS[prop.uom] : undefined;
}

const sensorKey = (prop) => `${prop.id.toLowerCase()}_${prop.uom}`;
const SENSOR_KEY = /^(st|clitemp|clihum|batlvl|lumin|cpw|cv|cc)_(\d{1,4})$/;

/** The definition of a key (sensor keys included), or undefined. */
export function featureOf(key) {
  if (Object.hasOwn(FEATURES, key)) return FEATURES[key];
  const match = SENSOR_KEY.exec(key);
  if (!match) return undefined;
  return sensorOf({ id: match[1].toUpperCase(), uom: match[2] })?.def;
}

const INSTEON_THERMOSTATS = [
  '4.8',
  '5.3',
  '5.10',
  '5.11',
  '5.14',
  '5.15',
  '5.16',
  '5.17',
  '5.18',
  '5.19',
  '5.20',
  '5.21',
];
const typeIs = (type, prefix) => type === prefix || type.startsWith(`${prefix}.`);

/** dimmer, relay, lock, thermostat, iolinc or other. */
export function kindOf(node) {
  const insteon = node.family === '' || node.family === '1';
  const zwave = node.family === '4' || node.family === '12';
  const st = node.props.get('ST');
  const primary = / 1$/.test(node.address);
  if (
    (insteon && (typeIs(node.type, '15') || typeIs(node.type, '4.64'))) ||
    (zwave && node.zwaveCategory === '111') ||
    st?.uom === '11'
  ) {
    return 'lock';
  }
  if (
    (insteon && INSTEON_THERMOSTATS.some((t) => typeIs(node.type, t))) ||
    (zwave && node.zwaveCategory === '140')
  ) {
    return 'thermostat';
  }
  if (insteon && typeIs(node.type, '7')) return 'iolinc';
  if (insteon && primary && st?.uom === '100') {
    if (typeIs(node.type, '1')) return 'dimmer';
    if (typeIs(node.type, '2')) return 'relay';
  }
  return 'other';
}

/** `1A 2B 3C 1` -> `n_1a_2b_3c_1`. */
export function nodePlatformId(address) {
  const slug = address
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
  return slug ? `n_${slug}` : undefined;
}

export const ids = (gladys, platformId) => gladys.externalIds('isy', platformId);

/** `ext:sel:isy:n_1a_2b_3c_1:brightness` -> { platformId, key }. */
export function parseFeatureId(externalId) {
  const match =
    /:isy:((?:n_[a-z0-9_]{1,48})|(?:v[12]_\d{1,5})|(?:p_[0-9a-f]{4})):([a-z0-9_]{1,40})$/.exec(
      String(externalId ?? ''),
    );
  return match ? { platformId: match[1], key: match[2] } : undefined;
}

/** The keys offered for a node now. */
export function nodeKeys(config, node, addressKey) {
  const kind = kindOf(node);
  const declared = config.safe.get(addressKey(node.address));
  const keys = [];
  const st = node.props.get('ST');
  if (kind === 'dimmer') {
    keys.push(...(declared ? ['binary', 'brightness'] : ['state', 'level', 'turn_on', 'turn_off']));
  } else if (kind === 'relay') {
    keys.push(...(declared ? [declared] : ['state', 'turn_on', 'turn_off']));
  } else if (kind === 'lock') {
    if (st?.uom === '11') keys.push('locked');
  } else if (st) {
    if (st.uom === '100' || st.uom === '51') keys.push('state', 'level');
    else if (st.uom === '78' || st.uom === '2') keys.push('state');
  }
  for (const prop of node.props.values()) {
    if (prop.id === 'ST' && kind !== 'other' && kind !== 'thermostat') continue;
    if (prop.id === 'ST' && (prop.uom === '100' || prop.uom === '51')) continue;
    if (sensorOf(prop)) keys.push(sensorKey(prop));
  }
  return keys;
}

/** What a discovered feature declares (a created one also has ids, values, dates). */
const FEATURE_FIELDS = [
  'name',
  'external_id',
  'category',
  'type',
  'min',
  'max',
  'read_only',
  'has_feedback',
  'keep_history',
  'unit',
];

/** Adds to each device the features of its created twin it no longer has. */
export function keepCreatedFeatures(devices, created = []) {
  const byId = new Map((created ?? []).map((device) => [device.external_id, device]));
  return devices.map((device) => {
    const twin = byId.get(device.external_id);
    if (!twin?.features?.length) return device;
    const have = new Set(device.features.map((f) => f.external_id));
    const kept = twin.features
      .filter((f) => f?.external_id && !have.has(f.external_id))
      .map((f) =>
        Object.fromEntries(
          FEATURE_FIELDS.filter((key) => f[key] !== undefined && f[key] !== null).map((key) => [
            key,
            f[key],
          ]),
        ),
      );
    return kept.length === 0 ? device : { ...device, features: [...device.features, ...kept] };
  });
}

function featureName(key, language) {
  if (Object.hasOwn(FEATURE_NAMES, key)) return word(FEATURE_NAMES[key], language);
  const id = key.split('_')[0];
  return Object.hasOwn(SENSOR_NAMES, id) ? word(SENSOR_NAMES[id], language) : key;
}

/**
 * The entries shown: [{ platformId, kind: 'node' | 'variable' | 'program', item, keys }],
 * in a stable order (nodes by address, variables, programs).
 */
export function entries(config, model, addressKey) {
  const out = [];
  for (const [platformId, node] of model.nodes) {
    const keys = nodeKeys(config, node, addressKey);
    if (keys.length > 0) out.push({ platformId, kind: 'node', item: node, keys });
  }
  for (const [platformId, variable] of model.variables) {
    out.push({ platformId, kind: 'variable', item: variable, keys: ['value'] });
  }
  for (const [platformId, program] of model.programs) {
    out.push({ platformId, kind: 'program', item: program, keys: ['status', 'run'] });
  }
  return out;
}

export function buildDevices(gladys, config, model, addressKey, created = gladys.devices) {
  const devices = [];
  for (const entry of entries(config, model, addressKey)) {
    const deviceIds = ids(gladys, entry.platformId);
    let name;
    let params;
    let deviceModel;
    if (entry.kind === 'node') {
      name = entry.item.name;
      deviceModel = entry.item.nodeDefId || 'ISY node';
      params = [{ name: 'address', value: entry.item.address }];
    } else if (entry.kind === 'variable') {
      name = word(
        fill(FEATURE_NAMES.variableDevice, entry.item.name, entry.item.type),
        config.language,
      );
      deviceModel = entry.item.type === 1 ? 'Integer variable' : 'State variable';
      params = [{ name: 'variable', value: `${entry.item.type}.${entry.item.id}` }];
    } else {
      name = word(fill(FEATURE_NAMES.programDevice, entry.item.name), config.language);
      deviceModel = 'Program';
      params = [{ name: 'program', value: entry.item.id.toUpperCase() }];
    }
    devices.push({
      name,
      external_id: deviceIds.device,
      model: deviceModel,
      should_poll: false,
      params,
      features: entry.keys.map((key) => ({
        name: featureName(key, config.language),
        external_id: deviceIds.feature(key),
        ...featureOf(key),
      })),
    });
  }
  return keepCreatedFeatures(devices, created);
}

/** Insteon level (0-255) -> Gladys percentage. */
export const percent = (raw) => Math.round((raw * 100) / 255);

/** The level of a node's status in % (uom 100: 0-255; uom 51: %), or undefined. */
export function levelOf(prop) {
  if (!prop || prop.raw === null) return undefined;
  if (prop.uom === '100') return Math.max(0, Math.min(100, percent(prop.raw)));
  if (prop.uom === '51' || prop.uom === '78')
    return Math.max(0, Math.min(100, Math.round(scaled(prop))));
  if (prop.uom === '2') return prop.raw > 0 ? 100 : 0;
  return undefined;
}

/** Every known state: `[{ device_feature_external_id, state }]`. */
export function buildStates(gladys, config, model, addressKey, created = gladys.devices) {
  const states = [];
  const createdKeys = new Map(
    (created ?? []).map((device) => [
      device.external_id,
      (device.features ?? []).map((f) => parseFeatureId(f?.external_id)?.key),
    ]),
  );
  for (const entry of entries(config, model, addressKey)) {
    const deviceIds = ids(gladys, entry.platformId);
    // The keys offered now, and the older ones the user kept.
    const keys = new Set(entry.keys);
    for (const key of createdKeys.get(deviceIds.device) ?? []) if (key) keys.add(key);
    const push = (key, value) => {
      if (!keys.has(key) || value === undefined || value === null || !Number.isFinite(value))
        return;
      states.push({ device_feature_external_id: deviceIds.feature(key), state: value });
    };
    if (entry.kind === 'variable') {
      if (entry.item.raw !== null) push('value', entry.item.raw / 10 ** entry.item.prec);
      continue;
    }
    if (entry.kind === 'program') {
      if (entry.item.status !== undefined) push('status', entry.item.status ? 1 : 0);
      continue;
    }
    const node = entry.item;
    const st = node.props.get('ST');
    const level = levelOf(st);
    if (level !== undefined) {
      const on = level > 0 ? 1 : 0;
      for (const key of ['binary', 'switch', 'light', 'state']) push(key, on);
      push('brightness', level);
      push('level', level);
    }
    if (st?.uom === '11' && st.raw !== null) {
      if (st.raw === 100) push('locked', 1);
      else if (st.raw === 0) push('locked', 0);
    }
    for (const prop of node.props.values()) {
      const how = sensorOf(prop);
      if (!how || prop.raw === null) continue;
      const value = scaled(prop);
      push(sensorKey(prop), how.integer ? Math.round(value) : value);
    }
  }
  return states;
}
