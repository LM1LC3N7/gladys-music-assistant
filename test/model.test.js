import { test } from 'node:test';
import assert from 'node:assert/strict';
import { artworkKey, validateMediaItems } from '@gladysassistant/integration-sdk';
import {
  isCompilation,
  isLive,
  isReissue,
  itemDomains,
  nowPlaying,
  pickBest,
  pickLatestAlbum,
  providerRefs,
  proxyIdOfUrl,
  queueItemToMediaItem,
  readPlayer,
  readQueue,
  toMediaItem,
  uriOn,
} from '../src/ma/model.js';
import { PROVIDERS, PROXY, catalog, player, queue } from './helpers/fakeMa.js';

const providers = new Map(
  PROVIDERS.map((p) => [p.instance_id, { domain: p.domain, name: p.name, type: p.type }]),
);
const base = 'http://10.0.0.2:8095';
const options = { base, providers, artwork: artworkKey };
const c = catalog();

test('the latest album of Qobuz: studio albums only, originals before reissues, highest year', () => {
  const latest = pickLatestAlbum(c.artistAlbums['qobuz--Q1/38457']);
  // Not the 2025 compilation, the 2024 remaster, the 2023 single, the 2020
  // live, nor the 2019 deluxe edition: the 2019 studio album.
  assert.equal(latest.album.uri, 'qobuz--Q1://album/qz-courage');
  assert.equal(latest.year, 2019);
});

test('the latest album of Spotify: the newest studio album, never a soundtrack', () => {
  const latest = pickLatestAlbum(c.artistAlbums['spotify--S1/4S9EykWX']);
  assert.equal(latest.album.uri, 'spotify--S1://album/sp-new');
  assert.equal(latest.year, 2026);
});

test('the latest album: the year decides, then the order of Music Assistant', () => {
  const album = (id, year, extra = {}) => ({
    uri: `p://album/${id}`,
    name: id,
    year,
    album_type: 'album',
    ...extra,
  });
  assert.equal(
    pickLatestAlbum([album('a', 2001), album('b', 2003), album('c', 2002)]).album.name,
    'b',
  );
  assert.equal(pickLatestAlbum([album('a', 2003), album('b', 2003)]).album.name, 'a');
  // Only reissues: the newest reissue is still an answer.
  assert.equal(
    pickLatestAlbum([album('x (Remastered)', 2020), album('y', 2021, { version: 'Deluxe' })]).album
      .name,
    'y',
  );
  // An album without a year never wins against a dated one, and none dated is no answer.
  assert.equal(pickLatestAlbum([album('n', null), album('d', 1999)]).album.name, 'd');
  assert.equal(pickLatestAlbum([album('n', null), album('m', undefined)]), undefined);
  assert.equal(pickLatestAlbum([]), undefined);
  // No album typed at all (a provider without types): "unknown" counts.
  assert.equal(
    pickLatestAlbum([
      album('u1', 2010, { album_type: 'unknown' }),
      album('u2', 2012, { album_type: 'unknown' }),
    ]).album.name,
    'u2',
  );
  // Typed albums exist: an "unknown" one does not compete with them.
  assert.equal(
    pickLatestAlbum([album('t', 2010), album('u', 2015, { album_type: 'unknown' })]).album.name,
    't',
  );
  // Years are integers in range.
  assert.equal(pickLatestAlbum([album('bad', 2030.5), album('ok', 2000)]).album.name, 'ok');
});

