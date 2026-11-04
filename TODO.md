# TODO — gladys-music-assistant

## Status

Version 0.1.0, not published (no tag, no topic: not in the store). Built for
Louis's tests in developer mode (image `:dev` on GHCR). Review r1 (`high`):
À CORRIGER, fixed in ff23518; review r2: À CORRIGER (B3, regression), fixed in the
next commit; r3 to come.

## Decisions

- **Version 0.1.0 set by hand** in `package.json`, `package-lock.json` and the
  manifest (`docker_image` `ghcr.io/lm1lc3n7/gladys-music-assistant:0.1.0`).
- **Scope**: Louis, 2026-11-04 — Qobuz and Spotify at least, through Music
  Assistant only (no credential of these services in the module); voice out of
  scope (Gladys does it); Music Assistant runs apart (host network), never as a
  sub-container of Gladys.
- **Own WebSocket client on `ws`** (no `music-assistant-client`: one version,
  one maintainer; no GPL client).
- **Identity**: `player:<16 hex of SHA-256(player_id)>` (player ids carry `:`).
  Stable across renames; a new Music Assistant install with new player ids
  gives new devices.
- **No polling**: the picture comes from `players/all`, `player_queues/all`
  and `providers` after each authentication, then from the events.
  `queue_time_updated` (every second) is ignored.
- **Volume cap 60 % by default.** Also applied before play / previous / next /
  play media / queue jump / play by search / unmute / group: the players that
  would sound (the player, its group members, its leader and the leader's
  members when it plays in a group) are lowered first; a volume unknown is
  read again (`players/get`), still unknown: nothing plays; nothing plays when
  lowering fails. A group player (`type: group`) gets its volume member by
  member. Seek, shuffle, repeat do not lower (no start of playback meant):
  to watch in the real tests.
- **Budgets per call of Gladys** (r1, I1): 4.5 s command, 8.5 s music player,
  27 s play_search, 8 s set_volume, 13 s group/ungroup, 18 s connection test;
  each request gets at most what is left, a command with an effect needs
  1.5 s left, urgent ones (pause, stop, mute, lower volume) are only bounded.
- **Preferred provider**: search `providers: ["library", <domain>]` and keep
  the items playable from that domain (never `providers: [<domain>]` alone:
  Music Assistant then drops the provider items already in the library),
  play the provider's own copy (`<instance>://<type>/<id>`); nothing there or
  provider not set up: every provider. Output `provider` says which one played.
- **Latest album** (r1, I2): the artist's albums on its provider
  (`artist_albums` on the provider mapping, never the library alone which only
  holds favorites); Music Assistant types (AlbumType of 2.10.9: album, single,
  live, soundtrack, compilation, ep, unknown) and title words (best-of,
  compilation, soundtrack, live: `src/ma/model.js`); a reissue left out only
  when its original (same base title) is listed; highest year; no year: a
  clear error. Can be wrong (said in the docs).
- **Refused token**: remembered in `/data` by a 2-hex marker of a salted
  SHA-256 (fiche: truncated print, no token); lifted by saving the
  configuration (any save: a new token has 1 chance in 256 of the same
  marker) or a successful connection test. Another error at the welcome of
  Music Assistant (not 503) is not a refusal: tried again with the backoff.
- **Backoff** 2 s doubled up to 5 min; back to 2 s only after a session that
  lived 60 s.
- **Artwork**: only from `<configured address>/imageproxy/<id>` (the host of
  the `image_url` of Music Assistant is its internal URL, often a Docker IP),
  JPEG 512 px (256 px in lists), 300 KB max, retried at 256 px when too large.
- Manifest without `keywords` / `countries` (later).
- **Image label** `io.gladysassistant.manifest` built from the manifest by the
  Build workflow (`GLADYS_MANIFEST` build argument), for dev installs by image.

## Contract checked against Music Assistant 2.10.9 (2026-11-04)

Official image `ghcr.io/music-assistant/server:2.10.9` on the VM (`--memory 2g`,
data in a temporary folder, removed after), built-in providers only: the
Snapcast provider with two `snapclient` inside the container as players, the
"Test / demo provider" as catalog. Checked: server info first, `auth` (error 23
on a bad token, 20 before auth), `players/all`, `player_queues/all`,
`providers`, `music/search` (library items with `provider_mappings`),
`music/browse`, `artist_albums` (only `item_id`, `provider_instance_id_or_domain`,
`provider_filter` in 2.10.9: no sort nor type filter, the module sorts),
`album_tracks`, `play_media` (replace / next / add), `play_index`, `items`,
volume, mute, shuffle, repeat, group / ungroup, `radio_playlist://playlist/<uri>`,
image proxy without token. The end-to-end run of the module (fake Gladys of the
SDK, real server) passed; `seek` timed out on a Snapcast player that was not
really playing. A token revoked in Music Assistant closes the session; the
next try is refused (error 23) and the module stops trying, as designed.

