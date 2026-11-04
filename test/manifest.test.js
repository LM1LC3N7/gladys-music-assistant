// -----------------------------------------------------------------------------
// The manifest is the contract with Gladys and the store: these tests tie it
// to the code, so a key renamed on one side only fails here.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { DEFAULT_CONFIG } from '../src/config.js';
import { ACTIONS, FEATURE, KINDS, PROVIDERS, SCENE_ACTIONS } from '../src/constants.js';
import { buildDevice, mergeWithCreated } from '../src/devices.js';
import { readPlayer } from '../src/ma/model.js';
import { player } from './helpers/fakeMa.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('gladys-assistant-integration.json'));
const pkg = JSON.parse(read('package.json'));
const lock = JSON.parse(read('package-lock.json'));
const handlers = read('src/handlers.js');
const dockerfile = read('Dockerfile');

function* texts(node, path = '') {
  if (Array.isArray(node)) {
    for (const [i, item] of node.entries()) yield* texts(item, `${path}[${i}]`);
  } else if (node && typeof node === 'object') {
    if ('en' in node || 'fr' in node) {
      yield [path, node];
      return;
    }
    for (const [key, value] of Object.entries(node)) yield* texts(value, `${path}.${key}`);
  }
}

const fakeGladys = {
  externalIds: (type, id) => ({
    device: `ext:x:${type}:${id}`,
    feature: (key) => `ext:x:${type}:${id}:${key}`,
  }),
};

test('the store basics; one semver version in 4 places, never pinned here', () => {
  assert.equal(manifest.manifest_version, 1);
  assert.equal(manifest.type, 'device');
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(
    manifest.docker_image,
    `ghcr.io/lm1lc3n7/gladys-music-assistant:${manifest.version}`,
  );
  assert.equal(manifest.version, pkg.version);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.name, pkg.name);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.equal(pkg.name, 'gladys-music-assistant');
  assert.equal(pkg.license, 'Apache-2.0');
  assert.equal(pkg.scripts.test, 'node --test --test-timeout=60000');
  assert.deepEqual(manifest.categories, ['multimedia']);
  assert.deepEqual(manifest.transports, ['local']);
  // The music field exists from Gladys 5.3.0 on (the store refuses a lower minimum).
  assert.equal(manifest.gladys_version, '>=5.3.0');
  assert.deepEqual(manifest.music, { browse: true, search: true, queue: true, append: true });
  assert.deepEqual(manifest.network_discovery, [{ type: 'mdns', service: '_mass._tcp' }]);
  assert.ok(!('keywords' in manifest) && !('countries' in manifest), 'in TODO.md for later');
  assert.match(
    manifest.cover_image,
    /^https:\/\/raw\.githubusercontent\.com\/LM1LC3N7\/gladys-music-assistant\//,
  );
  for (const lang of ['en', 'fr']) {
    const length = manifest.description[lang].length;
    assert.ok(length >= 10 && length <= 100, `description.${lang}: ${length} characters`);
    assert.ok(read(`docs/${lang}.md`).length >= 300, `docs/${lang}.md is too short for the store`);
  }
  assert.ok(manifest.name.length <= 30);
});

test('the cover is an 800 x 534 PNG', () => {
  const png = readFileSync(new URL('../cover.png', import.meta.url));
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(png.readUInt32BE(16), 800);
  assert.equal(png.readUInt32BE(20), 534);
});

test('the docs say it was never tested with a real Qobuz or Spotify account', () => {
  assert.match(read('docs/fr.md'), /[Jj]amais\s+été\s+testée\s+avec\s+un\s+vrai\s+compte/);
  assert.match(read('docs/en.md'), /[Nn]ever\s+tested\s+with\s+a\s+real\s+Qobuz/);
  assert.match(read('README.md'), /[Nn]ever\s+tested\s+with\s+a\s+real\s+Qobuz/);
  assert.match(read('README.md'), /Installation en mode dev \(tests de Louis\)/);
});

