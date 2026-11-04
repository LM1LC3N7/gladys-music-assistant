# TODO — gladys-music-assistant

## Status

Version 0.1.0, not published (no tag, no topic: not in the store). Built for
Louis's tests in developer mode. Review steps of `~/code/integrations/CLAUDE.md`
not run yet (relecture `high`).

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
- **Volume cap 60 % by default.** Also applied before play / play media / queue
  jump / play by search / unmute / group: a louder player is lowered first,
  and nothing plays when that fails.
- **Preferred provider**: search `providers: ["library", <domain>]` and keep
  the items playable from that domain (never `providers: [<domain>]` alone:
  Music Assistant then drops the provider items already in the library),
  play the provider's own copy (`<instance>://<type>/<id>`); nothing there or
  provider not set up: every provider. Output `provider` says which one played.
- **Latest album**: the artist's albums on its provider (`artist_albums` on the
  provider mapping, never the library alone which only holds favorites),
  studio albums (`album`, or `unknown` when nothing is typed), originals before
  reissues (remaster, deluxe, edition, live…), highest year; no year at all:
  a clear error, never a random album.
- **Refused token**: remembered in `/data` by a 2-hex marker of a salted
  SHA-256 (fiche: truncated print, no token); lifted by a new token or a
  successful connection test.
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

## Later

- `play_notification` (annonces par `play_announcement`), « Don't stop the
  music », power, sources, minuteur de sommeil.
- Option « fournisseurs de recherche » pour le widget.
- Tests contre la bêta 2.11 avant chaque release (schéma 102 en dev).
- `keywords` / `countries` du manifeste.
