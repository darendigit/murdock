# murdock

Paste a link, get an audio file. A local tool for sourcing vocal stems and
samples from online media.

```
npm start        # → http://localhost:5757
```

Files land in `./downloads`.

## What it does

Paste a URL, and murdock identifies the service, pulls the media, and transcodes
it to the audio format you pick.

**Supported:** YouTube, Spotify, Apple Music, SoundCloud, Bandcamp, Vimeo,
Mixcloud, Reddit, Twitch, direct links. **Best-effort (may fail):** TikTok.

**Not supported:** Instagram, X/Twitter, Facebook — these require a login that a
hosted tool can't do reliably, so murdock refuses them up front with a clear
message rather than a confusing failure. They may work from a local (residential
IP) run, but aren't dependable and are dropped from the hosted UI.

- **Formats** — WAV, FLAC (lossless, best for sampling), MP3, M4A, OPUS
- **Clipping** — optional start/end timecodes (`0:45`, `1:02:03`, or raw seconds)
  so you can pull just the phrase you want instead of the whole track
- **Preview player** — waveform with click/drag seeking, so you can hear the
  grab before committing it to disk. Arrow keys scrub ±5s, space toggles play.
- **Stereo downmix** — on by default; a lot of sources carry 5.1 audio, which
  loads awkwardly into a DAW. Turn it off to keep the original channel layout.

Files are named `Title [id]_start-end.ext`, so different clips of the same
source sit side by side instead of overwriting each other.

Beyond the named services, yt-dlp supports well over a thousand sites, so
unknown hosts are attempted rather than rejected.

## Spotify & Apple Music

Spotify (Widevine) and Apple Music (FairPlay) streams are DRM-protected and
cannot be downloaded — not by murdock, not by yt-dlp, not by anything. What
murdock does instead is read the track's public metadata (title + artist) and
match it against YouTube, then pull that. This is the same approach `spotdl`
takes. Both resolvers scrape only public page metadata; no account or API key.

**The match is a best guess.** Check the resolved title in the result card
before you sample it — you may get a live version, a remaster, or a cover
rather than the album cut you had in mind.

## Storage

By default **files are kept forever** — `./downloads` is your library.

Auto-deletion is opt-in and exists for hosted instances, where the download
directory is a scratch buffer rather than a library:

```
MURDOCK_EPHEMERAL=1        # enable sweeping (off by default)
MURDOCK_TTL_MINUTES=30     # delete files older than this
MURDOCK_MAX_DISK_MB=400    # cap total size, evicting oldest first
```

> Never set `MURDOCK_EPHEMERAL=1` against a directory holding audio you want to
> keep. The sweeper unlinks files directly — they do not go to the Trash.

## Deploying

The container installs `ffmpeg` and `yt-dlp` and enables ephemeral storage.

```
docker build -t murdock .
docker run -p 5757:5757 murdock
```

For Render: push the repo, then **New → Blueprint** and pick it — `render.yaml`
configures everything. See [docs/murdock-engineering-scope.md](docs/murdock-engineering-scope.md).

The container installs **yt-dlp nightly** (`--pre`) — extractor fixes land there
first, and stable had Vimeo + Mixcloud broken. A rebuild pulls the latest nightly.

**YouTube/Spotify on the hosted instance** work via a userspace Cloudflare WARP
tunnel (YouTube blocks datacenter IPs directly). It's brought up best-effort at
boot and only enabled once traffic is verified to egress through WARP; if it's
unavailable, those grabs fail gracefully and the other sources keep working.

A public instance is rate limited per IP (`MURDOCK_EXTRACT_PER_HOUR`, default
12) with a global concurrency cap (`MURDOCK_MAX_CONCURRENT`, default 2), since
512MB of RAM cannot survive many parallel transcodes.

### Avoiding the cold start
Render's free tier spins down after ~15 min idle, so the first request then takes
~1 min. Two free ways to keep it warm:

- **External monitor (recommended, reliable):** point [UptimeRobot](https://uptimerobot.com)
  or [cron-job.org](https://cron-job.org) at `https://<your-app>.onrender.com/api/health`
  every 10 minutes.
- **GitHub Action (in-repo):** `.github/workflows/keep-warm.yml` pings the health
  endpoint every ~10 min. Best-effort — GitHub's scheduler can lag and disables
  after ~60 days of repo inactivity, so the external monitor is more dependable.

One always-warm service fits within Render free tier's ~750 instance-hours/month.

## Docs

- [Product scope & plan](docs/murdock-product-scope.md)
- [Engineering scope & delivery](docs/murdock-engineering-scope.md)

## Requirements

- Node 20+
- `yt-dlp` and `ffmpeg` on PATH — `brew install yt-dlp ffmpeg`

For the full supported set locally (Vimeo + Mixcloud are broken on current stable
yt-dlp), run the **nightly** channel: `yt-dlp --update-to nightly`, or install via
`pipx install --pip-args=--pre yt-dlp`. The container already uses nightly.

yt-dlp breaks whenever a platform changes its internals, so update it when
extractions start failing:

```
brew upgrade yt-dlp
```

## Layout

```
server.js          Express API + job queue
src/services.js    URL → provider detection
src/ytdlp.js       yt-dlp wrapper (spawn, no shell)
src/spotify.js     Spotify metadata → YouTube search query
public/player.js   Waveform preview player (Web Audio + canvas, no deps)
public/            UI
```

### API

| Endpoint | Purpose |
| --- | --- |
| `POST /api/probe` | `{url}` → service + media metadata, no download |
| `POST /api/extract` | `{url, format, startTime, endTime, stereo}` → `{jobId}` |
| `GET /api/job/:id` | job status, progress, download URL when done |
| `GET /api/file/:name` | serves a produced file as a download |
| `GET /api/stream/:name` | serves a file inline with Range support, for the player |
| `GET /api/health` | yt-dlp availability, supported formats/providers |

Extraction is async: `POST /api/extract` returns a job id immediately and the
client polls `/api/job/:id`.

## Note on use

This is built for personal, non-commercial sampling. Downloading a recording
does not give you the right to release it — if a sample ends up in something you
put out, that's a clearance conversation with the rights holder. Sampling law
does not have a de minimis safe harbour you can rely on.