test('every text is in English and French; placeholders too', () => {
  for (const [path, text] of texts(manifest)) {
    for (const lang of ['en', 'fr']) assert.ok(text[lang]?.trim(), `${path} needs ${lang}`);
  }
  for (const field of manifest.config_schema) {
    if ('placeholder' in field) assert.equal(typeof field.placeholder, 'object', field.key);
  }
});

test('the configuration matches the code: the token is a secret without default, no gladys_ key', () => {
  const fields = Object.fromEntries(manifest.config_schema.map((f) => [f.key, f]));
  assert.deepEqual(Object.keys(fields), [
    'intro',
    'url',
    'token',
    'max_volume',
    'preferred_provider',
  ]);
  for (const key of Object.keys(fields)) assert.ok(!key.startsWith('gladys_'), key);
  assert.equal(fields.token.type, 'secret');
  assert.ok(!('default' in fields.token));
  assert.match(fields.token.description.en, /never shown again, sent only to your Music Assistant/);
  assert.match(fields.token.description.fr, /jamais réaffiché, envoyé seulement à votre serveur/);
  assert.equal(fields.url.type, 'string');
  assert.equal(fields.max_volume.default, DEFAULT_CONFIG.max_volume);
  assert.equal(fields.max_volume.min, 1);
  assert.equal(fields.max_volume.max, 100);
  assert.equal(fields.preferred_provider.default, DEFAULT_CONFIG.preferred_provider);
  assert.deepEqual(
    fields.preferred_provider.options.map((o) => o.value),
    [PROVIDERS.AUTO, PROVIDERS.QOBUZ, PROVIDERS.SPOTIFY],
  );
  for (const link of fields.intro.links) assert.match(link.url, /^https:\/\//);
});

test('the buttons and scene actions of the manifest are the handlers of the code', () => {
  assert.deepEqual(
    manifest.actions.map((a) => a.key),
    Object.values(ACTIONS),
  );
  assert.deepEqual(
    manifest.scene_actions.map((a) => a.key),
    Object.values(SCENE_ACTIONS),
  );
  for (const key of Object.keys(ACTIONS)) assert.ok(handlers.includes(`onAction(ACTIONS.${key}`));
  for (const key of Object.keys(SCENE_ACTIONS))
    assert.ok(handlers.includes(`onSceneAction(SCENE_ACTIONS.${key}`));
  for (const name of [
    'onSetValue',
    'onMusicBrowse',
    'onMusicSearch',
    'onMusicPlay',
    'onMusicQueueGet',
    'onMusicQueuePlay',
    'onMusicGetArtwork',
  ]) {
    assert.ok(handlers.includes(name), name);
  }
  assert.match(handlers, /\.connected\(\(\) => gladys\.getConfig\(\)\)/);
  const play = manifest.scene_actions.find((a) => a.key === SCENE_ACTIONS.PLAY);
  const fields = Object.fromEntries(play.fields.map((f) => [f.key, f]));
  assert.deepEqual(
    fields.kind.options.map((o) => o.value),
    Object.values(KINDS),
  );
  assert.deepEqual(
    fields.provider.options.map((o) => o.value),
    [PROVIDERS.CONFIG, PROVIDERS.AUTO, PROVIDERS.QOBUZ, PROVIDERS.SPOTIFY],
  );
  assert.deepEqual(
    fields.mode.options.map((o) => o.value),
    ['replace', 'next', 'append'],
  );
  for (const action of manifest.scene_actions) {
    assert.ok(action.timeout_seconds >= 10);
    for (const field of action.fields) {
      // A required field without default would break the scenes of an update.
      if (field.required) assert.ok(['device', 'query', 'volume', 'member'].includes(field.key));
      for (const option of field.options ?? []) assert.equal(typeof option.value, 'string');
    }
    for (const output of action.outputs ?? [])
      assert.ok(['string', 'number', 'boolean'].includes(output.type));
  }
});

test('the device: music features, no switch, has_feedback on the writable ones, keys forever', () => {
  const device = buildDevice(fakeGladys, readPlayer(player('aa:bb:cc', 'Salon')));
  assert.match(device.external_id, /^ext:x:player:[0-9a-f]{16}$/);
  const keys = device.features.map((f) => f.external_id.split(':').at(-1));
  assert.deepEqual(keys.sort(), Object.values(FEATURE).sort());
  for (const feature of device.features) {
    assert.equal(feature.category, 'music');
    assert.equal(feature.keep_history, false);
    if (!feature.read_only && !['play', 'pause', 'previous', 'next'].includes(feature.type)) {
      assert.equal(feature.has_feedback, true, feature.external_id);
    }
  }
  const fixed = buildDevice(
    fakeGladys,
    readPlayer(
      player('x', 'Fixed', {
        supported_features: [],
        volume_control: 'none',
        mute_control: 'none',
        volume_level: null,
      }),
    ),
  );
  assert.ok(!fixed.features.some((f) => ['volume', 'mute'].includes(f.type)));
});

test('supported_options follow the rules of the core (none published here)', () => {
  const device = buildDevice(fakeGladys, readPlayer(player('aa', 'Salon')));
  const core = new URL(
    '../../../Gladys/server/utils/normalizeSupportedOptions.js',
    import.meta.url,
  );
  const normalize = existsSync(core) ? createRequire(import.meta.url)(core.pathname) : undefined;
  for (const feature of device.features) {
    const options = feature.supported_options;
    if (options === undefined) continue;
    for (const option of options) {
      assert.equal(typeof option.label, 'string');
      assert.equal(option.label, option.label.trim());
    }
    if (normalize?.normalizeSupportedOptions) {
      assert.deepEqual(normalize.normalizeSupportedOptions(options, feature), options);
    }
  }
  assert.ok(device.features.every((f) => f.supported_options === undefined));
});

test('the licenses ship in the image; no name in LICENSE; the protocol source is credited', () => {
  assert.match(dockerfile, /COPY LICENSE THIRD_PARTY_NOTICES\.md/);
  const license = read('LICENSE');
  assert.match(license, /Apache License\s+Version 2\.0/);
  assert.match(license, /Copyright \[yyyy\] \[name of copyright owner\]/);
  const notices = read('THIRD_PARTY_NOTICES.md');
  for (const name of ['Music Assistant', 'Apache License', 'ws', 'MIT'])
    assert.ok(notices.includes(name), name);
  for (const dep of Object.keys(pkg.dependencies)) {
    assert.ok(['@gladysassistant/integration-sdk', 'ws'].includes(dep), dep);
  }
});

test('nothing logs a token: no token nor body reaches a logger', () => {
  for (const file of ['src/app.js', 'src/ma/client.js', 'src/handlers.js', 'index.js']) {
    const code = read(file);
    assert.doesNotMatch(code, /logger\.\w+\([^)]*(token|details|body|args)/i, file);
    assert.doesNotMatch(code, /console\./, file);
  }
});

test('every published feature has a finite min and max, min <= max, the max of its type', () => {
  const maxOf = {
    playback_state: 2,
    repeat: 2,
    volume: 100,
    position: 604800,
    duration: 604800,
  };
  const full = buildDevice(fakeGladys, readPlayer(player('aa', 'Salon')));
  const fixed = buildDevice(
    fakeGladys,
    readPlayer(
      player('bb', 'Fixed', {
        supported_features: [],
        volume_control: 'none',
        mute_control: 'none',
        volume_level: null,
      }),
    ),
  );
  // A created device whose player lost its volume keeps it, with its numbers.
  const merged = mergeWithCreated(fixed, { ...full, features: full.features });
  for (const device of [full, fixed, merged]) {
    for (const feature of device.features) {
      const key = feature.external_id.split(':').at(-1);
      assert.ok(Number.isFinite(feature.min), `${key}.min`);
      assert.ok(Number.isFinite(feature.max), `${key}.max`);
      assert.ok(feature.min <= feature.max, key);
      assert.equal(feature.min, 0, key);
      if (key in maxOf) assert.equal(feature.max, maxOf[key], key);
      else if (feature.read_only) assert.equal(feature.max, 0, key);
      else assert.equal(feature.max, 1, key);
      if (key === 'position' || key === 'duration') assert.equal(feature.unit, 'seconds', key);
    }
  }
  assert.ok(merged.features.some((f) => f.external_id.endsWith(':volume')));
});
