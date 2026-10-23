# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- Universal Devices controllers (ISY994, IoX on an eisy or a Polisy) over
  HTTP on the local network (REST API and event stream ported from PyISY
  3.8.0): the nodes, the variables and the programs of a "Gladys" folder,
  kept in `/data`.
- Insteon dimmers and switches: a light or a switch only when declared safe
  in the configuration; otherwise a read-only state and "Turn on" / "Turn
  off" buttons, disabled by default.
- Locks, thermostats, I/O Linc and the other nodes read only: state, level,
  temperature, humidity, light, power, voltage, current, battery.
- Variables (read only); programs of the "Gladys" folder with a "Run"
  button, disabled by default.
- The scene trigger "ISY control event": paddles, keypad buttons and
  remotes pressed (never during the replay of the statuses).
- Commands sent within 3.5 s or not at all, confirmed by the status the
  controller reports, else "sent, without confirmation" and a read back.
- The identifier of the controller pinned: another controller at the same
  address stops everything until its identifier is entered.
- A refused password stops for good (no automatic retry); other failures are
  retried at 10 s, 30 s, 1, 2, then 5 minutes, the pause kept across a
  restart. "Test the connection".
