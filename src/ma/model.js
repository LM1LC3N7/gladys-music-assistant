// -----------------------------------------------------------------------------
// Pure mappings between Music Assistant objects (Player, PlayerQueue, media
// items, browse folders) and what Gladys reads (now-playing states,
// MediaItems), plus the choices of the scene actions: the best search match,
// the provider of an item, the latest album of an artist. No I/O here.
// Every field read from the server is checked: a missing or odd value is
// "unknown", never 0 nor a crash.
// -----------------------------------------------------------------------------

import { FOLDER_PREFIX, LIMITS, QUEUE_ITEM_PREFIX } from '../constants.js';
import { cleanText } from './client.js';

const isPlain = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const text = (value, max = LIMITS.TEXT) => cleanText(value, max);
const finite = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);

/** `MUSIC_PLAYBACK_STATE` of the SDK: PAUSED 0, PLAYING 1, IDLE 2. */
const PLAYBACK = Object.freeze({ paused: 0, playing: 1, idle: 2 });
/** `MUSIC_REPEAT_MODE` of the SDK: OFF 0, ALL 1, ONE 2. */
const REPEAT = Object.freeze({ off: 0, all: 1, one: 2 });
export const REPEAT_MODES = Object.freeze(['off', 'all', 'one']);

/** An image proxy id (a hex digest in Music Assistant 2.10). */
const PROXY_ID = /^[A-Za-z0-9_-]{8,128}$/;
const IMAGEPROXY_PATH = /^\/imageproxy\/([A-Za-z0-9_-]{8,128})$/;

/** The URL of an image of the server, always on the address Gladys uses. */
export const imageUrl = (base, proxyId, size) =>
  `${base}/imageproxy/${proxyId}?size=${size}&fmt=jpeg`;

/** The proxy id of an `image_url` of Music Assistant (any host), or undefined. */
export function proxyIdOfUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return undefined;
  try {
    const url = new URL(value);
    return IMAGEPROXY_PATH.exec(url.pathname)?.[1];
  } catch {
    return undefined;
  }
}

/** The proxy id of the best image of a media item (a thumb first). */
export function proxyIdOfItem(item) {
  if (!isPlain(item)) return undefined;
  const images = [
    ...(Array.isArray(item.metadata?.images) ? item.metadata.images : []),
    ...(isPlain(item.image) ? [item.image] : []),
  ].filter((image) => isPlain(image) && PROXY_ID.test(String(image.proxy_id ?? '')));
  const thumb = images.find((image) => image.type === 'thumb') ?? images[0];
  return thumb?.proxy_id;
}

/** The provider domain of an instance id (`qobuz--x8Hq` -> `qobuz`). */
export const domainOfInstance = (instance, providers) =>
  providers?.get(instance)?.domain ?? String(instance ?? '').split('--')[0];

/**
 * The provider domains an item can be played from: its own provider, or the
 * providers of a library item (`provider_mappings`), unavailable ones left out.
 */
export function itemDomains(item, providers) {
  const domains = new Set();
  if (!isPlain(item)) return domains;
  if (typeof item.provider === 'string' && item.provider !== 'library') {
    domains.add(domainOfInstance(item.provider, providers));
  }
  for (const mapping of Array.isArray(item.provider_mappings) ? item.provider_mappings : []) {
    if (!isPlain(mapping) || mapping.available === false) continue;
    const domain =
      typeof mapping.provider_domain === 'string'
        ? mapping.provider_domain
        : domainOfInstance(mapping.provider_instance, providers);
    if (domain && domain !== 'library') domains.add(domain);
  }
  return domains;
}

/**
 * The references of an item on its providers: `[{ itemId, provider, domain }]`,
 * the item itself when it comes from a provider, else its mappings.
 */
export function providerRefs(item, providers) {
  if (!isPlain(item)) return [];
  if (typeof item.provider === 'string' && item.provider !== 'library') {
    return [
      {
        itemId: String(item.item_id ?? ''),
        provider: item.provider,
        domain: domainOfInstance(item.provider, providers),
      },
    ];
  }
  const refs = [];
  for (const mapping of Array.isArray(item.provider_mappings) ? item.provider_mappings : []) {
    if (!isPlain(mapping) || mapping.available === false) continue;
    if (typeof mapping.item_id !== 'string' || typeof mapping.provider_instance !== 'string') {
      continue;
    }
    refs.push({
      itemId: mapping.item_id,
      provider: mapping.provider_instance,
      domain: mapping.provider_domain ?? domainOfInstance(mapping.provider_instance, providers),
    });
  }
  return refs;
}

