// -----------------------------------------------------------------------------
// The lifecycle (connection, statuses, refusal, reconnection), the picture
// kept by the events, the commands of the features and the volume cap.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TIMINGS } from '../src/constants.js';
import { createMemoryStore } from '../src/store.js';
import { created, setup, until } from './helpers/app.js';
import { TOKEN, player, queue } from './helpers/fakeMa.js';

const SALON = 'heos_123:aa';
const CUISINE = 'ma_cuisine';
const feature = (device, key) => device.features.find((f) => f.external_id.endsWith(`:${key}`));
const commands = (ma) => ma.received.map((r) => r.command).filter((c) => c !== 'auth');
const after = (ma, from) => ma.received.slice(from).map((r) => [r.command, r.args]);

test('connects: status, one device per player (ids hashed), states of the created devices', async (t) => {
  const env = await setup();
  t.after(() => env.close());
  await env.ready();
  assert.equal(env.status().connected, true);
  assert.match(env.status().message.fr, /Connecté à Music Assistant \(test\).*2 lecteur/);
  const discovered = env.gladys.fake.discoveredDevices;
  assert.deepEqual(
    discovered.map((d) => d.name),
    ['Salon', 'Cuisine'],
  );
  assert.match(discovered[0].external_id, /^ext:music-assistant:player:[0-9a-f]{16}$/);
  assert.ok(!discovered[0].external_id.includes('heos'));
  assert.deepEqual(discovered[0].params[0], { name: 'ma_player_id', value: SALON });
  assert.equal(env.last(SALON, 'volume'), 70);
  assert.equal(env.last(SALON, 'playback_state'), 2);
  assert.equal(env.last(SALON, 'shuffle'), 0);
  assert.deepEqual(
    env.gladys.fake.transports.map((x) => x.transport),
    ['local', 'local'],
  );
  assert.deepEqual(commands(env.ma).sort(), ['player_queues/all', 'players/all', 'providers']);
});

test('only the created devices get states (Gladys would drop the others)', async (t) => {
  const env = await setup({ devices: [created(SALON, 'Salon')] });
  t.after(() => env.close());
  await env.ready();
  assert.equal(env.last(SALON, 'volume'), 70);
  assert.equal(env.last(CUISINE, 'volume'), undefined);
});

test('the token expiry is said 30 days before, and once expired', async (t) => {
  const exp = Date.UTC(2026, 0, 1) / 1000 + 10 * 24 * 3600;
  const token = `h.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.s`;
  const env = await setup({ ma: { token } });
  t.after(() => env.close());
  env.gladys.fake.config.token = token;
  await env.app.configUpdated({ ...env.gladys.fake.config });
  await env.ready();
  assert.match(env.status().message.en, /token expires in 9 day/);
  assert.match(env.status().message.fr, /jeton expire dans 9 jour/);
});

test('not configured, invalid values: a clear status, nothing opened, never the token', async (t) => {
  const env = await setup({ config: {} });
  t.after(() => env.close());
  assert.match(env.status().message.en, /Type the address/);
  await env.app.configUpdated({ url: 'http://x/path', token: 'bad token here' });
  await env.app.idle();
  assert.match(env.status().message.en, /Invalid value.*url, token/);
  assert.ok(!JSON.stringify(env.gladys.fake.connectionStatuses).includes('bad token'));
  assert.equal(env.ma.connections, 0);
});

test('a refused token: status, no more tries, remembered across a restart, lifted by a new token', async (t) => {
  const store = createMemoryStore();
  const env = await setup({ ma: { token: 'the-server-wants-this-one' }, store });
  t.after(() => env.close());
  await until(() => env.status().message.en.includes('refused the token'), 'refused');
  assert.equal(env.status().connected, false);
  assert.equal(env.ma.connections, 1);
  await env.clock.advance(TIMINGS.RETRY_MAX * 2);
  assert.equal(env.ma.connections, 1, 'no automatic try');
  await until(() => store.data.refused, 'the marker');
  assert.match(store.data.refused, /^[0-9a-f]{2}$/);
  assert.ok(!JSON.stringify(store.data).includes(TOKEN));

  // A restart with the same token: nothing is sent.
  const again = await setup({ ma: { token: 'the-server-wants-this-one' }, store, start: false });
  t.after(() => again.close());
  again.gladys.fake.config.url = env.ma.url;
  await again.app.connected(() => again.gladys.getConfig());
  await again.app.idle();
  assert.match(again.status().message.en, /refused by Music Assistant before the last restart/);
  assert.equal(env.ma.connections, 1);

  // A new token is tried at once, and the marker is forgotten.
  await again.app.configUpdated({ url: env.ma.url, token: 'the-server-wants-this-one' });
  await until(() => again.app.current?.ready, 'connected with the new token');
  assert.equal(store.data.refused, undefined);
});

