# Changelog

All notable changes to murdock are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/); this project
uses [Semantic Versioning](https://semver.org/).

## [0.1.1] — 2026-07-27

Fixes for the key shift, from real feedback (sounded warbly and took too long).

### Fixed
- **Shift quality** — the ffmpeg rubberband filter was running at its default
  `pitchq=speed` (warbly, "not smooth"). Now `pitchq=quality` + `smoothing=on`
  for a clean shift.
- **Shift speed / timeout** — a full-track shift measured ~106s even at the fast
  setting (and quality is slower), past the HTTP request timeout. `POST /api/shift`
  is now **asynchronous** (returns a jobId to poll); the UI shows a live elapsed
  counter instead of a frozen button. Tip: clip first, then shift — a short clip
  shifts in a few seconds; a full track on the free tier takes a couple of minutes.

### Added
- Shifter method (`ffmpeg-rubberband` / `rubberband-cli` / `ffmpeg-fallback`)
  reported in `/api/health`.

## [0.1.0] — 2026-07-26

The sampling-prep release — detect a sample's key and shift it into another.

### Added
- **Key detection** — estimates the musical key (with Camelot code) client-side
  (chroma + Krumhansl-Schmuckler) off the audio the player already decodes. Zero
  dependencies, no server cost. It's a best guess — the ±semitone control is the
  reliable fallback.
- **Key shifting** — pitch-shift a grab to a target key or by ±semitones, tempo
  preserved. New `POST /api/shift` runs rubberband (ffmpeg `rubberband` filter →
  `rubberband` CLI → `asetrate`/`atempo` fallback, detected at boot); the result
  swaps the player + download in place. Gated by the existing rate limit +
  concurrency slot. Verified live, incl. duration preserved exactly.
- UI: detected-key line, a "shift to key" picker and ±semitone steppers with a
  live resulting-key preview.
- Container installs `rubberband-cli`; `brew install rubberband` documented for
  best local quality.

## [0.0.5] — 2026-07-26

### Added
- **Apple Music** support. Its streams are DRM-protected (FairPlay) like
  Spotify, so murdock reads the song page's public metadata (schema.org JSON-LD
  `MusicRecording`, OpenGraph fallback — no account or API key) and matches the
  track on YouTube. Verified live on the hosted box, including a clipped grab.
  As with Spotify, the result is a best-guess YouTube match — the card shows
  what it matched.

### Changed
- Resolver dispatch generalized: Spotify and Apple Music share one path
  (`resolveTrack`), and the resolved-track response field + result-card note are
  now source-agnostic instead of Spotify-specific.

## [0.0.4] — 2026-07-24

A reliable hosted source set, and no more cold start. Source reliability was
verified with live test-grabs on the hosted box before shipping (feasibility
gate), which changed the plan mid-flight — see Fixed.

### Added
- **Keep-warm** — `.github/workflows/keep-warm.yml` pings `/api/health` every
  ~10 min so the free tier stops cold-starting; README documents the more
  reliable external-monitor option (UptimeRobot / cron-job.org).
- Per-source **tiers** (supported / best-effort / unsupported) in
  `src/services.js`, driving detection, routing, and the UI.

### Changed
- **yt-dlp → nightly** in the container. Extractor fixes land there first.
- **WARP routing generalized** from YouTube-only to a data-driven per-provider
  `proxied` flag — now covers YouTube, Spotify, TikTok, Reddit, and unknown
  hosts. Reliable music sites stay direct (WARP only adds latency for them).
- Supported-source list curated to what actually works hosted.

### Removed
- **Instagram, X/Twitter, Facebook** — dropped from the UI. They require a login
  no hosted tool can do reliably; murdock now refuses them up front with a calm
  notice instead of a raw yt-dlp cookies error. TikTok stays as **best-effort**
  (labeled in the UI).

### Fixed
- **Vimeo and Mixcloud** — broken on stable yt-dlp `2026.07.04` (Vimeo threw a
  macOS-OAuth 401), fixed by the nightly switch. Verified live on the hosted box,
  including a clipped Vimeo grab.

## [0.0.3] — 2026-07-24

Hosted YouTube & Spotify, plus player polish.

### Added
- **YouTube and Spotify now work on the hosted instance.** YouTube-bound
  requests are routed through a userspace Cloudflare WARP tunnel (wgcf +
  wireproxy) whose IP YouTube doesn't block. The tunnel is verified at boot and
  the proxy is only enabled once traffic is confirmed to egress through WARP;
  non-YouTube sources still go direct. (Fragile by nature — it works until
  YouTube starts blocking WARP ranges.)
- **Graceful degradation** — if YouTube is ever unreachable, grabs surface a
  calm "try again in a few minutes or use a link from another service" notice
  instead of yt-dlp's raw bot-check error.

### Changed
- Play/pause button is now a single icon that crossfades between states, rather
  than rendering both stacked.
- Waveform progress fills smoothly at the exact playhead position instead of
  snapping bar to bar.

### Fixed
- Clipped YouTube grabs failed on the hosted instance with "ffmpeg exited with
  code 8". yt-dlp hands its proxy to ffmpeg as `-http_proxy`, which requires an
  HTTP proxy, not SOCKS5, so ffmpeg couldn't reach YouTube through WARP. WARP is
  now exposed as an HTTP proxy. Verified — an 8 s clip returns exactly 8.000 s
  of valid stereo audio.

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

[0.1.1]: https://github.com/darendigit/murdock/releases/tag/v0.1.1
[0.1.0]: https://github.com/darendigit/murdock/releases/tag/v0.1.0
[0.0.5]: https://github.com/darendigit/murdock/releases/tag/v0.0.5
[0.0.4]: https://github.com/darendigit/murdock/releases/tag/v0.0.4
[0.0.3]: https://github.com/darendigit/murdock/releases/tag/v0.0.3
[0.0.2]: https://github.com/darendigit/murdock/releases/tag/v0.0.2
[0.0.1]: https://github.com/darendigit/murdock/releases/tag/v0.0.1
