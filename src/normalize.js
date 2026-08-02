/**
 * Loudness normalization (EBU R128) via ffmpeg's `loudnorm` filter.
 *
 * Two-pass for accuracy: pass 1 measures the file, pass 2 applies the
 * correction using those measurements. This makes every grabbed sample sit at a
 * consistent level, so chopping between them doesn't mean constant gain-riding.
 * Default target -14 LUFS / -1 dBTP (streaming-loud, sample-friendly).
 */

import { ffmpeg, ffprobe } from './ffmpeg.js';

const TARGET_I = Number(process.env.MURDOCK_LOUDNORM_I || -14);
const TARGET_TP = Number(process.env.MURDOCK_LOUDNORM_TP || -1);
const TARGET_LRA = Number(process.env.MURDOCK_LOUDNORM_LRA || 11);

async function sampleRate(inputPath) {
  try {
    const { stdout } = await ffprobe([
      '-v', 'error',
      '-select_streams', 'a:0',
      '-show_entries', 'stream=sample_rate',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      inputPath,
    ], { timeoutMs: 20_000 });
    const sr = parseInt(stdout.trim(), 10);
    return Number.isFinite(sr) && sr > 0 ? sr : 44100;
  } catch {
    return 44100;
  }
}

export async function normalizeAudio(inputPath, outputPath, { timeoutMs = 600_000 } = {}) {
  const base = `loudnorm=I=${TARGET_I}:TP=${TARGET_TP}:LRA=${TARGET_LRA}`;
  const sr = await sampleRate(inputPath);

  // Pass 1 — measure. loudnorm prints a JSON block to stderr with print_format=json.
  const { stderr } = await ffmpeg(
    ['-i', inputPath, '-af', `${base}:print_format=json`, '-f', 'null', '-'],
    { timeoutMs }
  );

  const json = stderr.slice(stderr.lastIndexOf('{'), stderr.lastIndexOf('}') + 1);
  let m = null;
  try {
    m = JSON.parse(json);
  } catch {
    /* fall through to single-pass below */
  }

  const filter = m
    ? `${base}:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:` +
      `measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true:print_format=summary`
    : base; // measurement failed — a single-pass normalize is still better than nothing

  // Pass 2 — apply, preserving the source sample rate (loudnorm resamples internally).
  await ffmpeg(
    ['-y', '-i', inputPath, '-af', filter, '-ar', String(sr), '-map_metadata', '0', outputPath],
    { timeoutMs }
  );

  return outputPath;
}
