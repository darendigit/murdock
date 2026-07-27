/**
 * Pitch shifting (key change) via ffmpeg + rubberband.
 *
 * Shifts pitch by N semitones while preserving tempo. Picks the best available
 * method, high→low quality, detected once and cached:
 *   1. ffmpeg's `rubberband` filter  — one command, if the ffmpeg build has it.
 *   2. `rubberband` CLI              — decode→wav, shift, re-encode (libsndfile
 *                                      is WAV-only, hence the ffmpeg bookends).
 *   3. asetrate + atempo fallback    — always available, lower quality.
 *
 * rubberband (tiers 1–2) is formant-preserving and studio-grade; tier 3 is only
 * a safety net. All spawns use an argv array with shell:false.
 */

import { spawn } from 'node:child_process';
import { unlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

const FFMPEG = process.env.MURDOCK_FFMPEG || 'ffmpeg';
const FFPROBE = process.env.MURDOCK_FFPROBE || 'ffprobe';
const RUBBERBAND = process.env.MURDOCK_RUBBERBAND || 'rubberband';

function run(cmd, args, { timeoutMs = 300_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { shell: false });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err.code === 'ENOENT' ? new Error(`${cmd} not found`) : err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) reject(new Error(`${cmd} timed out`));
      else if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(lastError(stderr) || `${cmd} exited with code ${code}`));
    });
  });
}

function lastError(stderr) {
  return String(stderr)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .pop();
}

const RATIO = (semitones) => Math.pow(2, semitones / 12);

let shifterCache = null;

/** Detect the best available shifter once; cached. Returns the tier name. */
export async function detectShifter() {
  if (shifterCache) return shifterCache;

  let hasFilter = false;
  try {
    const { stdout } = await run(FFMPEG, ['-hide_banner', '-filters'], { timeoutMs: 15_000 });
    hasFilter = /\brubberband\b/.test(stdout);
  } catch {
    /* ffmpeg missing entirely — fallback path will also fail, surfaced later */
  }

  let hasCli = false;
  if (!hasFilter) {
    try {
      await run(RUBBERBAND, ['--version'], { timeoutMs: 10_000 });
      hasCli = true;
    } catch {
      /* no rubberband CLI */
    }
  }

  shifterCache = hasFilter ? 'ffmpeg-rubberband' : hasCli ? 'rubberband-cli' : 'ffmpeg-fallback';
  return shifterCache;
}

async function probeSampleRate(inputPath) {
  try {
    const { stdout } = await run(
      FFPROBE,
      [
        '-v', 'error',
        '-select_streams', 'a:0',
        '-show_entries', 'stream=sample_rate',
        '-of', 'default=noprint_wrappers=1:nokey=1',
        inputPath,
      ],
      { timeoutMs: 20_000 }
    );
    const sr = parseInt(stdout.trim(), 10);
    return Number.isFinite(sr) && sr > 0 ? sr : 44100;
  } catch {
    return 44100;
  }
}

/**
 * Pitch-shift `inputPath` by `semitones` into `outputPath` (format from the
 * output extension). Tempo is preserved. Returns outputPath.
 */
export async function shiftAudio(inputPath, outputPath, semitones, options = {}) {
  const { stereo = true, timeoutMs = 300_000 } = options;
  const n = Number(semitones);
  if (!Number.isFinite(n) || n === 0) {
    throw new Error('Provide a non-zero number of semitones.');
  }

  const ratio = RATIO(n);
  const ac = stereo ? ['-ac', '2'] : [];
  const tier = await detectShifter();

  if (tier === 'ffmpeg-rubberband') {
    await run(
      FFMPEG,
      ['-y', '-i', inputPath, '-af', `rubberband=pitch=${ratio}`, ...ac, outputPath],
      { timeoutMs }
    );
    return outputPath;
  }

  if (tier === 'rubberband-cli') {
    const tmpIn = path.join(os.tmpdir(), `murdock-${randomUUID()}-in.wav`);
    const tmpOut = path.join(os.tmpdir(), `murdock-${randomUUID()}-out.wav`);
    try {
      await run(FFMPEG, ['-y', '-i', inputPath, ...ac, tmpIn], { timeoutMs });
      await run(RUBBERBAND, ['--pitch', String(n), tmpIn, tmpOut], { timeoutMs });
      await run(FFMPEG, ['-y', '-i', tmpOut, outputPath], { timeoutMs });
    } finally {
      unlink(tmpIn).catch(() => {});
      unlink(tmpOut).catch(() => {});
    }
    return outputPath;
  }

  // Fallback: asetrate shifts pitch+tempo, atempo corrects tempo back. Needs the
  // real sample rate. One atempo covers ±12 semitones (its 0.5–2.0 range).
  const sr = await probeSampleRate(inputPath);
  const shiftedRate = Math.round(sr * ratio);
  await run(
    FFMPEG,
    [
      '-y', '-i', inputPath,
      '-af', `asetrate=${shiftedRate},aresample=${sr},atempo=${1 / ratio}`,
      ...ac,
      outputPath,
    ],
    { timeoutMs }
  );
  return outputPath;
}