test('reissues, lives and compilations are told apart by type and title words, in French too', () => {
  for (const name of [
    'Courage (Deluxe Edition)',
    'Courage (Deluxe)',
    'Album (Remastered 2024)',
    'Réédition',
    'D’eux (Édition collector)',
    'Album (remasterisé)',
  ]) {
    assert.ok(isReissue({ name }), name);
  }
  for (const name of [
    'Courage',
    'Olivia',
    'Delivery',
    'Alive',
    'Éditions du soir',
    'Live Forever',
  ]) {
    assert.ok(!isReissue({ name }), name);
  }
  assert.ok(isReissue({ name: 'X', version: 'Remastered' }));
  for (const name of [
    'Live à Paris',
    'Live at Wembley',
    'Courage (Live)',
    'Tour - Live',
    'En concert',
    'Unplugged',
    'Live 1999',
  ]) {
    assert.ok(isLive({ name }), name);
  }
  for (const name of [
    'Live Forever',
    'Live in Love',
    'Alive',
    'Delivery',
    'Olivia',
    'Liveliness',
  ]) {
    assert.ok(!isLive({ name }), name);
  }
  assert.ok(isLive({ name: 'X', album_type: 'live' }));
  assert.ok(isLive({ name: 'X', version: 'Live' }));
  for (const name of [
    'Best Of',
    'The Very Best of Céline Dion',
    'Greatest Hits',
    'Les plus grands succès',
    'The Collection',
    'Anthology',
    'The Essential',
    'L’essentiel',
    'Titanic (Original Motion Picture Soundtrack)',
    'Bande originale du film',
    'Le film (B.O.)',
    'Film (OST)',
    'Best Of 1990-2000 Vol. 2',
  ]) {
    assert.ok(isCompilation({ name, artists: [{ name: 'Céline Dion' }] }), name);
  }
  // The name of the artist next to a form: a best-of.
  assert.ok(isCompilation({ name: 'Céline Dion Anthology', artists: [{ name: 'Céline Dion' }] }));
  assert.ok(!isCompilation({ name: 'The Very Best of Céline Dion', artists: [{ name: 'Zaz' }] }));
  // A keyword outside a telltale form: a studio album (r2).
  for (const name of [
    'Courage',
    'Ghost',
    'Hostile',
    'Bestial',
    'Collectionneur',
    'Best of Me',
    'Essential Love',
    'Music from the Heart',
    'Ost',
  ]) {
    assert.ok(!isCompilation({ name, artists: [{ name: 'Céline Dion' }] }), name);
  }
  // The types of Music Assistant 2.10.9 (music_assistant_models AlbumType: album,
  // single, live, soundtrack, compilation, ep, unknown).
  assert.ok(isCompilation({ name: 'X', album_type: 'compilation' }));
  assert.ok(isCompilation({ name: 'X', album_type: 'soundtrack' }));
});

test('the latest album, honest cases: "Live" in a studio title, a new album out only as Deluxe, best-ofs typed album', () => {
  const album = (name, year, extra = {}) => ({
    uri: `p://album/${name}`,
    name,
    year,
    album_type: 'album',
    ...extra,
  });
  const pick = (list) => pickLatestAlbum(list)?.album.name;
  assert.equal(pick([album('Encore', 2016), album('Live Forever', 2024)]), 'Live Forever');
  assert.equal(
    pick([album('Encore', 2016), album('Nouveau (Deluxe Edition)', 2025)]),
    'Nouveau (Deluxe Edition)',
  );
  assert.equal(
    pick([album('Encore', 2016), album('Nouveau', 2025, { version: 'Édition Collector' })]),
    'Nouveau',
  );
  // A reissue of an album in the list: left out (the original keeps its year).
  assert.equal(
    pick([album('Courage', 2019), album('Courage (Deluxe Edition)', 2021), album('Encore', 2016)]),
    'Courage',
  );
  assert.equal(pick([album('Courage', 2019), album('Courage - Remastered 2024', 2024)]), 'Courage');
  assert.equal(
    pick([
      album('Courage', 2019),
      album('Best Of', 2025),
      album('Greatest Hits', 2024),
      album('Titanic (Original Motion Picture Soundtrack)', 2023),
      album('Live à Paris', 2022),
      album('Courage (Live)', 2021),
      album('Love Again', 2023, { album_type: 'single' }),
      album('Hits', 2026, { album_type: 'compilation' }),
      album('Film', 2026, { album_type: 'soundtrack' }),
      album('EP', 2026, { album_type: 'ep' }),
      album('Show', 2026, { album_type: 'live' }),
    ]),
    'Courage',
  );
  // A reissue whose original has no year is still left out for the original's sake.
  assert.equal(
    pick([album('Courage', null), album('Courage (Remastered)', 2024), album('Encore', 2016)]),
    'Encore',
  );
});

test('the best match: an exact name (accents aside), else the first; restricted to a provider', () => {
  const items = [
    { uri: 'a://artist/1', name: 'Céline Dion Tribute', provider: 'qobuz--Q1' },
    { uri: 'a://artist/2', name: 'CELINE DION', provider: 'spotify--S1' },
  ];
  assert.equal(pickBest(items, 'céline dion').uri, 'a://artist/2');
  assert.equal(pickBest(items, 'Dion').uri, 'a://artist/1');
  assert.equal(pickBest(items, 'céline dion', { domain: 'qobuz', providers }).uri, 'a://artist/1');
  assert.equal(pickBest(items, 'céline dion', { domain: 'deezer', providers }), undefined);
  assert.equal(pickBest([], 'x'), undefined);
  assert.equal(pickBest([{ name: 'no uri' }], 'no uri'), undefined);
});

test('the providers of an item: its own, or the mappings of a library item', () => {
  const [celine, zaz] = c.artists;
  assert.deepEqual([...itemDomains(celine, providers)].sort(), ['qobuz', 'spotify']);
  assert.deepEqual([...itemDomains(zaz, providers)], ['qobuz']);
  const off = {
    ...celine,
    provider_mappings: [{ ...celine.provider_mappings[0], available: false }],
  };
  assert.deepEqual([...itemDomains(off, providers)], []);
  const refs = providerRefs(celine, providers);
  assert.deepEqual(
    refs.map((r) => r.domain),
    ['qobuz', 'spotify'],
  );
  assert.equal(uriOn('artist', refs[1]), 'spotify--S1://artist/4S9EykWX');
  assert.deepEqual(providerRefs(zaz, providers), [
    { itemId: '901', provider: 'qobuz--Q1', domain: 'qobuz' },
  ]);
});

