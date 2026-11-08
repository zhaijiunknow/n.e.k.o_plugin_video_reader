# Third-party attribution

This plugin vendors the original source and tests of SAOS-3624/dsh-see-now at
commit `8a5490885d23feec8aff6b035af95465d172c1f2`:
https://github.com/SAOS-3624/dsh-see-now

Copyright 2026 SAOS-3624. Licensed under Apache-2.0. Original LICENSE and NOTICE
are retained unmodified under `third_party/dsh-see-now/`.

No changes are made to the vendored source files. `UPSTREAM.json` records the
revision and SHA-256 of each file. `upstream_bridge.mjs` is our separate host
adapter: it decodes bounded local video segments through FFmpeg, calls the
original `createPipeline` with offline `queueDepth: 0`, and saves every produced
PNG plus its original frame metadata. Python handles downloading, process
lifecycle, N.E.K.O model bindings, and returning feedback. The old simplified
`sampling.py` implementation has been removed.

The original NOTICE describes the upstream project; this plugin sends selected
video images to the user-configured model provider for analysis. DSH-specific
UI, ASR/TTS and realtime host integrations are not activated by this adapter.

Runtime dependencies are supplied by `neko-plugin sync` with their own license
files: yt-dlp (Unlicense, with bundled component notices), imageio-ffmpeg (BSD)
and its platform-specific FFmpeg executable
(see that distribution's bundled FFmpeg license notices).

Node.js >=20 is an external runtime prerequisite, not redistributed in this package.
