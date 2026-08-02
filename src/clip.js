/**
 * Clip an already-grabbed file to a [start, end] window.
 *
 * This backs the visual waveform selection: you grab the whole track, drag a
 * region on the waveform, and this trims the local file — no re-download. We
 * decode from the start (seek after -i) so the cut is sample-accurate, which
 * matters when you're grabbing one exact phrase. Output format follows the
 * output extension (lossless stays lossless).
 */

import { ffmpeg, probeDuration } from './ffmpeg.js';

export async function clipAudio(inputPath, outputPath, startSec, endSec, { timeoutMs = 300_000 } = {}) {
  const start = Math.max(0, Number(startSec) || 0);
  let end = Number(endSec);

  const duration = await probeDuration(inputPath);
  if (duration && (!Number.isFinite(end) || end > duration)) end = duration;
  if (!Number.isFinite(end) || end <= start) {
    throw new Error('Clip end must be after the start.');
  }

  await ffmpeg(
    [
      '-y',
      '-i', inputPath,
      '-ss', String(start),
      '-to', String(end),
      // No -c copy: re-encoding to the same (lossless for FLAC/WAV) codec keeps
      // the cut sample-accurate instead of snapping to a packet boundary.
      '-map_metadata', '0',
      outputPath,
    ],
    { timeoutMs }
  );

  return outputPath;
}