/** The URI of an item on one provider (music_assistant_models create_uri). */
export const uriOn = (mediaType, ref) => `${ref.provider}://${mediaType}/${ref.itemId}`;

/** Lowercase, without accents, punctuation nor extra spaces: for name comparison. */
export function normalizeName(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * The best match of a search: the first item whose name equals the query
 * (accents and case aside), else the first item (Music Assistant sorts by
 * relevance). With `domain`, only items playable from that provider count.
 */
export function pickBest(items, query, { domain, providers } = {}) {
  const list = (Array.isArray(items) ? items : []).filter(
    (item) =>
      isPlain(item) &&
      typeof item.uri === 'string' &&
      (!domain || itemDomains(item, providers).has(domain)),
  );
  const wanted = normalizeName(query);
  return list.find((item) => normalizeName(item.name) === wanted) ?? list[0];
}

/**
 * "The latest album" rests on two things only: the `album_type` Music
 * Assistant gives (AlbumType of 2.10.9: album, single, live, soundtrack,
 * compilation, ep, unknown) and words of the title. Both can be wrong: a
 * provider may type a best-of or a soundtrack as `album`, a live album may
 * have no telltale word ("Au Palais Omnisports"). The scene says what it
 * played (title, year, provider) so that a wrong choice shows.
 */
/** Album types kept: a studio album (or one Music Assistant could not type). */
const ALBUM_TYPES = new Set(['album', 'unknown']);
const word = (body) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${body})(?![\\p{L}\\p{N}])`, 'iu');
/**
 * Words of a best-of, a compilation or a soundtrack that count wherever
 * they are: rare in the title of a studio album.
 */
const COMPILATION_ALWAYS = word(
  [
    'greatest hits',
    '(?:les )?plus grands succ[eè]s',
    'original motion picture',
    'motion picture soundtrack',
    'music from the (?:motion picture|film|movie|series)',
    'bande originale du film',
  ].join('|'),
);
/**
 * Words that count only in a telltale form: the whole title ("Best Of",
 * "The Collection"), a part in brackets or after " - " ("(OST)"), or next to
 * the name of the artist ("The Essential Céline Dion"). "Best of Me" or
 * "Essential Love" stay studio albums.
 */
const COMPILATION_FORM =
  /^(?:the |l )?(?:very )?(?:best of|collection|anthology|anthologie|essentials?|essentiel|integrale|soundtrack|bande originale)$/u;
/** Abbreviations that count only in brackets or after " - " ("Ost" alone is a word). */
const COMPILATION_TAG = /^(?:b o|ost)$/u;
/** Live forms that count wherever they are: "Live at …", "En concert", "Unplugged". */
const LIVE = word(
  'live (?:at|from|au|aux|à)|en concert|in concert|unplugged|en public|live 19\\d\\d|live 20\\d\\d',
);
const LIVE_TAG = /[([](?:[^)\]]*\s)?live(?:\s[^)\]]*)?[)\]]|\s[-–]\s*live\s*$/iu;
/** A reissue or a special edition of an album. */
const REISSUE = word(
  'remaster(?:ed)?|remasteris[ée]e?|deluxe|anniversary|reissue|r[ée][ée]dition|[ée]dition|edition|expanded|collector',
);

const titleOf = (album) => `${album?.name ?? ''} ${album?.version ?? ''}`;
/** The parts of a title that may carry a telltale form: in brackets, after " - " or ":". */
function titleParts(name) {
  const parts = [...name.matchAll(/[([]([^)\]]{1,120})[)\]]/g)].map((m) => m[1]);
  const tail = /\s[-–:]\s(.{1,120})$/u.exec(name);
  if (tail) parts.push(tail[1]);
  return parts;
}

/** A title without years, volume numbers and numbers ("Best Of 1990-2000 Vol. 2" -> "best of"). */
const bare = (text) =>
  normalizeName(text)
    .replace(/(?<![\p{L}\p{N}])(?:vol(?:ume)?\s*)?\d+(?![\p{L}\p{N}])/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

export function isCompilation(album) {
  if (album?.album_type === 'compilation' || album?.album_type === 'soundtrack') return true;
  const name = String(album?.name ?? '');
  const version = String(album?.version ?? '');
  if (COMPILATION_ALWAYS.test(`${name} ${version}`)) return true;
  if ([name, version].some((part) => COMPILATION_FORM.test(bare(part)))) return true;
  const parts = [...titleParts(name), version].map(bare);
  if (parts.some((part) => COMPILATION_FORM.test(part) || COMPILATION_TAG.test(part))) return true;
  // "The Essential Céline Dion", "Céline Dion Anthology": the form plus the artist name.
  const whole = bare(name);
  for (const artist of Array.isArray(album?.artists) ? album.artists.slice(0, 5) : []) {
    const artistName = normalizeName(artist?.name);
    if (artistName && whole.includes(artistName)) {
      if (COMPILATION_FORM.test(bare(whole.replace(artistName, ' ')))) return true;
    }
  }
  return false;
}
export const isLive = (album) =>
  album?.album_type === 'live' ||
  LIVE.test(titleOf(album)) ||
  LIVE_TAG.test(String(album?.name ?? '')) ||
  /(?<!\p{L})live(?!\p{L})/iu.test(String(album?.version ?? ''));
export const isReissue = (album) => REISSUE.test(titleOf(album));

/**
 * The title of an album without what marks a reissue: the parts in
 * brackets, what follows " - ", the reissue words; for "is there an
 * original of this reissue".
 */
export function baseTitle(album) {
  const name = String(album?.name ?? '')
    .replace(/[([][^)\]]*[)\]]/g, ' ')
    .replace(/\s[-–:]\s.*$/u, ' ');
  return normalizeName(name.replace(new RegExp(REISSUE.source, 'giu'), ' '));
}

/** A year Music Assistant gives (a positive integer), else undefined. */
const yearOf = (album) =>
  Number.isInteger(album?.year) && album.year > 0 && album.year < 10000 ? album.year : undefined;

/**
 * "The latest album" of a list of albums of one artist:
 * - album_type `album` (or `unknown` when no album is typed at all): never a
 *   single, an EP, a live, a compilation nor a soundtrack as typed by Music
 *   Assistant;
 * - without the title words of a best-of, a compilation, a soundtrack or a
 *   live (a studio album "Live Forever" stays);
 * - a reissue (remaster, deluxe, edition…) is left out only when the
 *   original of the same title is in the list: a new album out only as a
 *   "Deluxe Edition" stays;
 * - the highest release year; same year: the first one Music Assistant lists.
 * `{ album, year }`, or undefined when no album kept has a year.
 */
export function pickLatestAlbum(albums) {
  const list = (Array.isArray(albums) ? albums : []).filter(
    (album) => isPlain(album) && typeof album.uri === 'string',
  );
  const typed = list.filter((album) => album.album_type === 'album');
  const studio = (typed.length > 0 ? typed : list).filter(
    (album) =>
      ALBUM_TYPES.has(album.album_type ?? 'unknown') && !isCompilation(album) && !isLive(album),
  );
  const originals = new Set(studio.filter((album) => !isReissue(album)).map(baseTitle));
  const kept = studio.filter(
    (album) =>
      yearOf(album) !== undefined && (!isReissue(album) || !originals.has(baseTitle(album))),
  );
  let best;
  for (const album of kept) {
    if (best === undefined || yearOf(album) > yearOf(best)) best = album;
  }
  return best === undefined ? undefined : { album: best, year: yearOf(best) };
}

const artistsOf = (item) =>
  (Array.isArray(item?.artists) ? item.artists : [])
    .map((artist) => text(artist?.name, 80))
    .filter(Boolean)
    .join(', ');

/** The name of the provider of an item, for the subtitle ("Qobuz", "Spotify"…). */
export function providerName(item, providers) {
  const [domain] = itemDomains(item, providers);
  if (!domain) return '';
  for (const provider of providers?.values() ?? []) {
    if (provider.domain === domain && provider.name) return provider.name;
  }
  return domain;
}

const GLADYS_TYPES = Object.freeze({
  track: 'track',
  album: 'album',
  artist: 'artist',
  playlist: 'playlist',
  radio: 'radio',
  folder: 'folder',
});

/**
 * The MediaItem of a Music Assistant media item or browse folder, or
 * undefined when Gladys has no type for it (podcast, audiobook, genre…).
 * `artwork(url)` returns the artwork key of an image URL.
 */
export function toMediaItem(item, { base, providers, artwork }) {
  if (!isPlain(item)) return undefined;
  const type = GLADYS_TYPES[item.media_type];
  if (!type) return undefined;
  const name = text(item.name);
  if (!name || name === '..') return undefined;
  let id;
  if (type === 'folder') {
    const path = typeof item.path === 'string' && item.path ? item.path : item.uri;
    if (typeof path !== 'string' || !path) return undefined;
    id = `${FOLDER_PREFIX}${path}`;
  } else {
    if (typeof item.uri !== 'string' || !item.uri.includes('://')) return undefined;
    id = item.uri;
  }
  if (id.length > LIMITS.MEDIA_ID) return undefined;
  const version = text(item.version, 60);
  const title = text(version ? `${name} (${version})` : name);
  const source = type === 'folder' ? '' : providerName(item, providers);
  let parts;
  if (type === 'track') parts = [artistsOf(item), text(item.album?.name, 80), source];
  else if (type === 'album') parts = [artistsOf(item), yearOf(item), source];
  else if (type === 'playlist') parts = [text(item.owner, 80), source];
  else parts = [source];
  const subtitle = text(parts.filter((part) => part !== undefined && part !== '').join(' · '));
  const proxyId = proxyIdOfItem(item);
  const duration = finite(item.duration);
  return {
    id,
    type,
    title,
    ...(subtitle ? { subtitle } : {}),
    ...(type === 'track' && duration !== undefined && duration > 0
      ? { duration: Math.round(duration) }
      : {}),
    ...(proxyId && base ? { artwork_key: artwork(imageUrl(base, proxyId, 256)) } : {}),
    browsable: ['folder', 'artist', 'album', 'playlist'].includes(type),
    playable: type !== 'folder',
  };
}

/** The MediaItem of a queue entry (its media item when there is one). */
export function queueItemToMediaItem(entry, options) {
  if (!isPlain(entry)) return undefined;
  const fromMedia = isPlain(entry.media_item) ? toMediaItem(entry.media_item, options) : undefined;
  if (fromMedia) return { ...fromMedia, browsable: false };
  const id = `${QUEUE_ITEM_PREFIX}${text(entry.queue_item_id, 128)}`;
  const title = text(entry.name);
  if (!title || id === QUEUE_ITEM_PREFIX) return undefined;
  const proxyId = proxyIdOfItem(entry);
  const duration = finite(entry.duration);
  return {
    id,
    type: 'track',
    title,
    ...(duration !== undefined && duration > 0 ? { duration: Math.round(duration) } : {}),
    ...(proxyId && options.base
      ? { artwork_key: options.artwork(imageUrl(options.base, proxyId, 256)) }
      : {}),
    browsable: false,
    playable: true,
  };
}

/** The player of a `players/all` entry, checked: `{ id, name, … }` or undefined. */
export function readPlayer(raw) {
  if (!isPlain(raw) || typeof raw.player_id !== 'string') return undefined;
  const id = raw.player_id;
  // eslint-disable-next-line no-control-regex -- control characters are what is refused
  if (!id || id.length > LIMITS.ID || /[\x00-\x1f\x7f]/.test(id)) return undefined;
  const features = new Set(
    (Array.isArray(raw.supported_features) ? raw.supported_features : []).filter(
      (feature) => typeof feature === 'string',
    ),
  );
  const volume = finite(raw.volume_level);
  return {
    id,
    name: text(raw.display_name || raw.name, 100) || id.slice(0, 100),
    provider: text(raw.provider, 64),
    type: text(raw.type, 32),
    available: raw.available !== false,
    enabled: raw.enabled !== false,
    state: typeof raw.playback_state === 'string' ? raw.playback_state : raw.state,
    volume: volume === undefined ? undefined : Math.max(0, Math.min(100, Math.round(volume))),
    muted: typeof raw.volume_muted === 'boolean' ? raw.volume_muted : undefined,
    canVolume:
      features.has('volume_set') || (raw.volume_control !== 'none' && volume !== undefined),
    canMute: features.has('volume_mute') || (raw.mute_control && raw.mute_control !== 'none'),
    activeSource: typeof raw.active_source === 'string' ? raw.active_source : undefined,
    syncedTo: typeof raw.synced_to === 'string' ? raw.synced_to : undefined,
    activeGroup: typeof raw.active_group === 'string' ? raw.active_group : undefined,
    media: isPlain(raw.current_media) ? raw.current_media : undefined,
    elapsed: finite(raw.elapsed_time),
    sourceList: Array.isArray(raw.source_list) ? raw.source_list.filter(isPlain) : [],
    hidden: raw.hide_in_ui === true,
    // The players that sound with this one (a sync leader, a group player).
    members: [
      ...new Set(
        [
          ...(Array.isArray(raw.group_members) ? raw.group_members : []),
          ...(Array.isArray(raw.group_childs) ? raw.group_childs : []),
        ].filter(
          (member) =>
            typeof member === 'string' &&
            member &&
            member !== id &&
            member.length <= LIMITS.ID &&
            // eslint-disable-next-line no-control-regex -- control characters are what is refused
            !/[\x00-\x1f\x7f]/.test(member),
        ),
      ),
    ].slice(0, LIMITS.GROUP_MEMBERS),
  };
}

/** The queue of a `player_queues/*` entry, checked, or undefined. */
export function readQueue(raw) {
  if (!isPlain(raw) || typeof raw.queue_id !== 'string' || !raw.queue_id) return undefined;
  return {
    id: raw.queue_id,
    shuffle: typeof raw.shuffle_enabled === 'boolean' ? raw.shuffle_enabled : undefined,
    repeat: REPEAT_MODES.includes(raw.repeat_mode) ? raw.repeat_mode : undefined,
    currentIndex:
      Number.isInteger(raw.current_index) && raw.current_index >= 0 ? raw.current_index : null,
    items: Number.isInteger(raw.items) && raw.items >= 0 ? raw.items : 0,
    currentItem: isPlain(raw.current_item) ? raw.current_item : undefined,
  };
}

