// -----------------------------------------------------------------------------
// One WebSocket session with a Music Assistant server (`ws://<host>:8095/ws`),
// written on `ws` (MIT) from the documented protocol (Music Assistant server
// and models, Apache-2.0: see THIRD_PARTY_NOTICES.md):
//
//   1. the server speaks first: a ServerInfoMessage (server_id, versions);
//      a server not set up yet then sends an error for "connection" and closes
//   2. `auth` with the long-lived token -> `{ authenticated: true, user }`;
//      the events of the server follow from then on
//   3. commands `{ message_id, command, args }` -> `{ message_id, result,
//      partial }` (a long listing arrives in several `partial: true` parts)
//      or `{ message_id, error_code, details }`
//   4. events `{ event, object_id, data }`
//
// One session, one socket: any protocol error, a missed keepalive or a close
// ends it for good (the app opens a new one later). Nothing here ever logs:
// the auth message carries the token.
// -----------------------------------------------------------------------------

import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { LIMITS, MIN_SCHEMA, OUR_SCHEMA, TIMINGS } from '../constants.js';

/** Error codes of Music Assistant (music_assistant_models/errors.py). */
export const MA_ERRORS = Object.freeze({
  INVALID_COMMAND: 12,
  AUTHENTICATION_REQUIRED: 20,
  AUTHENTICATION_FAILED: 21,
  INSUFFICIENT_PERMISSIONS: 22,
  INVALID_TOKEN: 23,
});

export class MaError extends Error {
  /**
   * `code`: unreachable | closed | timeout | protocol | busy | refused |
   * setup_required | too_old | too_new | not_ma | command.
   * `maCode`/`details`: the error of a command, as Music Assistant sent it.
   * `sent`: the command left (Music Assistant may have acted on it).
   */
  constructor(code, { maCode, details, sent = false } = {}) {
    super(details ? `Music Assistant: ${code} (${details})` : `Music Assistant: ${code}`);
    this.name = 'MaError';
    this.code = code;
    this.maCode = maCode;
    this.details = details;
    this.sent = sent;
  }
}

const defaultTimers = { setTimeout, clearTimeout, setInterval, clearInterval };
const isPlain = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
/** A text from the server, shown to people: bounded, one line, no control character. */
export const cleanText = (value, max = LIMITS.TEXT) =>
  typeof value === 'string'
    ? value
        // eslint-disable-next-line no-control-regex -- control characters are what is refused
        .replace(/[\x00-\x1f\x7f]+/g, ' ')
        .trim()
        .slice(0, max)
    : '';

export class MaSession extends EventEmitter {
  constructor({
    url,
    token,
    WebSocketImpl = WebSocket,
    timers = defaultTimers,
    monotonic = () => performance.now(),
  }) {
    super();
    this.url = url;
    // Kept out of enumerable properties: a stray inspection never shows it.
    Object.defineProperty(this, 'token', { value: token, enumerable: false });
    this.WebSocketImpl = WebSocketImpl;
    this.timers = timers;
    this.monotonic = monotonic;
    this.nextId = 0;
    /** message_id -> `{ resolve, reject, timer, parts }`. */
    this.pending = new Map();
    this.error = undefined;
    this.info = undefined;
    this.user = undefined;
    this.ready = false;
    this.ws = undefined;
    this.lastHeard = monotonic();
    this.keepalive = undefined;
    this.openTimer = undefined;
    let closedResolve;
    this.closed = new Promise((resolve) => {
      closedResolve = resolve;
    });
    this.closedResolve = closedResolve;
  }