test('the test button lifts a refusal when it succeeds (the server accepts the token again)', async (t) => {
  const env = await setup({ ma: { token: 'other' } });
  t.after(() => env.close());
  await until(() => env.status().message.en.includes('refused'), 'refused');
  env.ma.token = TOKEN;
  env.clock.advance(TIMINGS.TEST_MIN_INTERVAL);
  const ack = await env.gladys.fake.action('test_connection', {});
  assert.equal(ack.success, true);
  assert.match(ack.data.message.en, /Qobuz: yes, Spotify: yes/);
  assert.match(ack.data.message.fr, /Lecteurs \(2\) : Salon \(heos\), Cuisine \(snapcast\)/);
  await until(() => env.app.current?.ready, 'the session opened again');
  assert.equal(env.status().connected, true);
});

test('the test button: one at a time, and a clear answer without a configuration', async (t) => {
  const env = await setup();
  t.after(() => env.close());
  await env.ready();
  const [a, b] = await Promise.all([
    env.gladys.fake.action('test_connection', {}),
    env.gladys.fake.action('test_connection', {}),
  ]);
  assert.match(a.data.message.en, /Connected to Music Assistant \(test\)/);
  assert.match(b.data.message.en, /already running/);
  await env.app.configUpdated({});
  await env.clock.advance(TIMINGS.TEST_MIN_INTERVAL);
  const c = await env.gladys.fake.action('test_connection', {});
  assert.match(c.data.message.en, /Type the address and the token first/);
});

test('a lost connection: status, then a new try after 2 s, doubled while it fails', async (t) => {
  const env = await setup();
  t.after(() => env.close());
  await env.ready();
  env.ma.drop();
  await until(() => env.status().message.en.includes('lost'), 'lost');
  assert.match(env.status().message.en, /tried again in 2 s/);
  assert.equal(env.ma.connections, 1);
  await env.clock.advance(TIMINGS.RETRY_MIN - 10);
  assert.equal(env.ma.connections, 1, 'never sooner');
  await env.clock.advance(20);
  await until(() => env.app.current?.ready, 'reconnected');
  assert.equal(env.ma.connections, 2);
  assert.equal(env.status().connected, true);
});

test('setup required, too old: clear statuses and tries again later', async (t) => {
  const env = await setup({ ma: { setupRequired: true } });
  t.after(() => env.close());
  await until(() => env.status().message.en.includes('not set up yet'), 'setup');
  const old = await setup({ ma: { schema: 20, info: { server_version: '2.6.0' } } });
  t.after(() => old.close());
  await until(() => old.status().message.en.includes('2.6.0 is too old'), 'too old');
});

test('getConfig failing in connected: retried, the status says so, then it connects', async (t) => {
  const env = await setup({ start: false });
  t.after(() => env.close());
  let calls = 0;
  await env.app.connected(async () => {
    calls += 1;
    if (calls === 1) throw new Error('Gladys busy');
    return env.gladys.getConfig();
  });
  assert.match(env.status().message.en, /could not be read from Gladys, tried again in 5 s/);
  await env.clock.advance(TIMINGS.CONFIG_RETRY_MIN);
  await env.app.idle();
  await until(() => env.app.current?.ready, 'connected');
  assert.equal(calls, 2);
});

test('Gladys reconnects: everything is published again from the live picture, one session', async (t) => {
  const env = await setup();
  t.after(() => env.close());
  await env.ready();
  const before = env.gladys.fake.states.length;
  await env.app.connected(() => env.gladys.getConfig());
  await env.flush();
  assert.ok(env.gladys.fake.states.length > before);
  assert.equal(env.ma.connections, 1);
});

test('events: now playing, shuffle, new and removed players; the time ticks are ignored', async (t) => {
  const env = await setup();
  t.after(() => env.close());
  await env.ready();
  const salon = env.ma.players[0];
  salon.playback_state = 'playing';
  salon.current_media = {
    title: 'Imagine',
    artist: 'Céline Dion',
    album: 'Courage',
    image_url: `http://172.17.0.2:8095/imageproxy/abcdef0123456789?size=512&fmt=png`,
    duration: 200,
    elapsed_time: 5,
  };
  env.ma.event('player_updated', SALON, salon);
  env.ma.event('queue_updated', SALON, queue(SALON, { shuffle_enabled: true, repeat_mode: 'all' }));
  await new Promise((r) => setTimeout(r, 30));
  await env.flush();
  assert.equal(env.last(SALON, 'title'), 'Imagine');
  assert.equal(env.last(SALON, 'playback_state'), 1);
  assert.equal(env.last(SALON, 'shuffle'), 1);
  assert.equal(env.last(SALON, 'repeat'), 1);
  assert.match(env.last(SALON, 'artwork'), /^art-[0-9a-f]{12}$/);

  const count = env.gladys.fake.states.length;
  for (let i = 0; i < 5; i += 1) env.ma.event('queue_time_updated', SALON, 6 + i);
  await new Promise((r) => setTimeout(r, 30));
  await env.flush();
  assert.equal(env.gladys.fake.states.length, count);

  env.ma.event('player_added', 'p3', player('p3', 'Chambre'));
  await new Promise((r) => setTimeout(r, 30));
  await until(() => env.gladys.fake.discoveredDevices.length === 3, 'three players');
  env.ma.event('player_removed', 'p3', null);
  await until(() => env.gladys.fake.discoveredDevices.length === 2, 'two players');
});

