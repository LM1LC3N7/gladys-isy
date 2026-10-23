// IsyApp with the SDK's fake Gladys (createFakeGladys) and a fake controller
// on 127.0.0.1 (test/helpers/fakeIsy.js): the whole chain from the REST API
// and the event stream to the Gladys devices, states, scene events and
// commands, over real sockets.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { IsyApp } from '../src/app.js';
import { registerHandlers } from '../src/handlers.js';
import { memoryStore } from '../src/store.js';
import { FakeIsy, event, quietLogger, settle, until } from './helpers/fakeIsy.js';

const DIMMER = '1A 2B 3C 1';
const BUTTON = '1A 2B 3C 2';
const RELAY = '2B 3C 4D 1';
const LOCK = 'ZW005_1';
const THERMOSTAT = '3C 4D 5E 1';
const SENSOR = 'ZW010_1';

const network = () => [
  {
    address: DIMMER,
    name: 'Kitchen',
    type: '1.32.65.0',
    nodeDefId: 'DimmerLampSwitch',
    props: [{ id: 'ST', value: 128, uom: '100' }],
  },
  {
    address: BUTTON,
    name: 'Keypad B',
    type: '1.32.65.0',
    props: [{ id: 'ST', value: 0, uom: '100' }],
  },
  { address: RELAY, name: 'Porch', type: '2.42.67.0', props: [{ id: 'ST', value: 0, uom: '100' }] },
  {
    address: LOCK,
    name: 'Front door',
    family: '4',
    cat: '111',
    props: [
      { id: 'ST', value: 100, uom: '11' },
      { id: 'BATLVL', value: 80, uom: '51' },
    ],
  },
  {
    address: THERMOSTAT,
    name: 'Hall',
    type: '5.11.16.0',
    props: [
      { id: 'ST', value: 72, uom: '17' },
      { id: 'CLIHUM', value: 45, uom: '22' },
      { id: 'CLISPH', value: 68, uom: '17' },
    ],
  },
  {
    address: SENSOR,
    name: 'Bedroom',
    family: '4',
    cat: '185',
    props: [
      { id: 'ST', value: 215, uom: '4', prec: '1' },
      { id: 'LUMIN', value: 300, uom: '36' },
    ],
  },
];

const programs = () => [
  { id: '0001', name: 'Gladys', folder: true },
  { id: '0002', parent: '0001', name: 'Evening', status: true },
  { id: '0004', name: 'Other folder', folder: true },
  { id: '0003', parent: '0004', name: 'Unlock all' },
];

const TIMINGS = {
  retries: [100, 200, 400, 800, 1_600],
  syncQuiet: 50,
  syncMax: 300,
  readBack: 100,
  persistGap: 0,
};

async function setup(t, { config = {}, store, isy, devices, wait = true } = {}) {
  const server =
    isy ??
    (await new FakeIsy({
      nodes: network(),
      programs: programs(),
      variables: { 1: [{ id: 1, name: 'counter', value: 5 }], 2: [] },
    }).start());
  const gladys = createFakeGladys({
    config: {
      host: '127.0.0.1',
      port: server.port,
      username: 'admin',
      password: 'secret',
      language: 'en',
      ...config,
    },
    devices,
  });
  const logger = quietLogger();
  const memory = store ?? memoryStore();
  const app = new IsyApp({ gladys, logger, store: memory, timings: TIMINGS });
  registerHandlers(gladys, app, logger);
  await gladys.connect();
  t.after(async () => {
    app.stop();
    if (!isy) await server.close();
  });
  const ids = (platformId) => gladys.externalIds('isy', platformId);
  const device = (platformId) =>
    gladys.fake.discoveredDevices.find((d) => d.external_id === ids(platformId).device);
  const ctx = {
    gladys,
    isy: server,
    app,
    logger,
    store: memory,
    ids,
    device,
    keys: (platformId) => device(platformId)?.features.map((f) => f.external_id.split(':').at(-1)),
    state: (platformId, key) => gladys.fake.lastState(ids(platformId).feature(key)),
    status: () => gladys.fake.connectionStatus,
    set: (platformId, key, value) =>
      gladys.fake.setValue(
        { external_id: ids(platformId).device, features: [] },
        { external_id: ids(platformId).feature(key) },
        value,
      ),
  };
  if (wait) {
    await until(() => app.connected && !app.syncing);
    await settle(100);
    await app.chain;
  }
  return ctx;
}

