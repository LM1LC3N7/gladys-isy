# Third-party notices

This integration is licensed under the Apache License 2.0 (see `LICENSE`). It
contains logic ported to JavaScript from the projects below. The ported code
was rewritten, not copied; the changes are described below.

## PyISY

<https://github.com/automicus/PyISY> (package `pyisy`, version 3.8.0, tag
`v3.8.0`, commit `a385680` of 2026-10-14), by Automicus (Ryan Kraus) and its
contributors (shbatm and others), the library of the Home Assistant
"Universal Devices ISY/IoX" integration.

Its licence file `LICENSE.txt` is the **Apache License, Version 2.0**, the
same licence as this integration (full text in `LICENSE`). Its notice, as
written in `LICENSE.txt`:

```
   Copyright 2014 Automicus

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
```

PyISY has no `NOTICE` file.

What was ported:

- the REST paths of the controller (`connection.py`, `constants.py`):
  `/rest/config`, `/rest/nodes?members=false`, `/rest/status`,
  `/rest/programs?subfolders=true`, `/rest/vars/definitions/<type>`,
  `/rest/vars/get/<type>`, `/rest/nodes/<address>/cmd/DON|DOF[/<value>]`,
  `/rest/programs/<id>/run`; the basic authentication in latin-1;
- the reading of the configuration (`configuration.py`: the identifier is
  the root id), of the nodes and their properties (`nodes/__init__.py`,
  `helpers.py` `parse_xml_properties`), of the programs
  (`programs/__init__.py`) and of the variables (`variables/__init__.py`);
- the event stream (`events/websocket.py`): `/rest/subscribe`, the
  subprotocol `ISYSUB` and the origin header, the routing of the events by
  `control` (`_0` heartbeat, `ST` status, other properties, control events,
  `_1` variables and programs, `_3` node changes), the heartbeat watchdog,
  and the quiet window after the opening (no scene event during the replay
  of every status);
- the lists that tell a node's kind (`constants.py`): Insteon types of
  dimmers, locks and thermostats, Z-Wave categories of locks and
  thermostats, the units of measure used, the control events.

Changes: written in JavaScript for Node.js, without aiohttp nor asyncio; own
bounded XML reader and WebSocket client; one connection per request; HTTP
only (no TLS yet); commands sent only before a deadline, gated by options,
and confirmed by the status of the node; Z-Wave configuration, node
servers, scenes (groups), climate and lock commands, variable writes and
networking resources not ported.

## Code of LM1LC3N7's other integrations

`src/publisher.js` comes from <https://github.com/LM1LC3N7/gladys-velbus> and
the WebSocket client of `src/isy/websocket.js` from
<https://github.com/LM1LC3N7/gladys-system-bridge> (Apache License 2.0, same
author as this integration).
