import express from 'express';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { mkdir, stat, readFile } from 'node:fs/promises';

import { detectService, listProviders } from './src/services.js';
import { probe, extractAudio, checkAvailable, AUDIO_FORMATS } from './src/ytdlp.js';
import { resolveSpotify, toSearchTarget } from './src/spotify.js';
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
} from './src/limits.js';

const __dirname = path.dirname(fileURLToPath(new URL(import.meta.url)));
// Configurable so the container can point at a scratch volume.
const DOWNLOAD_DIR = process.env.MURDOCK_DOWNLOAD_DIR || path.join(__dirname, 'downloads');
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
    limits: { extractPerHour: EXTRACT_PER_HOUR, probePerHour: PROBE_PER_HOUR },
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
      const resolved = await resolveSpotify(service.url);
      const info = await probe(toSearchTarget(resolved.searchQuery), { proxy: proxyFor(service) });

      return res.json({
        service,
        resolvedVia: 'youtube-match',
        spotify: { title: resolved.title, artist: resolved.artist },
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
    job.stage = 'Resolving Spotify track';
    const resolved = await resolveSpotify(service.url);
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

const server = app.listen(PORT, () => {
  console.log(`\n  murdock  →  http://localhost:${PORT}\n`);
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
    console.log(s.ok ? `  yt-dlp ${s.version} ready\n` : `  ⚠ yt-dlp unavailable: ${s.error}\n`);
  });
});

// Keep the cached status fresh without ever blocking a request.
const ytdlpTimer = setInterval(refreshYtdlpStatus, 5 * 60 * 1000);
ytdlpTimer.unref?.();

startSweeper(DOWNLOAD_DIR);

export { app, server };
