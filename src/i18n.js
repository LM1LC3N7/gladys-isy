// -----------------------------------------------------------------------------
// French and English texts: statuses, command errors, device and feature names.
// An entry is { en, fr }, each a string or a function of the arguments.
// -----------------------------------------------------------------------------

/** entry, language -> the text (a function stays a function). */
export const word = (entry, language) => entry[language] ?? entry.en;

/** entry + arguments -> { en, fr } strings. */
export function fill(entry, ...args) {
  const out = {};
  for (const lang of ['en', 'fr']) {
    const text = entry[lang];
    out[lang] = typeof text === 'function' ? text(...args) : text;
  }
  return out;
}

const plural = (n, one, many) => (n === 1 ? one : many);

export const T = {
  noConfig: {
    en: 'Enter the address of the controller and the user name and password of the ISY Admin Console.',
    fr: "Saisissez l'adresse du contrôleur ainsi que le nom d'utilisateur et le mot de passe de l'ISY Admin Console.",
  },
  httpsNotYet: {
    en: 'HTTPS is not supported yet: enter the HTTP address (port 8080 on an eisy or a Polisy, 80 on an ISY994).',
    fr: "Le HTTPS n'est pas encore pris en charge : saisissez l'adresse HTTP (port 8080 sur un eisy ou un Polisy, 80 sur un ISY994).",
  },
  badControllerId: {
    en: 'The "Identifier of the controller" is not valid (e.g. 00:21:b9:02:12:34).',
    fr: "L'« identifiant du contrôleur » n'est pas valide (par ex. 00:21:b9:02:12:34).",
  },
  connecting: { en: 'Connecting to the controller…', fr: 'Connexion au contrôleur…' },
  connected: {
    en: (devices, extra) =>
      `Connected to the controller: ${devices} ${plural(devices, 'device', 'devices')}.${extra}`,
    fr: (devices, extra) =>
      `Connecté au contrôleur : ${devices} ${plural(devices, 'appareil', 'appareils')}.${extra}`,
  },
  reading: {
    en: 'Connected to the controller, reading its nodes…',
    fr: 'Connecté au contrôleur, lecture de ses nœuds…',
  },
  safeErrors: {
    en: (list) => ` Not understood in "Nodes declared safe": ${list}.`,
    fr: (list) => ` Non compris dans « Nœuds déclarés sûrs » : ${list}.`,
  },
  duplicates: {
    en: (list) => ` Left out (same id as another node): ${list}.`,
    fr: (list) => ` Laissés de côté (même identifiant qu'un autre nœud) : ${list}.`,
  },
  unreachable: {
    en: (reason, seconds) => `Controller unreachable (${reason}); next try in ${seconds} s.`,
    fr: (reason, seconds) => `Contrôleur injoignable (${reason}) ; nouvel essai dans ${seconds} s.`,
  },
  refused: {
    en: 'The controller refused the user name or the password: no new try. Correct them, or click "Test the connection" once the controller accepts them.',
    fr: "Le contrôleur a refusé le nom d'utilisateur ou le mot de passe : aucun nouvel essai. Corrigez-les, ou cliquez sur « Tester la connexion » quand le contrôleur les accepte.",
  },
  otherController: {
    en: (seen, expected) =>
      `Another controller answers at this address (identifier ${seen}, expected ${expected}): nothing is read nor sent. If you replaced it, enter ${seen} in "Identifier of the controller".`,
    fr: (seen, expected) =>
      `Un autre contrôleur répond à cette adresse (identifiant ${seen}, attendu ${expected}) : rien n'est lu ni envoyé. Si vous l'avez remplacé, saisissez ${seen} dans « Identifiant du contrôleur ».`,
  },
  stillConnecting: {
    en: 'The controller has not answered yet: try again in a moment.',
    fr: "Le contrôleur n'a pas encore répondu : réessayez dans un instant.",
  },
  testOk: {
    en: (id, devices) => `The controller answers (identifier ${id}); ${devices} device(s) known.`,
    fr: (id, devices) =>
      `Le contrôleur répond (identifiant ${id}) ; ${devices} appareil(s) connu(s).`,
  },
  // Command errors.
  offline: {
    en: 'The controller is not connected: nothing was sent.',
    fr: "Le contrôleur n'est pas connecté : rien n'a été envoyé.",
  },
  tooLate: {
    en: 'The controller was too slow to take the command in time: nothing was sent.',
    fr: "Le contrôleur a été trop lent pour prendre la commande à temps : rien n'a été envoyé.",
  },
  notSafe: {
    en: 'This node is not declared safe in the configuration: nothing was sent.',
    fr: "Ce nœud n'est pas déclaré sûr dans la configuration : rien n'a été envoyé.",
  },
  buttonsOff: {
    en: 'The "Turn on" and "Turn off" buttons are disabled in the configuration: nothing was sent.',
    fr: "Les boutons « Allumer » et « Éteindre » sont désactivés dans la configuration : rien n'a été envoyé.",
  },
  programsOff: {
    en: 'Running programs is disabled in the configuration: nothing was sent.',
    fr: "Le lancement des programmes est désactivé dans la configuration : rien n'a été envoyé.",
  },
  programGone: {
    en: 'This program is no longer in the "Gladys" folder of the controller: nothing was sent.',
    fr: "Ce programme n'est plus dans le dossier « Gladys » du contrôleur : rien n'a été envoyé.",
  },
  identityUnknown: {
    en: 'The identity of the controller is not checked yet: nothing was sent.',
    fr: "L'identité du contrôleur n'est pas encore vérifiée : rien n'a été envoyé.",
  },
  otherControllerCommand: {
    en: 'Another controller answers at this address: nothing was sent.',
    fr: "Un autre contrôleur répond à cette adresse : rien n'a été envoyé.",
  },
  unknownDevice: {
    en: 'Unknown node or program: nothing was sent.',
    fr: "Nœud ou programme inconnu : rien n'a été envoyé.",
  },
  readOnly: {
    en: 'This feature is read only: nothing was sent.',
    fr: "Cette fonctionnalité est en lecture seule : rien n'a été envoyé.",
  },
  badValue: {
    en: (value) => `Invalid value ${value}: nothing was sent.`,
    fr: (value) => `Valeur invalide ${value} : rien n'a été envoyé.`,
  },
  controllerRefused: {
    en: (what, reason) => `${what}: the controller did not accept the command (${reason}).`,
    fr: (what, reason) => `${what} : le contrôleur n'a pas accepté la commande (${reason}).`,
  },
  unconfirmed: {
    en: (what) => `${what}: sent, without confirmation.`,
    fr: (what) => `${what} : envoyé, sans confirmation.`,
  },
};

