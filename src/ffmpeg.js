/**
 * Shared ffmpeg/ffprobe helpers for the post-processing features (clip, tag,
 * normalize). Pitch/tempo shifting has its own richer runner in src/pitch.js.
 *
 * Every spawn uses an argv array with shell:false — never a shell string.
 */

import { spawn } from 'node:child_process';

export const FFMPEG = process.env.MURDOCK_FFMPEG || 'ffmpeg';
export const FFPROBE = process.env.MURDOCK_FFPROBE || 'ffprobe';

/** Run a binary with argv and buffer output. Rejects with the last stderr line. */
export function run(bin, args, { timeoutMs = 300_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { shell: false });
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
      reject(err.code === 'ENOENT' ? new Error(`${bin} not found`) : err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) reject(new Error(`${bin} timed out`));
      else if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(lastLine(stderr) || `${bin} exited with code ${code}`));
    });
  });
}

export function ffmpeg(args, opts) {
  return run(FFMPEG, args, opts);
}

export function ffprobe(args, opts) {
  return run(FFPROBE, args, opts);
}

/** Total duration of an audio file in seconds, or null. */
export async function probeDuration(inputPath) {
  try {
    const { stdout } = await ffprobe([
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      inputPath,
    ], { timeoutMs: 20_000 });
    const d = parseFloat(stdout.trim());
    return Number.isFinite(d) && d > 0 ? d : null;
  } catch {
    return null;
  }
}

function lastLine(text) {
  return String(text)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .pop();
}
