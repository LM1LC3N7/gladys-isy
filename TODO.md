# TODO - ISY / IoX v1

Handoff document: what is done, what was decided, what comes next. Keep it
up to date at the end of every milestone.

## Working method

- One milestone at a time, one commit per milestone, tests green before moving on.
- After each milestone: `npm run format:check`, `npm run lint`, `npm test`
  (Node 22 and 24), `npm run audit`, `npx github:GladysAssistant/integration-store .`,
  then update README, `docs/fr.md`, `docs/en.md`, `CHANGELOG.md` and this file.
- No forum topic of its own, no forum post from a module session (lot 14,
  thread /t/10385); the main session posts one recap per wave.
- The `gladys-assistant-integration` topic is added at the first real release only.

## Status

- [x] **Milestone 1 - core** (2026-10-23): REST API and event stream of the
      controller ported from PyISY 3.8.0 (own XML reader and WebSocket
      client, bounded); identity pinned; catalogue of nodes, variables and
      programs of the "Gladys" folder kept in `/data`; Insteon dimmers and
      relays (lights / switches when declared safe, read-only state and
      opt-in buttons otherwise); locks, thermostats, I/O Linc and other nodes
      read only with their sensors; variables read only; program "Run"
      buttons (opt-in); control events as a scene trigger; status rounds;
      "Test the connection"; fr/en. Tested against a fake controller on
      127.0.0.1 only.
- [ ] **Milestone 2 - real controller**: run against an eisy (IoX 5.x) and an
      ISY994 (firmware 5.3); capture real answers and events (anonymised) as
      fixtures; fix what differs (see below).
- [ ] **Milestone 3 - more**: HTTPS (certificate pinned at the first
      connection, password only on the verified connection, a changed
      certificate never learnt again blindly, tested with a real local TLS
      server); Z-Wave dimmers and switches (uom 51/78, declared safe); the
      scenes (groups) of the controller as buttons; thermostats (set points
      behind an option, bounded, read back before, "off" never blocked);
      locks ("Lock" never blocked, "Unlock" behind an option, decided on the
      state read just before); I/O Linc relay (garage door: opt-in, guard
      persisted); variables written (option); energy totals (kWh) through
      the approved guard of gladys-p1-monitor; node servers.
- [ ] **Milestone 4 - first release**: Docker image check, Release workflow,
      topic, GHCR package public.

## To check on a real controller

- The answer of `/rest/programs/<id>` without `subfolders` (PyISY always
  adds `subfolders=true`): the program itself with its `parentId`; for a
  folder, the folder first, then its children. Only the element of the id
  asked is used. A 404 for a deleted program.
- That the event stream needs no subscription message (PyISY sends none) and
  that it replays every status at the opening; the size of that replay on a
  large network (the publisher spreads it under 300 states a minute).
- The interval of the heartbeat `_0` (its action, in seconds).
- The answer of `/rest/status/<address>` (`<properties>` or `<nodeInfo>`).
- Whether the controller sends an `ST` event after a command when the level
  does not change (a node already on): otherwise the read of the node
  confirms.
- That `DON` without a value turns a dimmer on at its on-level, and the
  quantization of a level (the confirmation compares the percentage).
- Whether a control event (`DON`, `DOF`...) is also sent for commands of the
  controller, and not only for presses.
- The time an ISY994 takes to answer a command (spurious 404 when the
  Insteon network is busy, seen by PyISY: reported "not accepted").
- The UUID format of an eisy and a Polisy in `/rest/config`.

## Decisions

- **HTTP only in this version**: eisy and Polisy answer on 8080, an ISY994
  on 80. An `https://` address is refused with a clear status, never
  downgraded: HTTPS needs a pinned certificate (lot 11 and 12 rules), planned
  for milestone 3. The password travels in clear: said in the manifest and
  the docs.
- **Own client, no dependency**: PyISY (Apache-2.0, `LICENSE.txt`, version
  3.8.0) is ported and credited in `THIRD_PARTY_NOTICES.md` (copied into the
  image with `LICENSE`). Runtime dependency: the SDK only.
- **Version 0.1.0, set by hand once**: `package.json`, `package-lock.json`,
  the manifest `version` and the `docker_image` tag
  (`ghcr.io/lm1lc3n7/gladys-isy:0.1.0`) set together in milestone 1, before
  any release; the first patch release gives 0.1.1. The manifest test checks
  the semver form and that the four agree, never a fixed value.
- **HTTP**: `node:http`, an agent without keep-alive (one connection per
  request: PyISY saw an ISY994 answer the next request of a kept-alive
  socket with the body of a previous 404), no `createConnection`; answers
  bounded per request (64 KB for the configuration, 4 MB for the nodes, 2 MB
  for the statuses, 1 MB for the programs, 512 KB for the variables, 16 KB
  for a command) and in time (the whole request); redirections not
  followed. The request is written only after the connection is made and
  `beforeSend` said yes; `sent` is false before that.
