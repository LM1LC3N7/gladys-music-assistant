import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer } from 'ws';
import { LIMITS, TIMINGS } from '../src/constants.js';
import { MaSession } from '../src/ma/client.js';
import { refusePort, testClock } from './kit/index.mjs';
import { TOKEN, fakeMa } from './helpers/fakeMa.js';

const wsOf = (ma) => `ws://127.0.0.1:${ma.port}/ws`;

async function open(t, maOptions, sessionOptions = {}) {
  const ma = await fakeMa(maOptions);
  const session = new MaSession({ url: wsOf(ma), token: TOKEN, ...sessionOptions });
  t.after(async () => {
    await session.close();
    await ma.close();
  });
  return { ma, session };
}

const failure = async (promise) => {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error('expected a failure');
};

test('the server info first, then auth: commands and events only once authenticated', async (t) => {
  const { ma, session } = await open(t);
  const events = [];
  session.on('event', (e) => events.push(e.event));
  const early = await failure(session.request('players/all'));
  assert.equal(early.code, 'closed');
  const { info, user } = await session.start();
  assert.equal(info.version, '2.10.9');
  assert.equal(info.schema, 65);
  assert.deepEqual(user, { name: 'gladys', role: 'user' });
  assert.deepEqual(
    ma.received.map((r) => r.command),
    ['auth'],
  );
  const players = await session.request('players/all');
  assert.equal(players.length, 2);
  ma.event('player_updated', 'x', { player_id: 'x' });
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(events, ['player_updated']);
});

test('a refused token ends the session as "refused" (error 23 of Music Assistant)', async (t) => {
  const { session } = await open(t, { token: 'another-token-entirely' });
  const err = await failure(session.start());
  assert.equal(err.code, 'refused');
  assert.equal(err.maCode, 23);
  assert.ok(!String(err.message).includes(TOKEN));
});

test('a server not set up yet: "setup_required"', async (t) => {
  const { session } = await open(t, { setupRequired: true });
  assert.equal((await failure(session.start())).code, 'setup_required');
});

test('an incompatible server never receives the token', async (t) => {
  for (const [opts, code] of [
    [{ schema: 27 }, 'too_old'],
    [{ minSchema: 66 }, 'too_new'],
    [{ info: { server_id: 42 } }, 'not_ma'],
  ]) {
    const { ma, session } = await open(t, opts);
    assert.equal((await failure(session.start())).code, code);
    assert.equal(ma.count('auth'), 0, code);
    assert.ok(!ma.raw.join('').includes(TOKEN));
  }
});

test('not a Music Assistant server: an HTTP error, a JSON that is not the server info, a closed port', async (t) => {
  const ma = await fakeMa();
  t.after(() => ma.close());
  const wrongPath = new MaSession({ url: `ws://127.0.0.1:${ma.port}/other`, token: TOKEN });
  assert.equal((await failure(wrongPath.start())).code, 'not_ma');

  const other = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  const got = [];
  other.on('connection', (socket) => {
    socket.on('message', (d) => got.push(String(d)));
    socket.send(JSON.stringify({ hello: 'world' }));
  });
  await new Promise((r) => other.on('listening', r));
  t.after(() => new Promise((r) => other.close(r)));
  const impostor = new MaSession({
    url: `ws://127.0.0.1:${other.address().port}/ws`,
    token: TOKEN,
  });
  assert.equal((await failure(impostor.start())).code, 'not_ma');
  assert.deepEqual(got, []);

  const port = await refusePort();
  const closed = new MaSession({ url: `ws://127.0.0.1:${port}/ws`, token: TOKEN });
  assert.equal((await failure(closed.start())).code, 'unreachable');
});

test('partial results are joined, and bounded', async (t) => {
  const { ma, session } = await open(t, { partialSize: 3 });
  ma.handlers['players/all'] = () => Array.from({ length: 10 }, (_, i) => ({ i }));
  ma.handlers['music/browse'] = () =>
    Array.from({ length: LIMITS.PARTIAL_ITEMS + 50 }, (_, i) => i);
  await session.start();
  const list = await session.request('players/all');
  assert.deepEqual(
    list.map((x) => x.i),
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  );
  assert.equal(
    (await session.request('music/browse', {}, { timeout: 5000 })).length,
    LIMITS.PARTIAL_ITEMS,
  );
});

test('an error of a command carries its code and its details, bounded and on one line', async (t) => {
  const { ma, session } = await open(t);
  ma.handlers['players/cmd/play'] = () => {
    throw { error_code: 10, details: `Player off\n${'x'.repeat(500)}` };
  };
  await session.start();
  const err = await failure(session.request('players/cmd/play', { player_id: 'p' }));
  assert.equal(err.code, 'command');
  assert.equal(err.maCode, 10);
  assert.equal(err.sent, true);
  assert.ok(!err.details.includes('\n'));
  assert.ok(err.details.length <= 200);
  assert.equal((await failure(session.request('nope/nope'))).maCode, 12);
});

test('no answer in time: "timeout", sent; too many waiting: "busy", except the urgent ones', async (t) => {
  const clock = testClock();
  const { ma, session } = await open(t, {}, { timers: clock.timers, monotonic: clock.monotonic });
  ma.handlers['players/cmd/next'] = (_args, srv) => srv.SILENT;
  await session.start();
  const waiting = Array.from({ length: LIMITS.IN_FLIGHT }, () =>
    session.request('players/cmd/next', { player_id: 'p' }).catch((e) => e),
  );
  assert.equal((await failure(session.request('players/cmd/next'))).code, 'busy');
  // A pause is never held by the commands waiting.
  const pause = await session.request(
    'players/cmd/pause',
    { player_id: 'heos_123:aa' },
    { urgent: true },
  );
  assert.equal(pause, null);
  await clock.advance(TIMINGS.COMMAND + 1);
  const errors = await Promise.all(waiting);
  assert.ok(errors.every((e) => e.code === 'timeout' && e.sent === true));
});

test('a server that stops answering pings is left after 2.5 keepalives', async (t) => {
  const clock = testClock();
  const { session } = await open(
    t,
    { autoPong: false },
    { timers: clock.timers, monotonic: clock.monotonic },
  );
  await session.start();
  let closedWith;
  session.on('closed', (err) => (closedWith = err.code));
  await clock.advance(TIMINGS.KEEPALIVE * 3 + 10);
  assert.equal(closedWith, 'timeout');
});

test('closing rejects what waits (sent: Music Assistant may have acted)', async (t) => {
  const { ma, session } = await open(t);
  ma.handlers['player_queues/play_media'] = (_a, srv) => srv.SILENT;
  await session.start();
  const pending = session
    .request('player_queues/play_media', {}, { timeout: 5000 })
    .catch((e) => e);
  await new Promise((r) => setTimeout(r, 20));
  await session.close();
  const err = await pending;
  assert.equal(err.code, 'closed');
  assert.equal(err.sent, true);
});

test('a message above the bound ends the session', async (t) => {
  const { ma, session } = await open(t);
  ma.handlers['players/all'] = () => 'x'.repeat(LIMITS.MESSAGE_BYTES + 10);
  await session.start();
  const err = await failure(session.request('players/all', {}, { timeout: 5000 }));
  assert.ok(['protocol', 'closed'].includes(err.code), err.code);
});
