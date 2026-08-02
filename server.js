import express from 'express';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { mkdir, stat, readFile, rename, rm } from 'node:fs/promises';

import { detectService, listProviders, looksLikeUrl } from './src/services.js';
import { probe, extractAudio, searchYoutube, checkAvailable, AUDIO_FORMATS, COOKIES_BROWSER } from './src/ytdlp.js';
import { resolveSpotify, toSearchTarget } from './src/spotify.js';
import { resolveAppleMusic } from './src/appleMusic.js';
import { shiftAudio, stretchAudio, detectShifter } from './src/pitch.js';
import { stemsAvailable, separateStems } from './src/stems.js';
import { clipAudio } from './src/clip.js';
import { normalizeAudio } from './src/normalize.js';
import { tagAudio } from './src/tag.js';
import { ffprobe } from './src/ffmpeg.js';
import { isPlaylistUrl, enumerateCollection, grabCollectionZip } from './src/playlist.js';
import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import {
  startSweeper,
  getStats,
  millisUntilExpiry,
  TTL_MINUTES,
  EPHEMERAL,
} from './src/storage.js';
import {
  rateLimit,
  acquireSlot,
  activeJobs,
  EXTRACT_PER_HOUR,
  PROBE_PER_HOUR,
  LOCAL,
} from './src/limits.js';

const __dirname = path.dirname(fileURLToPath(new URL(import.meta.url)));

