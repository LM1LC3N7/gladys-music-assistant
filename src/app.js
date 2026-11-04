// -----------------------------------------------------------------------------
// The integration: one session with the Music Assistant server of the
// configuration, the live picture of its players and queues (kept by the
// events), and everything Gladys asks (commands, browse, search, play, queue,
// artwork, configuration buttons, scene actions).
//
// Rules held here:
// - the volume cap: no command of this integration sets a volume above it,
//   and playing, unmuting or grouping first brings a louder player down to it;
//   a lower volume, pause, stop and mute are never held (no cap, no limit of
//   commands in flight);
// - the token never leaves memory: not in logs, statuses, errors nor /data;
//   a refused token stops the automatic tries (remembered by a 2-hex marker
//   in /data) until a new token is saved or the test button succeeds;
// - one session at a time, a generation number checked after every await;
//   reconnection 2 s doubled up to 5 min; nothing stale is republished.
// -----------------------------------------------------------------------------

import { createHash, randomBytes } from 'node:crypto';
import { createLogger, parseMdnsTxt } from '@gladysassistant/integration-sdk';
import {
  DEFAULT_PORT,
  FEATURE,
  FOLDER_PREFIX,
  KINDS,
  LIMITS,
  PROVIDERS,
  QUEUE_ITEM_PREFIX,
  TIMINGS,
} from './constants.js';
import {
  baseUrl,
  isConnectable,
  normalizeConfig,
  parseUrl,
  sessionKey,
  tokenExpiry,
  wsUrl,
} from './config.js';
import {
  buildDevice,
  deviceIdOf,
  featureKey,
  keyOfDeviceId,
  mergeWithCreated,
  playerKey,
} from './devices.js';
import { T } from './i18n.js';
import { MA_ERRORS, MaError, MaSession, cleanText } from './ma/client.js';
import {
  REPEAT_MODES,
  nowPlaying,
  pickBest,
  pickLatestAlbum,
  providerName,
  providerRefs,
  queueItemToMediaItem,
  readPlayer,
  readQueue,
  toMediaItem,
  uriOn,
} from './ma/model.js';
import { createFileStore } from './store.js';

const defaultTimers = { setTimeout, clearTimeout, setInterval, clearInterval };
const isPlain = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const fail = (message) => new Error(message);
const DAY = 24 * 3600 * 1000;

/** Gladys play modes -> QueueOption of Music Assistant. */
const PLAY_OPTIONS = Object.freeze({ replace: 'replace', next: 'next', append: 'add' });
/** Gladys media types searched -> MediaType of Music Assistant. */
const SEARCH_TYPES = Object.freeze({
  artist: 'artist',
  album: 'album',
  track: 'track',
  playlist: 'playlist',
  radio: 'radio',
});
/** The list of SearchResults holding a media type. */
const RESULT_KEYS = Object.freeze({
  artist: 'artists',
  album: 'albums',
  track: 'tracks',
  playlist: 'playlists',
  radio: 'radio',
});
/** What each kind of play_search looks for. */
const KIND_MEDIA = Object.freeze({
  [KINDS.TRACK]: 'track',
  [KINDS.ALBUM]: 'album',
  [KINDS.PLAYLIST]: 'playlist',
  [KINDS.ARTIST]: 'artist',
  [KINDS.LATEST_ALBUM]: 'artist',
  [KINDS.ARTIST_RADIO]: 'artist',
  [KINDS.RADIO]: 'radio',
});

/** A strict number from the value of a command. */
function numberOf(value, { integer = true, min, max }) {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (typeof value === 'string' && value.trim() === '') return undefined;
  if (!Number.isFinite(n) || (integer && !Number.isInteger(n)) || n < min || n > max) {
    return undefined;
  }
  return n;
}

/** The error a command shows, from a MaError (never the token, details bounded). */
export function commandError(err) {
  if (!(err instanceof MaError)) return err instanceof Error ? err : fail(String(err));
  if (err.code === 'busy') return fail(T.busy);
  if (err.code === 'timeout' && err.sent) return fail(T.noAnswer);
  if (err.sent) return fail(T.sentClosed);
  if (err.code === 'command') {
    if (err.maCode === MA_ERRORS.INSUFFICIENT_PERMISSIONS) return fail(T.permission);
    return fail(T.failed(err.details));
  }
  return fail(T.notConnected);
}

/** The salted marker of a token (2 hex characters: 256 values, tells nothing of the token). */
const markerOf = (salt, token) =>
  createHash('sha256').update(`${salt}\n${token}`, 'utf8').digest('hex').slice(0, 2);

