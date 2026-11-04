import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CONFIG,
  isConnectable,
  normalizeConfig,
  parseUrl,
  sessionKey,
  tokenExpiry,
  wsUrl,
} from '../src/config.js';

const TOKEN = 'abcdefgh.ijklmnop.qrstuvwx';

test('addresses: host, port, scheme, IPv6; never a path, credentials or a broadcast', () => {
  assert.deepEqual(parseUrl('192.168.1.20'), { secure: false, host: '192.168.1.20', port: 8095 });
  assert.deepEqual(parseUrl(' http://192.168.1.20:8095/ '), {
    secure: false,
    host: '192.168.1.20',
    port: 8095,
  });
  assert.deepEqual(parseUrl('ma.local:9000'), { secure: false, host: 'ma.local', port: 9000 });
  assert.deepEqual(parseUrl('http://ma.local:80'), { secure: false, host: 'ma.local', port: 80 });
  assert.deepEqual(parseUrl('https://MA.example.org'), {
    secure: true,
    host: 'ma.example.org',
    port: 443,
  });
  assert.deepEqual(parseUrl('https://[fd00::2]:8443'), {
    secure: true,
    host: 'fd00::2',
    port: 8443,
  });
  assert.equal(wsUrl(parseUrl('https://[fd00::2]:8443')), 'wss://[fd00::2]:8443/ws');
  assert.equal(wsUrl(parseUrl('192.168.1.20')), 'ws://192.168.1.20:8095/ws');
  for (const bad of [
    'http://user:pw@192.168.1.20:8095',
    'http://192.168.1.20:8095/ws',
    'http://192.168.1.20:8095/?a=1',
    'ftp://192.168.1.20',
    '0.0.0.0',
    '192.168.1.255',
    '224.0.0.251',
    'http://[ff02::1]:8095',
    'host name',
    'a\r\nb',
    'http://192.168.1.20:70000',
    '',
    42,
  ]) {
    assert.equal(parseUrl(bad), undefined, String(bad));
  }
});

test('normalized configuration: defaults, invalid keys listed (never the values)', () => {
  const empty = normalizeConfig({});
  assert.equal(empty.max_volume, DEFAULT_CONFIG.max_volume);
  assert.equal(empty.preferred_provider, 'auto');
  assert.deepEqual(empty.invalid, []);
  assert.equal(isConnectable(empty), false);

  const ok = normalizeConfig({ url: '10.0.0.2', token: ` Bearer ${TOKEN} `, max_volume: '45' });
  assert.equal(ok.url, 'http://10.0.0.2:8095');
  assert.equal(ok.token, TOKEN);
  assert.equal(ok.max_volume, 45);
  assert.equal(isConnectable(ok), true);

  const bad = normalizeConfig({
    url: 'http://x/y',
    token: 'with space inside',
    max_volume: 'loud',
    preferred_provider: 'deezer',
  });
  assert.deepEqual(bad.invalid, ['url', 'token', 'max_volume', 'preferred_provider']);
  assert.ok(!JSON.stringify(bad.invalid).includes('space'));
  assert.equal(isConnectable(bad), false);
  assert.equal(normalizeConfig({ token: 'a\nbcdefghij' }).invalid.includes('token'), true);
});

test('the volume cap: 1 to 100, a wrong value is the LOWEST cap, never a louder one', () => {
  assert.equal(normalizeConfig({ max_volume: 100 }).max_volume, 100);
  assert.equal(normalizeConfig({ max_volume: 1 }).max_volume, 1);
  assert.equal(normalizeConfig({ max_volume: 150 }).max_volume, 100);
  assert.equal(normalizeConfig({ max_volume: 0 }).max_volume, 1);
  assert.equal(normalizeConfig({ max_volume: 'x' }).max_volume, 1);
  assert.equal(normalizeConfig({ max_volume: 55.5 }).max_volume, 1);
  assert.equal(normalizeConfig({ max_volume: null }).max_volume, 60);
  assert.equal(normalizeConfig({ max_volume: '' }).max_volume, 60);
});

test('a session is reopened for a new address or token, not for the cap nor the provider', () => {
  const a = normalizeConfig({ url: '10.0.0.2', token: TOKEN, max_volume: 50 });
  const b = normalizeConfig({
    url: '10.0.0.2',
    token: TOKEN,
    max_volume: 20,
    preferred_provider: 'qobuz',
  });
  const c = normalizeConfig({ url: '10.0.0.2', token: `${TOKEN}x` });
  assert.equal(sessionKey(a), sessionKey(b));
  assert.notEqual(sessionKey(a), sessionKey(c));
});

test('the expiry of a JWT is read without a call; anything else has none', () => {
  const payload = Buffer.from(JSON.stringify({ exp: 1825357432 })).toString('base64url');
  assert.equal(tokenExpiry(`h.${payload}.s`), 1825357432000);
  assert.equal(tokenExpiry('not-a-jwt'), undefined);
  assert.equal(tokenExpiry('a.!!!.c'), undefined);
  assert.equal(
    tokenExpiry(`h.${Buffer.from('{"exp":"soon"}').toString('base64url')}.s`),
    undefined,
  );
});
