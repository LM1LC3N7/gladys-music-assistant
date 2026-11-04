// -----------------------------------------------------------------------------
// Scene actions: play by search (every kind, the provider choice, "the
// latest album of"), the volume under the cap, groups; and the find button.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, created } from './helpers/app.js';
import { PROVIDERS, SERVER_ID } from './helpers/fakeMa.js';

const SALON = 'heos_123:aa';
const CUISINE = 'ma_cuisine';
const id = (playerId) => created(playerId).external_id;

async function ready(t, options) {
  const env = await setup(options);
  t.after(() => env.close());
  await env.ready();
  env.play = (fields) =>
    env.gladys.fake.sceneAction('play_search', {
      device: id(CUISINE),
      mode: 'replace',
      provider: 'config',
      ...fields,
    });
  env.played = () => env.ma.last('player_queues/play_media');
  return env;
}

test('the latest album of an artist, automatic: the first provider of the artist (Qobuz here)', async (t) => {
  const env = await ready(t);
  const ack = await env.play({ query: 'celine dion', kind: 'latest_album', provider: 'auto' });
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(ack.data.outputs, { title: 'Courage', provider: 'Qobuz', year: 2019 });
  assert.deepEqual(env.played(), {
    queue_id: CUISINE,
    media: 'qobuz--Q1://album/qz-courage',
    option: 'replace',
  });
});

test('the latest album on Spotify: chosen in the action, or by the configuration', async (t) => {
  const env = await ready(t);
  const ack = await env.play({ query: 'Céline Dion', kind: 'latest_album', provider: 'spotify' });
  assert.deepEqual(ack.data.outputs, { title: 'Nouvel Album', provider: 'Spotify', year: 2026 });
  assert.equal(env.played().media, 'spotify--S1://album/sp-new');
  // The search itself asked the library and Spotify only.
  assert.deepEqual(
    env.ma.received.filter((r) => r.command === 'music/search').at(-1).args.providers,
    ['library', 'spotify'],
  );

  await env.app.configUpdated({ ...env.gladys.fake.config, preferred_provider: 'spotify' });
  await env.app.idle();
  const byConfig = await env.play({
    query: 'Céline Dion',
    kind: 'latest_album',
    provider: 'config',
  });
  assert.equal(byConfig.data.outputs.provider, 'Spotify');
  const forced = await env.play({ query: 'Céline Dion', kind: 'latest_album', provider: 'qobuz' });
  assert.equal(forced.data.outputs.provider, 'Qobuz');
});

test('the preferred provider plays its own copy of a library item', async (t) => {
  const env = await ready(t);
  for (const [provider, media] of [
    ['auto', 'library://album/21'],
    ['qobuz', 'qobuz--Q1://album/qz-courage'],
    ['spotify', 'spotify--S1://album/sp-courage'],
  ]) {
    const ack = await env.play({ query: 'Courage', kind: 'album', provider });
    assert.equal(ack.success, true, ack.error);
    assert.equal(env.played().media, media, provider);
  }
});

test('the preferred provider has nothing: every provider is searched', async (t) => {
  const env = await ready(t);
  const ack = await env.play({ query: 'Encore un soir', kind: 'album', provider: 'qobuz' });
  assert.equal(ack.success, true, ack.error);
  assert.equal(env.played().media, 'spotify--S1://album/sp-encore');
  assert.equal(ack.data.outputs.provider, 'Spotify');
  const searches = env.ma.received.filter((r) => r.command === 'music/search').slice(-2);
  assert.deepEqual(
    searches.map((s) => s.args.providers),
    [['library', 'qobuz'], undefined],
  );
});

test('a provider missing in Music Assistant: automatic, never an error', async (t) => {
  const env = await ready(t, { ma: { providers: PROVIDERS.filter((p) => p.domain !== 'qobuz') } });
  const ack = await env.play({ query: 'Courage', kind: 'album', provider: 'qobuz' });
  assert.equal(ack.success, true, ack.error);
  assert.equal(env.played().media, 'library://album/21');
  assert.equal(
    env.ma.received.filter((r) => r.command === 'music/search').at(-1).args.providers,
    undefined,
  );
});

test('track, playlist, artist, radio station, play modes', async (t) => {
  const env = await ready(t);
  for (const [fields, media, option] of [
    [
      { query: 'pour que tu', kind: 'track', provider: 'spotify', mode: 'next' },
      'spotify--S1://track/sp-t401',
      'next',
    ],
    [{ query: 'chill', kind: 'playlist', mode: 'append' }, 'spotify--S1://playlist/pl1', 'add'],
    [{ query: 'zaz', kind: 'artist' }, 'qobuz--Q1://artist/901', 'replace'],
    [{ query: 'fip', kind: 'radio' }, 'radiobrowser://radio/r1', 'replace'],
  ]) {
    const ack = await env.play(fields);
    assert.equal(ack.success, true, ack.error);
    assert.equal(env.played().media, media);
    assert.equal(env.played().option, option);
  }
});

