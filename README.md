# gladys-isy

External integration for [Gladys Assistant](https://gladysassistant.com):
Universal Devices controllers on the local network, **ISY994** and **IoX**
on an **eisy** or a **Polisy**. Insteon and Z-Wave nodes (Insteon lights and
switches only when declared safe; locks, thermostats and I/O Linc read only),
sensors, variables, the programs of a "Gladys" folder (opt-in "Run"
buttons), and control events as a scene trigger.

Unofficial, not affiliated with Universal Devices. Never tested with a real
device.

- User guide: [English](docs/en.md), [français](docs/fr.md).
- Project rules and architecture: [CLAUDE.md](CLAUDE.md); status and
  decisions: [TODO.md](TODO.md); changes: [CHANGELOG.md](CHANGELOG.md).
- The REST API and the event stream are ported from
  [PyISY](https://github.com/automicus/PyISY) (Apache 2.0, Automicus): see
  [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Development

```bash
npm install
npm run format:check
npm run lint
npm test
npm run audit
npx github:GladysAssistant/integration-store .
```

Runtime dependency: the Gladys integration SDK only. Licence: Apache-2.0.
