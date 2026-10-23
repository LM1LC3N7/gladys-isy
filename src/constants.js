// -----------------------------------------------------------------------------
// Keys shared with the manifest, timings and limits.
// -----------------------------------------------------------------------------

/** IoX on an eisy or a Polisy answers on 8080 (HTTP); an ISY994 on 80. */
export const DEFAULT_PORT = 8080;

export const ACTIONS = {
  TEST_CONNECTION: 'test_connection',
};

export const SCENE_TRIGGERS = {
  CONTROL: 'isy_control',
};

/**
 * The control events of a node that become the scene trigger (a paddle, a
 * keypad button, a remote pressed): pyisy's COMMAND_FRIENDLY_NAME.
 */
export const CONTROL_EVENTS = [
  'DON',
  'DOF',
  'DFON',
  'DFOF',
  'FDUP',
  'FDDOWN',
  'FDSTOP',
  'BRT',
  'DIM',
];

/** The name of the program folder whose programs get a "Run" button. */
export const PROGRAM_FOLDER = 'gladys';

export const TIMINGS = {
  /** Bound of one HTTP request (the whole request); the catalogue may be large. */
  httpTimeout: 15_000,
  catalogTimeout: 60_000,
  /** The WebSocket upgrade. */
  wsTimeout: 10_000,
  /** Without a heartbeat announced: the controller's default (pyisy: 30 s). */
  heartbeat: 30_000,
  /** Grace after the announced heartbeat before the socket is taken for dead. */
  heartbeatGrace: 15_000,
  /** The replay of every status after the socket opens: quiet window and cap (pyisy). */
  syncQuiet: 1_000,
  syncMax: 10_000,
  /** A command is sent within this time of the request, or not at all. */
  sendBy: 3_500,
  /** ... confirmed by the event of the controller within this one... */
  eventBy: 3_800,
  /** ... or by a read of the node finished within this one (Gladys waits 5 s). */
  answerBy: 4_600,
  /** Read back of a command left without confirmation. */
  readBack: 2_000,
  /** Reconnections: 10 s, 30 s, 1 min, 2 min, then 5 min. */
  retries: [10_000, 30_000, 60_000, 120_000, 300_000],
  /** The identity of the controller is read again this often. */
  identity: 10 * 60_000,
  /** The catalogue (nodes, programs, variables) is read again at most this often. */
  catalogGap: 10 * 60_000,
  /** Time stamps in /data are written at most this often. */
  persistGap: 60_000,
  /** Unchanged states are sent again this often (offset per feature). */
  stateHeartbeat: 30 * 60_000,
  heartbeatSpread: 5 * 60_000,
  /** Wait of "Test the connection". */
  testWait: 20_000,
};

export const LIMITS = {
  statesPerMinute: 300,
  eventsPerMinute: 120,
  /** Bytes of an answer of the controller. */
  configBytes: 64 * 1024,
  nodesBytes: 4 * 1024 * 1024,
  statusBytes: 2 * 1024 * 1024,
  programsBytes: 1024 * 1024,
  variablesBytes: 512 * 1024,
  commandBytes: 16 * 1024,
  /** One WebSocket message. */
  eventBytes: 64 * 1024,
  /** XML: elements of one document, nesting. */
  xmlElements: 200_000,
  xmlDepth: 64,
  /** What is kept. */
  maxNodes: 1_000,
  maxProperties: 24,
  maxVariables: 200,
  maxPrograms: 100,
  /** Entries of the "declared safe" list. */
  maxSafe: 500,
  /** Status rounds, minutes. */
  minInterval: 2,
  maxInterval: 60,
};
