// The parsers of the controller's answers and events, the XML reader and its
// bounds, the configuration, the classification of the nodes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addressKey, normalizeConfig, parseHost, parseSafeNodes } from '../src/config.js';
import { CONTROL_EVENTS, LIMITS } from '../src/constants.js';
import { kindOf, nodePlatformId, parseFeatureId } from '../src/devices.js';
import {
  parseConfig,
  parseEvent,
  parseNodes,
  parsePrograms,
  parseVariableNames,
  parseVariables,
  succeeded,
} from '../src/isy/parse.js';
import { XmlError, parseXml } from '../src/isy/xml.js';
import { basicAuth } from '../src/isy/http.js';

test('the XML reader: entities, attributes without prototype, bounds', () => {
  const doc = parseXml(
    '<?xml version="1.0"?><!-- c --><a __proto__="x" b=\'1 &amp; 2\'><c>x &lt;y&gt; &#233;&#x41;</c><d/></a>',
  );
  assert.equal(doc.name, 'a');
  assert.equal(Object.getPrototypeOf(doc.attrs), null);
  assert.equal(doc.attrs.__proto__, 'x');
  assert.equal(doc.attrs.b, '1 & 2');
  assert.equal(doc.children[0].text, 'x <y> éA');
  assert.equal({}.x, undefined);
  assert.throws(() => parseXml('<a><b></a>'), XmlError);
  assert.throws(() => parseXml('<a>'), XmlError);
  assert.throws(() => parseXml('<a/><b/>'), XmlError);
  assert.throws(() => parseXml(`${'<a>'.repeat(LIMITS.xmlDepth + 2)}`), XmlError);
  // Linear: a large flat document is read quickly.
  const many = `<r>${'<e id="1"/>'.repeat(100_000)}</r>`;
  const started = Date.now();
  assert.equal(parseXml(many).children.length, 100_000);
  assert.ok(Date.now() - started < 2_000);
  assert.throws(() => parseXml(`<r>${'<e/>'.repeat(LIMITS.xmlElements + 1)}</r>`), XmlError);
});

test('configuration, nodes, programs, variables', () => {
  const config = parseConfig(
    '<configuration><app_full_version>5.3.4</app_full_version><root><id>00:21:B9:02:12:34</id><name>ISY</name></root><product><desc>ISY 994i</desc></product></configuration>',
  );
  assert.deepEqual(config, {
    uuid: '00:21:b9:02:12:34',
    name: 'ISY',
    model: 'ISY 994i',
    firmware: '5.3.4',
  });
  assert.equal(
    parseConfig('<configuration><root><id></id></root></configuration>').uuid,
    undefined,
  );
  const nodes = parseNodes(
    '<nodes><root>N</root><folder><address>1</address></folder><group><address>2</address></group>' +
      '<node nodeDefId="DimmerLampSwitch"><address>1A 2B 3C 1</address><name>Kitchen\u0007 lamp</name><type>1.32.65.0</type>' +
      '<property id="ST" value="255" uom="100"/><property id="OL" value="" uom="100"/><property id="bad id" value="1" uom="2"/></node>' +
      '<node><address>1A 2B 3C 1</address><name>dup</name></node></nodes>',
  );
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].name, 'Kitchen lamp');
  assert.deepEqual(nodes[0].props, [
    { id: 'ST', raw: 255, uom: '100', prec: 0 },
    { id: 'OL', raw: null, uom: '100', prec: 0 },
  ]);
  const programs = parsePrograms(
    '<programs><program id="0001" folder="true"><name>gladys</name></program>' +
      '<program id="002A" parentId="0001" status="true" folder="false"><name>Night</name></program>' +
      '<program id="0003" parentId="0004" folder="false"><name>Other</name></program></programs>',
    'gladys',
  );
  assert.deepEqual(programs, [{ id: '002a', name: 'Night', status: true }]);
  assert.deepEqual(
    [...parseVariableNames('<CList><e id="3" name="Away"/></CList>')],
    [[3, 'Away']],
  );
  assert.deepEqual(parseVariableNames(''), new Map());
  assert.deepEqual(
    parseVariables('<vars><var type="2" id="3"><val>15</val><prec>1</prec></var></vars>'),
    [{ type: 2, id: 3, raw: 15, prec: 1 }],
  );
  assert.equal(
    succeeded('<RestResponse succeeded="true"><status>200</status></RestResponse>'),
    true,
  );
  assert.equal(succeeded('<RestResponse succeeded="false"/>'), false);
  assert.equal(succeeded('not xml'), false);
});

