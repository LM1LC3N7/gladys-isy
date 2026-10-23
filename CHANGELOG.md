# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Changed

- Before a program is run, only that program and its folder are read again,
  not the whole list of programs: faster on a slow controller.

### Fixed

- The count of connection failures is erased only by the event stream that
  stayed open a minute, never by the timer of a stream that already dropped.

## [0.1.1] - 2026-10-23

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
- The identifier of the controller pinned and read again at every
  connection before any command: another controller at the same address
  gets no read nor command; its identifier is read again every 5 minutes and
  on "Test the connection".
- A program is run only if a fresh read shows it still in the "Gladys"
  folder under the same name; each status round updates the list.
- A refused password stops for good (no automatic retry); other failures are
  retried at 10 s, 30 s, 1, 2, then 5 minutes, the pause kept across a
  restart and erased only once the event stream stayed open a minute. "Test
  the connection".
- The replay of the statuses at the opening of the event stream is read
  whole, in order, however many packets it spans.
- Declared safe addresses compared without leading zeros; those matching no
  node are listed in the status.

[Unreleased]: https://github.com/LM1LC3N7/gladys-isy/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/LM1LC3N7/gladys-isy/releases/tag/v0.1.1
