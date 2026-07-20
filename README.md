# murdock

Paste a link, get an audio file. A local tool for sourcing vocal stems and
samples from online media.

```
npm start        # → http://localhost:5757
```

Files land in `./downloads`.

## What it does

Paste a URL from YouTube, TikTok, Instagram, X/Twitter, SoundCloud, Bandcamp,
Vimeo, Facebook, Reddit, Twitch, Mixcloud, or Spotify. murdock identifies the
service, pulls the media, and transcodes it to the audio format you pick.

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

## Spotify

Spotify streams are DRM-protected (Widevine) and cannot be downloaded — not by
murdock, not by yt-dlp, not by anything. What murdock does instead is read the
track's public metadata (title + artist) and match it against YouTube, then pull
that. This is the same approach `spotdl` takes.

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

**Expect YouTube to be unreliable when hosted.** YouTube blocks datacenter IP
ranges, so grabs that work locally may fail on a cloud host with "Sign in to
confirm you're not a bot." Other providers are far less aggressive.

A public instance is rate limited per IP (`MURDOCK_EXTRACT_PER_HOUR`, default
12) with a global concurrency cap (`MURDOCK_MAX_CONCURRENT`, default 2), since
512MB of RAM cannot survive many parallel transcodes.

## Docs

- [Product scope & plan](docs/murdock-product-scope.md)
- [Engineering scope & delivery](docs/murdock-engineering-scope.md)

## Requirements

- Node 20+
- `yt-dlp` and `ffmpeg` on PATH — `brew install yt-dlp ffmpeg`

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
