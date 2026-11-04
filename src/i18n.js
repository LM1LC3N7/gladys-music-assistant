// -----------------------------------------------------------------------------
// The texts users read in Gladys (connection status, configuration buttons,
// command and scene errors), in English and French. Never a token: only names
// the code chose, and names and versions Music Assistant gives (bounded).
// -----------------------------------------------------------------------------

const both = (en, fr) => ({ en, fr });
const seconds = (ms) => Math.max(1, Math.round(ms / 1000));
const wait = (ms) => {
  const s = seconds(ms);
  return s < 120
    ? { en: `${s} s`, fr: `${s} s` }
    : { en: `${Math.round(s / 60)} min`, fr: `${Math.round(s / 60)} min` };
};

export const T = {
  notConfigured: both(
    'Type the address of your Music Assistant server and a long-lived token in the configuration (or click "Find Music Assistant").',
    'Saisissez l’adresse de votre serveur Music Assistant et un jeton longue durée dans la configuration (ou cliquez sur « Trouver Music Assistant »).',
  ),
  invalid: (keys) =>
    both(
      `Invalid value, fix it in the configuration: ${keys.join(', ')}.`,
      `Valeur invalide, à corriger dans la configuration : ${keys.join(', ')}.`,
    ),
  configUnread: (ms) =>
    both(
      `The configuration could not be read from Gladys, tried again in ${wait(ms).en}.`,
      `La configuration n’a pas pu être lue dans Gladys, nouvel essai dans ${wait(ms).fr}.`,
    ),
  connecting: (address) =>
    both(
      `Connecting to Music Assistant at ${address}…`,
      `Connexion à Music Assistant à ${address}…`,
    ),
  unreachable: (address, ms) =>
    both(
      `Music Assistant does not answer at ${address} (address, port, server stopped?), tried again in ${wait(ms).en}.`,
      `Music Assistant ne répond pas à ${address} (adresse, port, serveur arrêté ?), nouvel essai dans ${wait(ms).fr}.`,
    ),
  notMa: (address, ms) =>
    both(
      `The server at ${address} is not a Music Assistant server (check the port, 8095 by default), tried again in ${wait(ms).en}.`,
      `Le serveur à ${address} n’est pas un serveur Music Assistant (vérifiez le port, 8095 par défaut), nouvel essai dans ${wait(ms).fr}.`,
    ),
  setupRequired: (ms) =>
    both(
      `Music Assistant is not set up yet: open its web interface and create the first user, tried again in ${wait(ms).en}.`,
      `Music Assistant n’est pas encore configuré : ouvrez son interface web et créez le premier utilisateur, nouvel essai dans ${wait(ms).fr}.`,
    ),
  rejected: (code, ms) =>
    both(
      `Music Assistant refused the connection (error ${Number.isInteger(code) ? code : '?'}), not the token: tried again in ${wait(ms).en}.`,
      `Music Assistant a refusé la connexion (erreur ${Number.isInteger(code) ? code : '?'}), pas le jeton : nouvel essai dans ${wait(ms).fr}.`,
    ),
  unreadable: (ms) =>
    both(
      `A message of Music Assistant could not be read: the connection was closed, tried again in ${wait(ms).en}.`,
      `Un message de Music Assistant n’a pas pu être lu : la connexion a été fermée, nouvel essai dans ${wait(ms).fr}.`,
    ),
  tooOld: (version, ms) =>
    both(
      `Music Assistant ${version} is too old: version 2.8 or later is needed. Tried again in ${wait(ms).en}.`,
      `Music Assistant ${version} est trop ancien : il faut la version 2.8 ou plus récente. Nouvel essai dans ${wait(ms).fr}.`,
    ),
  tooNew: (version, ms) =>
    both(
      `Music Assistant ${version} changed its API in a way this integration does not know yet: update the integration. Tried again in ${wait(ms).en}.`,
      `Music Assistant ${version} a changé son API d’une façon que cette intégration ne connaît pas encore : mettez l’intégration à jour. Nouvel essai dans ${wait(ms).fr}.`,
    ),
  forbidden: (ms) =>
    both(
      `The user of the token may not list the players of Music Assistant (its role): give it the "user" role, tried again in ${wait(ms).en}.`,
      `L’utilisateur du jeton n’a pas le droit de lister les lecteurs de Music Assistant (son rôle) : donnez-lui le rôle « user », nouvel essai dans ${wait(ms).fr}.`,
    ),
  refused: both(
    'Music Assistant refused the token (revoked, expired or mistyped). Create a new long-lived token in Music Assistant (Settings > Profile), paste it in the configuration and save. No new try until then.',
    'Music Assistant a refusé le jeton (révoqué, expiré ou mal recopié). Créez un nouveau jeton longue durée dans Music Assistant (Paramètres > Profil), collez-le dans la configuration et enregistrez. Plus aucun essai d’ici là.',
  ),
  refusedBefore: both(
    'This token was refused by Music Assistant before the last restart: no new try. Paste a new token and save, or click "Test the connection".',
    'Ce jeton a été refusé par Music Assistant avant le dernier redémarrage : aucun nouvel essai. Collez un nouveau jeton et enregistrez, ou cliquez sur « Tester la connexion ».',
  ),
  lost: (ms) =>
    both(
      `The connection to Music Assistant was lost, tried again in ${wait(ms).en}.`,
      `La connexion à Music Assistant a été perdue, nouvel essai dans ${wait(ms).fr}.`,
    ),
  connected: ({ name, version, players }) =>
    both(
      `Connected to ${name || 'Music Assistant'} (Music Assistant ${version}): ${players} player(s).`,
      `Connecté à ${name || 'Music Assistant'} (Music Assistant ${version}) : ${players} lecteur(s).`,
    ),
  expiresSoon: (days) =>
    both(
      ` The token expires in ${days} day(s): create a new one in Music Assistant.`,
      ` Le jeton expire dans ${days} jour(s) : créez-en un nouveau dans Music Assistant.`,
    ),
  expired: both(
    ' The token has expired: create a new one in Music Assistant.',
    ' Le jeton a expiré : créez-en un nouveau dans Music Assistant.',
  ),

  // --- Errors of commands and scene actions (one language: Gladys shows the message as is) ---
  notConnected: 'Music Assistant is not connected',
  unknownPlayer: 'This player is not known to Music Assistant now',
  noVolume: 'This player has no volume control in Music Assistant',
  noMute: 'This player cannot be muted in Music Assistant',
  badValue: 'Invalid value',
  busy: 'Too many commands waiting for Music Assistant, try again',
  noAnswer: 'Sent to Music Assistant, no answer in time',
  sentClosed: 'Sent to Music Assistant, the connection closed before its answer',
  tooLate: 'Music Assistant is too slow: nothing more was sent, try again',
  volumeUnknown: (name) =>
    `The volume of "${name}" is unknown in Music Assistant: nothing played, so as not to go above the volume cap`,
  failed: (details) => `Music Assistant refused the command${details ? `: ${details}` : ''}`,
  permission: 'The token of Music Assistant does not allow this command (role of its user)',
  emptyQuery: 'Type what to look for',
  notFound: (kind, query) => `Nothing found in Music Assistant for ${kind} "${query}"`,
  noYear: (artist) =>
    `Music Assistant gives no release year for the albums of "${artist}": the latest one cannot be told`,
  noRadio: 'The "Endless Mix" provider of Music Assistant is not available for an artist radio',
  sameGroup: 'Choose two different players',
  queueIndex: 'This position is not in the queue',
  notMine: 'This media is not from Music Assistant',

  // --- Configuration screen buttons ---
  testBusy: both(
    'A test is already running, wait a few seconds.',
    'Un test est déjà en cours, patientez quelques secondes.',
  ),
  testNotConfigured: both(
    'Type the address and the token first, then save.',
    'Saisissez d’abord l’adresse et le jeton, puis enregistrez.',
  ),
  testFailed: (status) => status,
  findNone: both(
    'No Music Assistant server answered on the local network (mDNS). Type its address by hand (http://<IP>:8095).',
    'Aucun serveur Music Assistant n’a répondu sur le réseau local (mDNS). Saisissez son adresse à la main (http://<IP>:8095).',
  ),
  findFailed: both(
    'The search through Gladys failed: type the address by hand (http://<IP>:8095).',
    'La recherche par Gladys a échoué : saisissez l’adresse à la main (http://<IP>:8095).',
  ),
  findSaved: (url) =>
    both(
      `Found and saved: ${url}. Now paste a long-lived token and save.`,
      `Trouvé et enregistré : ${url}. Collez maintenant un jeton longue durée et enregistrez.`,
    ),
  findList: (list) =>
    both(
      `Music Assistant found: ${list}. Copy the address you want into the configuration.`,
      `Music Assistant trouvé : ${list}. Recopiez l’adresse voulue dans la configuration.`,
    ),
};
