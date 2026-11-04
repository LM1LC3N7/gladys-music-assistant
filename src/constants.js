// -----------------------------------------------------------------------------
// Timings, limits and the keys users store (manifest keys, feature keys,
// external id shape): the keys are forever, never rename them.
// -----------------------------------------------------------------------------

/** The port of the Music Assistant webserver (API, interface and image proxy). */
export const DEFAULT_PORT = 8095;

/**
 * The API schema this module was written and tested against (Music Assistant
 * 2.10.9). A server whose `min_supported_schema_version` is above it has made
 * a breaking change to the commands we use; a server below MIN_SCHEMA (2.8)
 * lacks fields we read.
 */
export const OUR_SCHEMA = 65;
export const MIN_SCHEMA = 28;

/** Manifest keys (configuration screen buttons and scene actions). */
export const ACTIONS = Object.freeze({
  TEST: 'test_connection',
  FIND: 'find_server',
});
export const SCENE_ACTIONS = Object.freeze({
  PLAY: 'play_search',
  VOLUME: 'set_volume',
  GROUP: 'group',
  UNGROUP: 'ungroup',
});

/** What `play_search` looks for (the values of its `kind` field). */
export const KINDS = Object.freeze({
  TRACK: 'track',
  ALBUM: 'album',
  PLAYLIST: 'playlist',
  ARTIST: 'artist',
  LATEST_ALBUM: 'latest_album',
  ARTIST_RADIO: 'artist_radio',
  RADIO: 'radio',
});

/** The provider choice of the configuration and of `play_search`. */
export const PROVIDERS = Object.freeze({
  AUTO: 'auto',
  QOBUZ: 'qobuz',
  SPOTIFY: 'spotify',
  /** `play_search` only: the choice of the configuration. */
  CONFIG: 'config',
});

/** Volume cap in percent (manifest default): a scene never goes louder. */
export const DEFAULT_MAX_VOLUME = 60;

const SECOND = 1000;
export const TIMINGS = Object.freeze({
  /** Opening the WebSocket (TCP + upgrade) and reading the server info. */
  CONNECT: 8 * SECOND,
  /** The answer to `auth`. */
  AUTH: 8 * SECOND,
  /** players/all, player_queues/all, providers after the authentication. */
  REQUEST: 10 * SECOND,
  /** A transport or volume command: under the 5 s Gladys gives an ack. */
  COMMAND: 3 * SECOND,
  /** A search, a browse, a play_media: under the 10 s Gladys gives music handlers. */
  MUSIC: 8 * SECOND,
  /**
   * Whole budgets, from the call of Gladys to the last request: every
   * request gets at most what is left, and nothing is sent once it is spent,
   * so nothing happens after Gladys gave up waiting. Gladys waits 5 s for a
   * command, 10 s for a music handler, the declared timeout_seconds for a
   * scene action (play_search 30 s, set_volume 10 s, group/ungroup 15 s) and
   * a button (20 s).
   */
  COMMAND_BUDGET: 4.5 * SECOND,
  MUSIC_BUDGET: 8.5 * SECOND,
  SCENE_BUDGET: 27 * SECOND,
  VOLUME_BUDGET: 8 * SECOND,
  GROUP_BUDGET: 13 * SECOND,
  TEST_BUDGET: 18 * SECOND,
  /** A command with an effect (play, next, group…) is sent only with this much left. */
  EFFECT_MIN: 1.5 * SECOND,
  /** A read is sent only with this much left. */
  READ_MIN: 0.2 * SECOND,
  /** A session must have lived this long for the backoff to start again from RETRY_MIN. */
  STABLE: 60 * SECOND,
  /** An artwork (Gladys waits 15 s). */
  IMAGE: 8 * SECOND,
  /** A WebSocket ping; nothing heard for 2.5 of them closes the session. */
  KEEPALIVE: 30 * SECOND,
  /** Reconnection: 2 s, doubled up to 5 min. */
  RETRY_MIN: 2 * SECOND,
  RETRY_MAX: 300 * SECOND,
  /** getConfig() refused by Gladys: 5 s, doubled up to 5 min, without end. */
  CONFIG_RETRY_MIN: 5 * SECOND,
  CONFIG_RETRY_MAX: 300 * SECOND,
  /** Events are gathered this long before the now-playing states are published. */
  FLUSH: 300,
  /** providers_updated: the list is read again this long after the last event. */
  PROVIDERS_REFRESH: 2 * SECOND,
  /** The connection test button: at most one every… */
  TEST_MIN_INTERVAL: 3 * SECOND,
  /** An mDNS search through the Gladys core. */
  FIND_SECONDS: 5,
  /** The token expires in less than this: said in the status. */
  TOKEN_WARNING: 30 * 24 * 3600 * SECOND,
});

export const LIMITS = Object.freeze({
  /** One WebSocket message (a players/all of a large install is ~100 KB). */
  MESSAGE_BYTES: 8 * 1024 * 1024,
  /** Items assembled from `partial` answers. */
  PARTIAL_ITEMS: 5000,
  /** Requests waiting for their answer (pause, stop, mute and a lower volume pass beyond). */
  IN_FLIGHT: 32,
  PLAYERS: 200,
  TEXT: 200,
  ID: 256,
  /** A MediaItem id for Gladys. */
  MEDIA_ID: 512,
  /** Gladys checks the artwork: at most 300 KB decoded. */
  ARTWORK_BYTES: 300 * 1024,
  /** Gladys keeps at most 100 items per music answer. */
  MUSIC_ITEMS: 100,
  /** Search results per media type. */
  SEARCH_PER_TYPE: 25,
  /** The token, as typed (a Music Assistant JWT is ~400 characters). */
  TOKEN: 4096,
  /** Answers kept from an mDNS search. */
  FOUND: 8,
  /** Artist albums lists read for one "latest album". */
  ALBUM_SOURCES: 3,
  /** Players a command may make sound (a group and its members). */
  GROUP_MEMBERS: 32,
});

/** The feature keys (= the Gladys types). */
export const FEATURE = Object.freeze({
  PLAYBACK_STATE: 'playback_state',
  PLAY: 'play',
  PAUSE: 'pause',
  PREVIOUS: 'previous',
  NEXT: 'next',
  TITLE: 'title',
  ARTIST: 'artist',
  ALBUM: 'album',
  ARTWORK: 'artwork',
  DURATION: 'duration',
  POSITION: 'position',
  SHUFFLE: 'shuffle',
  REPEAT: 'repeat',
  VOLUME: 'volume',
  MUTE: 'mute',
});

/** The id prefix of a browse folder (a Music Assistant browse path follows it). */
export const FOLDER_PREFIX = 'ma-folder:';
/** The id prefix of a queue entry without a media URI. */
export const QUEUE_ITEM_PREFIX = 'ma-queue-item:';