/** The source of the player the queue features describe (its own, or its group's). */
export function activeSource(player) {
  return player.sourceList.find((source) => source.id === player.activeSource);
}

/**
 * The now-playing of a player (for gladys.publishNowPlaying): every key that
 * is known; an unknown value is left out (unchanged), nothing loaded clears
 * the texts explicitly.
 */
export function nowPlaying(player, queue, base) {
  const out = {};
  const state = PLAYBACK[player.state];
  if (state !== undefined) out.playback_state = state;
  const media = player.media;
  if (media) {
    out.title = text(media.title);
    out.artist = text(media.artist);
    out.album = text(media.album);
    const proxyId = proxyIdOfUrl(media.image_url);
    out.artwork_url = proxyId && base ? imageUrl(base, proxyId, 512) : null;
    const duration = finite(media.duration);
    out.duration = duration !== undefined && duration > 0 ? Math.round(duration) : 0;
    const elapsed = finite(media.elapsed_time) ?? player.elapsed;
    if (elapsed !== undefined && elapsed >= 0) out.position = Math.floor(elapsed);
  } else {
    out.title = '';
    out.artist = '';
    out.album = '';
    out.artwork_url = null;
    out.duration = 0;
    out.position = 0;
  }
  if (player.canVolume && player.volume !== undefined) out.volume = player.volume;
  if (player.canMute && player.muted !== undefined) out.mute = player.muted ? 1 : 0;
  if (queue) {
    if (queue.shuffle !== undefined) out.shuffle = queue.shuffle ? 1 : 0;
    if (queue.repeat !== undefined) out.repeat = REPEAT[queue.repeat];
  }
  return out;
}
