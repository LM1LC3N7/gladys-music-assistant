// -----------------------------------------------------------------------------
// The music player contract: browse, search, play (modes), queue, artwork.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { artworkKey, validateMediaItems } from '@gladysassistant/integration-sdk';
import { LIMITS } from '../src/constants.js';
import { setup } from './helpers/app.js';
import { PROXY } from './helpers/fakeMa.js';

const SALON = 'heos_123:aa';
const CUISINE = 'ma_cuisine';
const after = (ma, from) => ma.received.slice(from).map((r) => [r.command, r.args]);

async function ready(t, options) {
  const env = await setup(options);
  t.after(() => env.close());
  await env.ready();
  return env;
}

test('browse: the root, a folder (".." left out), paging and the full total', async (t) => {
  const env = await ready(t);
  const device = env.device(CUISINE);
  const root = await env.gladys.fake.musicBrowse(device, { parentId: null });
  assert.deepEqual(
    root.data.items.map((i) => [i.id, i.type, i.browsable, i.playable]),
    [
      ['ma-folder:qobuz--Q1://', 'folder', true, false],
      ['ma-folder:spotify--S1://', 'folder', true, false],
    ],
  );
  const folder = await env.gladys.fake.musicBrowse(device, {
    parentId: 'ma-folder:qobuz--Q1://',
    offset: 1,
    limit: 1,
  });
  assert.deepEqual(env.ma.last('music/browse'), { path: 'qobuz--Q1://' });
  assert.equal(folder.data.total, 2);
  assert.deepEqual(
    folder.data.items.map((i) => i.title),
    ['Chill Céline'],
  );
});

test('browse an artist: its albums from its provider, latest first, with the year', async (t) => {
  const env = await ready(t);
  const device = env.device(CUISINE);
  const page = await env.gladys.fake.musicBrowse(device, { parentId: 'library://artist/7' });
  assert.deepEqual(env.ma.last('music/artists/artist_albums'), {
    item_id: '38457',
    provider_instance_id_or_domain: 'qobuz--Q1',
  });
  const years = page.data.items.map((i) => Number(/· (\d{4}) ·/.exec(i.subtitle)?.[1]));
  assert.deepEqual(
    years,
    [...years].sort((a, b) => b - a),
  );
  assert.equal(page.data.items[0].subtitle, 'Céline Dion · 2025 · Qobuz');
  assert.deepEqual(validateMediaItems(page.data.items), []);
  const album = await env.gladys.fake.musicBrowse(device, {
    parentId: 'qobuz--Q1://album/qz-courage',
  });
  assert.deepEqual(env.ma.last('music/albums/album_tracks'), {
    item_id: 'qz-courage',
    provider_instance_id_or_domain: 'qobuz--Q1',
  });
  assert.equal(album.data.items[0].type, 'track');
  const other = await env.gladys.fake.musicBrowse(device, { parentId: 'not a uri' });
  assert.equal(other.success, false);
});

test('search: every type in order, one type, the limit, an empty query', async (t) => {
  const env = await ready(t);
  const device = env.device(CUISINE);
  const all = await env.gladys.fake.musicSearch(device, { query: 'c', type: null, limit: 50 });
  assert.deepEqual(env.ma.last('music/search'), {
    search_query: 'c',
    media_types: ['artist', 'album', 'track', 'playlist', 'radio'],
    limit: 25,
  });
  assert.deepEqual(
    [...new Set(all.data.items.map((i) => i.type))],
    ['artist', 'album', 'track', 'playlist'],
  );
  assert.deepEqual(validateMediaItems(all.data.items), []);
  const albums = await env.gladys.fake.musicSearch(device, {
    query: 'encore',
    type: 'album',
    limit: 1,
  });
  assert.deepEqual(env.ma.last('music/search').media_types, ['album']);
  assert.equal(albums.data.items.length, 1);
  assert.equal(albums.data.items[0].subtitle, 'Céline Dion · 2016 · Spotify');
  const before = env.ma.count('music/search');
  const empty = await env.gladys.fake.musicSearch(device, { query: '   ', type: null });
  assert.deepEqual(empty.data.items, []);
  assert.equal(env.ma.count('music/search'), before);
});