export const COMMAND_NAMES = {
  level: {
    en: (name, level) => (level === 0 ? `${name} off` : `${name} on at ${level} %`),
    fr: (name, level) => (level === 0 ? `${name} éteint` : `${name} allumé à ${level} %`),
  },
  on: { en: (name) => `${name} on`, fr: (name) => `${name} allumé` },
  run: { en: (name) => `program ${name} run`, fr: (name) => `programme ${name} lancé` },
};

export const FEATURE_NAMES = {
  binary: { en: 'Power', fr: 'Alimentation' },
  brightness: { en: 'Brightness', fr: 'Luminosité' },
  switch: { en: 'Switch', fr: 'Interrupteur' },
  light: { en: 'Light', fr: 'Lumière' },
  state: { en: 'State', fr: 'État' },
  level: { en: 'Level (%)', fr: 'Niveau (%)' },
  locked: { en: 'Locked', fr: 'Verrouillé' },
  turn_on: { en: 'Turn on', fr: 'Allumer' },
  turn_off: { en: 'Turn off', fr: 'Éteindre' },
  value: { en: 'Value', fr: 'Valeur' },
  run: { en: 'Run', fr: 'Lancer' },
  status: { en: 'Condition (last run)', fr: 'Condition (dernier lancement)' },
  variableDevice: {
    en: (name, type) => `${name} (${type === 1 ? 'integer' : 'state'} variable)`,
    fr: (name, type) => `${name} (variable ${type === 1 ? 'entière' : "d'état"})`,
  },
  programDevice: { en: (name) => `${name} (program)`, fr: (name) => `${name} (programme)` },
};

/** Sensor features, by property id (lower case). */
export const SENSOR_NAMES = {
  st: { en: 'Measure', fr: 'Mesure' },
  clitemp: { en: 'Temperature', fr: 'Température' },
  clihum: { en: 'Humidity', fr: 'Humidité' },
  batlvl: { en: 'Battery', fr: 'Batterie' },
  lumin: { en: 'Luminance', fr: 'Luminosité ambiante' },
  cpw: { en: 'Power', fr: 'Puissance' },
  cv: { en: 'Voltage', fr: 'Tension' },
  cc: { en: 'Current', fr: 'Courant' },
};
