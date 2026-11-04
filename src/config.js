// -----------------------------------------------------------------------------
// The configuration of the form (config_schema of the manifest), normalized:
// the rest of the code never sees a raw value. Defaults mirror the manifest.
// The token is never echoed: `invalid` lists keys, never values.
// -----------------------------------------------------------------------------

import { isIPv4, isIPv6 } from 'node:net';
import { DEFAULT_MAX_VOLUME, DEFAULT_PORT, LIMITS, PROVIDERS } from './constants.js';

export const DEFAULT_CONFIG = Object.freeze({
  url: '',
  max_volume: DEFAULT_MAX_VOLUME,
  preferred_provider: PROVIDERS.AUTO,
});

const HOSTNAME =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;
/** A JWT or any printable token: no space, no control character. */
const TOKEN = new RegExp(`^[\\x21-\\x7e]{8,${LIMITS.TOKEN}}$`);

/** An IPv4 address a server can have: never 0.0.0.0, a broadcast or a multicast address. */
export function isUsableIPv4(address) {
  if (!isIPv4(address)) return false;
  const [a, , , d] = address.split('.').map(Number);
  return a !== 0 && a < 224 && d !== 255;
}

function isUsableIPv6(address) {
  if (!isIPv6(address)) return false;
  const lower = address.toLowerCase();
  return lower !== '::' && !lower.startsWith('ff');
}

/**
 * The address typed by the user: `192.168.1.20`, `ma.local:8095`,
 * `http://192.168.1.20:8095/`, `https://[fd00::2]:8443`. Returns
 * `{ secure, host, port }`, or undefined when it is not one. No user name, no
 * password, no path, no query: the module only talks to the API of the server.
 */
export function parseUrl(raw) {
  if (typeof raw !== 'string') return undefined;
  const text = raw.trim();
  // eslint-disable-next-line no-control-regex -- control characters are what is refused
  if (!text || text.length > 300 || /[\s\x00-\x1f\x7f]/.test(text)) return undefined;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
  if (url.username || url.password || url.search || url.hash) return undefined;
  if (url.pathname !== '/' && url.pathname !== '') return undefined;
  let host = url.hostname;
  if (host.startsWith('[')) {
    host = host.slice(1, -1);
    if (!isUsableIPv6(host)) return undefined;
  } else if (/^[\d.]+$/.test(host)) {
    if (!isUsableIPv4(host)) return undefined;
  } else if (!HOSTNAME.test(host)) {
    return undefined;
  }
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : DEFAULT_PORT;
  // `new URL('http://x:80')` drops the default port: keep what the user meant.
  const typedPort = /:(\d{1,5})\/?$/.exec(text.replace(/^[a-z]+:\/\/\[[^\]]*\]/i, ''));
  const finalPort = typedPort ? Number(typedPort[1]) : port;
  if (!Number.isInteger(finalPort) || finalPort < 1 || finalPort > 65535) return undefined;
  return { secure: url.protocol === 'https:', host: host.toLowerCase(), port: finalPort };
}

/** The HTTP base of a parsed address (`http://host:port`), IPv6 in brackets. */
export function baseUrl({ secure, host, port }) {
  const shown = host.includes(':') ? `[${host}]` : host;
  return `${secure ? 'https' : 'http'}://${shown}:${port}`;
}

/** The WebSocket URL of the API. */
export const wsUrl = (server) => `${baseUrl(server).replace(/^http/, 'ws')}/ws`;

/** A strict integer from a number or a string of digits; anything else is undefined. */
function strictInteger(raw) {
  if (typeof raw === 'number') return Number.isInteger(raw) ? raw : undefined;
  if (typeof raw === 'string' && /^\s*\d{1,6}\s*$/.test(raw)) return Number(raw.trim());
  return undefined;
}

/** The volume cap: a wrong value is the lowest cap (a mistake makes it quieter, never louder). */
export function parseMaxVolume(raw) {
  if (raw === undefined || raw === null || raw === '') {
    return { value: DEFAULT_MAX_VOLUME, ok: true };
  }
  const value = strictInteger(raw);
  if (value === undefined || value < 1 || value > 100) {
    return { value: value === undefined ? 1 : Math.min(100, Math.max(1, value)), ok: false };
  }
  return { value, ok: true };
}

const PROVIDER_CHOICES = new Set([PROVIDERS.AUTO, PROVIDERS.QOBUZ, PROVIDERS.SPOTIFY]);

/**
 * `{ server, url, token, max_volume, preferred_provider, invalid: [keys] }`.
 * An empty address or token is "not configured"; a wrong one is listed in
 * `invalid` (never connected to). `token` stays in memory only.
 */
export function normalizeConfig(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const invalid = [];

  const rawUrl = Object.hasOwn(source, 'url') ? source.url : '';
  let server;
  if (typeof rawUrl === 'string' && rawUrl.trim()) {
    server = parseUrl(rawUrl);
    if (!server) invalid.push('url');
  } else if (rawUrl !== '' && rawUrl !== null && rawUrl !== undefined) {
    invalid.push('url');
  }

  let token = '';
  const rawToken = Object.hasOwn(source, 'token') ? source.token : '';
  if (typeof rawToken === 'string' && rawToken.trim()) {
    const trimmed = rawToken.trim().replace(/^Bearer\s+/i, '');
    if (TOKEN.test(trimmed)) token = trimmed;
    else invalid.push('token');
  } else if (rawToken !== '' && rawToken !== null && rawToken !== undefined) {
    invalid.push('token');
  }

  const cap = parseMaxVolume(source.max_volume);
  if (!cap.ok) invalid.push('max_volume');

  let preferred = PROVIDERS.AUTO;
  const rawPreferred = source.preferred_provider;
  if (rawPreferred !== undefined && rawPreferred !== null && rawPreferred !== '') {
    if (PROVIDER_CHOICES.has(rawPreferred)) preferred = rawPreferred;
    else invalid.push('preferred_provider');
  }

  return {
    server,
    url: server ? baseUrl(server) : '',
    token,
    max_volume: cap.value,
    preferred_provider: preferred,
    invalid,
  };
}

/** The keys whose change opens a new session (the cap and the provider apply live). */
export const sessionKey = (config) =>
  JSON.stringify([config.url, config.token, config.invalid.includes('url')]);

/** The server can be reached: an address and a token, both well formed. */
export const isConnectable = (config) =>
  Boolean(config.server) &&
  Boolean(config.token) &&
  !config.invalid.includes('url') &&
  !config.invalid.includes('token');

/**
 * The expiry of a JWT (`exp`, in ms since the epoch), read without checking
 * the signature (only Music Assistant can): undefined when there is none.
 */
export function tokenExpiry(token) {
  const parts = String(token ?? '').split('.');
  if (parts.length !== 3) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    const exp = payload?.exp;
    return Number.isFinite(exp) && exp > 0 ? exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}