  /**
   * Opens the socket, checks the server info, then authenticates. Resolves
   * `{ info, user }` once commands can be sent; rejects with a MaError (the
   * session is then over).
   */
  start() {
    return new Promise((resolve, reject) => {
      this.startResolve = resolve;
      this.startReject = reject;
      this.openTimer = this.timers.setTimeout(
        () => this.fail(new MaError('timeout')),
        TIMINGS.CONNECT,
      );
      try {
        this.ws = new this.WebSocketImpl(this.url, {
          handshakeTimeout: TIMINGS.CONNECT,
          maxPayload: LIMITS.MESSAGE_BYTES,
          perMessageDeflate: false,
          followRedirects: false,
        });
      } catch {
        this.fail(new MaError('unreachable'));
        return;
      }
      this.ws.on('open', () => {
        this.wasOpen = true;
        this.heard();
      });
      this.ws.on('message', (data, isBinary) => this.onMessage(data, isBinary));
      this.ws.on('ping', () => this.heard());
      this.ws.on('pong', () => this.heard());
      this.ws.on('unexpected-response', () => this.fail(new MaError('not_ma')));
      this.ws.on('error', (err) => {
        const code = /^WS_ERR_/.test(String(err?.code ?? ''))
          ? 'protocol'
          : this.wasOpen
            ? 'closed'
            : 'unreachable';
        this.fail(new MaError(code));
      });
      this.ws.on('close', () => {
        this.fail(new MaError(this.wasOpen ? 'closed' : 'unreachable'));
        this.closedResolve();
      });
    });
  }

  heard() {
    this.lastHeard = this.monotonic();
  }

  /** Ends the session (the first error wins); every request waiting is rejected. */
  fail(err) {
    if (!this.error) {
      this.error = err;
      this.ready = false;
      this.timers.clearTimeout(this.openTimer);
      this.timers.clearInterval(this.keepalive);
      for (const [id, entry] of this.pending) {
        this.timers.clearTimeout(entry.timer);
        this.pending.delete(id);
        // Already on the wire: Music Assistant may have acted on it.
        entry.reject(new MaError(err.code, { sent: true }));
      }
      if (this.startReject) {
        const reject = this.startReject;
        this.startReject = undefined;
        this.startResolve = undefined;
        reject(err);
      }
      this.emit('closed', err);
    }
    const ws = this.ws;
    if (!ws || ws.readyState === WebSocket.CLOSED) {
      this.closedResolve();
      return;
    }
    if (this.ending) return;
    this.ending = true;
    try {
      ws.terminate();
    } catch {
      this.closedResolve();
    }
  }

  close() {
    this.fail(new MaError('closed'));
    return this.closed;
  }

  get alive() {
    return !this.error && this.ready && this.ws?.readyState === WebSocket.OPEN;
  }

  checkAlive() {
    if (this.error) return;
    if (this.monotonic() - this.lastHeard > 2.5 * TIMINGS.KEEPALIVE) {
      this.fail(new MaError('timeout'));
      return;
    }
    try {
      this.ws.ping();
    } catch {
      this.fail(new MaError('closed'));
    }
  }

  onMessage(data, isBinary) {
    this.heard();
    if (this.error) return;
    if (isBinary) {
      this.fail(new MaError('protocol'));
      return;
    }
    let message;
    try {
      message = JSON.parse(data.toString('utf8'));
    } catch {
      this.fail(new MaError('protocol'));
      return;
    }
    if (!isPlain(message)) {
      this.fail(new MaError('protocol'));
      return;
    }
    if (!this.info) {
      this.onServerInfo(message);
      return;
    }
    if (typeof message.event === 'string') {
      // Events before the authentication are not ours to read.
      if (this.ready) this.emit('event', message);
      return;
    }
    if (message.message_id === 'connection' && 'error_code' in message) {
      // "Setup required": the first user was never created.
      this.fail(
        new MaError(message.error_code === 503 ? 'setup_required' : 'refused', {
          maCode: message.error_code,
        }),
      );
      return;
    }
    const id = typeof message.message_id === 'string' ? message.message_id : undefined;
    const entry = id === undefined ? undefined : this.pending.get(id);
    if (!entry) return; // an answer to nothing we sent (or too late): ignored
    if ('error_code' in message) {
      this.settle(id, entry);
      entry.reject(
        new MaError('command', {
          maCode: Number.isInteger(message.error_code) ? message.error_code : undefined,
          details: cleanText(message.details),
          sent: true,
        }),
      );
      return;
    }
    if (message.partial === true) {
      if (!Array.isArray(message.result)) {
        this.fail(new MaError('protocol'));
        return;
      }
      entry.parts.push(...message.result.slice(0, LIMITS.PARTIAL_ITEMS));
      if (entry.parts.length > LIMITS.PARTIAL_ITEMS) entry.parts.length = LIMITS.PARTIAL_ITEMS;
      return;
    }
    this.settle(id, entry);
    let result = message.result;
    if (entry.parts.length > 0 && Array.isArray(result)) {
      result = [...entry.parts, ...result].slice(0, LIMITS.PARTIAL_ITEMS);
    }
    entry.resolve(result);
  }

