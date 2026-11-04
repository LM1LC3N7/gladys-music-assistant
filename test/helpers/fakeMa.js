// -----------------------------------------------------------------------------
// A fake Music Assistant server on a real loopback HTTP + WebSocket server,
// faithful to the API of Music Assistant 2.10.9 (checked against the real
// image, see TODO.md): the ServerInfoMessage sent first, "setup required"
// (error for message_id "connection", then close), commands refused with
// error 20 before `auth`, `auth` answered `{ authenticated, user }` or error
// 23, results split in `partial: true` parts, `{ error_code, details }`
// errors, events `{ event, object_id, data }` after the authentication only,
// and the image proxy (`GET /imageproxy/<id>?size=&fmt=`, no token needed).
//
// The catalog: Céline Dion in the library with a Qobuz and a Spotify mapping,
// albums on both providers (studio, live, single, compilation, reissues),
// tracks, playlists, a radio; two players (one above the volume cap).
// -----------------------------------------------------------------------------

import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

export const TOKEN =
  'eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjQxMDI0NDQ4MDAsInN1YiI6InUxIn0.c2VjcmV0LXRlc3Qtc2lnbmF0dXJl';
export const SERVER_ID = 'dfc57d8a66d0458088b488d342baa10c';
export const PROXY = '1f6cce43feb48957a497e30c5feb3b2680085c7ad4ba0c24be9a0850f278715e';

const image = (id = PROXY) => ({
  type: 'thumb',
  path: '/app/x.png',
  provider: 'builtin',
  remotely_accessible: false,
  proxy_id: id,
});

const mapping = (provider, itemId) => ({
  item_id: itemId,
  provider_domain: provider.split('--')[0],
  provider_instance: provider,
  available: true,
  in_library: true,
});

const album = (provider, id, name, year, type = 'album', version = '') => ({
  item_id: id,
  provider,
  name,
  version,
  uri: `${provider}://album/${id}`,
  media_type: 'album',
  year,
  album_type: type,
  artists: [{ item_id: 'x', provider, name: 'Céline Dion', media_type: 'artist' }],
  metadata: { images: [image()] },
  provider_mappings: [mapping(provider, id)],
});