export class MusicAssistantApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'music-assistant' }),
    monotonic = () => performance.now(),
    now = () => Date.now(),
    timers = defaultTimers,
    store = createFileStore(),
    sessionFactory = (options) => new MaSession(options),
    fetchImpl = (...args) => fetch(...args),
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.monotonic = monotonic;
    this.now = now;
    this.timers = timers;
    this.store = store;
    this.sessionFactory = sessionFactory;
    this.fetchImpl = fetchImpl;
    this.config = undefined;
    this.rawConfig = undefined;
    /** `{ gen, session, info, players, queues, providers, ready }` of the session being run. */
    this.current = undefined;
    this.generation = 0;
    this.retryTimer = undefined;
    this.retryDelay = TIMINGS.RETRY_MIN;
    this.lossStatus = undefined;
    this.lifecycle = Promise.resolve();
    this.connection = 0;
    this.configTimer = undefined;
    this.configFailures = 0;
    this.configRun = Promise.resolve();
    this.lastStatus = undefined;
    this.statusRun = Promise.resolve();
    this.flushTimer = undefined;
    this.flushRun = Promise.resolve();
    this.dirty = new Set();
    this.providersTimer = undefined;
    this.lastDiscovery = undefined;
    this.lastTransports = undefined;
    this.gladysDown = false;
    this.testing = false;
    this.lastTestAt = undefined;
    this.loadStore();
  }

  // --- /data ---------------------------------------------------------------------

  loadStore() {
    const result = this.store.load();
    this.salt = undefined;
    this.refusedMarker = undefined;
    if (!result.ok) {
      // Not an empty state: never overwritten; a refusal is then not remembered.
      this.storeError = result.code;
      this.logger.warn(`music-assistant: /data unreadable (${result.code}), not written`);
      return;
    }
    this.storeError = undefined;
    const data = isPlain(result.data) ? result.data : {};
    if (typeof data.salt === 'string' && /^[0-9a-f]{32}$/.test(data.salt)) this.salt = data.salt;
    if (typeof data.refused === 'string' && /^[0-9a-f]{2}$/.test(data.refused)) {
      this.refusedMarker = data.refused;
    }
  }

  /** Remembers (or forgets, with undefined) the marker of the refused token. */
  async saveRefused(token) {
    if (token === undefined) {
      if (this.refusedMarker === undefined) return;
      this.refusedMarker = undefined;
    } else {
      this.salt ??= randomBytes(16).toString('hex');
      this.refusedMarker = markerOf(this.salt, token);
    }
    if (this.storeError) return;
    try {
      await this.store.save({
        version: 1,
        ...(this.salt ? { salt: this.salt } : {}),
        ...(this.refusedMarker ? { refused: this.refusedMarker } : {}),
      });
    } catch (err) {
      this.logger.warn(`music-assistant: /data not written (${err?.code ?? 'Error'})`);
    }
  }

  /** This token was refused before (by its marker; a new token has another marker, 255 in 256). */
  wasRefused(token) {
    return this.refusedMarker !== undefined && this.salt !== undefined
      ? markerOf(this.salt, token) === this.refusedMarker
      : false;
  }

  // --- Lifecycle -------------------------------------------------------------------

  /** A connection to Gladys: the configuration is read, tried again without end. */
  connected(getConfig) {
    this.gladysDown = false;
    const token = ++this.connection;
    this.configFailures = 0;
    this.clearConfigTimer();
    this.configRun = this.tryConfig(getConfig, token);
    return this.configRun;
  }

  /** The connection to Gladys is lost: the getConfig tries end (the Music Assistant session stays). */
  disconnected() {
    this.gladysDown = true;
    this.connection += 1;
    this.clearConfigTimer();
  }

  /** The user saved the form: it wins over a getConfig still being tried. */
  configUpdated(raw) {
    this.connection += 1;
    this.clearConfigTimer();
    // Saving the form is a request to try: a refusal remembered is forgotten
    // (its 2-hex marker could match a new token, 1 time in 256).
    this.forgetRefusal = true;
    return this.start(raw);
  }

  clearConfigTimer() {
    if (this.configTimer !== undefined) {
      this.timers.clearTimeout(this.configTimer);
      this.configTimer = undefined;
    }
  }

  async tryConfig(getConfig, token) {
    let raw;
    try {
      raw = await getConfig();
    } catch (err) {
      if (token !== this.connection) return;
      const wait = Math.min(
        TIMINGS.CONFIG_RETRY_MIN * 2 ** this.configFailures,
        TIMINGS.CONFIG_RETRY_MAX,
      );
      this.configFailures += 1;
      this.logger.warn(
        `music-assistant: the configuration could not be read (${err?.name ?? 'Error'})`,
      );
      this.lastStatus = undefined;
      await this.setStatus(false, T.configUnread(wait));
      if (token !== this.connection) return;
      this.configTimer = this.timers.setTimeout(() => {
        this.configTimer = undefined;
        this.configRun = this.tryConfig(getConfig, token);
      }, wait);
      return;
    }
    if (token !== this.connection) return;
    this.configFailures = 0;
    await this.start(raw);
  }

  serialize(job) {
    const run = this.lifecycle.then(job, job);
    this.lifecycle = run.catch(() => {});
    return run;
  }

  start(raw = {}) {
    return this.serialize(() => this.doStart(raw));
  }

  stop() {
    return this.serialize(async () => {
      this.stopped = true;
      this.clearConfigTimer();
      this.connection += 1;
      this.timers.clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
      this.timers.clearTimeout(this.providersTimer);
      this.providersTimer = undefined;
      await this.closeSession();
    });
  }

  /** Resolves once the queued starts, the getConfig try and the flush are done (tests). */
  async idle() {
    await this.configRun;
    await this.lifecycle;
    await this.flushRun;
    await this.statusRun;
  }

  async doStart(raw) {
    if (this.stopped) return;
    const forget = this.forgetRefusal;
    this.forgetRefusal = false;
    const config = normalizeConfig(raw);
    const changed = this.config === undefined || sessionKey(config) !== sessionKey(this.config);
    this.config = config;
    this.rawConfig = raw;
    // Gladys may have restarted: everything is published again, from the live picture only.
    this.gladys.forgetPublishedStates();
    this.lastStatus = undefined;
    this.lastDiscovery = undefined;
    this.lastTransports = undefined;
    if (!changed && !this.current && this.retryTimer !== undefined) {
      // Waiting for the next try: a reconnection of Gladys or a form saved with
      // the same address and token never connects sooner, nor resets the backoff.
      await this.setStatus(false, this.lossStatus ?? T.lost(this.retryDelay));
      return;
    }
    if (changed || !this.current) {
      if (
        this.refusedMarker !== undefined &&
        (forget || (changed && !this.wasRefused(config.token)))
      ) {
        // A new token, or the form saved: the refusal is forgotten.
        await this.saveRefused(undefined);
      }
      await this.closeSession();
      this.retryDelay = TIMINGS.RETRY_MIN;
      this.openSession();
      return;
    }
    if (this.current.ready) {
      this.reportConnected(this.current);
      this.publishDiscovered(this.current);
      this.markAllDirty();
      this.scheduleFlush(0);
    } else {
      await this.setStatus(false, T.connecting(this.config.url));
    }
  }

  async closeSession() {
    this.clearRetry();
    const cur = this.current;
    this.current = undefined;
    this.generation += 1;
    if (cur) await cur.session.close();
  }

  clearRetry() {
    if (this.retryTimer !== undefined) {
      this.timers.clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
  }

  openSession() {
    this.clearRetry();
    this.lossStatus = undefined;
    const config = this.config;
    const invalid = config.invalid.filter((key) => key === 'url' || key === 'token');
    if (invalid.length > 0) {
      this.setStatus(false, T.invalid(invalid));
      return;
    }
    if (!isConnectable(config)) {
      this.setStatus(false, T.notConfigured);
      return;
    }
    if (this.wasRefused(config.token)) {
      this.setStatus(false, T.refusedBefore);
      return;
    }
    const gen = ++this.generation;
    const session = this.sessionFactory({
      url: wsUrl(config.server),
      token: config.token,
      timers: this.timers,
      monotonic: this.monotonic,
    });
    const cur = {
      gen,
      session,
      info: undefined,
      players: new Map(),
      queues: new Map(),
      providers: new Map(),
      ready: false,
    };
    this.current = cur;
    session.on('event', (event) => {
      if (!this.isCurrent(cur)) return;
      try {
        this.onEvent(cur, event);
      } catch (err) {
        this.logger.warn(`music-assistant: an event was not read (${err?.name ?? 'Error'})`);
      }
    });
    session.on('closed', (err) => {
      if (this.isCurrent(cur)) this.onClosed(cur, err);
    });
    this.setStatus(false, T.connecting(config.url));
    session.start().then(
      () => this.onAuthenticated(cur),
      () => {}, // the 'closed' event says why
    );
  }

  isCurrent(cur) {
    return this.current === cur && this.generation === cur.gen;
  }

  async onAuthenticated(cur) {
    const { session } = cur;
    cur.info = session.info;
    // The players are the picture; the queues (shuffle, repeat) and the
    // providers (preferred provider, names) are secondary: their failure
    // never keeps the players away.
    const secondary = (command) =>
      session.request(command, {}, { timeout: TIMINGS.REQUEST }).catch((err) => {
        this.logger.warn(
          `music-assistant: ${command} not read (${err?.code ?? 'Error'}${err?.maCode ? ` ${err.maCode}` : ''})`,
        );
        return [];
      });
    let players;
    let queues;
    let providers;
    try {
      [players, queues, providers] = await Promise.all([
        session.request('players/all', {}, { timeout: TIMINGS.REQUEST }),
        secondary('player_queues/all'),
        secondary('providers'),
      ]);
    } catch (err) {
      if (!this.isCurrent(cur)) return;
      this.logger.warn(
        `music-assistant: the players could not be read (${err?.code ?? 'Error'}${err?.maCode ? ` ${err.maCode}` : ''})`,
      );
      // A session without its picture is no session: closed, tried again later.
      const code =
        err?.maCode === MA_ERRORS.INSUFFICIENT_PERMISSIONS
          ? 'forbidden'
          : err?.code === 'command'
            ? 'protocol'
            : (err?.code ?? 'protocol');
      session.fail(new MaError(code));
      return;
    }
    if (!this.isCurrent(cur)) return;
    this.applyPlayers(cur, players);
    for (const raw of Array.isArray(queues) ? queues : []) this.applyQueue(cur, raw);
    this.applyProviders(cur, providers);
    cur.ready = true;
    cur.readyAt = this.monotonic();
    if (this.refusedMarker !== undefined) await this.saveRefused(undefined);
    if (!this.isCurrent(cur)) return;
    const domains = [
      ...new Set(
        [...cur.providers.values()].filter((p) => p.type === 'music').map((p) => p.domain),
      ),
    ].join(', ');
    this.logger.info(
      `music-assistant: connected to "${cur.info.name}" (Music Assistant ${cur.info.version}, schema ${cur.info.schema}) as ${session.user?.role || 'user'}: ${cur.players.size} player(s), music providers: ${domains || 'none'}`,
    );
    this.reportConnected(cur);
    this.publishDiscovered(cur);
    this.markAllDirty();
    this.scheduleFlush(0);
  }

  onClosed(cur, err) {
    const wasReady = cur.ready;
    cur.ready = false;
    this.current = undefined;
    this.generation += 1;
    this.lastTransports = undefined;
    this.publishTransports(undefined);
    const address = this.config.url;
    if (err.code === 'refused') {
      this.logger.error('music-assistant: authentication refused by Music Assistant (no new try)');
      this.saveRefused(this.config.token).catch(() => {});
      this.setStatus(false, T.refused);
      return;
    }
    // The backoff starts again from 2 s only after a session that lived:
    // a server that accepts then drops at once is not called every 2 s.
    if (wasReady && this.monotonic() - cur.readyAt >= TIMINGS.STABLE) {
      this.retryDelay = TIMINGS.RETRY_MIN;
    }
    const delay = this.retryDelay;
    this.retryDelay = Math.min(delay * 2, TIMINGS.RETRY_MAX);
    let status;
    if (err.code === 'setup_required') status = T.setupRequired(delay);
    else if (err.code === 'not_ma' || err.code === 'protocol') status = T.notMa(address, delay);
    else if (err.code === 'unreadable') status = T.unreadable(delay);
    else if (err.code === 'too_old') status = T.tooOld(err.details ?? '?', delay);
    else if (err.code === 'too_new') status = T.tooNew(err.details ?? '?', delay);
    else if (err.code === 'forbidden') status = T.forbidden(delay);
    else if (err.code === 'rejected') status = T.rejected(err.maCode, delay);
    else if (wasReady) status = T.lost(delay);
    else status = T.unreachable(address, delay);
    this.lossStatus = status;
    this.logger.warn(
      `music-assistant: ${wasReady ? 'connection lost' : 'no session'} (${err.code === 'unreadable' ? 'a message could not be read' : err.code}), tried again in ${Math.round(delay / 1000)} s`,
    );
    this.setStatus(false, status);
    this.retryTimer = this.timers.setTimeout(() => {
      this.retryTimer = undefined;
      if (!this.stopped && !this.current) this.openSession();
    }, delay);
  }

  reportConnected(cur) {
    const status = T.connected({
      name: cur.info?.name,
      version: cur.info?.version ?? '?',
      players: cur.players.size,
    });
    const exp = tokenExpiry(this.config.token);
    if (exp !== undefined) {
      const left = exp - this.now();
      const suffix =
        left <= 0
          ? T.expired
          : left < TIMINGS.TOKEN_WARNING
            ? T.expiresSoon(Math.max(1, Math.floor(left / DAY)))
            : undefined;
      if (suffix) {
        status.en += suffix.en;
        status.fr += suffix.fr;
      }
    }
    this.setStatus(true, status);
  }

  /** One setConnectionStatus per change of status, one after the other. */
  setStatus(connected, message) {
    const key = JSON.stringify([connected, message]);
    if (key === this.lastStatus) return this.statusRun;
    this.lastStatus = key;
    this.statusRun = this.statusRun
      .then(() => this.gladys.setConnectionStatus(connected, message))
      .catch((err) => {
        if (this.lastStatus === key) this.lastStatus = undefined;
        this.logger.warn(`music-assistant: status not published (${err?.name ?? 'Error'})`);
      });
    return this.statusRun;
  }

  // --- The live picture ------------------------------------------------------------

  applyPlayers(cur, list) {
    cur.players.clear();
    for (const raw of Array.isArray(list) ? list : []) {
      if (cur.players.size >= LIMITS.PLAYERS) break;
      const player = readPlayer(raw);
      if (player && player.enabled) cur.players.set(player.id, player);
    }
  }

  applyQueue(cur, raw) {
    const queue = readQueue(raw);
    if (queue) cur.queues.set(queue.id, queue);
    return queue;
  }

  applyProviders(cur, list) {
    cur.providers.clear();
    for (const raw of Array.isArray(list) ? list : []) {
      if (!isPlain(raw) || typeof raw.instance_id !== 'string' || typeof raw.domain !== 'string') {
        continue;
      }
      if (cur.providers.size >= 100) break;
      cur.providers.set(raw.instance_id, {
        instance: raw.instance_id,
        domain: raw.domain,
        name: cleanText(raw.name ?? raw.domain, 60),
        type: typeof raw.type === 'string' ? raw.type : '',
        available: raw.available !== false,
      });
    }
  }

  onEvent(cur, message) {
    const { event, object_id: objectId, data } = message;
    if (!cur.ready) return;
    switch (event) {
      case 'player_added':
      case 'player_updated': {
        const player = readPlayer(data);
        if (!player) return;
        const before = cur.players.get(player.id);
        if (!player.enabled) {
          if (before) {
            cur.players.delete(player.id);
            this.publishDiscovered(cur);
          }
          return;
        }
        if (!before && cur.players.size >= LIMITS.PLAYERS) return;
        cur.players.set(player.id, player);
        if (
          !before ||
          before.name !== player.name ||
          before.canVolume !== player.canVolume ||
          before.canMute !== player.canMute
        ) {
          this.publishDiscovered(cur);
        }
        if (!before || before.available !== player.available) this.lastTransports = undefined;
        this.dirty.add(player.id);
        this.scheduleFlush();
        return;
      }
      case 'player_removed': {
        const id = typeof objectId === 'string' ? objectId : data?.player_id;
        if (cur.players.delete(id)) {
          this.lastTransports = undefined;
          this.publishDiscovered(cur);
          this.scheduleFlush();
        }
        return;
      }
      case 'queue_added':
      case 'queue_updated':
      case 'queue_items_updated': {
        const queue = this.applyQueue(cur, data);
        if (!queue) return;
        for (const player of cur.players.values()) {
          if (player.id === queue.id || player.activeSource === queue.id) this.dirty.add(player.id);
        }
        this.scheduleFlush();
        return;
      }
      case 'providers_updated':
        this.refreshProviders(cur);
        return;
      default:
      // queue_time_updated (every second while playing) and the others: the
      // position sample is republished by the SDK only on a real change.
    }
  }

  refreshProviders(cur) {
    if (this.providersTimer !== undefined) return;
    this.providersTimer = this.timers.setTimeout(async () => {
      this.providersTimer = undefined;
      if (!this.isCurrent(cur) || !cur.ready) return;
      try {
        const list = await cur.session.request('providers', {}, { timeout: TIMINGS.REQUEST });
        if (this.isCurrent(cur)) this.applyProviders(cur, list);
      } catch (err) {
        this.logger.warn(`music-assistant: providers not read again (${err?.code ?? 'Error'})`);
      }
    }, TIMINGS.PROVIDERS_REFRESH);
  }

  // --- Publishing ------------------------------------------------------------------

  /** The devices of the user that are ours: player key -> created device. */
  createdDevices() {
    const map = new Map();
    for (const device of Array.isArray(this.gladys.devices) ? this.gladys.devices : []) {
      const key = keyOfDeviceId(device?.external_id);
      if (key && device.external_id === this.gladys.externalIds('player', key).device) {
        map.set(key, device);
      }
    }
    return map;
  }

  publishDiscovered(cur) {
    if (!cur?.ready || this.gladysDown) return;
    const created = this.createdDevices();
    const devices = [...cur.players.values()].map((player) =>
      mergeWithCreated(buildDevice(this.gladys, player), created.get(playerKey(player.id))),
    );
    const key = JSON.stringify(devices);
    if (key === this.lastDiscovery) return;
    this.lastDiscovery = key;
    this.gladys.publishDiscoveredDevices(devices).catch((err) => {
      if (this.lastDiscovery === key) this.lastDiscovery = undefined;
      this.logger.warn(`music-assistant: Discovery not published (${err?.name ?? 'Error'})`);
    });
  }

  /** The transport badges of the created devices (`cur` undefined: all unreachable). */
  publishTransports(cur) {
    if (this.gladysDown) return;
    const created = this.createdDevices();
    if (created.size === 0) return;
    const byKey = new Map(cur ? [...cur.players.values()].map((p) => [playerKey(p.id), p]) : []);
    const transports = [...created.values()].map((device) => {
      const player = byKey.get(keyOfDeviceId(device.external_id));
      return {
        external_id: device.external_id,
        transport: cur?.ready && player?.available ? 'local' : 'unreachable',
      };
    });
    const key = JSON.stringify(transports);
    if (key === this.lastTransports) return;
    this.lastTransports = key;
    this.gladys.publishTransports(transports.slice(0, 100)).catch((err) => {
      if (this.lastTransports === key) this.lastTransports = undefined;
      this.logger.warn(`music-assistant: transports not published (${err?.name ?? 'Error'})`);
    });
  }

  markAllDirty() {
    for (const id of this.current?.players.keys() ?? []) this.dirty.add(id);
  }

  /** The user created, updated or deleted a device: its states are published again. */
  devicesChanged() {
    this.lastDiscovery = undefined;
    this.lastTransports = undefined;
    if (this.current?.ready) {
      this.publishDiscovered(this.current);
      this.markAllDirty();
      this.scheduleFlush();
    }
  }

  scheduleFlush(delay = TIMINGS.FLUSH) {
    if (this.flushTimer !== undefined || this.stopped) return;
    this.flushTimer = this.timers.setTimeout(() => {
      this.flushTimer = undefined;
      this.flushRun = this.flushRun.then(() => this.flush()).catch(() => {});
    }, delay);
  }

  async flush() {
    const cur = this.current;
    if (!cur?.ready || this.gladysDown) return;
    this.publishTransports(cur);
    const created = this.createdDevices();
    const ids = [...this.dirty];
    this.dirty.clear();
    let failed = false;
    for (const id of ids) {
      if (!this.isCurrent(cur)) return;
      const player = cur.players.get(id);
      if (!player) continue;
      const device = created.get(playerKey(id));
      if (!device) continue; // not created: Gladys would drop the states
      const queue = cur.queues.get(player.activeSource) ?? cur.queues.get(player.id);
      try {
        await this.gladys.publishNowPlaying(
          device.external_id,
          nowPlaying(player, queue, this.config.url),
        );
      } catch (err) {
        failed = true;
        this.dirty.add(id);
        this.logger.warn(
          `music-assistant: states not published (${err?.status ?? err?.name ?? 'Error'})`,
        );
      }
    }
    // Refused by Gladys (429…): tried again later, never in a loop.
    if (failed) this.scheduleFlush(5000);
  }

  // --- Commands ----------------------------------------------------------------------

  /** The live session, ready, or an error said to the user. */
  session() {
    const cur = this.current;
    if (!cur?.ready || !cur.session.alive) throw fail(T.notConnected);
    return cur;
  }

  /** The live player of a device (by its external id). */
  playerOf(cur, deviceExternalId) {
    const key = keyOfDeviceId(deviceExternalId);
    if (!key) throw fail(T.unknownPlayer);
    for (const player of cur.players.values()) {
      if (playerKey(player.id) === key) return player;
    }
    throw fail(T.unknownPlayer);
  }

  /** The end of the budget of one call of Gladys (monotonic clock). */
  deadline(ms) {
    return { at: this.monotonic() + ms };
  }

  /**
   * Sends one command within the budget `deadline`: its timeout is at most
   * what is left; with too little left, nothing is sent (an `effect` needs
   * EFFECT_MIN, a read READ_MIN). Urgent commands (pause, stop, mute, a lower
   * volume) are never held, only bounded.
   */
  async send(
    cur,
    command,
    args,
    { deadline, effect = false, urgent = false, timeout = TIMINGS.COMMAND } = {},
  ) {
    let wait = timeout;
    if (deadline) {
      const left = deadline.at - this.monotonic();
      if (!urgent && left < (effect ? TIMINGS.EFFECT_MIN : TIMINGS.READ_MIN)) {
        throw fail(T.tooLate);
      }
      wait = Math.max(1, Math.min(timeout, left));
    }
    try {
      return await cur.session.request(command, args, { timeout: wait, urgent });
    } catch (err) {
      throw commandError(err);
    }
  }

  /** The volume cap of the configuration (1 to 100). */
  get cap() {
    return this.config?.max_volume ?? 1;
  }

  /**
   * Before Gladys makes a player sound (play, unmute, join a group): a
   * volume above the cap is brought down to it first. When it cannot be
   * lowered, nothing is played.
   */
  async lowerToCap(cur, player, deadline) {
    for (const id of this.soundingIds(cur, player)) {
      let target = cur.players.get(id);
      if (!target || (target.canVolume && target.volume === undefined)) {
        // Not in the picture, or its volume unknown: read again, never guessed.
        target = await this.readAgain(cur, id, deadline);
        if (!target) {
          if (id === player.id) throw fail(T.unknownPlayer);
          continue; // a member Music Assistant does not know any more does not sound
        }
      }
      if (!target.canVolume) continue;
      // An offline member does not sound: it never holds the group.
      if (id !== player.id && !target.available) continue;
      if (target.volume === undefined) throw fail(T.volumeUnknown(target.name));
      if (target.volume <= this.cap) continue;
      await this.send(
        cur,
        'players/cmd/volume_set',
        { player_id: target.id, volume_level: this.cap },
        { urgent: true, deadline },
      );
      target.volume = this.cap;
    }
  }

  /**
   * The players a command on `player` may make sound: itself, its group
   * members, and when it plays in a group, the leader and its members.
   */
  soundingIds(cur, player) {
    const ids = new Set([player.id, ...player.members]);
    const leaderId = player.syncedTo ?? player.activeGroup;
    if (leaderId && leaderId !== player.id) {
      ids.add(leaderId);
      for (const id of cur.players.get(leaderId)?.members ?? []) ids.add(id);
    }
    return [...ids].slice(0, LIMITS.GROUP_MEMBERS + 1);
  }

  /** A player read again from Music Assistant (and kept in the picture), or undefined. */
  async readAgain(cur, id, deadline) {
    const raw = await this.send(
      cur,
      'players/get',
      { player_id: id },
      { deadline, timeout: TIMINGS.COMMAND },
    );
    const player = readPlayer(raw);
    if (!player || player.id !== id) return undefined;
    if (this.isCurrent(cur) && cur.players.has(id)) cur.players.set(id, player);
    return player;
  }

  /**
   * Sets a volume, capped: on a group player of Music Assistant (its
   * own volume moves its members by MA's rules), every member is set
   * instead, so none goes above the cap. Returns the level set.
   */
  async applyVolume(cur, player, asked, deadline) {
    // Rounded down, then capped: never one step above what was asked or allowed.
    const level = Math.min(Math.floor(asked), this.cap);
    const targets =
      player.type === 'group' && player.members.length > 0 ? player.members : [player.id];
    for (const id of targets) {
      const known = cur.players.get(id);
      const lower = known?.volume === undefined || level <= known.volume;
      await this.send(
        cur,
        'players/cmd/volume_set',
        { player_id: id, volume_level: level },
        { urgent: lower, effect: !lower, deadline },
      );
    }
    if (level < asked) this.republishVolume(player, level);
    return level;
  }

  /**
   * A capped write may change nothing in Music Assistant (already at the
   * cap): the volume is published again so that Gladys sees the answer.
   */
  republishVolume(player, level) {
    const device = this.createdDevices().get(playerKey(player.id));
    if (!device || this.gladysDown) return;
    this.gladys.publishState(`${device.external_id}:${FEATURE.VOLUME}`, level).catch((err) => {
      this.logger.warn(
        `music-assistant: volume not published (${err?.status ?? err?.name ?? 'Error'})`,
      );
    });
  }

  async setValue(device, deviceFeature, value) {
    const deadline = this.deadline(TIMINGS.COMMAND_BUDGET);
    const cur = this.session();
    const player = this.playerOf(cur, device?.external_id);
    const key = featureKey(deviceFeature?.external_id);
    const id = { player_id: player.id };
    const queueId =
      player.activeSource && cur.queues.has(player.activeSource) ? player.activeSource : player.id;
    switch (key) {
      case FEATURE.PLAYBACK_STATE: {
        const state = numberOf(value, { min: 0, max: 2 });
        if (state === undefined) throw fail(T.badValue);
        if (state === 0) return this.send(cur, 'players/cmd/pause', id, { urgent: true });
        if (state === 2) return this.send(cur, 'players/cmd/stop', id, { urgent: true });
        await this.lowerToCap(cur, player, deadline);
        return this.send(cur, 'players/cmd/play', id, { effect: true, deadline });
      }
      case FEATURE.PLAY:
        await this.lowerToCap(cur, player, deadline);
        return this.send(cur, 'players/cmd/play', id, { effect: true, deadline });
      case FEATURE.PAUSE:
        return this.send(cur, 'players/cmd/pause', id, { urgent: true });
      // Previous and next start the playback of a paused player in Music
      // Assistant: under the cap first, like play.
      case FEATURE.PREVIOUS:
        await this.lowerToCap(cur, player, deadline);
        return this.send(cur, 'players/cmd/previous', id, { effect: true, deadline });
      case FEATURE.NEXT:
        await this.lowerToCap(cur, player, deadline);
        return this.send(cur, 'players/cmd/next', id, { effect: true, deadline });
      case FEATURE.VOLUME: {
        if (!player.canVolume) throw fail(T.noVolume);
        const asked = numberOf(value, { integer: false, min: 0, max: 100 });
        if (asked === undefined) throw fail(T.badValue);
        await this.applyVolume(cur, player, asked, deadline);
        return undefined;
      }
      case FEATURE.MUTE: {
        if (!player.canMute) throw fail(T.noMute);
        const mute = numberOf(value, { min: 0, max: 1 });
        if (mute === undefined) throw fail(T.badValue);
        if (mute === 1) {
          return this.send(
            cur,
            'players/cmd/volume_mute',
            { ...id, muted: true },
            { urgent: true },
          );
        }
        await this.lowerToCap(cur, player, deadline);
        return this.send(
          cur,
          'players/cmd/volume_mute',
          { ...id, muted: false },
          { effect: true, deadline },
        );
      }
      case FEATURE.POSITION: {
        const position = numberOf(value, { integer: false, min: 0, max: 604800 });
        if (position === undefined) throw fail(T.badValue);
        return this.send(
          cur,
          'players/cmd/seek',
          { ...id, position: Math.floor(position) },
          { effect: true, deadline },
        );
      }
      case FEATURE.SHUFFLE: {
        const on = numberOf(value, { min: 0, max: 1 });
        if (on === undefined) throw fail(T.badValue);
        return this.send(
          cur,
          'player_queues/shuffle',
          { queue_id: queueId, shuffle_enabled: on === 1 },
          { deadline },
        );
      }
      case FEATURE.REPEAT: {
        const mode = numberOf(value, { min: 0, max: 2 });
        if (mode === undefined) throw fail(T.badValue);
        return this.send(
          cur,
          'player_queues/repeat',
          { queue_id: queueId, repeat_mode: REPEAT_MODES[mode] },
          { deadline },
        );
      }
      default:
        throw fail(T.badValue);
    }
  }

  // --- Catalog -----------------------------------------------------------------------

  mediaOptions(cur) {
    return {
      base: this.config.url,
      providers: cur.providers,
      artwork: (url) => this.gladys.artworkKey(url),
    };
  }

  mapItems(cur, list) {
    const options = this.mediaOptions(cur);
    return (Array.isArray(list) ? list : [])
      .map((item) => toMediaItem(item, options))
      .filter(Boolean);
  }

  async musicBrowse(device, { parentId, offset = 0, limit = 50 } = {}) {
    const deadline = this.deadline(TIMINGS.MUSIC_BUDGET);
    const cur = this.session();
    this.playerOf(cur, device?.external_id);
    let items;
    if (parentId === null || parentId === undefined || parentId === '') {
      items = this.mapItems(
        cur,
        await this.send(cur, 'music/browse', {}, { timeout: TIMINGS.MUSIC, deadline }),
      );
    } else if (String(parentId).startsWith(FOLDER_PREFIX)) {
      const path = String(parentId).slice(FOLDER_PREFIX.length);
      items = this.mapItems(
        cur,
        await this.send(cur, 'music/browse', { path }, { timeout: TIMINGS.MUSIC, deadline }),
      );
    } else {
      items = await this.browseItem(cur, String(parentId), deadline);
    }
    const start = Math.max(0, Number.isInteger(offset) ? offset : 0);
    const size = Math.min(LIMITS.MUSIC_ITEMS, Math.max(1, Number.isInteger(limit) ? limit : 50));
    return { items: items.slice(start, start + size), total: items.length };
  }

  /** The children of a media item: an artist's albums (latest first), an album's or a playlist's tracks. */
  async browseItem(cur, uri, deadline) {
    const match = /^([a-z0-9_-]+(?:--[A-Za-z0-9_-]+)?):\/\/(artist|album|playlist)\/(.+)$/.exec(
      uri,
    );
    if (!match) throw fail(T.notMine);
    const [, provider, type, itemId] = match;
    const args = { item_id: itemId, provider_instance_id_or_domain: provider };
    if (type === 'artist') {
      const albums = await this.artistAlbums(
        cur,
        { uri, provider, item_id: itemId },
        undefined,
        deadline,
      );
      return this.mapItems(cur, sortByYear(albums));
    }
    const command =
      type === 'album' ? 'music/albums/album_tracks' : 'music/playlists/playlist_tracks';
    return this.mapItems(
      cur,
      await this.send(cur, command, args, { timeout: TIMINGS.MUSIC, deadline }),
    );
  }

  /**
   * The albums of an artist: those of its provider (the preferred one first)
   * when it is a library artist, else the library's.
   */
  async artistAlbums(cur, artist, domain, deadline) {
    let item = artist;
    if (artist.provider === 'library' && !Array.isArray(artist.provider_mappings)) {
      item = await this.send(
        cur,
        'music/item_by_uri',
        { uri: artist.uri },
        { timeout: TIMINGS.MUSIC, deadline },
      );
    }
    let refs = providerRefs(item, cur.providers);
    if (domain) refs = refs.filter((ref) => ref.domain === domain);
    for (const ref of refs.slice(0, LIMITS.ALBUM_SOURCES)) {
      const albums = await this.send(
        cur,
        'music/artists/artist_albums',
        { item_id: ref.itemId, provider_instance_id_or_domain: ref.provider },
        { timeout: TIMINGS.MUSIC, deadline },
      );
      if (Array.isArray(albums) && albums.length > 0) return albums;
    }
    if (artist.provider === 'library' || item?.provider === 'library') {
      const albums = await this.send(
        cur,
        'music/artists/artist_albums',
        {
          item_id: String(item?.item_id ?? artist.item_id),
          provider_instance_id_or_domain: 'library',
        },
        { timeout: TIMINGS.MUSIC, deadline },
      );
      if (Array.isArray(albums)) return albums;
    }
    return [];
  }

  async musicSearch(device, { query, type = null, limit = 50 } = {}) {
    const deadline = this.deadline(TIMINGS.MUSIC_BUDGET);
    const cur = this.session();
    this.playerOf(cur, device?.external_id);
    const text = cleanText(query, 200);
    if (!text) return { items: [] };
    const types = type ? [SEARCH_TYPES[type]].filter(Boolean) : Object.values(SEARCH_TYPES);
    if (types.length === 0) return { items: [] };
    const size = Math.min(LIMITS.MUSIC_ITEMS, Math.max(1, Number.isInteger(limit) ? limit : 50));
    const result = await this.send(
      cur,
      'music/search',
      {
        search_query: text,
        media_types: types,
        limit: Math.min(size, LIMITS.SEARCH_PER_TYPE),
      },
      { timeout: TIMINGS.MUSIC, deadline },
    );
    const lists = isPlain(result) ? result : {};
    const ordered = [
      ...(lists.artists ?? []),
      ...(lists.albums ?? []),
      ...(lists.tracks ?? []),
      ...(lists.playlists ?? []),
      ...(lists.radio ?? []),
    ];
    return { items: this.mapItems(cur, ordered).slice(0, size) };
  }

  queueIdOf(cur, player) {
    return player.activeSource && cur.queues.has(player.activeSource)
      ? player.activeSource
      : player.id;
  }

  async musicPlay(device, media, mode = 'replace') {
    const deadline = this.deadline(TIMINGS.MUSIC_BUDGET);
    const cur = this.session();
    const player = this.playerOf(cur, device?.external_id);
    const uri = typeof media?.id === 'string' ? media.id : '';
    if (
      !uri.includes('://') ||
      uri.startsWith(FOLDER_PREFIX) ||
      uri.startsWith(QUEUE_ITEM_PREFIX) ||
      uri.length > LIMITS.MEDIA_ID
    ) {
      throw fail(T.notMine);
    }
    const option = PLAY_OPTIONS[mode ?? 'replace'];
    if (!option) throw fail(T.badValue);
    await this.lowerToCap(cur, player, deadline);
    await this.send(
      cur,
      'player_queues/play_media',
      { queue_id: player.id, media: uri, option },
      { timeout: TIMINGS.MUSIC, effect: true, deadline },
    );
  }

  async musicQueueGet(device, { offset = 0, limit = 50 } = {}) {
    const deadline = this.deadline(TIMINGS.MUSIC_BUDGET);
    const cur = this.session();
    const player = this.playerOf(cur, device?.external_id);
    const queueId = this.queueIdOf(cur, player);
    const start = Math.max(0, Number.isInteger(offset) ? offset : 0);
    const size = Math.min(LIMITS.MUSIC_ITEMS, Math.max(1, Number.isInteger(limit) ? limit : 50));
    const [rawQueue, entries] = await Promise.all([
      this.send(
        cur,
        'player_queues/get',
        { queue_id: queueId },
        { timeout: TIMINGS.MUSIC, deadline },
      ),
      this.send(
        cur,
        'player_queues/items',
        { queue_id: queueId, limit: size, offset: start },
        { timeout: TIMINGS.MUSIC, deadline },
      ),
    ]);
    const queue = readQueue(rawQueue);
    const options = this.mediaOptions(cur);
    const items = (Array.isArray(entries) ? entries : [])
      .slice(0, size)
      .map((entry) => queueItemToMediaItem(entry, options))
      .filter(Boolean);
    return {
      items,
      currentIndex: queue?.currentIndex ?? null,
      total: Math.max(queue?.items ?? 0, start + items.length),
    };
  }

  async musicQueuePlay(device, index) {
    const deadline = this.deadline(TIMINGS.MUSIC_BUDGET);
    const cur = this.session();
    const player = this.playerOf(cur, device?.external_id);
    if (!Number.isInteger(index) || index < 0) throw fail(T.queueIndex);
    await this.lowerToCap(cur, player, deadline);
    await this.send(
      cur,
      'player_queues/play_index',
      { queue_id: this.queueIdOf(cur, player), index },
      { timeout: TIMINGS.MUSIC, effect: true, deadline },
    );
  }

  /** The bytes of an artwork, from the image proxy of the server Gladys is configured with. */
  async artwork(key) {
    const url = this.gladys.artworkUrls?.get(key);
    const base = this.config?.url;
    if (typeof url !== 'string' || !base || !url.startsWith(`${base}/imageproxy/`)) {
      throw fail('Unknown artwork');
    }
    let bytes = await this.fetchImage(url);
    if (!bytes && /size=512/.test(url))
      bytes = await this.fetchImage(url.replace('size=512', 'size=256'));
    if (!bytes) throw fail('Artwork too large or not an image');
    return bytes.toString('base64');
  }

  /** An image of at most 300 KB (JPEG, PNG or WebP), else undefined; network errors throw. */
  async fetchImage(url) {
    const response = await this.fetchImpl(url, {
      redirect: 'error',
      signal: AbortSignal.timeout(TIMINGS.IMAGE),
      headers: { Accept: 'image/jpeg, image/png, image/webp' },
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw fail(`Artwork: HTTP ${response.status}`);
    }
    const type = String(response.headers.get('content-type') ?? '')
      .split(';')[0]
      .trim();
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(type)) {
      await response.body?.cancel().catch(() => {});
      return undefined;
    }
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > LIMITS.ARTWORK_BYTES) {
      await response.body?.cancel().catch(() => {});
      return undefined;
    }
    const chunks = [];
    let total = 0;
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > LIMITS.ARTWORK_BYTES) {
        await reader.cancel().catch(() => {});
        return undefined;
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  }

  // --- Scene actions -------------------------------------------------------------------

  /** The provider domain asked (`config` = the one of the configuration), when Music Assistant has it. */
  domainOf(cur, choice) {
    const wanted = choice === PROVIDERS.CONFIG || !choice ? this.config.preferred_provider : choice;
    if (wanted !== PROVIDERS.QOBUZ && wanted !== PROVIDERS.SPOTIFY) return undefined;
    for (const provider of cur.providers.values()) {
      if (provider.domain === wanted && provider.available) return wanted;
    }
    return undefined; // not set up in Music Assistant: every provider is searched
  }

  /**
   * The best item of a kind: on the preferred provider first (its library
   * items included), then on every provider. `{ item, domain }`.
   */
  async findBest(cur, mediaType, query, domain, deadline) {
    const search = (providers) =>
      this.send(
        cur,
        'music/search',
        {
          search_query: query,
          media_types: [mediaType],
          limit: 10,
          ...(providers ? { providers } : {}),
        },
        { timeout: TIMINGS.MUSIC, deadline },
      );
    const listOf = (result) =>
      isPlain(result) && Array.isArray(result[RESULT_KEYS[mediaType]])
        ? result[RESULT_KEYS[mediaType]]
        : [];
    if (domain) {
      const item = pickBest(listOf(await search(['library', domain])), query, {
        domain,
        providers: cur.providers,
      });
      if (item) return { item, domain };
    }
    const item = pickBest(listOf(await search(undefined)), query);
    return item ? { item, domain: undefined } : undefined;
  }

  /** The URI to play an item from: on the preferred provider when it has it. */
  uriFor(cur, item, mediaType, domain) {
    if (domain && item.provider === 'library') {
      const ref = providerRefs(item, cur.providers).find((r) => r.domain === domain);
      if (ref) return uriOn(mediaType, ref);
    }
    return item.uri;
  }

  async playSearch(fields = {}) {
    const deadline = this.deadline(TIMINGS.SCENE_BUDGET);
    const cur = this.session();
    const player = this.playerOf(cur, fields.device);
    const query = cleanText(fields.query, 200);
    if (!query) throw fail(T.emptyQuery);
    const kind = Object.values(KINDS).includes(fields.kind) ? fields.kind : KINDS.ALBUM;
    const option = PLAY_OPTIONS[fields.mode || 'replace'];
    if (!option) throw fail(T.badValue);
    const mediaType = KIND_MEDIA[kind];
    const domain = this.domainOf(cur, fields.provider);
    const found = await this.findBest(cur, mediaType, query, domain, deadline);
    if (!found) throw fail(T.notFound(mediaType, query));
    let { item } = found;
    let uri;
    let year;
    if (kind === KINDS.LATEST_ALBUM) {
      const albums = await this.artistAlbums(cur, item, found.domain, deadline);
      const latest = pickLatestAlbum(albums);
      if (!latest) {
        if (albums.length > 0) throw fail(T.noYear(cleanText(item.name, 100)));
        throw fail(T.notFound('album', query));
      }
      item = latest.album;
      year = latest.year;
      uri = item.uri;
    } else if (kind === KINDS.ARTIST_RADIO) {
      const radio = [...cur.providers.values()].some(
        (p) => p.domain === 'radio_playlist' && p.available,
      );
      if (!radio) throw fail(T.noRadio);
      uri = `radio_playlist://playlist/${this.uriFor(cur, item, 'artist', found.domain)}`;
    } else {
      uri = this.uriFor(cur, item, mediaType, found.domain);
    }
    if (uri.length > 2048) throw fail(T.badValue);
    await this.lowerToCap(cur, player, deadline);
    await this.send(
      cur,
      'player_queues/play_media',
      { queue_id: player.id, media: uri, option },
      { timeout: TIMINGS.MUSIC, effect: true, deadline },
    );
    if (item.year !== undefined && year === undefined && Number.isInteger(item.year)) {
      year = item.year;
    }
    return {
      title: cleanText(item.name),
      provider: providerName(item, cur.providers),
      ...(year !== undefined ? { year } : {}),
    };
  }

  async setVolume(fields = {}) {
    const deadline = this.deadline(TIMINGS.VOLUME_BUDGET);
    const cur = this.session();
    const player = this.playerOf(cur, fields.device);
    if (!player.canVolume) throw fail(T.noVolume);
    const asked = numberOf(fields.volume, { integer: false, min: 0, max: 100 });
    if (asked === undefined) throw fail(T.badValue);
    return { volume: await this.applyVolume(cur, player, asked, deadline) };
  }

  async group(fields = {}) {
    const deadline = this.deadline(TIMINGS.GROUP_BUDGET);
    const cur = this.session();
    const leader = this.playerOf(cur, fields.device);
    const member = this.playerOf(cur, fields.member);
    if (leader.id === member.id) throw fail(T.sameGroup);
    // The member plays with the group from now on: never above the cap.
    await this.lowerToCap(cur, member, deadline);
    await this.send(
      cur,
      'players/cmd/group',
      { player_id: member.id, target_player: leader.id },
      { effect: true, deadline },
    );
    return undefined;
  }

  async ungroup(fields = {}) {
    const deadline = this.deadline(TIMINGS.GROUP_BUDGET);
    const cur = this.session();
    const player = this.playerOf(cur, fields.device);
    await this.send(cur, 'players/cmd/ungroup', { player_id: player.id }, { deadline });
    return undefined;
  }

  // --- Configuration buttons -----------------------------------------------------------

  /**
   * Opens a separate short session with the saved configuration, lists the
   * music providers and the players, then closes it. A success lifts a refusal.
   */
  async testConnection() {
    const at = this.monotonic();
    if (
      this.testing ||
      (this.lastTestAt !== undefined && at - this.lastTestAt < TIMINGS.TEST_MIN_INTERVAL)
    ) {
      return T.testBusy;
    }
    const config = this.config;
    if (!config || !isConnectable(config)) return T.testNotConfigured;
    this.testing = true;
    this.lastTestAt = at;
    // The session opens within CONNECT + AUTH (16 s); the lists get what is left of 18 s.
    const testEnd = at + TIMINGS.TEST_BUDGET;
    const session = this.sessionFactory({
      url: wsUrl(config.server),
      token: config.token,
      timers: this.timers,
      monotonic: this.monotonic,
    });
    try {
      let started;
      try {
        started = await session.start();
      } catch (err) {
        if (err?.code === 'refused') {
          await this.saveRefused(config.token);
          return T.refused;
        }
        if (err?.code === 'setup_required') return T.setupRequired(0);
        if (err?.code === 'rejected') return T.rejected(err.maCode, 0);
        if (err?.code === 'too_old') return T.tooOld(err.details ?? '?', 0);
        if (err?.code === 'too_new') return T.tooNew(err.details ?? '?', 0);
        if (err?.code === 'not_ma' || err?.code === 'protocol') return T.notMa(config.url, 0);
        return T.unreachable(config.url, 0);
      }
      const left = Math.max(1, testEnd - this.monotonic());
      const [providers, players] = await Promise.all([
        session.request('providers', {}, { timeout: Math.min(TIMINGS.REQUEST, left) }),
        session.request('players/all', {}, { timeout: Math.min(TIMINGS.REQUEST, left) }),
      ]).catch((err) => {
        throw commandError(err);
      });
      const music = (Array.isArray(providers) ? providers : []).filter(
        (p) => isPlain(p) && p.type === 'music' && typeof p.domain === 'string',
      );
      const has = (domain) => music.some((p) => p.domain === domain && p.available !== false);
      const names = music.map((p) => cleanText(p.name ?? p.domain, 40)).filter(Boolean);
      const list = (Array.isArray(players) ? players : [])
        .map(readPlayer)
        .filter((p) => p && p.enabled)
        .map(
          (p) => `${p.name}${p.provider ? ` (${p.provider})` : ''}${p.available ? '' : ' [off]'}`,
        );
      const shown = (items) =>
        items.length > 12 ? `${items.slice(0, 12).join(', ')}, …` : items.join(', ');
      const yes = (ok, en) => (en ? (ok ? 'yes' : 'no') : ok ? 'oui' : 'non');
      const name = started.info.name || 'Music Assistant';
      const version = started.info.version;
      const role = started.user?.role || '?';
      // A success lifts a refusal remembered for this token.
      if (this.wasRefused(config.token)) {
        await this.saveRefused(undefined);
        if (this.rawConfig) this.start(this.rawConfig);
      }
      return {
        en: cleanText(
          `Connected to ${name} (Music Assistant ${version}), token of a user "${role}". Qobuz: ${yes(has('qobuz'), true)}, Spotify: ${yes(has('spotify'), true)}. Music providers (${names.length}): ${shown(names) || 'none'}. Players (${list.length}): ${shown(list) || 'none'}.`,
          1000,
        ),
        fr: cleanText(
          `Connecté à ${name} (Music Assistant ${version}), jeton d’un utilisateur « ${role} ». Qobuz : ${yes(has('qobuz'), false)}, Spotify : ${yes(has('spotify'), false)}. Fournisseurs de musique (${names.length}) : ${shown(names) || 'aucun'}. Lecteurs (${list.length}) : ${shown(list) || 'aucun'}.`,
          1000,
        ),
      };
    } finally {
      this.testing = false;
      await session.close();
    }
  }

  /** Asks the local network (mDNS `_mass._tcp`, through Gladys) which servers are there. */
  async findServer() {
    let services;
    try {
      services = await this.gladys.scanNetwork('mdns', { timeoutSeconds: TIMINGS.FIND_SECONDS });
    } catch (err) {
      this.logger.warn(
        `music-assistant: mDNS search failed (${err?.status ?? err?.name ?? 'Error'})`,
      );
      return T.findFailed;
    }
    const found = new Map();
    for (const service of Array.isArray(services) ? services : []) {
      if (!isPlain(service) || found.size >= LIMITS.FOUND) continue;
      const txt = parseMdnsTxt(Array.isArray(service.txt) ? service.txt : []);
      if (typeof txt.server_id !== 'string' || !txt.server_id) continue;
      const addresses = (Array.isArray(service.addresses) ? service.addresses : []).filter(
        (a) => typeof a === 'string',
      );
      const address = addresses.find((a) => /^[\d.]+$/.test(a)) ?? addresses[0];
      const port = Number.isInteger(service.port) ? service.port : DEFAULT_PORT;
      const parsed = address
        ? parseUrl(address.includes(':') ? `http://[${address}]:${port}` : `${address}:${port}`)
        : undefined;
      if (!parsed) continue;
      const url = baseUrl(parsed);
      if (!found.has(txt.server_id)) {
        found.set(txt.server_id, {
          url,
          label:
            `${cleanText(txt.name || 'Music Assistant', 60)} ${cleanText(txt.server_version || '', 20)} (${url})`.trim(),
        });
      }
    }
    if (found.size === 0) return T.findNone;
    const list = [...found.values()];
    if (list.length === 1 && !this.config?.url) {
      await this.gladys.setConfig({ url: list[0].url });
      return T.findSaved(list[0].url);
    }
    return T.findList(list.map((entry) => entry.label).join(' ; '));
  }
}

/** Albums latest first (no year last), the order of Music Assistant kept between equals. */
export function sortByYear(albums) {
  return (Array.isArray(albums) ? albums : [])
    .map((album, index) => ({ album, index }))
    .sort((a, b) => {
      const ya = Number.isInteger(a.album?.year) ? a.album.year : -Infinity;
      const yb = Number.isInteger(b.album?.year) ? b.album.year : -Infinity;
      return yb - ya || a.index - b.index;
    })
    .map(({ album }) => album);
}

export { deviceIdOf };
