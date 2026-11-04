// -----------------------------------------------------------------------------
// The app on a REAL moving clock sped up 20 times (performance.now and real
// timers) against the fake Music Assistant on a real loopback WebSocket: the
// keepalive really runs every 30 s and keeps a live session, and an
// unreachable server is really tried again after 2 s, then 4 s. Periods
// measured on the methods that decide; margins wide (late under load, never
// early). The app is stopped in t.after, so a failure never leaves it running.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { measurePeriod, memoryLogger, realClock, refusePort, spyOn } from './kit/index.mjs';
import { MusicAssistantApp } from '../src/app.js';
import { TIMINGS } from '../src/constants.js';
import { registerHandlers } from '../src/handlers.js';
import { MaSession } from '../src/ma/client.js';
import { createMemoryStore } from '../src/store.js';
import { TOKEN, fakeMa } from './helpers/fakeMa.js';

const SPEED = 20;

async function realApp(t, config) {
  const clock = realClock({ speed: SPEED });
  const gladys = createFakeGladys({ selector: 'music-assistant', config });
  await gladys.connect();
  const app = new MusicAssistantApp({
    gladys,
    logger: memoryLogger(),
    monotonic: clock.monotonic,
    now: clock.now,
    timers: clock.timers,
    store: createMemoryStore(),
  });
  registerHandlers(gladys, app, memoryLogger());
  t.after(async () => {
    await app.stop();
    clock.close();
  });
  return { clock, gladys, app };
}

test('real clock x20: the keepalive every 30 s keeps a live session', async (t) => {
  const ma = await fakeMa();
  t.after(() => ma.close());
  const { clock, app, gladys } = await realApp(t, { url: ma.url, token: TOKEN });
  const spy = spyOn(MaSession.prototype, 'checkAlive', clock);
  t.after(() => spy.restore());
  await app.connected(() => gladys.getConfig());
  await measurePeriod(spy, { count: 3, period: TIMINGS.KEEPALIVE });
  assert.equal(app.current?.session.alive, true, 'pongs keep it');
  assert.equal(ma.connections, 1);
});

test('real clock x20: an unreachable server is tried again after 2 s, then 4 s', async (t) => {
  const port = await refusePort();
  const { clock, app, gladys } = await realApp(t, { url: `127.0.0.1:${port}`, token: TOKEN });
  const spy = spyOn(app, 'openSession', clock);
  t.after(() => spy.restore());
  await app.connected(() => gladys.getConfig());
  await measurePeriod(spy, { count: 2, period: TIMINGS.RETRY_MIN });
  const gaps = await measurePeriod(spy, {
    count: 3,
    min: TIMINGS.RETRY_MIN * 0.9,
    max: TIMINGS.RETRY_MIN * 2 * 1.5,
  });
  assert.ok(gaps[1] >= TIMINGS.RETRY_MIN * 2 * 0.9, `doubled: ${gaps}`);
});