test('play: replace, next and append (add in Music Assistant), the cap first, never a folder', async (t) => {
  const env = await ready(t);
  const device = env.device(SALON);
  let from = env.ma.received.length;
  await env.gladys.fake.musicPlay(device, { id: 'library://album/21', type: 'album' }, 'replace');
  assert.deepEqual(after(env.ma, from), [
    ['players/cmd/volume_set', { player_id: SALON, volume_level: 60 }],
    [
      'player_queues/play_media',
      { queue_id: SALON, media: 'library://album/21', option: 'replace' },
    ],
  ]);
  for (const [mode, option] of [
    ['next', 'next'],
    ['append', 'add'],
  ]) {
    await env.gladys.fake.musicPlay(device, { id: 'library://track/401', type: 'track' }, mode);
    assert.equal(env.ma.last('player_queues/play_media').option, option);
  }
  from = env.ma.received.length;
  for (const id of ['ma-folder:qobuz--Q1://', 'ma-queue-item:q1', 'plain']) {
    const ack = await env.gladys.fake.musicPlay(device, { id, type: 'folder' }, 'replace');
    assert.equal(ack.success, false, id);
  }
  assert.deepEqual(after(env.ma, from), []);
});

test('queue: a page, the current index and the full total; jump to an index', async (t) => {
  const env = await ready(t, {
    ma: {
      queues: [
        {
          queue_id: 'heos_123:aa',
          items: 30,
          current_index: 4,
          shuffle_enabled: false,
          repeat_mode: 'off',
        },
        { queue_id: 'ma_cuisine', items: 0, current_index: null },
      ],
    },
  });
  const device = env.device(SALON);
  const page = await env.gladys.fake.musicQueueGet(device, { offset: 10, limit: 5 });
  assert.equal(page.data.total, 30);
  assert.equal(page.data.currentIndex ?? page.data.current_index, 4);
  assert.deepEqual(
    page.data.items.map((i) => i.title),
    ['Titre 10', 'Titre 11', 'Titre 12', 'Titre 13', 'Titre 14'],
  );
  assert.deepEqual(env.ma.last('player_queues/items'), { queue_id: SALON, limit: 5, offset: 10 });
  const from = env.ma.received.length;
  await env.gladys.fake.musicQueuePlay(device, 7);
  assert.deepEqual(after(env.ma, from), [
    ['players/cmd/volume_set', { player_id: SALON, volume_level: 60 }],
    ['player_queues/play_index', { queue_id: SALON, index: 7 }],
  ]);
  assert.equal((await env.gladys.fake.musicQueuePlay(device, -1)).success, false);
});

test('artwork: fetched from the image proxy of the configured server only, bounded', async (t) => {
  const env = await ready(t);
  const url = `${env.ma.url}/imageproxy/${PROXY}?size=512&fmt=jpeg`;
  const key = env.gladys.artworkKey(url);
  const ok = await env.gladys.fake.musicGetArtwork(key);
  assert.equal(ok.success, true, ok.error);
  assert.equal(
    Buffer.from(ok.data.image ?? ok.data, 'base64').toString('hex'),
    env.ma.imageBytes.toString('hex'),
  );

  // Too large at 512 px: the 256 px one is asked instead.
  env.ma.imageBytes = (u) =>
    u.searchParams.get('size') === '512'
      ? Buffer.alloc(LIMITS.ARTWORK_BYTES + 1)
      : Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const smaller = await env.gladys.fake.musicGetArtwork(env.gladys.artworkKey(`${url}&v=2`));
  assert.equal(smaller.success, true);
  assert.match(env.ma.lastImage, /size=256/);

  env.ma.imageType = 'text/html';
  assert.equal(
    (await env.gladys.fake.musicGetArtwork(env.gladys.artworkKey(`${url}&v=3`))).success,
    false,
  );

  // Another host: never fetched.
  const images = env.ma.images;
  const foreign = artworkKey('http://192.0.2.1:8095/imageproxy/abcdef0123456789?size=512&fmt=jpeg');
  env.gladys.artworkKey('http://192.0.2.1:8095/imageproxy/abcdef0123456789?size=512&fmt=jpeg');
  assert.equal((await env.gladys.fake.musicGetArtwork(foreign)).success, false);
  assert.equal(env.ma.images, images);
});
