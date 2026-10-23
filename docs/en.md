# ISY / IoX (Universal Devices) for Gladys Assistant

This integration connects Gladys to a **Universal Devices controller** on
your local network: an **ISY994**, or **IoX** on an **eisy** or a
**Polisy**. It reads the Insteon and Z-Wave nodes of the controller, its
variables and some of its programs, follows their changes live, and drives
the Insteon lights and switches you declare safe.

> Unofficial integration, not affiliated with Universal Devices.
>
> **Never tested with a real device**: it was written from the PyISY library
> (the one of Home Assistant) and tested against a simulated controller only.
> Feedback welcome.

## What you get

| Node on the controller                                             | In Gladys                                                                                                             |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| Insteon dimmer declared safe                                       | a light: on/off and brightness                                                                                        |
| Insteon switch (relay) declared safe                               | a switch (or a light)                                                                                                 |
| Insteon dimmer or switch **not** declared safe                     | its state (and level), read only, and "Turn on" / "Turn off" buttons, disabled by default                             |
| Lock (Insteon, Z-Wave)                                             | "Locked", read only, and its battery                                                                                  |
| Thermostat (Insteon, Z-Wave)                                       | its temperature and humidity, read only                                                                               |
| Any other node (sensors, keypad buttons, Z-Wave devices, I/O Linc) | its state (or level), read only, and what it measures: temperature, humidity, light, power, voltage, current, battery |
| Integer and state variables                                        | their value, read only                                                                                                |
| Programs of a folder named **Gladys**                              | a "Run" button, disabled by default, and the result of their last condition                                           |
| Paddles, keypad buttons, remotes pressed                           | the scene trigger "ISY control event"                                                                                 |

Not supported yet: HTTPS, commands of Z-Wave dimmers and switches, locks,
thermostats and garage doors (I/O Linc), the scenes (groups) of the
controller, writing variables, node servers' commands, energy totals (kWh).

## Setting it up

1. Give the controller a fixed IP address in your router.
2. In Gladys, open the integration and enter:
   - the **address of the controller** (its IP address) and its **HTTP
     port**: 8080 on an eisy or a Polisy, 80 on an ISY994;
   - the **user name** and **password** of the ISY Admin Console. The
     password is kept by Gladys in its database, never shown again, sent only
     to the controller, never written in the logs. HTTP only for now: anyone
     who can read your local network can read it;
   - optionally the **identifier of the controller** (its UUID, in the ISY
     Admin Console under Help > About). Left empty, the controller found at
     the first connection is remembered.
3. Save, then click **Test the connection**.
4. Add the devices from the **Discovery** tab.

## Lights and switches: declare them safe

A light or a switch in Gladys obeys Google Home, Alexa, the MCP ("turn
everything off") and every scene. An Insteon switch or dimmer may drive
anything: a lamp, but also a pump, a heater, a freezer, a garage door. So a
dimmer or a switch is a light or a switch **only if you list its address in
"Nodes declared safe"**, as the ISY Admin Console shows it, for example:

```
1A 2B 3C 1, 4D 5E 6F 1: light
```

A dimmer is always a light; a switch is a switch, or a light when followed by
`: light`. The other ones show their state, and two buttons "Turn on" and
"Turn off" that only work once **"Allow the Turn on / Turn off buttons"** is
ticked. When you declare a node safe later, its new features appear in the
Discovery; delete the old ones you no longer want (their history goes with
them).

## Programs

Put the programs Gladys may run in a folder named **Gladys** of the ISY Admin
Console (directly in it, not in a sub-folder). Each one gets a **Run** button
(the controller evaluates its If, then runs its Then or its Else) and the
result of its last condition. The buttons only work once **"Allow running
the programs of the Gladys folder"** is ticked: a program may do anything,
unlock a door or open a garage. A program taken out of the folder can no
longer be run.

## Commands

A command leaves within 3.5 seconds or not at all ("nothing was sent"). It is
confirmed only when the controller reports the level asked; otherwise Gladys
shows "sent, without confirmation" and the node is read again 2 seconds
later. A program run is confirmed by the answer of the controller, which runs
it itself. Every command is written in the integration logs.

## Scene trigger "ISY control event"

Each control event of a node (a paddle, a keypad button or a remote pressed)
fires the trigger with:

- `address`: the address of the node, as the ISY Admin Console shows it
  (`1A 2B 3C 1`): it is compared as written;
- `control`: `DON` (on), `DOF` (off), `DFON` / `DFOF` (double press),
  `FDUP` / `FDDOWN` (held), `FDSTOP` (released), `BRT`, `DIM`;
- `name`: the name of the node.

The replay of every status when the event stream opens never fires it. 120
events per minute at most.

## Readings and limits

- The controller sends every change as it happens. Every **status reading**
  interval (10 minutes by default) every status is read again. A restart of
  the integration never reads sooner.
- The list of nodes, variables and programs is read at the first connection,
  then again on **Scan** in the Discovery or when the controller says its
  nodes changed, at most every 10 minutes.
- **Another controller** answering at the same IP address (after a router
  change): nothing is read nor sent until you enter its identifier.
- **Password refused**: the integration stops and never tries again by
  itself. Correct the password, or click "Test the connection" once the
  controller accepts it.
- **Controller unreachable**: new tries after 10 s, 30 s, 1, 2, then every 5
  minutes; the pause is kept across a restart.
- Units: those of the controller, fixed when the feature is created (a
  temperature in °F stays in °F).

## Credits

The REST API and the event stream of the controller come from
[PyISY](https://github.com/automicus/PyISY) (Apache 2.0, Automicus), see
`THIRD_PARTY_NOTICES.md`.