test('artist radio: the Endless Mix of Music Assistant, seeded on the preferred provider', async (t) => {
  const env = await ready(t);
  await env.play({ query: 'Céline Dion', kind: 'artist_radio', provider: 'spotify' });
  assert.equal(env.played().media, 'radio_playlist://playlist/spotify--S1://artist/4S9EykWX');
  await env.play({ query: 'Céline Dion', kind: 'artist_radio', provider: 'auto' });
  assert.equal(env.played().media, 'radio_playlist://playlist/library://artist/7');
  const none = await ready(t, {
    ma: { providers: PROVIDERS.filter((p) => p.domain !== 'radio_playlist') },
  });
  const ack = await none.play({ query: 'Céline Dion', kind: 'artist_radio' });
  assert.equal(ack.success, false);
  assert.match(ack.error, /Endless Mix/);
});

test('clear refusals: nothing found, no release year, an empty text, another player', async (t) => {
  const env = await ready(t);
  const from = env.ma.count('player_queues/play_media');
  const nothing = await env.play({ query: 'zzzz', kind: 'album' });
  assert.match(nothing.error, /Nothing found in Music Assistant for album "zzzz"/);
  const yearless = await env.play({ query: 'Sans Année', kind: 'latest_album' });
  assert.match(yearless.error, /no release year/);
  const empty = await env.play({ query: '  ', kind: 'album' });
  assert.equal(empty.success, false);
  const stranger = await env.gladys.fake.sceneAction('play_search', {
    device: 'ext:music-assistant:player:0000000000000000',
    query: 'x',
  });
  assert.equal(stranger.success, false);
  assert.equal(env.ma.count('player_queues/play_media'), from);
});

test('play by search on a player louder than the cap: brought down first', async (t) => {
  const env = await ready(t);
  await env.play({ device: id(SALON), query: 'Courage', kind: 'album' });
  const tail = env.ma.received.slice(-2).map((r) => r.command);
  assert.deepEqual(tail, ['players/cmd/volume_set', 'player_queues/play_media']);
  assert.equal(env.ma.last('players/cmd/volume_set').volume_level, 60);
});

test('set the volume: never above the cap; a lower value as asked', async (t) => {
  const env = await ready(t);
  const loud = await env.gladys.fake.sceneAction('set_volume', { device: id(CUISINE), volume: 95 });
  assert.deepEqual(loud.data.outputs, { volume: 60 });
  assert.equal(env.ma.last('players/cmd/volume_set').volume_level, 60);
  const low = await env.gladys.fake.sceneAction('set_volume', { device: id(SALON), volume: 10 });
  assert.deepEqual(low.data.outputs, { volume: 10 });
  await env.app.configUpdated({ ...env.gladys.fake.config, max_volume: 25 });
  await env.app.idle();
  const capped = await env.gladys.fake.sceneAction('set_volume', { device: id(SALON), volume: 30 });
  assert.deepEqual(capped.data.outputs, { volume: 25 });
});

test('group: the member is brought under the cap first; ungroup', async (t) => {
  const env = await ready(t);
  const from = env.ma.received.length;
  const ack = await env.gladys.fake.sceneAction('group', {
    device: id(CUISINE),
    member: id(SALON),
  });
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(
    env.ma.received.slice(from).map((r) => [r.command, r.args]),
    [
      ['players/cmd/volume_set', { player_id: SALON, volume_level: 60 }],
      ['players/cmd/group', { player_id: SALON, target_player: CUISINE }],
    ],
  );
  const same = await env.gladys.fake.sceneAction('group', { device: id(SALON), member: id(SALON) });
  assert.equal(same.success, false);
  await env.gladys.fake.sceneAction('ungroup', { device: id(SALON) });
  assert.deepEqual(env.ma.last('players/cmd/ungroup'), { player_id: SALON });
});

test('find Music Assistant: one server saved when no address is typed, else listed', async (t) => {
  const env = await setup({ config: { token: 'x'.repeat(20) } });
  t.after(() => env.close());
  env.gladys.fake.scanResults = {
    mdns: [
      {
        name: `${SERVER_ID}._mass._tcp.local.`,
        host: 'ma.local.',
        addresses: ['fe80::1', '192.168.1.20'],
        port: 8095,
        txt: [
          `server_id=${SERVER_ID}`,
          'server_version=2.10.9',
          'name=Maison',
          'base_url=http://172.17.0.2:8095',
        ],
      },
      {
        name: 'other._mass._tcp.local.',
        addresses: ['192.168.1.30'],
        port: 8095,
        txt: ['nothing=here'],
      },
    ],
  };
  const ack = await env.gladys.fake.action('find_server', {});
  assert.match(ack.data.message.en, /Found and saved: http:\/\/192\.168\.1\.20:8095/);
  assert.equal(env.gladys.fake.config.url, 'http://192.168.1.20:8095');

  await env.app.configUpdated(env.gladys.fake.config);
  const listed = await env.gladys.fake.action('find_server', {});
  assert.match(listed.data.message.fr, /Maison 2\.10\.9 \(http:\/\/192\.168\.1\.20:8095\)/);
  env.gladys.fake.scanResults = { mdns: [] };
  assert.match(
    (await env.gladys.fake.action('find_server', {})).data.message.en,
    /No Music Assistant server/,
  );
});