test('MediaItems: ids, types, subtitles with the year and the provider, artwork key', () => {
  const albumItem = toMediaItem(c.albums[1], options);
  assert.deepEqual(albumItem, {
    id: 'spotify--S1://album/sp-encore',
    type: 'album',
    title: 'Encore un soir',
    subtitle: 'Céline Dion · 2016 · Spotify',
    artwork_key: artworkKey(`${base}/imageproxy/${PROXY}?size=256&fmt=jpeg`),
    browsable: true,
    playable: true,
  });
  const track = toMediaItem(c.tracks[0], options);
  assert.equal(track.duration, 254);
  assert.equal(track.subtitle, 'Céline Dion · D’eux · Qobuz');
  assert.equal(track.browsable, false);
  const folder = toMediaItem(
    { media_type: 'folder', name: 'Artists', path: 'qobuz--Q1://artists' },
    options,
  );
  assert.equal(folder.id, 'ma-folder:qobuz--Q1://artists');
  assert.equal(folder.playable, false);
  assert.equal(toMediaItem({ media_type: 'folder', name: '..', path: 'root' }, options), undefined);
  assert.equal(
    toMediaItem({ media_type: 'podcast', name: 'P', uri: 'x://podcast/1' }, options),
    undefined,
  );
  assert.equal(
    toMediaItem({ media_type: 'track', name: 'T', uri: `x://track/${'9'.repeat(600)}` }, options),
    undefined,
  );
  const items = [albumItem, track, folder];
  assert.deepEqual(validateMediaItems(items), []);
});

test('queue entries keep their index: a fallback item when there is no media', () => {
  assert.equal(
    queueItemToMediaItem({ queue_item_id: 'q1', name: 'Stream', duration: 0 }, options).id,
    'ma-queue-item:q1',
  );
  assert.equal(
    queueItemToMediaItem({ queue_item_id: 'q2', media_item: c.tracks[0] }, options).id,
    'library://track/401',
  );
});

test('players and queues read from the server: odd values are unknown, never 0', () => {
  const p = readPlayer(player('aa:bb', 'Salon', { volume_level: '12', volume_muted: 'no' }));
  assert.equal(p.volume, undefined);
  assert.equal(p.muted, undefined);
  assert.equal(readPlayer({ player_id: 'x\ny' }), undefined);
  assert.equal(readPlayer(null), undefined);
  assert.equal(readPlayer(player('a', '', {})).name, 'a');
  const q = readQueue(queue('a', { current_index: -1, repeat_mode: 'sometimes', items: 'many' }));
  assert.equal(q.currentIndex, null);
  assert.equal(q.repeat, undefined);
  assert.equal(q.items, 0);
});

test('now playing: texts, artwork on the configured address, position, volume, shuffle, repeat', () => {
  const p = readPlayer(
    player('a', 'Salon', {
      playback_state: 'playing',
      volume_level: 35,
      volume_muted: true,
      current_media: {
        title: 'Imagine',
        artist: 'Céline Dion',
        album: 'Courage',
        image_url: `http://172.17.0.2:8095/imageproxy/${PROXY}?size=512&fmt=png`,
        duration: 245.6,
        elapsed_time: 12.9,
      },
    }),
  );
  assert.deepEqual(
    nowPlaying(p, readQueue(queue('a', { shuffle_enabled: true, repeat_mode: 'one' })), base),
    {
      playback_state: 1,
      title: 'Imagine',
      artist: 'Céline Dion',
      album: 'Courage',
      artwork_url: `${base}/imageproxy/${PROXY}?size=512&fmt=jpeg`,
      duration: 246,
      position: 12,
      volume: 35,
      mute: 1,
      shuffle: 1,
      repeat: 2,
    },
  );
  const idle = nowPlaying(
    readPlayer(player('a', 'Salon', { playback_state: 'idle' })),
    undefined,
    base,
  );
  assert.deepEqual(
    [idle.playback_state, idle.title, idle.artist, idle.album, idle.artwork_url],
    [2, '', '', '', null],
  );
  assert.equal(
    nowPlaying(readPlayer(player('a', 'S', { playback_state: 'weird' })), undefined, base)
      .playback_state,
    undefined,
  );
  // An image that is not the image proxy is never fetched.
  assert.equal(proxyIdOfUrl('https://cdn.example.com/x.jpg'), undefined);
  assert.equal(proxyIdOfUrl(`http://x/imageproxy/${PROXY}/../../etc`), undefined);
});