  settle(id, entry) {
    this.timers.clearTimeout(entry.timer);
    this.pending.delete(id);
  }

  onServerInfo(message) {
    // The envelope first: anything else is not a Music Assistant server.
    if (
      typeof message.server_id !== 'string' ||
      !Number.isInteger(message.schema_version) ||
      typeof message.server_version !== 'string'
    ) {
      this.fail(new MaError('not_ma'));
      return;
    }
    const info = {
      serverId: cleanText(message.server_id, 64),
      version: cleanText(message.server_version, 32),
      schema: message.schema_version,
      minSchema: Number.isInteger(message.min_supported_schema_version)
        ? message.min_supported_schema_version
        : message.schema_version,
      name: cleanText(message.name ?? '', 80),
      onboardDone: message.onboard_done === true,
    };
    this.info = info;
    if (info.schema < MIN_SCHEMA) {
      this.fail(new MaError('too_old', { details: info.version }));
      return;
    }
    if (info.minSchema > OUR_SCHEMA) {
      this.fail(new MaError('too_new', { details: info.version }));
      return;
    }
    this.timers.clearTimeout(this.openTimer);
    this.keepalive = this.timers.setInterval(() => this.checkAlive(), TIMINGS.KEEPALIVE);
    this.emit('info', info);
    this.send('auth', { token: this.token }, { timeout: TIMINGS.AUTH, beforeReady: true }).then(
      (result) => {
        if (!isPlain(result) || result.authenticated !== true) {
          this.fail(new MaError('refused'));
          return;
        }
        this.user = {
          name: cleanText(result.user?.username ?? '', 64),
          role: cleanText(result.user?.role ?? '', 32),
        };
        this.ready = true;
        const resolve = this.startResolve;
        this.startResolve = undefined;
        this.startReject = undefined;
        resolve?.({ info, user: this.user });
      },
      (err) => {
        if (err.code === 'command') {
          const refused = [
            MA_ERRORS.AUTHENTICATION_REQUIRED,
            MA_ERRORS.AUTHENTICATION_FAILED,
            MA_ERRORS.INVALID_TOKEN,
          ].includes(err.maCode);
          this.fail(new MaError(refused ? 'refused' : 'protocol', { maCode: err.maCode }));
        } else {
          this.fail(err);
        }
      },
    );
  }

  /**
   * Sends a command; resolves with its result (the `partial` parts joined),
   * rejects with a MaError. An `urgent` command (pause, stop, mute, a lower
   * volume) is not held by the limit of requests in flight (only by a hard
   * bound four times higher).
   */
  request(command, args = {}, { timeout = TIMINGS.COMMAND, urgent = false } = {}) {
    return this.send(command, args, { timeout, urgent });
  }

  send(command, args, { timeout, urgent = false, beforeReady = false }) {
    if (this.error) return Promise.reject(new MaError(this.error.code));
    if (!beforeReady && !this.ready) return Promise.reject(new MaError('closed'));
    const limit = urgent ? 4 * LIMITS.IN_FLIGHT : LIMITS.IN_FLIGHT;
    if (this.pending.size >= limit) return Promise.reject(new MaError('busy'));
    this.nextId += 1;
    const id = `g${this.nextId}`;
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, timer: undefined, parts: [] };
      entry.timer = this.timers.setTimeout(() => {
        if (this.pending.get(id) !== entry) return;
        this.pending.delete(id);
        reject(new MaError('timeout', { sent: true }));
      }, timeout);
      this.pending.set(id, entry);
      try {
        this.ws.send(JSON.stringify({ message_id: id, command, args }));
      } catch {
        this.settle(id, entry);
        reject(new MaError('closed'));
      }
    });
  }
}
