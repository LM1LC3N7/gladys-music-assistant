// -----------------------------------------------------------------------------
// Review r1: the volume cap on every path that can start sound (next,
// previous, group members, an unknown volume), the budget of each call of
// Gladys, the guards the mutants of r1 got past, and the minor points.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { LIMITS, TIMINGS } from '../src/constants.js';
import { MaSession } from '../src/ma/client.js';
import { createMemoryStore } from '../src/store.js';
import { refusePort, testClock } from './kit/index.mjs';
import { created, setup, until } from './helpers/app.js';
import { PROXY, TOKEN, fakeMa, player, queue } from './helpers/fakeMa.js';

const SALON = 'heos_123:aa';
const CUISINE = 'ma_cuisine';
const feature = (device, key) => device.features.find((f) => f.external_id.endsWith(`:${key}`));
const after = (ma, from) => ma.received.slice(from).map((r) => [r.command, r.args]);
const id = (playerId) => created(playerId).external_id;

async function ready(t, options) {
  const env = await setup(options);
  t.after(() => env.close());
  await env.ready();
  return env;
}

const salonAt = (volume, extra = {}) => [
  player(SALON, 'Salon', { volume_level: volume, playback_state: 'paused', ...extra }),
  player(CUISINE, 'Cuisine', { provider: 'snapcast' }),
];

// --- B1: every path that can start sound ---------------------------------------------

test('next and previous on a paused player at 90 %: brought down to the cap first', async (t) => {
  for (const key of ['next', 'previous']) {
    const env = await ready(t, { ma: { players: salonAt(90) } });
    const device = env.device(SALON);
    const from = env.ma.received.length;
    const ack = await env.gladys.fake.setValue(device, feature(device, key), 1);
    assert.equal(ack.success, true, ack.error);
    assert.deepEqual(after(env.ma, from), [
      ['players/cmd/volume_set', { player_id: SALON, volume_level: 60 }],
      [`players/cmd/${key}`, { player_id: SALON }],
    ]);
  }
});

test('the cap is exact: 61 % is lowered, 60 % is left alone', async (t) => {
  const env = await ready(t, { ma: { players: salonAt(61) } });
  const device = env.device(SALON);
  let from = env.ma.received.length;
  await env.gladys.fake.setValue(device, feature(device, 'play'), 1);
  assert.deepEqual(after(env.ma, from)[0], [
    'players/cmd/volume_set',
    { player_id: SALON, volume_level: 60 },
  ]);
  from = env.ma.received.length;
  await env.gladys.fake.setValue(device, feature(device, 'play'), 1);
  assert.deepEqual(after(env.ma, from), [['players/cmd/play', { player_id: SALON }]]);
});

test('a group: its members are brought down too, and the leader of a member', async (t) => {
  const env = await ready(t, {
    ma: {
      players: [
        player(SALON, 'Salon', { volume_level: 50, group_members: [SALON, CUISINE, 'gone'] }),
        player(CUISINE, 'Cuisine', { volume_level: 80, synced_to: SALON }),
      ],
    },
  });
  env.ma.handlers['players/get'] = (a) =>
    env.ma.players.find((p) => p.player_id === a.player_id) ?? null;
  const from = env.ma.received.length;
  await env.gladys.fake.musicPlay(
    env.device(SALON),
    { id: 'library://album/21', type: 'album' },
    'replace',
  );
  assert.deepEqual(
    after(env.ma, from).map(([c, a]) => [c, a.player_id ?? a.queue_id, a.volume_level]),
    [
      ['players/cmd/volume_set', CUISINE, 60],
      ['players/get', 'gone', undefined],
      ['player_queues/play_media', SALON, undefined],
    ],
  );
  // Playing on the member: its leader (and its members) are checked too.
  env.ma.players[0].volume_level = 75;
  env.ma.event('player_updated', SALON, env.ma.players[0]);
  await new Promise((r) => setTimeout(r, 30));
  const again = env.ma.received.length;
  await env.gladys.fake.setValue(env.device(CUISINE), feature(env.device(CUISINE), 'play'), 1);
  assert.ok(
    after(env.ma, again).some(
      ([c, a]) => c === 'players/cmd/volume_set' && a.player_id === SALON && a.volume_level === 60,
    ),
  );
});

