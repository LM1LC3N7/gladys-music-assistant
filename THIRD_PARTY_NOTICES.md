# Third-party notices

This integration is licensed under the Apache License 2.0 (see `LICENSE`). It
ships or relies on the following third-party work.

## Music Assistant (protocol reference, no code copied)

The WebSocket client (`src/ma/client.js`) and the mappings (`src/ma/model.js`)
were written from the documented API of Music Assistant: the message formats
(`ServerInfoMessage`, `CommandMessage`, `SuccessResultMessage` with `partial`,
`ErrorResultMessage`, `MassEvent`), the error codes, the enums (`MediaType`,
`AlbumType`, `QueueOption`, `RepeatMode`, `PlaybackState`) and the commands,
as read in:

- Music Assistant server, <https://github.com/music-assistant/server>,
  version 2.10.9 (`controllers/webserver/websocket_client.py`,
  `controllers/music/`, `controllers/metadata/images.py`,
  `providers/radio_playlist/`);
- Music Assistant models, <https://github.com/music-assistant/models>
  (`api.py`, `enums.py`, `errors.py`, `event.py`, `helpers.py`).

Copyright Music Assistant contributors. Licensed under the Apache License,
Version 2.0 (the same license as this integration; full text in `LICENSE`).
No source file of Music Assistant is included in this repository or in its
image; this integration is not affiliated with, nor endorsed by, the Music
Assistant project. "Music Assistant" is used only to name the server this
integration connects to.

The test fixtures (`test/helpers/fakeMa.js`) reproduce the shape of the
answers of Music Assistant 2.10.9, checked against the official image
`ghcr.io/music-assistant/server:2.10.9` with built-in providers only.

## Runtime dependencies (npm, shipped in the image)

- `@gladysassistant/integration-sdk`, Apache License 2.0, Copyright Gladys
  Assistant contributors, <https://github.com/GladysAssistant/integration-sdk-js>.
- `ws`, MIT License, Copyright (c) 2011 Einar Otto Stangvik, Copyright (c) 2013
  Arnout Kazemier and contributors, Copyright (c) 2016 Luigi Pinca and
  contributors, <https://github.com/websockets/ws>.

  > Permission is hereby granted, free of charge, to any person obtaining a copy
  > of this software and associated documentation files (the "Software"), to
  > deal in the Software without restriction, including without limitation the
  > rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
  > sell copies of the Software, and to permit persons to whom the Software is
  > furnished to do so, subject to the following conditions:
  >
  > The above copyright notice and this permission notice shall be included in
  > all copies or substantial portions of the Software.
  >
  > THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
  > IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
  > FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
  > AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
  > LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
  > FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
  > IN THE SOFTWARE.

No GPL, AGPL or LGPL code is used, shipped or ported.
