// -----------------------------------------------------------------------------
// One Gladys music player per Music Assistant player (group players
// included). The identity is the Music Assistant player id, which is stable
// across restarts and renames: `player:<16 hex of SHA-256(player_id)>` (a
// player id holds ':' — MAC addresses — that an external id must not carry).
// Feature keys are the Gladys types; keys and id shape are forever.
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import { FEATURE } from './constants.js';

/** The platform id of a player: from its Music Assistant id. */
export const playerKey = (playerId) =>
  createHash('sha256').update(String(playerId), 'utf8').digest('hex').slice(0, 16);

export const deviceIdOf = (gladys, playerId) =>
  gladys.externalIds('player', playerKey(playerId)).device;

/** The player key of a device external id, or undefined when it is not one of ours. */
export function keyOfDeviceId(externalId) {
  const match = /:player:([0-9a-f]{16})$/.exec(String(externalId ?? ''));
  return match ? match[1] : undefined;
}

/** The feature key of a feature external id (`…:player:<key>:volume` -> `volume`). */
export const featureKey = (featureExternalId) =>
  String(featureExternalId ?? '')
    .split(':')
    .at(-1);

const feature = (deviceId, key, name, type, extra = {}) => ({
  name,
  external_id: `${deviceId}:${key}`,
  category: C.MUSIC,
  type,
  min: 0,
  max: 1,
  read_only: false,
  has_feedback: true,
  keep_history: false,
  ...extra,
});

/** The device of a live player (`readPlayer` of the model). */
export function buildDevice(gladys, player) {
  const id = deviceIdOf(gladys, player.id);
  const M = T.MUSIC;
  const press = { has_feedback: false };
  const shown = { read_only: true, has_feedback: false, max: 0 };
  const seconds = { unit: U.SECONDS, max: 604800 };
  const features = [
    feature(id, FEATURE.PLAYBACK_STATE, 'Playback', M.PLAYBACK_STATE, { max: 2 }),
    feature(id, FEATURE.PLAY, 'Play', M.PLAY, press),
    feature(id, FEATURE.PAUSE, 'Pause', M.PAUSE, press),
    feature(id, FEATURE.PREVIOUS, 'Previous', M.PREVIOUS, press),
    feature(id, FEATURE.NEXT, 'Next', M.NEXT, press),
    feature(id, FEATURE.TITLE, 'Title', M.TITLE, shown),
    feature(id, FEATURE.ARTIST, 'Artist', M.ARTIST, shown),
    feature(id, FEATURE.ALBUM, 'Album', M.ALBUM, shown),
    feature(id, FEATURE.ARTWORK, 'Artwork', M.ARTWORK, shown),
    feature(id, FEATURE.DURATION, 'Duration', M.DURATION, { ...shown, ...seconds }),
    feature(id, FEATURE.POSITION, 'Position', M.POSITION, seconds),
    feature(id, FEATURE.SHUFFLE, 'Shuffle', M.SHUFFLE),
    feature(id, FEATURE.REPEAT, 'Repeat', M.REPEAT, { max: 2 }),
    ...(player.canVolume ? [feature(id, FEATURE.VOLUME, 'Volume', M.VOLUME, { max: 100 })] : []),
    ...(player.canMute ? [feature(id, FEATURE.MUTE, 'Mute', M.MUTE)] : []),
  ];
  return {
    name: player.name,
    external_id: id,
    features,
    params: [
      { name: 'ma_player_id', value: player.id.slice(0, 200) },
      ...(player.provider ? [{ name: 'ma_provider', value: player.provider }] : []),
    ],
  };
}

/**
 * The discovered device of a player already created: the features of the
 * created device that the player does not offer any more (a volume turned
 * fixed) are kept, so that a republication never removes one.
 */
export function mergeWithCreated(built, created) {
  if (!created) return built;
  const ids = new Set(built.features.map((f) => f.external_id));
  const kept = (created.features ?? [])
    .filter((f) => !ids.has(f.external_id))
    .map((f) => ({
      name: f.name,
      external_id: f.external_id,
      category: f.category,
      type: f.type,
      min: f.min,
      max: f.max,
      read_only: f.read_only,
      has_feedback: f.has_feedback,
      keep_history: false,
      ...(f.unit ? { unit: f.unit } : {}),
    }));
  return { ...built, features: [...built.features, ...kept] };
}