test('an unknown volume is read again; still unknown: nothing played, a clear error', async (t) => {
  const env = await ready(t, { ma: { players: salonAt(null) } });
  const device = env.device(SALON);
  let from = env.ma.received.length;
  const ack = await env.gladys.fake.setValue(device, feature(device, 'next'), 1);
  assert.equal(ack.success, false);
  assert.match(ack.error, /volume of "Salon" is unknown/);
  assert.deepEqual(
    after(env.ma, from).map(([c]) => c),
    ['players/get'],
  );
  // Read again with a volume: lowered, then played.
  env.ma.players[0].volume_level = 95;
  from = env.ma.received.length;
  const ok = await env.gladys.fake.setValue(device, feature(device, 'next'), 1);
  assert.equal(ok.success, true, ok.error);
  assert.deepEqual(
    after(env.ma, from).map(([c]) => c),
    ['players/get', 'players/cmd/volume_set', 'players/cmd/next'],
  );
});

test('the volume of a group player is set member by member, each under the cap', async (t) => {
  const env = await ready(t, {
    ma: {
      players: [
        player('grp', 'Rez-de-chaussée', {
          type: 'group',
          provider: 'sync_group',
          group_members: [SALON, CUISINE],
        }),
        player(SALON, 'Salon', { volume_level: 30 }),
        player(CUISINE, 'Cuisine', { volume_level: 30 }),
      ],
    },
    devices: [created('grp', 'Rez-de-chaussée')],
  });
  const ack = await env.gladys.fake.sceneAction('set_volume', { device: id('grp'), volume: 90 });
  assert.deepEqual(ack.data.outputs, { volume: 60 });
  assert.deepEqual(
    env.ma.received.filter((r) => r.command === 'players/cmd/volume_set').map((r) => r.args),
    [
      { player_id: SALON, volume_level: 60 },
      { player_id: CUISINE, volume_level: 60 },
    ],
  );
});

// --- I1: one budget per call of Gladys -------------------------------------------------

test('budget: a read gets at most what is left; with too little left, no effect is sent', async (t) => {
  const env = await ready(t);
  const cur = env.app.current;
  const from = env.ma.received.length;
  await assert.rejects(
    env.app.send(
      cur,
      'player_queues/play_media',
      { queue_id: SALON },
      { effect: true, deadline: env.app.deadline(1000) },
    ),
    /too slow: nothing more was sent/,
  );
  assert.deepEqual(after(env.ma, from), []);
  // Urgent commands are never held by the budget.
  await env.app.send(
    cur,
    'players/cmd/pause',
    { player_id: SALON },
    { urgent: true, deadline: env.app.deadline(10) },
  );
  env.ma.handlers['music/browse'] = (_a, srv) => srv.SILENT;
  const read = env.app.send(
    cur,
    'music/browse',
    {},
    { timeout: TIMINGS.MUSIC, deadline: env.app.deadline(2000) },
  );
  const failed = read.catch((e) => e);
  await new Promise((r) => setTimeout(r, 20));
  await env.clock.advance(2001);
  assert.match((await failed).message, /no answer in time/);
});

test('budget: opening an artist answers within 8.5 s in all, however its steps are split', async (t) => {
  const env = await ready(t);
  const gate = env.ma.gate();
  env.ma.handlers['music/item_by_uri'] = () => gate.promise;
  env.ma.handlers['music/artists/artist_albums'] = (_a, srv) => srv.SILENT;
  let settled = false;
  const pending = env.gladys.fake
    .musicBrowse(env.device(CUISINE), { parentId: 'library://artist/7' })
    .finally(() => (settled = true));
  await until(() => env.ma.count('music/item_by_uri') === 1, 'asked');
  await env.clock.advance(5000);
  gate.release(env.ma.catalog.artists[0]);
  await until(() => env.ma.count('music/artists/artist_albums') === 1, 'albums asked');
  // 5 s spent: the albums get the 3.5 s left, not their own 8 s.
  await env.clock.advance(TIMINGS.MUSIC_BUDGET - 5000 + 50);
  await until(() => settled, 'answered within the budget');
  assert.equal((await pending).success, false);
});

test('budget: a slow volume step leaves no time to play, so nothing plays after the answer', async (t) => {
  const env = await ready(t);
  const gate = env.ma.gate();
  env.ma.handlers['players/cmd/volume_set'] = () => gate.promise;
  const pending = env.gladys.fake.musicPlay(
    env.device(SALON),
    { id: 'library://album/21', type: 'album' },
    'replace',
  );
  await until(() => env.ma.count('players/cmd/volume_set') === 1, 'volume asked');
  await env.clock.advance(TIMINGS.MUSIC_BUDGET - TIMINGS.EFFECT_MIN + 100);
  gate.release(null);
  const ack = await pending;
  assert.equal(ack.success, false);
  assert.ok(/too slow|no answer/.test(ack.error), ack.error);
  assert.equal(env.ma.count('player_queues/play_media'), 0);
});