test('volume: capped (60 here), rounded down, a lower one is urgent', async (t) => {
  const env = await setup();
  t.after(() => env.close());
  await env.ready();
  const device = env.device(SALON);
  let from = env.ma.received.length;
  assert.equal(
    (await env.gladys.fake.setValue(device, feature(device, 'volume'), 90)).success,
    true,
  );
  assert.deepEqual(after(env.ma, from), [
    ['players/cmd/volume_set', { player_id: SALON, volume_level: 60 }],
  ]);
  from = env.ma.received.length;
  await env.gladys.fake.setValue(device, feature(device, 'volume'), 59.9);
  assert.deepEqual(after(env.ma, from)[0][1].volume_level, 59);
  from = env.ma.received.length;
  await env.gladys.fake.setValue(device, feature(device, 'volume'), 61);
  assert.deepEqual(after(env.ma, from)[0][1].volume_level, 60);
  const bad = await env.gladys.fake.setValue(device, feature(device, 'volume'), 'loud');
  assert.equal(bad.success, false);
});

test('play, unmute: a player louder than the cap is brought down to it FIRST', async (t) => {
  const env = await setup();
  t.after(() => env.close());
  await env.ready();
  const device = env.device(SALON); // 70 in Music Assistant, cap 60
  let from = env.ma.received.length;
  await env.gladys.fake.setValue(device, feature(device, 'playback_state'), 1);
  assert.deepEqual(after(env.ma, from), [
    ['players/cmd/volume_set', { player_id: SALON, volume_level: 60 }],
    ['players/cmd/play', { player_id: SALON }],
  ]);
  env.ma.players[0].volume_level = 80;
  env.ma.event('player_updated', SALON, env.ma.players[0]);
  await new Promise((r) => setTimeout(r, 30));
  from = env.ma.received.length;
  await env.gladys.fake.setValue(device, feature(device, 'mute'), 0);
  assert.deepEqual(after(env.ma, from), [
    ['players/cmd/volume_set', { player_id: SALON, volume_level: 60 }],
    ['players/cmd/volume_mute', { player_id: SALON, muted: false }],
  ]);
  // The volume could not be lowered: nothing is played.
  env.ma.players[0].volume_level = 80;
  env.ma.event('player_updated', SALON, env.ma.players[0]);
  await new Promise((r) => setTimeout(r, 30));
  env.ma.handlers['players/cmd/volume_set'] = () => {
    throw { error_code: 11, details: 'volume failed' };
  };
  from = env.ma.received.length;
  const ack = await env.gladys.fake.setValue(device, feature(device, 'play'), 1);
  assert.equal(ack.success, false);
  assert.deepEqual(
    after(env.ma, from).map(([c]) => c),
    ['players/cmd/volume_set'],
  );
});

test('pause, stop and mute are never held: no cap, no volume first, past a full queue of commands', async (t) => {
  const env = await setup();
  t.after(() => env.close());
  await env.ready();
  const device = env.device(SALON);
  env.ma.handlers['players/cmd/next'] = (_a, srv) => srv.SILENT;
  const stuck = Array.from({ length: 40 }, () =>
    env.gladys.fake.setValue(device, feature(device, 'next'), 1),
  );
  await new Promise((r) => setTimeout(r, 50));
  const from = env.ma.received.length;
  for (const [key, value] of [
    ['playback_state', 0],
    ['playback_state', 2],
    ['pause', 1],
    ['mute', 1],
  ]) {
    const ack = await env.gladys.fake.setValue(device, feature(device, key), value);
    assert.equal(ack.success, true, key);
  }
  assert.deepEqual(
    after(env.ma, from).map(([c]) => c),
    ['players/cmd/pause', 'players/cmd/stop', 'players/cmd/pause', 'players/cmd/volume_mute'],
  );
  await env.clock.advance(TIMINGS.COMMAND + 1);
  await Promise.all(stuck);
});

