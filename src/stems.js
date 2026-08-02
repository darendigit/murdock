/**
 * Stem separation via Demucs (htdemucs).
 *
 * Splits a track into vocals / drums / bass / other. This is a local-only power
 * feature: Demucs needs PyTorch, which is far too heavy for the 512MB hosted box
 * and is never installed there. On an Apple-silicon Mac it runs on the GPU via
 * PyTorch's MPS backend, so a full track separates in seconds-to-tens-of-seconds.
 *
 * Demucs lives in its own Python venv (system Python here is 3.14, ahead of
 * PyTorch's wheels — see scripts/setup-stems.sh). We locate its binary from:
 *   1. MURDOCK_DEMUCS         — explicit path to a `demucs` executable, or
 *   2. MURDOCK_DEMUCS_VENV    — a venv dir; we use <venv>/bin/demucs, or
 *   3. `demucs` on PATH       — last resort.
 *
 * Every spawn uses an argv array with shell:false.
 */

import { spawn } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

const MODEL = process.env.MURDOCK_DEMUCS_MODEL || 'htdemucs';
const DEVICE = process.env.MURDOCK_DEMUCS_DEVICE || 'mps'; // Apple GPU; 'cpu' fallback
export const STEM_NAMES = ['vocals', 'drums', 'bass', 'other'];

/** Resolve the demucs executable per the precedence documented above. */
export function demucsBin() {
  if (process.env.MURDOCK_DEMUCS) return process.env.MURDOCK_DEMUCS;
  if (process.env.MURDOCK_DEMUCS_VENV) {
    return path.join(process.env.MURDOCK_DEMUCS_VENV, 'bin', 'demucs');
  }
  return 'demucs';
}

let availableCache = null;

/** Is Demucs installed and runnable? Cached — spawning it is not free. */
export async function stemsAvailable() {
  if (availableCache != null) return availableCache;
  availableCache = await new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (!done) {
        done = true;
        resolve(v);
      }
    };
    let child;
    try {
      child = spawn(demucsBin(), ['--help'], { shell: false });
    } catch {
      return finish(false);
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(false);
    }, 20_000);
    child.on('error', () => {
      clearTimeout(timer);
      finish(false);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      finish(code === 0);
    });
  });
  return availableCache;
}

/** Reset the cached availability probe (used after a setup run). */
export function resetStemsCache() {
  availableCache = null;
}

/**
 * Separate `inputPath` into stems under `outputDir`. Returns
 * { dir, stems: { vocals, drums, bass, other } } as absolute file paths.
 * `onProgress(pct)` is called with 0..100 as Demucs reports it.
 */
export async function separateStems(inputPath, outputDir, { mode = 'two', onProgress, timeoutMs = 1_800_000 } = {}) {
  const args = [
    '-n', MODEL,
    '--device', DEVICE,
    // FLAC keeps the stems lossless without WAV's bulk.
    '--flac',
  ];
  // Default: a 2-stem split (vocals + instrumental) — the common sampling case,
  // and roughly twice as fast as a full separation. `mode: 'full'` gives the
  // granular vocals/drums/bass/other breakdown.
  if (mode !== 'full') args.push('--two-stems', 'vocals');
  args.push('-o', outputDir, inputPath);

  await new Promise((resolve, reject) => {
    const child = spawn(demucsBin(), args, { shell: false });
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    // Demucs draws a tqdm progress bar on stderr ("  45%|██ | ...").
    const onChunk = (chunk) => {
      const text = chunk.toString();
      stderr += text;
      const m = text.match(/(\d+)%\|/g);
      if (m && onProgress) {
        const last = m[m.length - 1].match(/(\d+)%/);
        if (last) onProgress(Number(last[1]));
      }
    };
    child.stdout.on('data', onChunk);
    child.stderr.on('data', onChunk);

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(
        err.code === 'ENOENT'
          ? new Error('Demucs is not installed. Run scripts/setup-stems.sh once to enable stems.')
          : err
      );
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) reject(new Error('Stem separation timed out.'));
      else if (code === 0) resolve();
      else reject(new Error(lastLine(stderr) || `Demucs exited with code ${code}`));
    });
  });

  // Demucs writes to <outputDir>/<model>/<trackname>/<stem>.flac. The trackname
  // is derived from the input filename, but rather than reconstruct its escaping
  // we just find the one subfolder that holds the stems.
  const modelDir = path.join(outputDir, MODEL);
  const trackDir = await findTrackDir(modelDir);
  if (!trackDir) throw new Error('Demucs finished but produced no stems.');

  // Collect whatever stems were actually written (the set varies by mode),
  // mapping Demucs's "no_vocals" to the friendlier "instrumental", ordered.
  let files;
  try {
    files = await readdir(trackDir);
  } catch {
    files = [];
  }
  const stems = [];
  for (const f of files) {
    if (!f.toLowerCase().endsWith('.flac')) continue;
    const raw = f.slice(0, -'.flac'.length);
    const name = raw === 'no_vocals' ? 'instrumental' : raw;
    stems.push({ name, path: path.join(trackDir, f) });
  }
  if (stems.length === 0) throw new Error('Demucs produced no readable stems.');
  stems.sort((a, b) => stemOrder(a.name) - stemOrder(b.name));

  return { dir: trackDir, stems };
}

const STEM_ORDER = ['vocals', 'instrumental', 'drums', 'bass', 'other'];
function stemOrder(name) {
  const i = STEM_ORDER.indexOf(name);
  return i === -1 ? 99 : i;
}

/** The most-recently-modified subdirectory of the model output dir. */
async function findTrackDir(modelDir) {
  let entries;
  try {
    entries = await readdir(modelDir, { withFileTypes: true });
  } catch {
    return null;
  }
  const dirs = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const full = path.join(modelDir, e.name);
    const info = await stat(full);
    dirs.push({ full, mtimeMs: info.mtimeMs });
  }
  dirs.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return dirs[0]?.full || null;
}

function lastLine(text) {
  return String(text)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .pop();
}
