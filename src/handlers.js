// -----------------------------------------------------------------------------
// Every SDK handler -> the app. Shared by index.js and the tests, so that the
// tests drive the integration through the same wiring as Gladys.
// -----------------------------------------------------------------------------

import { ACTIONS, SCENE_ACTIONS } from './constants.js';

export function registerHandlers(gladys, app, logger) {
  // --- Discovery: the players Music Assistant lists now (never a new connection) ---
  gladys.onScanRequest(() => app.devicesChanged());
  gladys.onDeviceCreated(() => app.devicesChanged());
  gladys.onDeviceUpdated(() => app.devicesChanged());
  gladys.onDeviceDeleted(() => app.devicesChanged());

  // --- Commands of the music features ------------------------------------------------
  gladys.onSetValue((device, feature, value) => app.setValue(device, feature, value));

  // --- The music player contract: catalog, search, play, queue, artwork --------------
  gladys.onMusicBrowse((device, options) => app.musicBrowse(device, options));
  gladys.onMusicSearch((device, options) => app.musicSearch(device, options));
  gladys.onMusicPlay((device, media, mode) => app.musicPlay(device, media, mode));
  gladys.onMusicQueueGet((device, options) => app.musicQueueGet(device, options));
  gladys.onMusicQueuePlay((device, index) => app.musicQueuePlay(device, index));
  gladys.onMusicGetArtwork((key) => app.artwork(key));

  // --- Configuration screen buttons ---------------------------------------------------
  gladys.onAction(ACTIONS.TEST, () => app.testConnection());
  gladys.onAction(ACTIONS.FIND, () => app.findServer());

  // --- Scene actions --------------------------------------------------------------------
  gladys.onSceneAction(SCENE_ACTIONS.PLAY, (fields) => app.playSearch(fields));
  gladys.onSceneAction(SCENE_ACTIONS.VOLUME, (fields) => app.setVolume(fields));
  gladys.onSceneAction(SCENE_ACTIONS.GROUP, (fields) => app.group(fields));
  gladys.onSceneAction(SCENE_ACTIONS.UNGROUP, (fields) => app.ungroup(fields));

  // --- Configuration changed by the user ---------------------------------------------
  gladys.onConfigUpdated((config) => {
    logger.info('Configuration updated');
    return app.configUpdated(config);
  });

  // --- Connection lifecycle ------------------------------------------------------------
  // Every connection reads the configuration (tried again without end while
  // Gladys cannot give it), then publishes the status, the Discovery list and
  // every state again from the live picture of Music Assistant.
  gladys.on('connected', () => {
    app
      .connected(() => gladys.getConfig())
      .catch((err) => logger.error(`Start failed (${err?.name ?? 'Error'})`));
  });
  gladys.on('disconnected', () => app.disconnected());
}