- **XML**: own reader, one forward pass with `indexOf`, an explicit stack
  (64 levels), 200 000 elements at most, text bounded per element, the five
  entities and numeric references only (no DOCTYPE entity is ever defined),
  attributes in objects without prototype.
- **Event stream**: `ws://<host>:<port>/rest/subscribe` with the
  subprotocol `ISYSUB` and the origin `com.universal-devices.websockets.isy`
  (the values of the Universal Devices WebSocket documentation, sent by
  PyISY: a protocol requirement, not the imitation of an application; no
  User-Agent is set). Own RFC 6455 client (the one of gladys-system-bridge):
  64 KB per message, fragments bounded, masked server frames refused,
  linear copy. A heartbeat missed (the interval announced + 15 s) closes the
  stream. The replay of every status at the opening updates the states but
  never fires a scene event (quiet window of 1 s, 10 s at most, as PyISY).
- **Identity**: the root id of `/rest/config` (its UUID), pinned in `/data`
  with the place `host:port`, or typed in `controller_id`. Read at each
  connection (a failure there is a failure of the connection), at each
  status round and every 10 minutes (unreadable then: kept, read again a
  minute later; never taken for another controller). The identity is reset
  to "unknown" at every connection and every loss of the stream: no command
  leaves before `/rest/config` was read again in the current connection, and
  the stream must be open (review 1, I-2). Another identifier: the stream is
  closed, no node read, no command sent, the status shows both and says to
  type the new one; the identity alone is read again every 5 minutes (the
  time persisted, a restart waits for it) and at each "Test the connection"
  (review 1, I-3): this sends the credentials to the device present, said in
  the docs and the manifest.
- **Catalogue**: `/rest/nodes?members=false` (the folders and the scenes are
  not nodes), the programs whose parent folder is named `Gladys`
  (case-insensitive, the whole name, direct children only), the integer and
  state variables (a 404 means none). Read at the first session of a place,
  then on "Scan" or on a `_3` node change event, at most every 10 minutes
  (its start written in `/data` before it starts). Kept in `/data` (1000
  nodes, 24 properties each, 200 variables, 100 programs at most); another
  place empties it. The programs or variables that fail to read keep their
  previous list; the nodes are required.
- **Ids**: `n_` + the address in lower case with each run of other
  characters than `a-z0-9` made one `_` (`1A 2B 3C 1` -> `n_1a_2b_3c_1`,
  `ZW002_1` -> `n_zw002_1`); a second address giving the same id is left out
  and listed in the status. `v1_<id>` / `v2_<id>` for the variables,
  `p_<id>` (4 hex digits) for the programs. Feature keys: `binary`,
  `brightness`, `switch`, `light`, `state`, `level`, `locked`, `turn_on`,
  `turn_off`, `value`, `run`, `status`, and `<property>_<uom>` for the
  sensors (`st_4`, `clitemp_17`, `clihum_22`, `batlvl_51`, `lumin_36`,
  `cpw_73`, `cv_72`, `cc_1`): the unit of a sensor is fixed with its key.