/** Expand a leading ~ / ~user-less home so MURDOCK_DOWNLOAD_DIR can be "~/Downloads/murdock". */
function expandHome(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

// Configurable so the container can point at a scratch volume, or a local
// install at ~/Downloads/murdock (set in the `power` run profile).
const DOWNLOAD_DIR = expandHome(process.env.MURDOCK_DOWNLOAD_DIR) || path.join(__dirname, 'downloads');
const PORT = process.env.PORT || 5757;

const app = express();
// Render/Fly sit behind a proxy; without this every client looks like the LB.
app.set('trust proxy', true);
app.use(express.json({ limit: '64kb' }));
app.use(express.static(path.join(__dirname, 'public')));

/** In-memory job registry. Jobs are ephemeral; files on disk are the artifact. */
const jobs = new Map();

/** Accepts "83", "1:23", or "1:02:03" and returns seconds. */
function parseTimecode(value) {
  if (value == null || value === '') return null;

  const text = String(value).trim();
  if (/^\d+(\.\d+)?$/.test(text)) return Number(text);

  const parts = text.split(':').map((p) => p.trim());
  if (parts.length < 2 || parts.length > 3 || parts.some((p) => !/^\d+(\.\d+)?$/.test(p))) {
    throw new Error(`Invalid timecode: "${text}". Use seconds, m:ss, or h:mm:ss.`);
  }

  return parts.reduce((total, part) => total * 60 + Number(part), 0);
}

/**
 * Cached yt-dlp availability. Checking it spawns a subprocess, and the health
 * endpoint is hit frequently by the platform's health probe — doing it per
 * request piled up hanging processes on the hosted instance and made the whole
 * service unresponsive. Check once at boot, then refresh on a slow interval.
 */
// Optional egress proxy for the platforms that block/limit datacenter IPs
// (marked `proxied` in src/services.js). A WARP proxy (wired up in the
// Dockerfile) gives those requests a non-blocked egress. Unset locally, so
// local grabs — from a residential IP — always go direct.
const YT_PROXY = process.env.MURDOCK_YT_PROXY || null;

/** Proxy to use for a service's yt-dlp calls, or null. Data-driven per provider. */
function proxyFor(service) {
  if (!YT_PROXY) return null;
  return service?.proxied ? YT_PROXY : null;
}

/**
 * Resolve a `mode: 'resolve'` service (DRM streaming) to a YouTube search term +
 * display metadata. Both Spotify and Apple Music return the same shape.
 */
function resolveTrack(service) {
  if (service.id === 'applemusic') return resolveAppleMusic(service.url);
  return resolveSpotify(service.url);
}

/**
 * Refusal message for a dropped (unsupported) provider — shown up front instead
 * of letting the request hit yt-dlp and fail with a raw login/cookies error.
 */
function unsupportedMessage(service) {
  return `${service.label} isn’t supported — it requires a login that a hosted tool can’t do reliably. Try SoundCloud, Bandcamp, YouTube, or a direct link.`;
}

/**
 * Map a raw extractor error to a calm, actionable message. yt-dlp's block/
 * bot-check errors read as fatal and technical; on the hosted instance they just
 * mean the source wasn't reachable this time. Returns { message, soft } — soft
 * errors render as a gentle notice rather than a red failure.
 */
function friendlyError(message, service) {
  const m = String(message || '');
  const unreachable =
    /not a bot|sign in to confirm|player response|unable to download|http error 403|login|rate.?limit|proxy|timed out|connection refused|failed to extract/i.test(
      m
    );

  // Proxied/best-effort sources are the ones that fail this way on a hosted box.
  if (service?.proxied && unreachable) {
    return {
      soft: true,
      message: `Unable to pull audio from ${service.label} right now, try again in a few minutes or use a link from another service.`,
    };
  }
  return { soft: false, message: m };
}

let ytdlpStatus = { ok: false, checking: true };

async function refreshYtdlpStatus() {
  ytdlpStatus = await checkAvailable();
  return ytdlpStatus;
}

app.get('/api/health', async (req, res) => {
  res.json({
    // 'checking' during the brief boot window means "not known yet", not broken.
    ok: ytdlpStatus.ok || ytdlpStatus.checking === true,
    ytdlp: ytdlpStatus,
    formats: AUDIO_FORMATS,
    providers: listProviders(),
    storage: await getStats(DOWNLOAD_DIR),
    jobs: activeJobs(),
    shifter: await detectShifter(),
    limits: { extractPerHour: EXTRACT_PER_HOUR, probePerHour: PROBE_PER_HOUR },
    // Power-mode surface. The frontend keys its extra UI off these so the same
    // static bundle stays plain on the hosted box (where LOCAL is unset).
    local: LOCAL,
    features: {
      cookies: Boolean(COOKIES_BROWSER),
      search: LOCAL,
      stems: LOCAL && (await stemsAvailable()),
      library: LOCAL,
      tools: LOCAL, // clip / tempo / normalize / camelot / bpm / loop
      tag: LOCAL, // auto-write key+bpm to metadata
      playlist: LOCAL, // bulk playlist/album → ZIP
      reveal: LOCAL && process.platform === 'darwin',
      defaultFormat: LOCAL ? 'flac' : 'mp3',
    },
  });
});

/** Identify the service and pull metadata, without downloading anything. */
app.post('/api/probe', rateLimit('probe', PROBE_PER_HOUR), async (req, res) => {
  let service;
  try {
    service = detectService(req.body?.url);

    // Dropped platforms (Instagram/X/Facebook) — refuse up front with a calm
    // notice instead of letting yt-dlp fail with a raw login/cookies error.
    if (service.tier === 'unsupported') {
      return res.status(400).json({ error: unsupportedMessage(service), soft: true });
    }

    if (service.mode === 'resolve') {
      const resolved = await resolveTrack(service);
      const info = await probe(toSearchTarget(resolved.searchQuery), { proxy: proxyFor(service) });

      return res.json({
        service,
        resolvedVia: 'youtube-match',
        resolved: { title: resolved.title, artist: resolved.artist, source: service.label },
        media: { ...info, thumbnail: resolved.thumbnail || info.thumbnail },
      });
    }

    const info = await probe(service.url, { proxy: proxyFor(service) });
    res.json({ service, media: info });
  } catch (err) {
    const e = friendlyError(err.message, service);
    res.status(400).json({ error: e.message, soft: e.soft });
  }
});

/**
 * Search-by-name (local power feature): given free text, return the top YouTube
 * matches so the user can pick one instead of pasting a link. The chosen result
 * is just a YouTube URL, which then flows through the normal probe→extract path.
 */
app.post('/api/search', rateLimit('probe', PROBE_PER_HOUR), async (req, res) => {
  try {
    const results = await searchYoutube(req.body?.query, { limit: 6, proxy: YT_PROXY });
    res.json({ results });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/** Kick off an extraction. Returns immediately with a job id to poll. */
app.post('/api/extract', rateLimit('extract', EXTRACT_PER_HOUR), async (req, res) => {
  try {
    const { url, format = 'mp3', startTime, endTime, stereo = true } = req.body || {};

    if (!AUDIO_FORMATS.includes(format)) {
      return res.status(400).json({ error: `Unsupported format: ${format}` });
    }

    const service = detectService(url);

    if (service.tier === 'unsupported') {
      return res.status(400).json({ error: unsupportedMessage(service), soft: true });
    }

    const start = parseTimecode(startTime);
    const end = parseTimecode(endTime);

    if (start != null && end != null && end <= start) {
      return res.status(400).json({ error: 'End time must be after start time.' });
    }

    const jobId = randomUUID();
    jobs.set(jobId, {
      id: jobId,
      status: 'pending',
      service: service.id,
      progress: 0,
      stage: 'Starting',
      createdAt: Date.now(),
    });

    res.json({ jobId });

    // Run detached from the request lifecycle.
    runJob(jobId, service, { format, start, end, stereo: stereo !== false }).catch((err) => {
      const job = jobs.get(jobId);
      if (job) {
        const e = friendlyError(err.message, service);
        job.status = 'error';
        job.error = e.message;
        job.soft = e.soft;
      }
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

async function runJob(jobId, service, { format, start, end, stereo }) {
  const job = jobs.get(jobId);

  // Queue behind any jobs already running. Reported to the client so a wait
  // reads as "queued" rather than a stalled download.
  const { active, max } = activeJobs();
  if (active >= max) {
    job.stage = 'Queued — instance busy';
  }

  const releaseSlot = await acquireSlot();

  try {
    await runJobInner(job, service, { format, start, end, stereo });
  } finally {
    releaseSlot();
  }
}

async function runJobInner(job, service, { format, start, end, stereo }) {
  job.status = 'running';

  let target = service.url;

  if (service.mode === 'resolve') {
    job.stage = `Resolving ${service.label} track`;
    const resolved = await resolveTrack(service);
    job.stage = `Matching "${resolved.searchQuery}" on YouTube`;
    target = toSearchTarget(resolved.searchQuery);
    job.matchedQuery = resolved.searchQuery;
  }

  job.stage = 'Downloading';

  const filePath = await extractAudio(target, DOWNLOAD_DIR, {
    format,
    startTime: start,
    endTime: end,
    stereo,
    proxy: proxyFor(service),
    onProgress: (text) => {
      const pct = text.match(/\[download\]\s+(\d+(?:\.\d+)?)%/);
      if (pct) {
        job.progress = Number(pct[1]);
        job.stage = 'Downloading';
      } else if (/\[ExtractAudio\]|Destination:.*\.(mp3|wav|flac|m4a|opus)/.test(text)) {
        job.stage = `Converting to ${format.toUpperCase()}`;
        job.progress = 100;
      }
    },
  });

  const { size } = await stat(filePath);
  const filename = path.basename(filePath);

  job.status = 'done';
  job.progress = 100;
  job.stage = 'Ready';
  job.filename = filename;
  job.sizeBytes = size;
  job.downloadUrl = `/api/file/${encodeURIComponent(filename)}`;
  job.streamUrl = `/api/stream/${encodeURIComponent(filename)}`;

  // Files are swept on a timer; tell the client when this one goes away so it
  // can show a countdown instead of the download silently 404ing later.
  // Only advertise an expiry when files are actually swept; on a local install
  // they are kept indefinitely and a countdown would be a lie.
  if (EPHEMERAL) {
    job.expiresAt = Date.now() + TTL_MINUTES * 60_000;
    job.ttlMinutes = TTL_MINUTES;
  }
}

const AUDIO_MIME = {
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.opus': 'audio/ogg',
};

/**
 * Resolve a requested filename to a path inside DOWNLOAD_DIR, or null.
 * basename() strips any traversal; the resolve check is defense in depth.
 */
function resolveDownloadPath(name) {
  const requested = path.basename(decodeURIComponent(name));
  const filePath = path.resolve(DOWNLOAD_DIR, requested);

  if (path.dirname(filePath) !== path.resolve(DOWNLOAD_DIR)) return null;
  return filePath;
}

app.get('/api/job/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Unknown job.' });
  res.json(job);
});

/**
 * Pitch-shift an already-grabbed file by N semitones (key change). Operates on
 * the existing file — no re-download. Asynchronous (returns a jobId to poll)
 * because a high-quality shift of a full track can take a minute or more on a
 * small box — well past an HTTP timeout. Gated by the same rate limit +
 * concurrency slot as extraction.
 */
app.post('/api/shift', rateLimit('shift', EXTRACT_PER_HOUR), async (req, res) => {
  try {
    const { filename, semitones } = req.body || {};
    const src = resolveDownloadPath(String(filename || ''));
    if (!src) return res.status(400).json({ error: 'Invalid file.' });
    try {
      await stat(src);
    } catch {
      return res.status(404).json({ error: 'That file is no longer available — grab it again.' });
    }

    const n = Number(semitones);
    if (!Number.isFinite(n) || n === 0) {
      return res.status(400).json({ error: 'Choose a non-zero shift.' });
    }
    if (Math.abs(n) > 12) {
      return res.status(400).json({ error: 'Shift must be within ±12 semitones.' });
    }

    const ext = path.extname(src);
    const base = path.basename(src, ext);
    const outName = `${base}_${n > 0 ? '+' : ''}${n}st${ext}`;
    const outPath = path.join(DOWNLOAD_DIR, outName);

    const jobId = randomUUID();
    jobs.set(jobId, {
      id: jobId,
      kind: 'shift',
      status: 'running',
      stage: `Shifting key ${n > 0 ? '+' : ''}${n} st`,
      progress: 0,
      createdAt: Date.now(),
    });
    res.json({ jobId });

    // Run detached from the request lifecycle.
    (async () => {
      const release = await acquireSlot();
      try {
        await shiftAudio(src, outPath, n, { stereo: true });
        const { size } = await stat(outPath);
        const job = jobs.get(jobId);
        if (job) {
          job.status = 'done';
          job.stage = 'Ready';
          job.progress = 100;
          job.filename = outName;
          job.sizeBytes = size;
          job.downloadUrl = `/api/file/${encodeURIComponent(outName)}`;
          job.streamUrl = `/api/stream/${encodeURIComponent(outName)}`;
          if (EPHEMERAL) {
            job.expiresAt = Date.now() + TTL_MINUTES * 60_000;
            job.ttlMinutes = TTL_MINUTES;
          }
        }
      } catch (err) {
        const job = jobs.get(jobId);
        if (job) {
          job.status = 'error';
          job.error = `Key shift failed: ${err.message}`;
        }
      } finally {
        release();
      }
    })();
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * Resolve a request's { filename } to an existing file inside DOWNLOAD_DIR.
 * Sends the appropriate 400/404 and returns null if it can't; otherwise returns
 * the absolute source path. Shared by the post-processing routes below.
 */
async function resolveSource(res, filename) {
  const src = resolveDownloadPath(String(filename || ''));
  if (!src) {
    res.status(400).json({ error: 'Invalid file.' });
    return null;
  }
  try {
    await stat(src);
  } catch {
    res.status(404).json({ error: 'That file is no longer available — grab it again.' });
    return null;
  }
  return src;
}

/**
 * Run a producer job that reads an existing file and writes a new one into
 * DOWNLOAD_DIR. `produce(job)` must create the file and return its basename.
 * Mirrors the async job lifecycle of /api/shift (slot + poll + expiry).
 */
function startProducerJob(res, { kind, stage, produce }) {
  const jobId = randomUUID();
  jobs.set(jobId, { id: jobId, kind, status: 'running', stage, progress: 0, createdAt: Date.now() });
  res.json({ jobId });

  (async () => {
    const release = await acquireSlot();
    try {
      const outName = await produce(jobs.get(jobId));
      const outPath = path.join(DOWNLOAD_DIR, outName);
      const { size } = await stat(outPath);
      const job = jobs.get(jobId);
      if (job) {
        job.status = 'done';
        job.stage = 'Ready';
        job.progress = 100;
        job.filename = outName;
        job.sizeBytes = size;
        job.downloadUrl = `/api/file/${encodeURIComponent(outName)}`;
        job.streamUrl = `/api/stream/${encodeURIComponent(outName)}`;
        if (EPHEMERAL) {
          job.expiresAt = Date.now() + TTL_MINUTES * 60_000;
          job.ttlMinutes = TTL_MINUTES;
        }
      }
    } catch (err) {
      const job = jobs.get(jobId);
      if (job) {
        job.status = 'error';
        job.error = `${kind} failed: ${err.message}`;
      }
    } finally {
      release();
    }
  })();
}

/** Trim an already-grabbed file to a [start, end] window (visual waveform clip). */
app.post('/api/clip', rateLimit('extract', EXTRACT_PER_HOUR), async (req, res) => {
  try {
    const { filename, start, end } = req.body || {};
    const src = await resolveSource(res, filename);
    if (!src) return;

    const s = Number(start);
    const e = Number(end);
    if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s || s < 0) {
      return res.status(400).json({ error: 'Choose a valid clip region.' });
    }

    const ext = path.extname(src);
    const base = path.basename(src, ext);
    const outName = `${base}_clip_${Math.floor(s)}-${Math.floor(e)}${ext}`;
    const outPath = path.join(DOWNLOAD_DIR, outName);

    startProducerJob(res, {
      kind: 'clip',
      stage: 'Trimming clip',
      produce: async () => {
        await clipAudio(src, outPath, s, e);
        return outName;
      },
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * Tempo/BPM change on an already-grabbed file, pitch preserved. Accepts a raw
 * `ratio` (2.0 = twice as fast) plus an optional `label` for the filename.
 */
app.post('/api/tempo', rateLimit('extract', EXTRACT_PER_HOUR), async (req, res) => {
  try {
    const { filename, ratio, label } = req.body || {};
    const src = await resolveSource(res, filename);
    if (!src) return;

    const r = Number(ratio);
    if (!Number.isFinite(r) || r <= 0 || r === 1) {
      return res.status(400).json({ error: 'Choose a different tempo.' });
    }
    if (r < 0.25 || r > 4) {
      return res.status(400).json({ error: 'Tempo change must be within 0.25×–4×.' });
    }

    const ext = path.extname(src);
    const base = path.basename(src, ext);
    const tag = String(label || `${r.toFixed(2)}x`).replace(/[^\w.+-]/g, '');
    const outName = `${base}_${tag}${ext}`;
    const outPath = path.join(DOWNLOAD_DIR, outName);

    startProducerJob(res, {
      kind: 'tempo',
      stage: 'Changing tempo',
      produce: async () => {
        await stretchAudio(src, outPath, r, { stereo: true });
        return outName;
      },
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/** Loudness-normalize an already-grabbed file (EBU R128). */
app.post('/api/normalize', rateLimit('extract', EXTRACT_PER_HOUR), async (req, res) => {
  try {
    const { filename } = req.body || {};
    const src = await resolveSource(res, filename);
    if (!src) return;

    const ext = path.extname(src);
    const base = path.basename(src, ext);
    const outName = `${base}_norm${ext}`;
    const outPath = path.join(DOWNLOAD_DIR, outName);

    startProducerJob(res, {
      kind: 'normalize',
      stage: 'Normalizing loudness',
      produce: async () => {
        await normalizeAudio(src, outPath);
        return outName;
      },
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * Write detected key + BPM into a file's metadata, in place. Fast (`-c copy`),
 * so it's synchronous — the client fires it once analysis finishes and doesn't
 * need to poll. Never fatal: tagging failing must not break a good grab.
 */
app.post('/api/tag', rateLimit('extract', EXTRACT_PER_HOUR), async (req, res) => {
  try {
    const { filename, keyLabel, camelot, bpm } = req.body || {};
    const src = await resolveSource(res, filename);
    if (!src) return;

    await tagAudio(src, { keyLabel, camelot, bpm });
    res.json({ ok: true });
  } catch (err) {
    res.status(200).json({ ok: false, error: err.message });
  }
});

/**
 * Split an already-grabbed file into stems (vocals/drums/bass/other) with
 * Demucs. Local-only and heavy, so it's an async job with real % progress
 * parsed from Demucs. The stem files are moved up into DOWNLOAD_DIR (flat) so
 * they're individually streamable/downloadable like any other grab.
 */
app.post('/api/stems', rateLimit('extract', EXTRACT_PER_HOUR), async (req, res) => {
  try {
    if (!LOCAL || !(await stemsAvailable())) {
      return res.status(400).json({ error: 'Stem separation isn’t set up. Run scripts/setup-stems.sh.' });
    }
    const src = await resolveSource(res, req.body?.filename);
    if (!src) return;

    const mode = req.body?.mode === 'full' ? 'full' : 'two';
    const ext = path.extname(src);
    const base = path.basename(src, ext);

    const jobId = randomUUID();
    jobs.set(jobId, {
      id: jobId,
      kind: 'stems',
      status: 'running',
      stage: 'Separating stems',
      progress: 0,
      createdAt: Date.now(),
    });
    res.json({ jobId });

    (async () => {
      const release = await acquireSlot();
      try {
        const workDir = path.join(DOWNLOAD_DIR, `.stems-${jobId}`);
        await mkdir(workDir, { recursive: true });
        const { stems } = await separateStems(src, workDir, {
          mode,
          onProgress: (pct) => {
            const job = jobs.get(jobId);
            if (job) job.progress = pct;
          },
        });

        // Flatten each stem up into DOWNLOAD_DIR with a predictable name so the
        // existing file/stream routes can serve it (they reject subdirectories).
        // Drop any tempo tag (e.g. "_130bpm") from the stem names — stems are
        // about instrument content, and the BPM is already in the metadata.
        const out = [];
        const stemBase = base.replace(/_\d+bpm/gi, '');
        for (const s of stems) {
          const stemExt = path.extname(s.path);
          const stemName = `${stemBase}_${s.name}${stemExt}`;
          const dest = path.join(DOWNLOAD_DIR, stemName);
          await rename(s.path, dest);
          const { size } = await stat(dest);
          out.push({
            stem: s.name,
            filename: stemName,
            sizeBytes: size,
            downloadUrl: `/api/file/${encodeURIComponent(stemName)}`,
            streamUrl: `/api/stream/${encodeURIComponent(stemName)}`,
          });
        }

        // Best-effort cleanup of the now-empty demucs work tree.
        rm(workDir, { recursive: true, force: true }).catch(() => {});

        const job = jobs.get(jobId);
        if (job) {
          job.status = 'done';
          job.stage = 'Ready';
          job.progress = 100;
          job.stems = out;
        }
      } catch (err) {
        const job = jobs.get(jobId);
        if (job) {
          job.status = 'error';
          job.error = `Stem separation failed: ${err.message}`;
        }
      } finally {
        release();
      }
    })();
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * The persistent local library: list everything in the download folder, newest
 * first, with size/date and any embedded key + BPM. Local power feature — this
 * folder is the user's sample archive (kept forever).
 */
app.get('/api/library', async (req, res) => {
  if (!LOCAL) return res.status(404).json({ error: 'Not available.' });
  try {
    const names = await readdir(DOWNLOAD_DIR).catch(() => []);
    const audio = names.filter((n) => !n.startsWith('.') && AUDIO_MIME[path.extname(n).toLowerCase()]);

    const stats = [];
    for (const name of audio) {
      try {
        const info = await stat(path.join(DOWNLOAD_DIR, name));
        if (info.isFile()) stats.push({ name, sizeBytes: info.size, mtimeMs: info.mtimeMs });
      } catch {
        /* raced with a write/delete */
      }
    }
    stats.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const recent = stats.slice(0, 300);

    // Read key/BPM/duration tags with a small concurrency pool (ffprobe per file).
    const items = [];
    const queue = recent.slice();
    async function worker() {
      while (queue.length) {
        const f = queue.shift();
        const meta = await readAudioMeta(path.join(DOWNLOAD_DIR, f.name));
        items.push({
          name: f.name,
          sizeBytes: f.sizeBytes,
          mtimeMs: f.mtimeMs,
          durationSeconds: meta.durationSeconds,
          key: meta.key,
          bpm: meta.bpm,
          downloadUrl: `/api/file/${encodeURIComponent(f.name)}`,
          streamUrl: `/api/stream/${encodeURIComponent(f.name)}`,
        });
      }
    }
    await Promise.all(Array.from({ length: 6 }, worker));
    items.sort((a, b) => b.mtimeMs - a.mtimeMs);

    res.json({ items, total: stats.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** Read duration + key/BPM tags from a file (best-effort). */
async function readAudioMeta(filePath) {
  try {
    const { stdout } = await ffprobe([
      '-v', 'error',
      '-show_entries', 'format=duration:format_tags=BPM,TBPM,INITIALKEY,TKEY,KEY',
      '-of', 'json',
      filePath,
    ], { timeoutMs: 15_000 });
    const data = JSON.parse(stdout);
    const tags = data.format?.tags || {};
    const lower = {};
    for (const [k, v] of Object.entries(tags)) lower[k.toLowerCase()] = v;
    const d = parseFloat(data.format?.duration);
    return {
      durationSeconds: Number.isFinite(d) ? Math.round(d) : null,
      key: lower.initialkey || lower.tkey || lower.key || null,
      bpm: lower.bpm || lower.tbpm ? Number(lower.bpm || lower.tbpm) : null,
    };
  } catch {
    return { durationSeconds: null, key: null, bpm: null };
  }
}

/** Enumerate a playlist/album for confirmation before a bulk grab. */
app.post('/api/playlist/enumerate', rateLimit('probe', PROBE_PER_HOUR), async (req, res) => {
  try {
    if (!LOCAL) return res.status(404).json({ error: 'Not available.' });
    const url = req.body?.url;
    if (!isPlaylistUrl(url)) {
      return res.status(400).json({ error: 'That doesn’t look like a playlist or album link.' });
    }
    const service = detectService(url);
    const { title, entries } = await enumerateCollection(url, service, { proxy: proxyFor(service) });
    res.json({
      title,
      count: entries.length,
      service: service.label,
      entries: entries.slice(0, 100).map((e) => ({ title: e.title })),
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/** Grab every track in a playlist/album and return a single ZIP. */
app.post('/api/playlist', rateLimit('extract', EXTRACT_PER_HOUR), async (req, res) => {
  try {
    if (!LOCAL) return res.status(404).json({ error: 'Not available.' });
    const { url, format = 'flac', stereo = true } = req.body || {};
    if (!isPlaylistUrl(url)) {
      return res.status(400).json({ error: 'That doesn’t look like a playlist or album link.' });
    }
    if (!AUDIO_FORMATS.includes(format)) {
      return res.status(400).json({ error: `Unsupported format: ${format}` });
    }
    const service = detectService(url);

    const jobId = randomUUID();
    jobs.set(jobId, {
      id: jobId,
      kind: 'playlist',
      status: 'running',
      stage: 'Reading playlist',
      progress: 0,
      createdAt: Date.now(),
    });
    res.json({ jobId });

    (async () => {
      const release = await acquireSlot();
      try {
        const { title, entries } = await enumerateCollection(url, service, { proxy: proxyFor(service) });
        const job = jobs.get(jobId);
        if (job) {
          job.total = entries.length;
          job.stage = `Grabbing 0 / ${entries.length}`;
        }

        const result = await grabCollectionZip(title, entries, DOWNLOAD_DIR, {
          format,
          stereo: stereo !== false,
          proxy: proxyFor(service),
          onProgress: ({ done, total, failed, current }) => {
            const j = jobs.get(jobId);
            if (!j) return;
            j.progress = total ? Math.round((done / total) * 100) : 0;
            j.done = done;
            j.failed = failed;
            j.stage = `Grabbing ${Math.min(done + 1, total)} / ${total}${current ? ` — ${current}` : ''}`;
          },
        });

        const { size } = await stat(result.zipPath);
        const j = jobs.get(jobId);
        if (j) {
          j.status = 'done';
          j.stage = 'Ready';
          j.progress = 100;
          j.filename = result.zipName;
          j.sizeBytes = size;
          j.count = result.count;
          j.failedTracks = result.failed;
          j.downloadUrl = `/api/file/${encodeURIComponent(result.zipName)}`;
        }
      } catch (err) {
        const j = jobs.get(jobId);
        if (j) {
          j.status = 'error';
          j.error = `Playlist grab failed: ${err.message}`;
        }
      } finally {
        release();
      }
    })();
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/** Reveal the download folder (or a specific file) in Finder. macOS/local only. */
app.post('/api/reveal', (req, res) => {
  if (!LOCAL || process.platform !== 'darwin') {
    return res.status(400).json({ error: 'Reveal is only available on a local macOS install.' });
  }
  try {
    const name = req.body?.filename;
    if (name) {
      const target = resolveDownloadPath(String(name));
      if (!target) return res.status(400).json({ error: 'Invalid file.' });
      spawn('open', ['-R', target], { shell: false });
    } else {
      spawn('open', [DOWNLOAD_DIR], { shell: false });
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** Serve a produced file as a download (Content-Disposition: attachment). */
app.get('/api/file/:name', async (req, res) => {
  const filePath = resolveDownloadPath(req.params.name);
  if (!filePath) return res.status(400).json({ error: 'Invalid file path.' });

  try {
    await stat(filePath);
  } catch {
    return res.status(404).json({ error: 'File not found.' });
  }

  res.download(filePath, path.basename(filePath));
});

/**
 * Serve a produced file inline for the preview player. Separate from
 * /api/file because that one forces an attachment download; sendFile also
 * honours Range requests, which is what makes seeking work.
 */
app.get('/api/stream/:name', async (req, res) => {
  const filePath = resolveDownloadPath(req.params.name);
  if (!filePath) return res.status(400).json({ error: 'Invalid file path.' });

  try {
    await stat(filePath);
  } catch {
    return res.status(404).json({ error: 'File not found.' });
  }

  const mime = AUDIO_MIME[path.extname(filePath).toLowerCase()];
  if (mime) res.type(mime);
  res.sendFile(filePath, { acceptRanges: true });
});

await mkdir(DOWNLOAD_DIR, { recursive: true });

// Local power mode binds to loopback, so the tool — and the cookies/library
// behind it — is reachable only from this machine, not everyone on the Wi-Fi.
// Hosted leaves the host unset (all interfaces) so the platform's router reaches
// it; override with MURDOCK_HOST if needed.
const HOST = process.env.MURDOCK_HOST || (LOCAL ? '127.0.0.1' : null);

function onListening() {
  console.log(`\n  murdock  →  http://localhost:${PORT}${HOST ? '  (localhost only)' : ''}\n`);
  console.log(`  storage  ${DOWNLOAD_DIR}`);
  console.log(
    EPHEMERAL
      ? `  ephemeral: files auto-delete after ${TTL_MINUTES} min`
      : `  files are kept (set MURDOCK_EPHEMERAL=1 to auto-delete)`
  );
  console.log(`  limits   ${EXTRACT_PER_HOUR} grabs/hr per IP\n`);

  // Probe yt-dlp after the server is already listening, so a slow first probe
  // never delays the port opening or the platform's health check passing.
  refreshYtdlpStatus().then((s) => {
    console.log(s.ok ? `  yt-dlp ${s.version} ready` : `  ⚠ yt-dlp unavailable: ${s.error}`);
  });
  // Detect + cache the pitch-shift tier (rubberband filter > CLI > fallback).
  detectShifter().then((tier) => console.log(`  pitch-shift: ${tier}\n`));
}

const server = HOST ? app.listen(PORT, HOST, onListening) : app.listen(PORT, onListening);

// Keep the cached status fresh without ever blocking a request.
const ytdlpTimer = setInterval(refreshYtdlpStatus, 5 * 60 * 1000);
ytdlpTimer.unref?.();

startSweeper(DOWNLOAD_DIR);

export { app, server };
