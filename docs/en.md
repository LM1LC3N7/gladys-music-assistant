# Music Assistant for Gladys

Community integration, not affiliated with the Music Assistant project. It
connects Gladys to a [Music Assistant](https://www.music-assistant.io/) server
you already run: every Music Assistant player (HEOS, Sonos, Chromecast,
AirPlay, Snapcast speaker, group…) becomes a **Gladys music player**, with the
catalog of every provider added in Music Assistant (**Qobuz**, **Spotify**,
radios, local files…).

> **Version 0.1.0, to be tested.** It was checked against the official Music
> Assistant 2.10.9 image with built-in providers that need no account, but it
> was **never tested with a real Qobuz or Spotify account** nor with a real
> speaker. Feedback is welcome.

## What you get

- One Gladys music player per Music Assistant player: play, pause, stop,
  previous, next, volume, mute, position (seek), shuffle, repeat, and the
  track playing with its artwork for the Music widget.
- The **catalog** in Gladys: browse (the folders of each provider; an open
  artist lists its albums **latest first**, with the year), search (tracks,
  albums, artists, playlists, radios), play replacing the queue, **next** or
  **at the end**, see the queue and jump in it.
- **Scene actions**: play by search (including "the latest album of …" and an
  artist radio), set the volume, group or ungroup two players.

Voice control is not handled here: Gladys does it, with the player and the
scene actions above.

## Before you start: Music Assistant

Music Assistant runs **apart** from Gladys:

- as a Docker container in **host network**
  (`ghcr.io/music-assistant/server`, `network_mode: host`, a `/data` volume),
  see the [installation](https://www.music-assistant.io/installation/);
- or as a Home Assistant add-on.

It needs the host network to discover the speakers and stream audio to them.
That is why the integration does not start it: the containers of Gladys live
on an isolated network. The integration only connects to its local API (port
8095), like the Music Assistant web app does.

Minimum version: Music Assistant **2.8**. Authentication is mandatory since
2.7: a token is needed.

### Your Qobuz and Spotify accounts stay in Music Assistant

Add Qobuz, Spotify and your other providers **in the Music Assistant
interface** (Settings > Music providers). The integration never talks to
Qobuz or Spotify directly, never sees your credentials and never sets a
provider up for you: Music Assistant holds the relation with these services.

- **Qobuz**: paid subscription. Search, albums, playlists and the albums of
  an artist work. An artist radio is **poor** with Qobuz alone (Qobuz gives no
  similar tracks). The artwork of an artist missing from your library may be
  absent. [Music Assistant Qobuz page](https://www.music-assistant.io/music-providers/qobuz/).
- **Spotify**: **Premium** account required. Music Assistant plays either
  through librespot (usually fails with accounts created since December 2024)
  or Spotify Soloist (works with every Premium account, host network
  required, one stream at a time per account): you choose in Music Assistant.
  A **personal Spotify Client ID** is advised: without one, searches go
  through a slow shared quota. An artist radio is rich with Spotify.
  [Music Assistant Spotify page](https://www.music-assistant.io/music-providers/spotify/).

### Create the token

1. In Music Assistant, preferably create a **user dedicated** to Gladys
   (Settings > Users). The "user" role is enough; a more limited role was not
   tried yet.
2. Signed in as that user, open **Settings > Profile > Long-lived access
   tokens** and create a token (valid one year).
3. Copy it: Music Assistant does not show it again.

## Configuration

1. Install the integration, then open its **Configuration** tab.
2. **Music Assistant address**: `http://192.168.1.20:8095`, or just
   `192.168.1.20` (port 8095 by default). The **Find Music Assistant** button
   looks for the server on the local network (mDNS `_mass._tcp`, through
   Gladys) and fills the address in when exactly one server answers. Check
   the address found: a device of the local network could pose as Music
   Assistant.
3. **Long-lived token**: paste the token. It is kept by Gladys in its
   database, never shown again, sent only to your Music Assistant server.
4. **Volume cap** (60 % by default): see below.
5. **Preferred provider**: Automatic, Qobuz or Spotify (see "Play by search").
6. Save, then click **Test the connection**: the message lists the Music
   Assistant version, whether Qobuz and Spotify are there, the music providers
   and the players.
7. Open the **Discovery** tab and add the players you want.

### What the connection status says

- "Connected to … (Music Assistant 2.10.9): N player(s)", with a warning when
  the token expires in less than 30 days, or has expired.
- "Music Assistant does not answer" / "The connection … was lost": tried
  again after 2 s, then 4, 8… up to 5 minutes between two tries.
- "is not a Music Assistant server": wrong port, or another service. The
  token is sent only after the welcome message of Music Assistant was
  recognized.
- "is not set up yet": create the first user in Music Assistant.
- "too old" (before 2.8) or "changed its API" (update the integration).
- "refused the token": revoked, expired or mistyped. The integration then
  **stops trying**, even after a restart (it keeps in `/data` only a 2-hex
  marker, never the token). It tries again when you save the configuration
  (new token or not), or when **Test the connection** succeeds with the saved
  token.
- "refused the connection (error N), not the token": another refusal at the
  welcome of Music Assistant; tried again later.

## The volume cap

No command of the integration sets a volume above the cap (1 to 100 %, 60 %
by default, 100 = no cap):

- a louder volume asked by the dashboard or a scene is set to the cap; on a
  Music Assistant **group player**, the volume is set member by member (each
  at most at the cap), not on the group;
- before **starting sound** (play, previous, next, play a media, jump in the
  queue, play by search), **unmuting** or **adding a player to a group**, the
  integration brings down to the cap the player set louder in Music
  Assistant, **the members of its group** and, when it plays in a group, its
  leader and the other members;
- an unknown volume is read again from Music Assistant; still unknown,
  nothing is started ("volume is unknown"); when lowering fails, nothing is
  started either.

A lower volume, pause, stop and mute are held neither by the cap nor by the
commands waiting (up to 128 commands in flight). They fail only when Music
Assistant cannot be reached or does not answer, no longer knows the player,
the player has no volume or mute, or Music Assistant itself refuses the
command. The volume set in the Music Assistant app itself is not changed as
long as Gladys plays nothing.

### Time limits

Gladys waits 5 s for a command, 10 s for a player request (browse, search,
play, queue) and the declared timeout of a scene action (30 s for "play by
search"). The integration gives itself a slightly shorter budget (4.5 s,
8.5 s, 27 s) for all the requests of one call: past it, it sends nothing more
and answers "Music Assistant is too slow". A command that starts sound is
sent only with at least 1.5 s left.

## The music player

The Music widget and the "Play a media" scene action of the Gladys core use
the player directly:

- **Browse**: the root shows the providers of Music Assistant; open a folder,
  an artist (its albums, latest first, with the year and the provider), an
  album or a playlist.
- **Search**: tracks, albums, artists, playlists, radios, on every provider.
  The subtitle gives the artist, the year of an album and the provider
  ("Céline Dion · 2019 · Qobuz").
- **Play**: replace the queue, play next, or add at the end.
- **Queue**: the list, the current position, and a jump to a position.
- **Artwork**: served by the image proxy of Music Assistant (512 px for the
  track playing, 256 px in lists), 300 KB at most.

## Scene actions

### Music Assistant: play by search

- **Player**, **Search text** (scene variables accepted).
- **What to play**: track, album, playlist, artist, **latest album of the
  artist**, **artist radio**, radio station.
- **Provider**: as in the configuration, Automatic, Qobuz first or Spotify
  first. With Qobuz or Spotify, the integration searches that provider first
  (your library items coming from it included) and plays its copy; when it
  has nothing, or is not set up in Music Assistant, every provider is
  searched.
- **Queue**: replace and play, play next, add at the end.
- Outputs: the title played, the provider, the year (for an album).

**"The latest album of Céline Dion"**, step by step:

1. New scene, any trigger.
2. Action **Music Assistant: play by search**: player "Living room", text
   "Céline Dion", what to play "Latest album of the artist", provider "Qobuz
   first".
3. The integration finds the artist, reads its albums **on that provider**,
   and chooses this way:
   - the **type** Music Assistant gives: album (never a single, EP, live,
     compilation nor soundtrack **when Music Assistant types them so**);
   - **words of the title**: "Best of", "Greatest Hits", "Les plus grands
     succès", "Collection", "Anthology", "Essentials", "Bande originale",
     "Soundtrack", "OST" leave an album out; so do "Live at…", "(Live)",
     "En concert", "Unplugged" (a studio album named "Live Forever" stays);
   - a **reissue** (remaster, deluxe, edition…) is left out only when the
     original of the same title is in the list: a new album out only as a
     "Deluxe Edition" stays;
   - then the **latest year** (same year: the order of Music Assistant).

This choice rests only on the type of Music Assistant and on these words: it
can be wrong, for instance on a live album without a telltale word ("Au
Palais Omnisports"), a best-of with a neutral title, or a reissue with a
changed title. The outputs of the action (title, year, provider) show what
was played. According to its code, Music Assistant reads at most the first
100 releases of a Qobuz artist; when no album kept has a year, the action
says so instead of playing one at random.

### Music Assistant: set the volume

Sets the volume of a player, never above the cap. Output: the volume actually
set.

### Music Assistant: group two players / take a player out of its group

Adds a player to the group of a leader (brought under the cap first), or
takes it out. Music Assistant must allow these two players together.

## Good to know

- **HEOS (Denon, Marantz)**: an amplifier may show twice in Gladys (the
  amplifier integration + the Music Assistant player). Each keeps its role:
  inputs and power on one side, music on the other. A multi-zone amplifier is
  one player in Music Assistant.
- The "now playing" comes from the events of Music Assistant, without polling.
- `/data` keeps only the marker of a refused token and its random salt.

## Troubleshooting

The logs of the integration (Supervision tab) tell each connection
("connected to …: N player(s), music providers: qobuz, spotify"), each loss
and each new try, never the token. Set `LOG_LEVEL=debug` for more.
