# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

First version, 0.1.0 (not published yet).

### Added

- Connection to a Music Assistant server (2.8 or later) over its local
  WebSocket API, with a long-lived token kept as a secret field; the server is
  recognized before the token is sent; reconnection 2 s doubled up to 5 min; a
  refused token stops the tries until a new token is saved or the connection
  test succeeds; the token expiry is shown 30 days ahead.
- One Gladys music player per Music Assistant player: play, pause, stop,
  previous, next, volume, mute, seek, shuffle, repeat, now playing with the
  artwork (through the image proxy of Music Assistant), published on events.
- Browse (an artist lists its albums latest first, with the year), search,
  play (replace, next, append), queue and jump in the queue.
- Scene actions: play by search (track, album, playlist, artist, latest album
  of an artist, artist radio, radio station) with a preferred provider
  (Qobuz, Spotify or automatic), set the volume, group, ungroup.
- A volume cap (60 % by default): no command sets a louder volume (a group
  player is set member by member); before Gladys starts sound (play, next,
  previous, play a media, queue jump, play by search), unmutes or groups a
  player, the players that would sound louder, group members and leader
  included, are brought down to it, and an unknown volume is read again or
  nothing plays; a lower volume, pause, stop and mute are not held by it.
- A time budget per call of Gladys (4.5 s for a command, 8.5 s for the music
  player, 27 s for "play by search"): past it nothing more is sent, so nothing
  starts after Gladys stopped waiting.
- "The latest album": Music Assistant types plus title words (best-of,
  compilation, soundtrack, live), a reissue left out only when its original
  is listed.
- Configuration buttons: "Test the connection" (version, Qobuz and Spotify,
  music providers, players) and "Find Music Assistant" (mDNS through Gladys).
- The Docker image carries its manifest as a label, for the developer mode of
  Gladys.