test('events of the stream', () => {
  const ev = (control, action, node = '', info = '', attrs = '') =>
    `<Event seqnum="1" sid="uuid:1"><control>${control}</control><action${attrs}>${action}</action><node>${node}</node><eventInfo>${info}</eventInfo></Event>`;
  assert.deepEqual(parseEvent(ev('_0', '120'), CONTROL_EVENTS), {
    kind: 'heartbeat',
    seconds: 120,
  });
  assert.deepEqual(
    parseEvent(ev('ST', '255', '1A 2B 3C 1', '', ' uom="100" prec="0"'), CONTROL_EVENTS),
    {
      kind: 'property',
      address: '1A 2B 3C 1',
      prop: { id: 'ST', raw: 255, uom: '100', prec: 0 },
    },
  );
  assert.deepEqual(parseEvent(ev('DFON', '0', '1A 2B 3C 3'), CONTROL_EVENTS), {
    kind: 'control',
    address: '1A 2B 3C 3',
    control: 'DFON',
  });
  assert.deepEqual(
    parseEvent(ev('_1', '6', '', '<var type="1" id="4"><val>7</val></var>'), CONTROL_EVENTS),
    { kind: 'variable', type: 1, id: 4, raw: 7, prec: 0 },
  );
  assert.equal(
    parseEvent(ev('_1', '7', '', '<var type="1" id="4"><init>7</init></var>'), CONTROL_EVENTS),
    undefined,
  );
  assert.deepEqual(parseEvent(ev('_1', '0', '', '<id>1A</id><s>21</s>'), CONTROL_EVENTS), {
    kind: 'program',
    id: '001a',
    status: true,
  });
  assert.deepEqual(parseEvent(ev('_3', 'NN', '1A 2B 3C 1'), CONTROL_EVENTS), { kind: 'catalog' });
  assert.equal(parseEvent('<Event><control>ST', CONTROL_EVENTS), undefined);
  assert.equal(parseEvent(ev('ST', '1', '<bad>'), CONTROL_EVENTS), undefined);
});

test('configuration: host, safe nodes, identifier', () => {
  assert.deepEqual(parseHost('http://192.168.1.9:80/desc'), { host: '192.168.1.9', port: 80 });
  assert.equal(parseHost('https://eisy.local').https, true);
  assert.equal(parseHost('admin:pw@eisy').host, '');
  assert.equal(addressKey('1a.2b.3c'), '1A 2B 3C 1');
  assert.equal(addressKey(' zw002_1 '), 'ZW002_1');
  const { safe, errors } = parseSafeNodes('1A 2B 3C 1, 4d 5e 6f: light; ZW002_1 light\n<x>');
  assert.deepEqual(
    [...safe],
    [
      ['1A 2B 3C 1', 'switch'],
      ['4D 5E 6F 1', 'light'],
      ['ZW002_1', 'light'],
    ],
  );
  assert.deepEqual(errors, ['<x>']);
  const config = normalizeConfig({ host: 'eisy:8443', controller_id: 'bad id!', poll_interval: 0 });
  assert.equal(config.port, 8443);
  assert.equal(config.controllerIdInvalid, true);
  assert.equal(config.interval, 2 * 60_000);
  assert.equal(config.allowButtons, false);
  assert.equal(config.allowPrograms, false);
  assert.equal(normalizeConfig({ host: 'https://eisy' }).https, true);
});

test('ids and kinds', () => {
  assert.equal(nodePlatformId('1A 2B 3C 1'), 'n_1a_2b_3c_1');
  assert.equal(nodePlatformId('n003_temp.1'), 'n_n003_temp_1');
  assert.equal(nodePlatformId('...'), undefined);
  assert.deepEqual(parseFeatureId('ext:x:isy:n_1a_2b_3c_1:brightness'), {
    platformId: 'n_1a_2b_3c_1',
    key: 'brightness',
  });
  assert.deepEqual(parseFeatureId('ext:x:isy:p_002a:run'), { platformId: 'p_002a', key: 'run' });
  assert.equal(parseFeatureId('ext:x:isy:p_zz:run'), undefined);
  const node = (address, type, uom, extra = {}) => ({
    address,
    type,
    family: '',
    zwaveCategory: '',
    props: new Map([['ST', { id: 'ST', raw: 0, uom, prec: 0 }]]),
    ...extra,
  });
  assert.equal(kindOf(node('1A 2B 3C 1', '1.32.65.0', '100')), 'dimmer');
  assert.equal(kindOf(node('1A 2B 3C 2', '1.32.65.0', '100')), 'other');
  assert.equal(kindOf(node('1A 2B 3C 1', '2.42.67.0', '100')), 'relay');
  assert.equal(kindOf(node('1A 2B 3C 1', '7.0.65.0', '100')), 'iolinc');
  assert.equal(kindOf(node('1A 2B 3C 1', '15.1.0.0', '100')), 'lock');
  assert.equal(kindOf(node('1A 2B 3C 1', '5.11.16.0', '17')), 'thermostat');
  // A Z-Wave dimmer is not commanded in this version.
  assert.equal(
    kindOf(node('ZW002_1', '4.16.1.0', '51', { family: '4', zwaveCategory: '109' })),
    'other',
  );
});

test('basic authentication: latin-1 when it fits, as pyisy', () => {
  assert.equal(
    basicAuth('admin', 'pässword'),
    `Basic ${Buffer.from('admin:pässword', 'latin1').toString('base64')}`,
  );
  assert.equal(
    basicAuth('admin', 'pw€'),
    `Basic ${Buffer.from('admin:pw€', 'utf8').toString('base64')}`,
  );
});