test('the catalogue: controller pinned, nodes, variables and programs of the Gladys folder', async (t) => {
  const ctx = await setup(t, { config: { safe_nodes: `${RELAY}` } });
  assert.equal(ctx.store.data.controller.uuid, '00:21:b9:02:aa:bb');
  assert.equal(ctx.store.data.catalog.nodes.length, 6);
  assert.ok(ctx.store.data.lastCatalogAt > 0 && ctx.store.data.lastRoundAt > 0);
  // A dimmer not declared: a state, a level and two buttons; never a light.
  assert.deepEqual(ctx.keys('n_1a_2b_3c_1'), ['state', 'level', 'turn_on', 'turn_off']);
  const dimmer = ctx.device('n_1a_2b_3c_1');
  assert.deepEqual(
    dimmer.features.map((f) => [f.category, f.type, f.read_only]),
    [
      ['unknown', 'binary', true],
      ['unknown', 'unknown', true],
      ['button', 'push', false],
      ['button', 'push', false],
    ],
  );
  assert.equal(dimmer.name, 'Kitchen');
  // A secondary keypad button: read only.
  assert.deepEqual(ctx.keys('n_1a_2b_3c_2'), ['state', 'level']);
  // The relay declared safe: a switch.
  assert.deepEqual(ctx.keys('n_2b_3c_4d_1'), ['switch']);
  // The lock: read only; its battery.
  assert.deepEqual(ctx.keys('n_zw005_1'), ['locked', 'batlvl_51']);
  // The thermostat: temperature and humidity, never the set point.
  assert.deepEqual(ctx.keys('n_3c_4d_5e_1'), ['st_17', 'clihum_22']);
  const thermostat = ctx.device('n_3c_4d_5e_1');
  assert.deepEqual(
    thermostat.features.map((f) => [f.category, f.unit]),
    [
      ['temperature-sensor', 'fahrenheit'],
      ['humidity-sensor', 'percent'],
    ],
  );
  assert.deepEqual(ctx.keys('n_zw010_1'), ['st_4', 'lumin_36']);
  // Variables and the programs of the "Gladys" folder only.
  assert.deepEqual(ctx.keys('v1_1'), ['value']);
  assert.deepEqual(ctx.keys('p_0002'), ['status', 'run']);
  assert.equal(ctx.device('p_0003'), undefined);
  // States.
  assert.equal(ctx.state('n_1a_2b_3c_1', 'state'), 1);
  assert.equal(ctx.state('n_1a_2b_3c_1', 'level'), 50);
  assert.equal(ctx.state('n_2b_3c_4d_1', 'switch'), 0);
  assert.equal(ctx.state('n_zw005_1', 'locked'), 1);
  assert.equal(ctx.state('n_zw005_1', 'batlvl_51'), 80);
  assert.equal(ctx.state('n_3c_4d_5e_1', 'st_17'), 72);
  assert.equal(ctx.state('n_zw010_1', 'st_4'), 21.5);
  assert.equal(ctx.state('v1_1', 'value'), 5);
  assert.equal(ctx.state('p_0002', 'status'), 1);
  assert.equal(ctx.status().connected, true);
  assert.match(ctx.status().message.en, /Connected to the controller: 8 devices\./);
});

test('events: states follow, control events become scene events (never during the replay)', async (t) => {
  const ctx = await setup(t);
  // The replay at the opening carried no control event: none sent.
  assert.equal(ctx.gladys.fake.sceneEvents.length, 0);
  ctx.isy.push(event('ST', '255', DIMMER, { uom: '100' }));
  ctx.isy.push(event('DON', '255', BUTTON));
  ctx.isy.push(
    event('_1', '6', '', { info: '<var type="1" id="1"><val>9</val><prec>0</prec></var>' }),
  );
  ctx.isy.push(event('_1', '0', '', { info: '<id>2</id><s>31</s>' }));
  ctx.isy.push(event('ST', '0', 'unknown node', { uom: '100' }));
  await until(() => ctx.gladys.fake.sceneEvents.length === 1);
  await settle(50);
  await ctx.app.chain;
  assert.equal(ctx.state('n_1a_2b_3c_1', 'level'), 100);
  assert.equal(ctx.state('v1_1', 'value'), 9);
  assert.equal(ctx.state('p_0002', 'status'), 0);
  assert.deepEqual(ctx.gladys.fake.sceneEvents[0], {
    key: 'isy_control',
    data: { address: BUTTON, control: 'DON', name: 'Keypad B' },
  });
  // A node added on the controller: the catalogue is wanted again (at most every 10 min).
  ctx.isy.push(event('_3', 'ND', 'AA BB CC 1'));
  await settle(50);
  assert.equal(ctx.app.catalogWanted, true);
  assert.equal(ctx.isy.paths('/rest/nodes').length, 1);
});

