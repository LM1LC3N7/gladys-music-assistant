# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for
human contributors. Read **[TODO.md](./TODO.md) first**: status, decisions
already taken, the contract checked against Music Assistant, what is left.

## What this is

A Gladys Assistant **external integration** of type `device`: a Node.js
service (Node 22+, ESM, no build step) in its own sandboxed Docker container,
talking to Gladys through `@gladysassistant/integration-sdk` (v0.16) and to a
**Music Assistant** server (2.8+) through its local WebSocket API
(`ws://<server>:8095/ws`, JSON commands, results, events), with a long-lived
token. Runtime dependencies: the SDK and `ws`. One device per Music Assistant
player, music features and the music player contract of Gladys 5.3 (browse,
search, play, queue, artwork), scene actions. Local only. Not affiliated with
Music Assistant. Qobuz, Spotify and the other providers are set up in Music
Assistant: the module never talks to them.

## Commands

```bash
npm install
npm test                                  # node --test --test-timeout=60000
node --test test/app.test.js              # one file
npm run lint
npm run format:check
npm run audit
npm run cover                             # regenerates cover.png
node ~/code/ref/integration-store/src/validate-cli.js . --skip-image-check
```

## Architecture

```
index.js                SDK bootstrap only
src/handlers.js         every SDK handler -> the app (shared with the tests)
src/app.js              MusicAssistantApp: lifecycle, session, picture,
                        publication, commands, music handlers, scene
                        actions, buttons, artwork, volume cap
src/ma/client.js        one WebSocket session: server info, auth, commands
                        (partial results), events, keepalive, bounds
src/ma/model.js         Music Assistant objects -> now playing, MediaItems;
                        best match, provider of an item, latest album (pure)
src/devices.js          the player device, its id, its features (pure)
src/store.js            /data: the marker of a refused token
src/config.js           config_schema normalized, address parsing, JWT expiry
src/constants.js        timings, limits, keys
src/i18n.js             runtime texts (en/fr)
test/helpers/fakeMa.js  a fake Music Assistant (HTTP + WebSocket, loopback)
```

## Rules

- **Keys are forever**: the manifest keys (config, actions, scene actions and
  their field values), the feature keys (`FEATURE`), the device id shape
  `player:<16 hex of SHA-256(player_id)>`.
- **The token never leaves memory and Music Assistant**: never logged, never in
  a status, an error, /data or a test output; sent only after the server info
  of Music Assistant was recognized. Log error codes, never a body.
- **Volume cap**: no command sets a volume above `max_volume`; a louder player
  is lowered before Gladys plays, unmutes or groups it. Pause, stop, mute and a
  lower volume are never held (urgent: past the limit of commands in flight).
- **States only from the live picture** of the current session; nothing
  stale republished; no polling.
- **Read-only rootfs**: write only `/data`.
- **Versions belong to the Release workflow**; changelog under
  `## [Unreleased]`.
- **User-facing text** bilingual (`docs/en.md`, `docs/fr.md`, manifest,
  `src/i18n.js`); a secret is never described as ciphered (test/encoding.test.js).
- **Tests never touch the network** beyond loopback (the fake Music Assistant,
  the kit in `test/kit`).
- **Never tested with real Qobuz / Spotify accounts**: `TODO.md` lists what
  Louis checks.
