# Changelog

All notable changes to murdock are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/); this project
uses [Semantic Versioning](https://semver.org/).

## [0.0.2] — 2026-07-24

The "make it actually run in the cloud" release. Everything below surfaced only
on the hosted container — the local app was never affected.

### Added
- **Live public deployment** at https://murdock.onrender.com (Render free tier,
  Docker).
- **Product and engineering scope docs**, published to Notion.
- This changelog.

### Changed
- **yt-dlp is now installed via pip into a venv**, replacing the standalone
  `yt-dlp_linux` PyInstaller build.
- **`/api/health` caches yt-dlp availability** (checked once at boot, refreshed
  on an interval) instead of spawning a subprocess on every request.
- **Container ffmpeg is now yt-dlp's patched static build**, replacing Debian's
  apt `ffmpeg`.
- `package.json` version aligned to the changelog (`0.0.2`).

### Fixed
- **Hosted service hung on every request.** The `yt-dlp_linux` bundle
  self-extracts ~30 MB per invocation; on the throttled free-tier CPU a single
  `yt-dlp --version` exceeded its timeout. Because `/api/health` probed yt-dlp
  per request and the platform polls health frequently, hung processes piled up
  and wedged the 512 MB instance. Fixed by the pip install + cached health check.
- **Clipping failed on HLS sources (SoundCloud) on the container** with
  "unable to obtain file audio codec with ffprobe", while full grabs and all
  local clips worked. Debian's apt ffmpeg (5.x) mishandles `--download-sections`
  on HLS; yt-dlp's patched build fixes it. Verified: an 8 s clip returns exactly
  8.000 s of valid stereo audio.

## [0.0.1] — 2026-07-20

Initial build: paste a link, get an audio file.

### Added
- **Link → audio extraction** across 12 named platforms (YouTube, Spotify,
  TikTok, Instagram, X, SoundCloud, Bandcamp, Vimeo, Facebook, Reddit, Twitch,
  Mixcloud) with unknown hosts attempted via yt-dlp (~1000 more sites).
- **Output formats:** WAV, FLAC, MP3, M4A, OPUS.
- **Clip trimming** via start/end timecodes (`0:45`, `1:02:03`, or raw seconds).
- **Stereo downmix** (on by default; keeps 5.1 sources from loading awkwardly
  into a DAW).
- **Spotify resolver** — reads track metadata and matches it on YouTube, since
  Spotify streams are DRM-protected and cannot be downloaded directly.
- **Waveform preview player** — Web Audio + canvas, click/drag seek, keyboard
  scrub, zero dependencies.
- **Opt-in ephemeral storage** — TTL sweep + disk-quota eviction, enabled only
  via `MURDOCK_EPHEMERAL` (off by default so a local library is never swept).
- **Per-IP rate limiting** and a **global job-concurrency cap**.
- **Dockerfile** and **render.yaml** for hosted deployment.

### Fixed
- 5.1 surround passed through as 6-channel audio → stereo downmix by default.
- Spotify artist reported as "Spotify" (track page is an SPA with no OG tags) →
  read the embed page's `__NEXT_DATA__` payload.
- `ytsearch1:` returned a playlist container (title = query, null duration) →
  unwrap to the matched entry.
- Re-grabbing an existing source reported "produced no audio file" → resolve the
  output path from yt-dlp instead of diffing the directory, and `--force-overwrites`.
- Two clips of the same source collided on one filename → clip range added to
  the filename.
- Progress bar stuck at 0 then jumped to 100 → read progress from stdout, and
  `--progress` (since `--print` implies `--quiet`).
- A default-on TTL sweeper deleted real user files from `downloads/` → made
  auto-deletion opt-in; `downloads/` is a library locally, a scratch buffer only
  when hosted.

[0.0.2]: https://github.com/darendigit/murdock/releases/tag/v0.0.2
[0.0.1]: https://github.com/darendigit/murdock/releases/tag/v0.0.1