test('a node declared safe: confirmed by the event of the controller', async (t) => {
  const ctx = await setup(t, { config: { safe_nodes: `${DIMMER}, ${RELAY}: light` } });
  assert.deepEqual(ctx.keys('n_1a_2b_3c_1'), ['binary', 'brightness']);
  assert.deepEqual(ctx.keys('n_2b_3c_4d_1'), ['light']);
  const ack = await ctx.set('n_1a_2b_3c_1', 'brightness', 20);
  assert.equal(ack.success, true, ack.error);
  assert.ok(ctx.isy.requests.includes('/rest/nodes/1A%202B%203C%201/cmd/DON/51'));
  const off = await ctx.set('n_2b_3c_4d_1', 'light', 0);
  assert.equal(off.success, true, off.error);
  assert.ok(ctx.isy.requests.includes('/rest/nodes/2B%203C%204D%201/cmd/DOF'));
  // Strict values: null and '' are not 0.
  const bad = await ctx.set('n_2b_3c_4d_1', 'light', '');
  assert.equal(bad.success, false);
  assert.match(bad.error, /Invalid value/);
});

test('without an event: confirmed by a read of the node, else "sent, without confirmation"', async (t) => {
  const ctx = await setup(t, { config: { safe_nodes: DIMMER } });
  ctx.isy.silent = true;
  const ack = await ctx.set('n_1a_2b_3c_1', 'binary', 0);
  assert.equal(ack.success, true, ack.error);
  assert.ok(ctx.isy.paths('/rest/status/').length >= 1);
  // The controller takes the command but the node keeps its level.
  ctx.isy.silent = true;
  const realHandle = ctx.isy.handle.bind(ctx.isy);
  ctx.isy.handle = (req, res) => {
    if (req.url.includes('/cmd/')) {
      ctx.isy.requests.push(req.url);
      res.writeHead(200, { 'content-type': 'text/xml' });
      res.end('<RestResponse succeeded="true"><status>200</status></RestResponse>');
      return;
    }
    realHandle(req, res);
  };
  const ack2 = await ctx.set('n_1a_2b_3c_1', 'brightness', 80);
  assert.equal(ack2.success, false);
  assert.match(ack2.error, /sent, without confirmation/);
  // A busy controller: it did not take it.
  ctx.isy.handle = realHandle;
  ctx.isy.refuseCommands = true;
  const ack3 = await ctx.set('n_1a_2b_3c_1', 'binary', 1);
  assert.equal(ack3.success, false);
  assert.match(ack3.error, /did not accept the command \(HTTP 503\)/);
});

test('buttons and programs are off by default: nothing is sent', async (t) => {
  const ctx = await setup(t);
  const before = ctx.isy.requests.length;
  const on = await ctx.set('n_1a_2b_3c_1', 'turn_on', 1);
  assert.equal(on.success, false);
  assert.match(on.error, /disabled in the configuration/);
  const run = await ctx.set('p_0002', 'run', 1);
  assert.equal(run.success, false);
  assert.match(run.error, /disabled in the configuration/);
  const lock = await ctx.set('n_zw005_1', 'locked', 0);
  assert.equal(lock.success, false);
  assert.match(lock.error, /read only/);
  const light = await ctx.set('n_1a_2b_3c_1', 'binary', 1);
  assert.equal(light.success, false);
  assert.match(light.error, /not declared safe/);
  assert.equal(ctx.isy.requests.length, before);
});