Mutations (one at a time, full suite): 23 mutants on the volume cap (each
lowering before play / unmute / queue jump / play by search / group, the
values capped, a wrong cap value), the urgency of pause, the provider choice
(config, library + provider search, provider copy, albums of the provider) and
the latest album (year, reissues, album types, "deluxe"), and the album order
of an artist: all killed.

## Tests chez Louis (Qobuz et Spotify)

1. Installer en dev (README), configurer l'adresse et un jeton d'un
   utilisateur dédié ; « Tester la connexion » doit dire Qobuz : oui, Spotify : oui.
2. Découverte : le Denon HEOS apparaît ; l'ajouter ; lecture, pause, volume
   (au-dessus du plafond → plafond), sourdine, suivant ; le widget Musique
   montre titre, artiste, pochette.
3. Chercher « Céline Dion » dans le widget : artistes, albums avec l'année et
   le fournisseur ; ouvrir l'artiste : albums du plus récent au plus ancien.
4. Jouer un album en « remplacer », un titre en « ensuite » et en « à la fin »
   ; la file d'attente et le saut.
5. Scène « jouer par recherche » : « dernier album » de Céline Dion avec
   Qobuz d'abord, puis Spotify d'abord (comparer avec la discographie réelle :
   rééditions, live, compilations, albums français et anglais) ; radio
   d'artiste avec Spotify et avec Qobuz seul ; une playlist Spotify ; une
   station de radio.
6. Spotify : temps d'une recherche (Client ID global ou personnel) contre le
   délai de 10 s de Gladys ; Soloist ou librespot selon le compte.
7. Jeton : révoquer le jeton dans Music Assistant → statut « a refusé le
   jeton », plus d'essai ; nouveau jeton → reconnexion.
8. Redémarrer Music Assistant pendant une lecture : « connexion perdue », puis
   reconnexion et état à jour.
9. « Trouver Music Assistant » depuis Gladys (mDNS sur le réseau de pve01).
10. Droits : un utilisateur de rôle plus limité que « user » suffit-il ?

## Review r1: done and left

Done: B1 (next/previous, group members, unknown volume), B2 (finite min/max
test), I1 (budgets), I2 (latest album and docs), I4 (tests for the r1
survivors), minors 1 (welcome error), 2 (refusal forgotten on save), 3
(stable session before resetting the backoff), 4 ("sent, the connection
closed"), 5 (capped volume published again), 7 (128 commands in flight in the
docs), 8 (mDNS spoofing said in the docs), 9 (this file).

Left: minor 6, `elapsed_time_last_updated` not read: if Music Assistant does
not refresh `elapsed_time` on each event, the position may lag; to check in a
real playback at Louis's.

Mutations r1 (one at a time, whole suite): 31 mutants on B1, B2, I1, I2, I4 and
the minors, all killed; the redundant slice of the partial parts was removed
(equivalent mutant).

## Review r2: done and left

Done: B3 (a `partial` part is bounded item by item before being kept, never
`push(...list)`; `onMessage` under a guard: an exception ends the session as
"unreadable", never the process; test with 300 000 items), I1 (each path
that starts sound pinned as an effect with a deadline; budgets tied to the
core delays and to `timeout_seconds` of the manifest), minor 1 (third member
and `active_group` tested), minor 2 (an offline member is skipped), minor 4
(title words only in a telltale form: "Live in Love", "Best of Me",
"Essential Love", "Music from the Heart", "Ost" stay studio albums).

Left: minor 3, a group player set member by member flattens the balance of
its members (20 % and 30 % both go to the level asked): to look at with
Louis's groups. Mutations r2 (one at a time, whole suite): 24 mutants on B3,
I1 (effect per path, budgets), groups and title forms, all killed.

## Later

- `play_notification` (annonces par `play_announcement`), « Don't stop the
  music », power, sources, minuteur de sommeil.
- Option « fournisseurs de recherche » pour le widget.
- Tests contre la bêta 2.11 avant chaque release (schéma 102 en dev).
- `keywords` / `countries` du manifeste.

## Next patch (review r3, minors)

- An offline group member at 95 % is not lowered: if it comes back during playback it plays at its
  Music Assistant volume, above the cap. Lower it when it comes back online (player_updated).
- Album names longer than 200 characters: cut before the title regexes (a hostile server could stall
  the event loop about 33 s with 200 000 parentheses).
- Untested: target player offline; two nested try/catch overlap (3 surviving mutants).