// --- I4: guards the mutants of r1 got past --------------------------------------------

test('a lower volume (dashboard, scene) and the lowering before play pass a full queue of commands', async (t) => {
  const env = await ready(t);
  const cuisine = env.device(CUISINE);
  env.ma.handlers['players/cmd/next'] = (_a, srv) => srv.SILENT;
  const stuck = Array.from({ length: 40 }, () =>
    env.gladys.fake.setValue(cuisine, feature(cuisine, 'next'), 1),
  );
  await until(() => env.ma.count('players/cmd/next') >= LIMITS.IN_FLIGHT, 'queue full');
  const salon = env.device(SALON); // 70 %
  assert.equal((await env.gladys.fake.setValue(salon, feature(salon, 'volume'), 30)).success, true);
  assert.equal(
    (await env.gladys.fake.sceneAction('set_volume', { device: id(SALON), volume: 20 })).success,
    true,
  );
  env.ma.players[0].volume_level = 90;
  env.ma.event('player_updated', SALON, env.ma.players[0]);
  await new Promise((r) => setTimeout(r, 30));
  const from = env.ma.received.length;
  const unmute = await env.gladys.fake.setValue(salon, feature(salon, 'mute'), 0);
  // The lowering went through; the unmute itself (not urgent) waits its turn.
  assert.deepEqual(after(env.ma, from)[0], [
    'players/cmd/volume_set',
    { player_id: SALON, volume_level: 60 },
  ]);
  assert.equal(unmute.success, false);
  await env.clock.advance(TIMINGS.COMMAND + 1);
  await Promise.all(stuck);
});

test('artwork: never fetched from another host, and bounded while read (no content-length)', async (t) => {
  const env = await ready(t);
  let foreignHits = 0;
  const foreign = createServer((req, res) => {
    foreignHits += 1;
    res.writeHead(200, { 'content-type': 'image/jpeg' });
    res.end(Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  });
  await new Promise((r) => foreign.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => foreign.close(r)));
  const url = `http://127.0.0.1:${foreign.address().port}/imageproxy/${PROXY}?size=512&fmt=jpeg`;
  const ack = await env.gladys.fake.musicGetArtwork(env.gladys.artworkKey(url));
  assert.equal(ack.success, false);
  assert.equal(foreignHits, 0);

  env.ma.chunked = true;
  env.ma.imageBytes = Buffer.alloc(LIMITS.ARTWORK_BYTES + 1);
  const big = await env.gladys.fake.musicGetArtwork(
    env.gladys.artworkKey(`${env.ma.url}/imageproxy/${PROXY}?size=512&fmt=jpeg&v=big`),
  );
  assert.equal(big.success, false);
  assert.match(big.error, /too large/);
});

test('the reconnection waits at most 5 min, and starts again from 2 s only after a session that lived', async (t) => {
  const port = await refusePort();
  const env = await setup({ config: { url: `127.0.0.1:${port}`, token: TOKEN } });
  t.after(() => env.close());
  for (let i = 0; i < 12; i += 1) {
    await until(() => env.app.retryTimer !== undefined, 'a try planned');
    await env.clock.advance(TIMINGS.RETRY_MAX);
  }
  await until(() => /tried again in 5 min/.test(env.status().message.en), '5 min');
  assert.equal(env.app.retryDelay, TIMINGS.RETRY_MAX);

  // A server that accepts then drops at once: 2 s, then 4 s, not 2 s forever.
  const flaky = await setup();
  t.after(() => flaky.close());
  await flaky.ready();
  flaky.ma.drop();
  await until(() => /tried again in 2 s/.test(flaky.status().message.en), 'first loss');
  await flaky.clock.advance(TIMINGS.RETRY_MIN);
  await until(() => flaky.app.current?.ready, 'back');
  flaky.ma.drop();
  await until(() => /tried again in 4 s/.test(flaky.status().message.en), 'second loss doubled');
  // After a session that lived a minute, from 2 s again.
  await flaky.clock.advance(TIMINGS.RETRY_MIN * 2);
  await until(() => flaky.app.current?.ready, 'back again');
  await flaky.clock.advance(TIMINGS.STABLE);
  flaky.ma.drop();
  await until(
    () => /lost.*tried again in 2 s/.test(flaky.status().message.en),
    'reset after a stable session',
  );
});