test('seek, shuffle, repeat, previous, next', async (t) => {
  const env = await setup();
  t.after(() => env.close());
  await env.ready();
  const device = env.device(CUISINE);
  const from = env.ma.received.length;
  await env.gladys.fake.setValue(device, feature(device, 'position'), 42.7);
  await env.gladys.fake.setValue(device, feature(device, 'shuffle'), 1);
  await env.gladys.fake.setValue(device, feature(device, 'repeat'), 2);
  await env.gladys.fake.setValue(device, feature(device, 'previous'), 1);
  await env.gladys.fake.setValue(device, feature(device, 'next'), 1);
  assert.deepEqual(after(env.ma, from), [
    ['players/cmd/seek', { player_id: CUISINE, position: 42 }],
    ['player_queues/shuffle', { queue_id: CUISINE, shuffle_enabled: true }],
    ['player_queues/repeat', { queue_id: CUISINE, repeat_mode: 'one' }],
    ['players/cmd/previous', { player_id: CUISINE }],
    ['players/cmd/next', { player_id: CUISINE }],
  ]);
  assert.equal(
    (await env.gladys.fake.setValue(device, feature(device, 'repeat'), 3)).success,
    false,
  );
});

test('a command while Music Assistant is away: a clear error, nothing sent', async (t) => {
  const env = await setup();
  t.after(() => env.close());
  await env.ready();
  env.ma.drop();
  await until(() => !env.app.current, 'lost');
  const device = env.device(SALON);
  const ack = await env.gladys.fake.setValue(device, feature(device, 'pause'), 1);
  assert.equal(ack.success, false);
  assert.match(ack.error, /not connected/);
  assert.deepEqual(
    env.gladys.fake.transports.slice(-2).map((x) => x.transport),
    ['unreachable', 'unreachable'],
  );
});

test('the token is never in a log line, a status, /data or a request to Gladys', async (t) => {
  const store = createMemoryStore();
  const env = await setup({ store });
  t.after(() => env.close());
  await env.ready();
  await env.gladys.fake.action('test_connection', {});
  env.ma.token = 'changed';
  env.ma.drop();
  await until(() => env.status().message.en.includes('lost'), 'lost');
  await env.clock.advance(TIMINGS.RETRY_MIN + 1);
  await until(() => env.status().message.en.includes('refused'), 'refused');
  const all = JSON.stringify({
    lines: env.logger.lines,
    statuses: env.gladys.fake.connectionStatuses,
    store: store.data,
    requests: env.gladys.fake.requests,
    ws: env.gladys.fake.wsMessages,
  });
  for (const part of [TOKEN, TOKEN.split('.')[2]]) assert.ok(!all.includes(part));
});

test('the queues and the providers failing never keep the players away', async (t) => {
  const env = await setup({ start: false });
  t.after(() => env.close());
  env.ma.handlers['player_queues/all'] = () => {
    throw { error_code: 22, details: 'This command requires the queues.read scope' };
  };
  env.ma.handlers.providers = () => {
    throw { error_code: 999, details: 'boom' };
  };
  await env.app.connected(() => env.gladys.getConfig());
  await env.ready();
  assert.equal(env.status().connected, true);
  assert.equal(env.gladys.fake.discoveredDevices.length, 2);
  assert.equal(env.last(SALON, 'volume'), 70);
  assert.ok(env.logger.lines.some((l) => /player_queues\/all not read \(command 22\)/.test(l)));
});

test('a token whose user may not list the players: a clear status, tried again later', async (t) => {
  const env = await setup({ start: false });
  t.after(() => env.close());
  env.ma.handlers['players/all'] = () => {
    throw { error_code: 22, details: 'This command requires the players.read scope' };
  };
  await env.app.connected(() => env.gladys.getConfig());
  await until(() => /may not list the players/.test(env.status().message.en), 'forbidden');
  delete env.ma.handlers['players/all'];
  await env.clock.advance(TIMINGS.RETRY_MIN + 1);
  await until(() => env.app.current?.ready, 'connected once allowed');
});

test('/data unreadable or not writable: still connects; a refusal is then not remembered', async (t) => {
  const broken = createMemoryStore();
  broken.broken = true;
  const env = await setup({ store: broken });
  t.after(() => env.close());
  await env.ready();
  assert.equal(env.status().connected, true);
  assert.ok(env.logger.lines.some((l) => /\/data unreadable \(EIO\), not written/.test(l)));
  assert.equal(broken.saves, 0);

  const full = createMemoryStore();
  full.failSave = true;
  const refused = await setup({ store: full, ma: { token: 'other' } });
  t.after(() => refused.close());
  await until(() => refused.status().message.en.includes('refused'), 'refused');
  await until(
    () => refused.logger.lines.some((l) => /\/data not written \(ENOSPC\)/.test(l)),
    'save failure logged',
  );
});