- **Kinds** (PyISY's lists): Insteon (no family or family 1) type `1.x`
  first sub-node with a 0-255 status = dimmer; `2.x` first sub-node =
  relay; `15.x` / `4.64` (or Z-Wave category 111, or a status in the
  deadbolt unit 11) = lock; Insteon thermostat types (`4.8`, `5.3`,
  `5.10`-`5.21`) or Z-Wave category 140 = thermostat; `7.x` = I/O Linc;
  anything else = other. The set points of a thermostat are never shown (a
  set point read as a temperature would mislead).
- **Declared safe** (Louis's rule, as gladys-qbus and gladys-insteon): an
  Insteon dimmer is `light/binary` + `light/brightness`, a relay
  `switch/binary` (`light/binary` with `: light`), only when its address is
  in `safe_nodes`; otherwise `unknown/binary` (`state`), `unknown/unknown`
  0-100 (`level`) and `button/push` `turn_on` / `turn_off`, refused unless
  `allow_output_buttons` (off). A feature created before the list changed is
  kept (never a lost feature) and still gets its state; a command on it is
  refused when not declared safe any more.
- **Not commanded in v1**: locks, thermostats, I/O Linc (garage doors),
  Z-Wave nodes, scenes, variables, node servers. "Turn off" of an unknown
  load is not a protective command (a freezer, a pump): it stays behind the
  option, like "Turn on".
- **Programs**: `run` (the controller evaluates the If) for the programs of
  the `Gladys` folder only, behind `allow_programs` (off). Before each run,
  in the budget of the command, the program alone (`/rest/programs/<id>`)
  then its parent folder are read fresh (review 2, m-2: not the whole list,
  up to 1 MB on a slow ISY994; 256 KB at most each): the program must
  still be a direct child of a folder named `Gladys`, under the same name
  (an id reused after a deletion is refused); the option is checked again
  right before the request (review 1, I-1). Each status round replaces the
  list (a program removed disappears from Gladys and from `/data`; one added
  appears). Confirmed by `succeeded="true"` of the controller, which runs the
  program itself (there is no value to read back). `status` is the result of
  the last condition: `s` 21 = true, 31 = false; any other value is ignored
  (PyISY sets false then; ignoring is more careful).
- **Commands**: one turn per node, which ends when the request is written
  (the confirmation is awaited outside it); the deadline (3.5 s after the
  request), the gate (declared safe / option), the identity and the session
  are checked once the connection is made, right before the request is
  written. Confirmed by an `ST` event received after the request whose level
  equals the one asked (off: 0; on: above 0; brightness: the same
  percentage), before 3.8 s; else by one read of the node
  (`/rest/status/<address>`) before 4.6 s; else "sent, without
  confirmation" and a read back 2 s later. A 404 after the request is
  "sent, without confirmation" with a read back (an ISY994 answers spurious
  404 when its Insteon network is busy). Another HTTP error answer (401,
  503...) or `succeeded="false"`: "the controller did not accept the
  command" (a 401 on a command never stops the reads). Values strict
  (`null`, `''` are not 0; a button takes 1 only). Commands use their own
  connection: never behind a background read.
- **Ack independent of the publication**: a command resolves on the answer
  of the controller and its event or read, never on `publishStates`.
- **States**: from the event stream as it comes, and from the status round
  every `poll_interval` minutes (2 to 60, 10 by default): identity, then
  `/rest/status`, the variables and the programs. The start of the round is
  written in `/data` before it starts: restart, Gladys reconnection, test
  button and configuration saves never read sooner. A secondary part that
  fails (variables, programs) never stops the rest. A failed background read
  waits like a round before the next one.
- **Units**: only those the core lists for the category: temperature
  `celsius` (uom 4), `fahrenheit` (17), `kelvin` (26); humidity `percent`
  (22, or 51 for `CLIHUM`); light `lux` (36); power `watt` (73), voltage
  `volt` (72), current `ampere` (1); battery `percent` (`BATLVL` uom 51).
  Other units are not shown. No energy index in this version.
- **Control events**: the trigger `isy_control` with `address` (as the
  controller writes it), `control` (`DON`, `DOF`, `DFON`, `DFOF`, `FDUP`,
  `FDDOWN`, `FDSTOP`, `BRT`, `DIM`) and the variable `name`, for the known
  nodes only; never during the replay of the opening. 120 events a minute,
  refused at the entry beyond. No `undefined` nor `NaN` in the data (made
  `null`).
- **Password refused** (401 or 403 on a read or on the stream): final; the
  stop is persisted in `/data/isy-state.json` with a salted SHA-256 of the
  refused user name and password (never of a pair the controller accepted),
  erased at the first success. Same pair after a restart: no request. New
  pair: tried at once. "Test the connection" tries once and erases the stop
  only on success.
- **Other failures**: 10 s, 30 s, 1 min, 2 min, then 5 min; the next try and
  the count persisted (at most once a minute unless the pause is a minute or
  more); a restart waits for it. The count and the pause are erased only
  once the stream has stayed open 60 s: a stream that opens then drops at
  once keeps its pace, and `/data` is written at most once a minute
  (review 1, I-4). The 60 s timer belongs to the stream that set it: it is
  cancelled when that stream drops, and counts only if that very stream is
  still the open one (review 2, m-1). The test button refuses during a pause (shows the
  status), except after "another controller".
- **Event stream bytes** (review 1, B-1): the bytes that come with the 101
  answer are parsed first, then what the socket received meanwhile, in
  order (4 MB at most before the first turn). Tested with bursts of 20 000
  frames, in one write and in one write each; the fake controller replays
  600 frames at each opening. gladys-system-bridge parses `head`
  synchronously in its constructor, so it does not have this reordering.
- **Declared safe addresses**: compared without leading zeros (`09.7E.1C`
  = `9 7E 1C 1`, as the controller writes it); a declared address that
  matches no node is listed in the status. An address with credentials
  (`user:pw@host`) gets its own message.
- **Late answers**: every await of the session code is followed by a check
  of the session number; a late answer of an old session publishes nothing
  and sets no status. A background read of an old connection is refused.
- **Gladys reconnection**: the status, the Discovery, the states and the
  transports are sent again; the session, the stop and the pause are kept.
- **Not checked**: Docker is not installed on this PC, so no image build and
  no end-to-end test in a container; never run against a real controller.
  The store validator could not be run from the development agent.