/** Every item of the catalog, as Music Assistant serializes them (the fields the module reads). */
export function catalog() {
  const celine = {
    item_id: '7',
    provider: 'library',
    name: 'Céline Dion',
    version: '',
    uri: 'library://artist/7',
    media_type: 'artist',
    metadata: { images: [image()] },
    provider_mappings: [mapping('qobuz--Q1', '38457'), mapping('spotify--S1', '4S9EykWX')],
  };
  const qobuzOnly = {
    item_id: '901',
    provider: 'qobuz--Q1',
    name: 'Zaz',
    uri: 'qobuz--Q1://artist/901',
    media_type: 'artist',
    metadata: { images: [] },
    provider_mappings: [mapping('qobuz--Q1', '901')],
  };
  const yearless = {
    item_id: '12',
    provider: 'library',
    name: 'Sans Année',
    uri: 'library://artist/12',
    media_type: 'artist',
    provider_mappings: [mapping('qobuz--Q1', '1200')],
  };
  return {
    artists: [celine, qobuzOnly, yearless],
    albums: [
      {
        ...album('library', '21', 'Courage', 2019),
        provider_mappings: [
          mapping('qobuz--Q1', 'qz-courage'),
          mapping('spotify--S1', 'sp-courage'),
        ],
      },
      album('spotify--S1', 'sp-encore', 'Encore un soir', 2016),
    ],
    tracks: [
      {
        item_id: '401',
        provider: 'library',
        name: 'Pour que tu m’aimes encore',
        version: '',
        uri: 'library://track/401',
        media_type: 'track',
        duration: 254,
        artists: [{ name: 'Céline Dion' }],
        album: { name: 'D’eux' },
        metadata: { images: [image()] },
        provider_mappings: [mapping('qobuz--Q1', 'qz-t401'), mapping('spotify--S1', 'sp-t401')],
      },
    ],
    playlists: [
      {
        item_id: 'pl1',
        provider: 'spotify--S1',
        name: 'Chill Céline',
        owner: 'Louis',
        uri: 'spotify--S1://playlist/pl1',
        media_type: 'playlist',
        provider_mappings: [mapping('spotify--S1', 'pl1')],
      },
    ],
    radio: [
      {
        item_id: 'r1',
        provider: 'radiobrowser',
        name: 'FIP',
        uri: 'radiobrowser://radio/r1',
        media_type: 'radio',
        provider_mappings: [mapping('radiobrowser', 'r1')],
      },
    ],
    artistAlbums: {
      'qobuz--Q1/38457': [
        album('qobuz--Q1', 'qz-encore', 'Encore un soir', 2016),
        album('qobuz--Q1', 'qz-courage', 'Courage', 2019),
        album('qobuz--Q1', 'qz-courage-dlx', 'Courage', 2019, 'album', 'Deluxe Edition'),
        album('qobuz--Q1', 'qz-live', 'Live 2020', 2020, 'live'),
        album('qobuz--Q1', 'qz-love', 'Love Again', 2023, 'single'),
        album('qobuz--Q1', 'qz-best', 'The Best So Far', 2025, 'compilation'),
        album('qobuz--Q1', 'qz-remaster', 'S’il suffisait d’aimer (Remastered)', 2024),
        album('qobuz--Q1', 'qz-ssda', 'S’il suffisait d’aimer', 1998),
      ],
      'spotify--S1/4S9EykWX': [
        album('spotify--S1', 'sp-encore', 'Encore un soir', 2016),
        album('spotify--S1', 'sp-courage', 'Courage', 2019),
        album('spotify--S1', 'sp-lovea', 'Love Again (Soundtrack)', 2023, 'soundtrack'),
        album('spotify--S1', 'sp-new', 'Nouvel Album', 2026),
      ],
      'qobuz--Q1/1200': [
        album('qobuz--Q1', 'na1', 'Premier', null),
        album('qobuz--Q1', 'na2', 'Second', null),
      ],
      'library/7': [album('library', '21', 'Courage', 2019)],
    },
  };
}

export function player(id, name, extra = {}) {
  return {
    player_id: id,
    provider: 'heos',
    type: 'player',
    name,
    display_name: name,
    available: true,
    enabled: true,
    supported_features: ['volume_set', 'volume_mute', 'pause', 'set_members'],
    playback_state: 'idle',
    elapsed_time: null,
    volume_level: 20,
    volume_muted: false,
    active_source: id,
    source_list: [{ id, name: 'Music Assistant Queue' }],
    current_media: null,
    volume_control: 'native',
    mute_control: 'native',
    ...extra,
  };
}

export function queue(id, extra = {}) {
  return {
    queue_id: id,
    active: true,
    items: 0,
    shuffle_enabled: false,
    repeat_mode: 'off',
    current_index: null,
    current_item: null,
    ...extra,
  };
}

export const PROVIDERS = [
  { instance_id: 'qobuz--Q1', domain: 'qobuz', name: 'Qobuz', type: 'music', available: true },
  {
    instance_id: 'spotify--S1',
    domain: 'spotify',
    name: 'Spotify',
    type: 'music',
    available: true,
  },
  {
    instance_id: 'radiobrowser',
    domain: 'radiobrowser',
    name: 'Radio Browser',
    type: 'music',
    available: true,
  },
  {
    instance_id: 'radio_playlist',
    domain: 'radio_playlist',
    name: 'Endless Mix Playlists',
    type: 'plugin',
    available: true,
  },
  {
    instance_id: 'musicbrainz',
    domain: 'musicbrainz',
    name: 'MusicBrainz',
    type: 'metadata',
    available: true,
  },
];

