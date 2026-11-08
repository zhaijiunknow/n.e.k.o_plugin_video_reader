# Third-party attribution

This plugin vendors the original source and tests of SAOS-3624/dsh-see-now at
commit `8a5490885d23feec8aff6b035af95465d172c1f2`:
https://github.com/SAOS-3624/dsh-see-now

Copyright 2026 SAOS-3624. Licensed under Apache-2.0. Original LICENSE and NOTICE
are retained unmodified under `third_party/dsh-see-now/`.

One formatting-only edit is applied to the vendored source: in `src/indicator.py` a
three-line `PySide6.QtGui` import is folded onto a single line, because the plugin
market reviews this repository with `ruff --isolated` (which ignores `ruff.toml`, so
`extend-exclude` cannot skip `third_party/`) and the original layout fails I001. That
script is a DSH desktop overlay this plugin never loads. The pristine and edited text
are recorded verbatim in `third_party/dsh-see-now/LOCAL-PATCHES.json`, and
`tests/test_video.py` restores the pristine text from that record before comparing
hash for hash against `UPSTREAM.json`, so any further change to a vendored file fails
the suite.

No other changes are made to the vendored source files. `UPSTREAM.json` records the
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