test('buttons and programs once allowed', async (t) => {
  const ctx = await setup(t, { config: { allow_output_buttons: true, allow_programs: true } });
  const on = await ctx.set('n_2b_3c_4d_1', 'turn_on', 1);
  assert.equal(on.success, true, on.error);
  assert.ok(ctx.isy.requests.includes('/rest/nodes/2B%203C%204D%201/cmd/DON'));
  const run = await ctx.set('p_0002', 'run', 1);
  assert.equal(run.success, true, run.error);
  assert.ok(ctx.isy.requests.includes('/rest/programs/0002/run'));
  // The option withdrawn: refused at once, even before a restart.
  await ctx.gladys.fake.configUpdated({ ...ctx.gladys.fake.config, allow_programs: false });
  const again = await ctx.set('p_0002', 'run', 1);
  assert.equal(again.success, false);
  assert.equal(ctx.isy.paths('/rest/programs/0002/run').length, 1);
});

test('a refused password stops for good; a restart sends nothing; a new password is tried', async (t) => {
  const isy = await new FakeIsy({ nodes: network(), password: 'right' }).start();
  t.after(() => isy.close());
  const store = memoryStore();
  const first = await setup(t, { isy, store, wait: false });
  await until(() => store.data?.stop);
  assert.equal(first.status().connected, false);
  assert.match(first.status().message.en, /refused the user name or the password/);
  assert.doesNotMatch(JSON.stringify(store.data), /secret/);
  const requests = isy.requests.length;
  first.app.stop();
  // Restart with the same pair: no request.
  const second = await setup(t, { isy, store, wait: false });
  await settle(200);
  assert.equal(isy.requests.length, requests);
  assert.match(second.status().message.en, /refused/);
  // A new password: tried at once, the stop erased by the success.
  await second.gladys.fake.configUpdated({ ...second.gladys.fake.config, password: 'right' });
  await until(() => second.app.connected);
  await until(() => store.data.stop === null);
});

test('a restart never reads sooner than the interval; another controller stops everything', async (t) => {
  const isy = await new FakeIsy({ nodes: network() }).start();
  t.after(() => isy.close());
  const store = memoryStore();
  const first = await setup(t, { isy, store });
  first.app.stop();
  assert.equal(isy.paths('/rest/nodes').length, 1);
  assert.equal(isy.paths('/rest/status').length, 1);
  const second = await setup(t, { isy, store });
  assert.equal(isy.paths('/rest/nodes').length, 1, 'the catalogue comes from /data');
  assert.equal(isy.paths('/rest/status').length, 1, 'the round is not due');
  assert.deepEqual(second.keys('n_1a_2b_3c_1'), ['state', 'level', 'turn_on', 'turn_off']);
  second.app.stop();
  // Another controller at the same address.
  isy.uuid = '00:21:b9:02:cc:dd';
  const third = await setup(t, { isy, store, wait: false });
  await until(() => /Another controller/.test(third.status()?.message?.en ?? ''));
  assert.equal(third.status().connected, false);
  assert.equal(isy.paths('WS').length, 2, 'no event stream with another controller');
  const ack = await third.set('n_1a_2b_3c_1', 'turn_on', 1);
  assert.equal(ack.success, false);
});

test('a lost event stream reconnects after a pause; Gladys reconnection resends everything', async (t) => {
  const ctx = await setup(t);
  ctx.isy.dropStreams();
  await until(() => !ctx.app.connected);
  await until(() => ctx.app.connected, 3_000);
  assert.equal(ctx.isy.paths('WS').length, 2);
  const published = ctx.gladys.fake.discoveredDevices.length;
  await ctx.app.onConnected(ctx.gladys.fake.config);
  assert.equal(ctx.gladys.fake.discoveredDevices.length, published);
  assert.equal(ctx.status().connected, true);
  assert.equal(ctx.isy.paths('/rest/nodes').length, 1);
});

test('"Test the connection" reads no node', async (t) => {
  const ctx = await setup(t);
  const before = ctx.isy.requests.length;
  const ack = await ctx.gladys.fake.action('test_connection');
  assert.equal(ack.success, true, ack.error);
  assert.match(JSON.stringify(ack.data), /00:21:b9:02:aa:bb/);
  assert.equal(ctx.isy.requests.length, before);
});
