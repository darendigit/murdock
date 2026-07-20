/**
 * Ephemeral file storage.
 *
 * Grabs are temporary by design: a file lives long enough for the user to
 * preview and download it, then it is deleted. Two independent limits apply —
 * whichever trips first wins:
 *
 *   1. Age  — anything older than TTL_MINUTES is swept.
 *   2. Size — if the directory exceeds MAX_DISK_MB, oldest files are evicted
 *             until it fits, regardless of age.
 *
 * The size cap matters on a small host: without it a handful of long WAV grabs
 * fills the disk and every later job fails with a confusing write error.
 */

import { readdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';

/**
 * Auto-deletion is OFF unless explicitly enabled.
 *
 * On a hosted instance the download directory is a scratch buffer and sweeping
 * is required. On a local install it is the user's working library of samples —
 * sweeping there destroys their files. Defaulting this on once cost real data,
 * so the safe default is permanent storage and the container opts in.
 */
export const EPHEMERAL = process.env.MURDOCK_EPHEMERAL === '1';

export const TTL_MINUTES = Number(process.env.MURDOCK_TTL_MINUTES || 30);
export const MAX_DISK_MB = Number(process.env.MURDOCK_MAX_DISK_MB || 400);
const SWEEP_INTERVAL_MS = Number(process.env.MURDOCK_SWEEP_SECONDS || 60) * 1000;

/** Files the sweeper must never touch. */
const PROTECTED = new Set(['.gitkeep', '.DS_Store']);

async function listFiles(dir) {
  let names;
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }

  const entries = [];
  for (const name of names) {
    if (PROTECTED.has(name)) continue;
    try {
      const info = await stat(path.join(dir, name));
      if (info.isFile()) {
        entries.push({ name, path: path.join(dir, name), size: info.size, mtimeMs: info.mtimeMs });
      }
    } catch {
      // Raced with another delete; ignore.
    }
  }
  return entries;
}

/** Milliseconds until a file is swept, or 0 if it is already due. */
export function millisUntilExpiry(mtimeMs) {
  return Math.max(0, mtimeMs + TTL_MINUTES * 60_000 - Date.now());
}

export async function getStats(dir) {
  const files = await listFiles(dir);
  const bytes = files.reduce((total, f) => total + f.size, 0);
  return {
    fileCount: files.length,
    bytes,
    megabytes: Number((bytes / (1024 * 1024)).toFixed(1)),
    ttlMinutes: TTL_MINUTES,
    maxDiskMb: MAX_DISK_MB,
  };
}

/**
 * Delete expired and over-quota files. Returns what was removed, so callers
 * can log it. Safe to run concurrently with downloads: a file being written is
 * new, so it is never the oldest and never past TTL.
 */
export async function sweep(dir, { onDelete } = {}) {
  const files = await listFiles(dir);
  const removed = [];

  const expired = files.filter((f) => millisUntilExpiry(f.mtimeMs) === 0);
  for (const file of expired) {
    try {
      await unlink(file.path);
      removed.push({ name: file.name, reason: 'ttl' });
      onDelete?.(file.name, 'ttl');
    } catch {
      // Already gone.
    }
  }

  // Re-evaluate size against what actually survived.
  const survivors = files
    .filter((f) => !expired.includes(f))
    .sort((a, b) => a.mtimeMs - b.mtimeMs);

  let total = survivors.reduce((sum, f) => sum + f.size, 0);
  const capBytes = MAX_DISK_MB * 1024 * 1024;

  while (total > capBytes && survivors.length > 0) {
    const oldest = survivors.shift();
    try {
      await unlink(oldest.path);
      total -= oldest.size;
      removed.push({ name: oldest.name, reason: 'quota' });
      onDelete?.(oldest.name, 'quota');
    } catch {
      total -= oldest.size;
    }
  }

  return removed;
}

/**
 * Start the periodic sweeper. Returns a stop function.
 * No-op unless MURDOCK_EPHEMERAL=1 — see the EPHEMERAL note above.
 */
export function startSweeper(dir, { onDelete, log = true } = {}) {
  if (!EPHEMERAL) {
    return () => {};
  }

  const run = async () => {
    try {
      const removed = await sweep(dir, { onDelete });
      if (log && removed.length > 0) {
        console.log(
          `  swept ${removed.length} file(s): ` +
            removed.map((r) => `${r.name} (${r.reason})`).join(', ')
        );
      }
    } catch (err) {
      console.error('  sweep failed:', err.message);
    }
  };

  run();
  const timer = setInterval(run, SWEEP_INTERVAL_MS);
  timer.unref?.();

  return () => clearInterval(timer);
}