test('partial parts are bounded while they arrive, an answer to nothing is ignored', async (t) => {
  const ma = await fakeMa();
  const session = new MaSession({ url: `ws://127.0.0.1:${ma.port}/ws`, token: TOKEN });
  t.after(async () => {
    await session.close();
    await ma.close();
  });
  ma.handlers['music/browse'] = (_a, srv, { socket, id: messageId }) => {
    for (let i = 0; i < 3; i += 1) {
      socket.send(
        JSON.stringify({
          message_id: messageId,
          result: Array(LIMITS.PARTIAL_ITEMS).fill(i),
          partial: true,
        }),
      );
    }
    socket.send(JSON.stringify({ message_id: 'not-ours', result: 1 }));
    return srv.SILENT;
  };
  await session.start();
  session.request('music/browse', {}, { timeout: 5000 }).catch(() => {});
  await until(() => [...session.pending.values()].some((e) => e.parts.length > 0), 'parts');
  await new Promise((r) => setTimeout(r, 50));
  for (const entry of session.pending.values())
    assert.ok(entry.parts.length <= LIMITS.PARTIAL_ITEMS);
  assert.equal(session.alive, true);
  assert.equal((await session.request('players/all')).length, 2);
});

test('a search over five types keeps at most what Gladys asked (100)', async (t) => {
  const env = await ready(t);
  const many = (type, n = 25) =>
    Array.from({ length: n }, (_, i) => ({
      item_id: `${i}`,
      provider: 'qobuz--Q1',
      name: `${type} ${i}`,
      uri: `qobuz--Q1://${type}/${i}`,
      media_type: type,
    }));
  env.ma.handlers['music/search'] = () => ({
    artists: many('artist'),
    albums: many('album'),
    tracks: many('track'),
    playlists: many('playlist'),
    radio: many('radio'),
  });
  const ack = await env.gladys.fake.musicSearch(env.device(CUISINE), {
    query: 'x',
    type: null,
    limit: 100,
  });
  assert.equal(ack.data.items.length, 100);
});

// --- Minor points ------------------------------------------------------------------------

test('another error at the welcome is not a refused token: tried again, nothing remembered', async (t) => {
  const store = createMemoryStore();
  const env = await setup({ ma: { setupRequired: 429 }, store });
  t.after(() => env.close());
  await until(
    () => /refused the connection \(error 429\), not the token/.test(env.status().message.en),
    'rejected',
  );
  assert.equal(store.data.refused, undefined);
  await env.clock.advance(TIMINGS.RETRY_MIN + 1);
  await until(() => env.ma.connections === 2, 'tried again');
});

test('saving the form tries a refused token once more', async (t) => {
  const env = await setup({ ma: { token: 'other' } });
  t.after(() => env.close());
  await until(() => env.status().message.en.includes('refused the token'), 'refused');
  env.ma.token = TOKEN;
  await env.app.configUpdated({ ...env.gladys.fake.config });
  await until(() => env.app.current?.ready, 'connected');
  assert.equal(env.ma.connections, 2);
});

test('sent, then the connection closed: "sent, no answer", never "not connected"', async (t) => {
  const env = await ready(t);
  env.ma.handlers['player_queues/play_media'] = (_a, srv) => srv.SILENT;
  const pending = env.gladys.fake.musicPlay(
    env.device(CUISINE),
    { id: 'library://album/21', type: 'album' },
    'replace',
  );
  await until(() => env.ma.count('player_queues/play_media') === 1, 'sent');
  env.ma.drop();
  const ack = await pending;
  assert.match(ack.error, /Sent to Music Assistant, the connection closed before its answer/);
});

test('a volume asked above the cap on a player already at the cap is published again', async (t) => {
  const env = await ready(t, {
    ma: { players: salonAt(60), queues: [queue(SALON), queue(CUISINE)] },
  });
  const device = env.device(SALON);
  const volumeStates = () =>
    env.gladys.fake.states.filter((s) => s.device_feature_external_id.endsWith(':volume')).length;
  const before = volumeStates();
  await env.gladys.fake.setValue(device, feature(device, 'volume'), 100);
  await until(() => volumeStates() > before, 'republished');
  assert.equal(env.last(SALON, 'volume'), 60);
});

test('the test clock moves: nothing here relies on the wall clock', () => {
  const clock = testClock();
  assert.notEqual(clock.monotonic(), clock.monotonic());
});