const norm = (s) =>
  String(s ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

/**
 * `fakeMa({ token, schema, minSchema, setupRequired, latencyMs, partialSize,
 * autoPong, players, queues, providers })`. `srv.handlers[command] = (args,
 * srv) => result` overrides a command (throw `{ error_code, details }` for an
 * error, return `srv.SILENT` to never answer).
 */
export async function fakeMa(options = {}) {
  const srv = {
    SILENT: Symbol('silent'),
    token: options.token ?? TOKEN,
    info: {
      server_id: SERVER_ID,
      server_version: '2.10.9',
      schema_version: options.schema ?? 65,
      min_supported_schema_version: options.minSchema ?? 28,
      base_url: 'http://172.17.0.2:8095',
      homeassistant_addon: false,
      onboard_done: true,
      name: 'Music Assistant (test)',
      status: 'running',
      ...(options.info ?? {}),
    },
    setupRequired: options.setupRequired ?? false,
    latencyMs: options.latencyMs ?? 0,
    partialSize: options.partialSize ?? 0,
    players: options.players ?? [
      player('heos_123:aa', 'Salon', { volume_level: 70 }),
      player('ma_cuisine', 'Cuisine', { provider: 'snapcast' }),
    ],
    queues: options.queues ?? [queue('heos_123:aa'), queue('ma_cuisine')],
    providers: options.providers ?? PROVIDERS,
    catalog: catalog(),
    handlers: {},
    received: [],
    raw: [],
    connections: 0,
    authenticated: 0,
    sockets: new Set(),
    images: 0,
    imageBytes: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]),
    imageType: 'image/jpeg',
  };

  const http = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'GET' && url.pathname.startsWith('/imageproxy/')) {
      srv.images += 1;
      srv.lastImage = url.pathname + url.search;
      const body = typeof srv.imageBytes === 'function' ? srv.imageBytes(url) : srv.imageBytes;
      if (srv.chunked) {
        // No content-length: the size is only known by reading.
        res.writeHead(200, { 'content-type': srv.imageType });
        for (let i = 0; i < body.length; i += 16384) res.write(body.subarray(i, i + 16384));
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': srv.imageType, 'content-length': body.length });
      res.end(body);
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found');
  });
  const wss = new WebSocketServer({
    server: http,
    path: '/ws',
    autoPong: options.autoPong ?? true,
  });

  const findPlayer = (id) => srv.players.find((p) => p.player_id === id);
  srv.event = (event, objectId, data) => {
    for (const socket of srv.sockets) {
      if (socket.authenticated) socket.send(JSON.stringify({ event, object_id: objectId, data }));
    }
  };
  const updatePlayer = (id, change) => {
    const p = findPlayer(id);
    if (!p) throw { error_code: 10, details: `Player ${id} is not available` };
    Object.assign(p, change);
    srv.event('player_updated', id, p);
    return null;
  };
  const updateQueue = (id, change) => {
    const q = srv.queues.find((x) => x.queue_id === id);
    if (!q) throw { error_code: 2, details: `Queue ${id} not found` };
    Object.assign(q, change);
    srv.event('queue_updated', id, q);
    return null;
  };

  const search = (args) => {
    const types = args.media_types ?? ['artist', 'album', 'track', 'playlist', 'radio'];
    const providers = args.providers;
    const wantLibrary = !providers || providers.includes('library');
    const allowed = (item) => {
      if (item.provider === 'library') return wantLibrary;
      if (!providers) return true;
      return providers.includes(item.provider) || providers.includes(item.provider.split('--')[0]);
    };
    const q = norm(args.search_query);
    const pick = (list) =>
      list.filter((i) => norm(i.name).includes(q) && allowed(i)).slice(0, args.limit ?? 25);
    const c = srv.catalog;
    return {
      artists: types.includes('artist') ? pick(c.artists) : [],
      albums: types.includes('album') ? pick(c.albums) : [],
      genres: [],
      tracks: types.includes('track') ? pick(c.tracks) : [],
      playlists: types.includes('playlist') ? pick(c.playlists) : [],
      radio: types.includes('radio') ? pick(c.radio) : [],
      audiobooks: [],
      podcasts: [],
      sound_effects: [],
    };
  };

  const commands = {
    info: () => srv.info,
    'players/all': () => srv.players,
    'player_queues/all': () => srv.queues,
    providers: (args) =>
      args?.provider_type
        ? srv.providers.filter((p) => p.type === args.provider_type)
        : srv.providers,
    'players/get': (args) => findPlayer(args.player_id) ?? null,
    'players/cmd/play': (a) => updatePlayer(a.player_id, { playback_state: 'playing' }),
    'players/cmd/pause': (a) => updatePlayer(a.player_id, { playback_state: 'paused' }),
    'players/cmd/stop': (a) => updatePlayer(a.player_id, { playback_state: 'idle' }),
    'players/cmd/next': (a) => updatePlayer(a.player_id, {}),
    'players/cmd/previous': (a) => updatePlayer(a.player_id, {}),
    'players/cmd/seek': (a) => updatePlayer(a.player_id, { elapsed_time: a.position }),
    'players/cmd/volume_set': (a) => updatePlayer(a.player_id, { volume_level: a.volume_level }),
    'players/cmd/volume_mute': (a) => updatePlayer(a.player_id, { volume_muted: a.muted }),
    'players/cmd/group': (a) => updatePlayer(a.player_id, { synced_to: a.target_player }),
    'players/cmd/ungroup': (a) => updatePlayer(a.player_id, { synced_to: null }),
    'player_queues/shuffle': (a) => updateQueue(a.queue_id, { shuffle_enabled: a.shuffle_enabled }),
    'player_queues/repeat': (a) => updateQueue(a.queue_id, { repeat_mode: a.repeat_mode }),
    'player_queues/get': (a) => srv.queues.find((q) => q.queue_id === a.queue_id) ?? null,
    'player_queues/items': (a) => {
      const all = Array.from({ length: 30 }, (_, i) => ({
        queue_id: a.queue_id,
        queue_item_id: `qi${i}`,
        name: `Céline Dion - Titre ${i}`,
        duration: 200 + i,
        media_item: {
          ...srv.catalog.tracks[0],
          name: `Titre ${i}`,
          uri: `library://track/${500 + i}`,
        },
      }));
      return all.slice(a.offset ?? 0, (a.offset ?? 0) + (a.limit ?? 500));
    },
    'player_queues/play_index': (a) => updateQueue(a.queue_id, { current_index: a.index }),
    'player_queues/play_media': (a) => {
      updateQueue(a.queue_id, { items: 12, current_index: 0 });
      return null;
    },
    'music/search': search,
    'music/browse': (a) => {
      if (!a.path) {
        return [
          {
            item_id: 'root',
            provider: 'qobuz--Q1',
            name: 'Qobuz',
            uri: 'qobuz--Q1://',
            path: 'qobuz--Q1://',
            media_type: 'folder',
            image: null,
          },
          {
            item_id: 'root',
            provider: 'spotify--S1',
            name: 'Spotify',
            uri: 'spotify--S1://',
            path: 'spotify--S1://',
            media_type: 'folder',
            image: null,
          },
        ];
      }
      return [
        {
          item_id: 'root',
          provider: 'library',
          name: '..',
          uri: 'library://folder/root',
          path: 'root',
          media_type: 'folder',
        },
        {
          item_id: 'artists',
          provider: 'qobuz--Q1',
          name: 'Artists',
          uri: 'qobuz--Q1://folder/artists',
          path: 'qobuz--Q1://artists',
          media_type: 'folder',
        },
        ...srv.catalog.playlists,
      ];
    },
    'music/item_by_uri': (a) => {
      const all = [...srv.catalog.artists, ...srv.catalog.albums, ...srv.catalog.tracks];
      const item = all.find((i) => i.uri === a.uri);
      if (!item) throw { error_code: 2, details: `Item not found: ${a.uri}` };
      return item;
    },
    'music/artists/artist_albums': (a) =>
      srv.catalog.artistAlbums[`${a.provider_instance_id_or_domain}/${a.item_id}`] ?? [],
    'music/albums/album_tracks': () => srv.catalog.tracks,
    'music/playlists/playlist_tracks': () => srv.catalog.tracks,
  };

  const answer = (socket, id, result) => {
    if (srv.partialSize > 0 && Array.isArray(result) && result.length > srv.partialSize) {
      for (let i = 0; i < result.length - srv.partialSize; i += srv.partialSize) {
        socket.send(
          JSON.stringify({
            message_id: id,
            result: result.slice(i, i + srv.partialSize),
            partial: true,
          }),
        );
      }
      const rest = result.length % srv.partialSize || srv.partialSize;
      socket.send(JSON.stringify({ message_id: id, result: result.slice(-rest), partial: false }));
      return;
    }
    socket.send(JSON.stringify({ message_id: id, result, partial: false }));
  };

  wss.on('connection', (socket) => {
    srv.connections += 1;
    srv.sockets.add(socket);
    socket.on('close', () => srv.sockets.delete(socket));
    socket.send(JSON.stringify(srv.info));
    if (srv.setupRequired) {
      socket.send(
        JSON.stringify({
          message_id: 'connection',
          error_code: srv.setupRequired === true ? 503 : srv.setupRequired,
          details: 'Setup required',
        }),
      );
      socket.close();
      return;
    }
    socket.on('message', async (data) => {
      srv.raw.push(data.toString());
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        socket.close();
        return;
      }
      const { message_id: id, command, args = {} } = msg;
      srv.received.push({ command, args: command === 'auth' ? { token: '***' } : args });
      if (srv.latencyMs) await new Promise((r) => setTimeout(r, srv.latencyMs));
      if (socket.readyState !== socket.OPEN) return;
      if (command === 'auth') {
        if (args.token === srv.token) {
          socket.authenticated = true;
          srv.authenticated += 1;
          answer(socket, id, { authenticated: true, user: { username: 'gladys', role: 'user' } });
        } else {
          socket.send(
            JSON.stringify({ message_id: id, error_code: 23, details: 'Invalid or expired token' }),
          );
        }
        return;
      }
      if (!socket.authenticated) {
        socket.send(
          JSON.stringify({
            message_id: id,
            error_code: 20,
            details: 'Authentication is required.',
          }),
        );
        return;
      }
      const handler = srv.handlers[command] ?? commands[command];
      if (!handler) {
        socket.send(
          JSON.stringify({
            message_id: id,
            error_code: 12,
            details: `Invalid command: ${command}`,
          }),
        );
        return;
      }
      try {
        const result = await handler(args, srv, { socket, id });
        if (result === srv.SILENT) return;
        answer(socket, id, result ?? null);
      } catch (err) {
        socket.send(
          JSON.stringify({
            message_id: id,
            error_code: err?.error_code ?? 999,
            details: err?.details ?? String(err),
          }),
        );
      }
    });
  });

  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
  srv.port = http.address().port;
  srv.url = `http://127.0.0.1:${srv.port}`;
  /** A promise the test resolves: a handler answering when the test says so. */
  srv.gate = () => {
    let release;
    const promise = new Promise((resolve) => (release = resolve));
    return { promise, release };
  };
  srv.count = (command) => srv.received.filter((r) => r.command === command).length;
  srv.last = (command) => srv.received.filter((r) => r.command === command).at(-1)?.args;
  /** Closes every client connection (as a Music Assistant restart). */
  srv.drop = () => {
    for (const socket of srv.sockets) socket.terminate();
  };
  srv.close = async () => {
    srv.drop();
    await new Promise((resolve) => wss.close(resolve));
    http.closeAllConnections();
    await new Promise((resolve) => http.close(resolve));
  };
  return srv;
}
