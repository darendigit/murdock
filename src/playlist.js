/**
 * Bulk playlist → ZIP.
 *
 * Given a playlist/album link, enumerate its tracks, grab each to audio, and zip
 * them into a single download. YouTube playlists enumerate natively via yt-dlp;
 * Spotify playlists/albums resolve their public track list to YouTube searches
 * (same DRM workaround as a single Spotify track). Local power feature — this is
 * the "grab a whole set at once" flow, no per-track player/pitch UI.
 *
 * The zip is built with the system `zip` (no npm dependency).
 */

import { spawn } from 'node:child_process';
import { mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { enumeratePlaylist, extractAudio } from './ytdlp.js';
import { resolveSpotifyPlaylist } from './spotify.js';

/** Does this link point at a playlist/album (a collection) rather than one item? */
export function isPlaylistUrl(raw) {
  const u = String(raw || '');
  if (/open\.spotify\.com\/(?:intl-[\w-]+\/)?(?:playlist|album)\//.test(u)) return true;
  if (/music\.apple\.com\/.+\/playlist\//.test(u)) return true;
  if (/youtube\.com\/playlist\?/.test(u)) return true;
  if (/[?&]list=/.test(u) && !/[?&]v=/.test(u)) return true; // bare ?list= with no video
  return false;
}

/**
 * Enumerate a collection into { title, entries: [{ title, target }] }, where
 * target is something yt-dlp can grab (a URL or a `ytsearch1:` query).
 */
export async function enumerateCollection(url, service, { proxy = null } = {}) {
  if (service?.id === 'spotify') {
    const { title, tracks } = await resolveSpotifyPlaylist(url);
    return {
      title,
      entries: tracks.map((t) => ({ title: t.searchQuery, target: `ytsearch1:${t.searchQuery}` })),
    };
  }
  if (service?.id === 'applemusic') {
    throw new Error('Apple Music playlists aren’t supported yet — paste a YouTube or Spotify playlist.');
  }
  // YouTube (and anything else yt-dlp treats as a playlist).
  return enumeratePlaylist(url, { proxy });
}

const SAFE = (s) => String(s || 'playlist').replace(/[^\w.() -]+/g, '_').slice(0, 80).trim() || 'playlist';

/**
 * Grab every entry to `outputDir/<tmp>` then zip into `outputDir/<title>.zip`.
 * `onProgress({ done, total, failed, current })` reports live status. Individual
 * track failures are collected, not fatal — a couple of dead links shouldn't
 * sink a 40-track grab. Returns { zipName, zipPath, count, failed }.
 */
export async function grabCollectionZip(title, entries, outputDir, options = {}) {
  const { format = 'flac', stereo = true, proxy = null, concurrency = 2, onProgress } = options;

  const workDir = path.join(outputDir, `.playlist-${randomUUID()}`);
  await mkdir(workDir, { recursive: true });

  let done = 0;
  const failed = [];
  const total = entries.length;
  const queue = entries.map((e, i) => ({ ...e, i }));

  const report = (current) => onProgress?.({ done, total, failed: failed.length, current });

  async function worker() {
    while (queue.length) {
      const entry = queue.shift();
      report(entry.title);
      try {
        await extractAudio(entry.target, workDir, { format, stereo, proxy });
      } catch (err) {
        failed.push({ title: entry.title, error: err.message });
      } finally {
        done++;
        report(entry.title);
      }
    }
  }

  try {
    await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));

    if (done - failed.length === 0) {
      throw new Error('Every track failed to grab — nothing to zip.');
    }

    const zipName = `${SAFE(title)}.zip`;
    const zipPath = path.join(outputDir, zipName);
    await zipDir(workDir, zipPath);
    await stat(zipPath); // ensure it exists

    return { zipName, zipPath, count: done - failed.length, failed };
  } finally {
    rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Zip the flat contents of `dir` into `zipPath` using the system zip. */
function zipDir(dir, zipPath) {
  return new Promise((resolve, reject) => {
    // -j junks paths (flat zip), -r recurses, "." = everything in cwd.
    const child = spawn('zip', ['-j', '-r', zipPath, '.'], { cwd: dir, shell: false });
    let stderr = '';
    child.stderr.on('data', (c) => (stderr += c));
    child.on('error', (err) =>
      reject(err.code === 'ENOENT' ? new Error('`zip` not found on PATH.') : err)
    );
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(stderr || `zip exited ${code}`))));
  });
}
