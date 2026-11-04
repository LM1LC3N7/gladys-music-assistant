// -----------------------------------------------------------------------------
// The app against the SDK's fake Gladys, a fake Music Assistant server on a
// real loopback WebSocket and a virtual clock that moves at every read
// (1 µs): the timers of the app (flush, retries, keepalive) fire only
// through `clock.advance`, the network is real.
// -----------------------------------------------------------------------------

import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { memoryLogger, testClock } from '../kit/index.mjs';
import { MusicAssistantApp } from '../../src/app.js';
import { TIMINGS } from '../../src/constants.js';
import { buildDevice } from '../../src/devices.js';
import { registerHandlers } from '../../src/handlers.js';
import { readPlayer } from '../../src/ma/model.js';
import { createMemoryStore } from '../../src/store.js';
import { TOKEN, fakeMa, player } from './fakeMa.js';

export const SELECTOR = 'music-assistant';

/** Waits (real time) until `check()` is truthy. */
export async function until(check, what = 'condition', ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** The device of a player as the user created it in Gladys. */
export function created(id, name = id, extra = {}) {
  const gladys = createFakeGladys({ selector: SELECTOR });
  const device = buildDevice(gladys, readPlayer(player(id, name, extra)));
  device.id = `device-${id}`;
  return device;
}

export async function setup({
  ma: maOptions,
  devices = [created('heos_123:aa', 'Salon'), created('ma_cuisine', 'Cuisine')],
  store = createMemoryStore(),
  config,
  start = true,
  now,
  fetchImpl,
} = {}) {
  const ma = await fakeMa(maOptions);
  const gladys = createFakeGladys({
    selector: SELECTOR,
    config: config ?? { url: ma.url, token: TOKEN, max_volume: 60, preferred_provider: 'auto' },
    devices,
  });
  await gladys.connect();
  const clock = testClock();
  const logger = memoryLogger();
  const app = new MusicAssistantApp({
    gladys,
    logger,
    monotonic: clock.monotonic,
    now: now ?? clock.now,
    timers: clock.timers,
    store,
    ...(fetchImpl ? { fetchImpl } : {}),
  });
  registerHandlers(gladys, app, logger);
  const env = {
    ma,
    gladys,
    clock,
    logger,
    app,
    store,
    /** Lets the flush run (virtual time) and waits for the app. */
    async flush() {
      await clock.advance(TIMINGS.FLUSH);
      await app.idle();
    },
    /** Waits for a complete picture, then publishes it. */
    async ready() {
      await until(() => app.current?.ready, 'the picture of Music Assistant');
      await env.flush();
    },
    status: () => gladys.fake.connectionStatus,
    device: (id) => gladys.fake.devices.find((d) => d.external_id === created(id).external_id),
    last: (id, key) => gladys.fake.lastState(`${created(id).external_id}:${key}`),
    feature: (device, key) => device.features.find((f) => f.external_id.endsWith(`:${key}`)),
    async close() {
      await app.stop();
      await ma.close();
    },
  };
  if (start) {
    await app.connected(() => gladys.getConfig());
    await app.idle();
  }
  return env;
}
