/**
 * yt-dlp wrapper.
 *
 * Everything here spawns yt-dlp with an argv array and no shell, so pasted
 * URLs are never interpreted by a shell. Do not switch these to `exec`.
 */

import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import path from 'node:path';

const YTDLP = process.env.MURDOCK_YTDLP || 'yt-dlp';

export const AUDIO_FORMATS = ['mp3', 'wav', 'flac', 'm4a', 'opus'];

/** Run yt-dlp and buffer its output. Rejects with yt-dlp's own stderr on failure. */
function run(args, { timeoutMs = 120_000, onOutput } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(YTDLP, args, { shell: false });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    // yt-dlp writes download progress to stdout and warnings/errors to stderr,
    // so both have to be watched to track a job.
    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      onOutput?.(text);
    });

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      onOutput?.(text);
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      if (err.code === 'ENOENT') {
        reject(new Error('yt-dlp is not installed or not on PATH. Run: brew install yt-dlp'));
      } else {
        reject(err);
      }
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error('yt-dlp timed out.'));
      } else if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(cleanError(stderr) || `yt-dlp exited with code ${code}`));
      }
    });
  });
}

/** yt-dlp errors are noisy; surface the line that actually says what went wrong. */
function cleanError(stderr) {
  const line = stderr
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .reverse()
    .find((l) => l.startsWith('ERROR:'));

  if (!line) return '';

  return line
    .replace(/^ERROR:\s*/, '')
    .replace(/^\[[^\]]+\]\s*[^:]*:\s*/, '')
    .trim();
}

/** Fetch metadata without downloading. */
export async function probe(url, { timeoutMs = 60_000 } = {}) {
  const { stdout } = await run(
    ['--dump-single-json', '--no-playlist', '--no-warnings', '--', url],
    { timeoutMs }
  );

  let info;
  try {
    info = JSON.parse(stdout);
  } catch {
    throw new Error('Could not read media info from that link.');
  }

  // A `ytsearch1:` target resolves to a playlist container whose single entry is
  // the actual match. Unwrap it, or the caller gets the search query as a title
  // with null duration.
  if (info._type === 'playlist' && Array.isArray(info.entries)) {
    if (info.entries.length === 0) {
      throw new Error('No match found for that track.');
    }
    info = info.entries[0];
  }

  return {
    id: info.id,
    title: info.title || info.fulltitle || 'Untitled',
    uploader: info.uploader || info.channel || info.artist || info.creator || null,
    durationSeconds: typeof info.duration === 'number' ? Math.round(info.duration) : null,
    thumbnail: info.thumbnail || null,
    extractor: info.extractor_key || info.extractor || null,
    webpageUrl: info.webpage_url || url,
    isLive: Boolean(info.is_live),
  };
}

/**
 * Download and transcode to an audio file in `outputDir`.
 * Returns the absolute path of the produced file.
 */
export async function extractAudio(url, outputDir, options = {}) {
  const {
    format = 'mp3',
    quality = '0',
    startTime = null,
    endTime = null,
    stereo = true,
    onProgress,
    timeoutMs = 900_000,
  } = options;

  if (!AUDIO_FORMATS.includes(format)) {
    throw new Error(`Unsupported audio format: ${format}`);
  }

  const before = new Set(await safeReaddir(outputDir));

  // Encode the clip window in the filename. Without this, two different
  // sections of the same source collide on one name and the second grab
  // silently returns the first one's audio.
  const clipTag =
    startTime != null || endTime != null
      ? `_${Math.floor(startTime ?? 0)}-${endTime != null ? Math.floor(endTime) : 'end'}`
      : '';

  const args = [
    '--extract-audio',
    '--audio-format', format,
    '--audio-quality', String(quality),
    '--no-playlist',
    '--no-warnings',
    '--newline',
    '--restrict-filenames',
    // Re-grabbing the same source must actually re-extract; otherwise yt-dlp
    // skips the existing destination and we report "no audio file".
    '--force-overwrites',
    // Have yt-dlp tell us the final path rather than inferring it by diffing
    // the directory — the diff breaks whenever the file already exists.
    '--no-simulate',
    '--print', 'after_move:filepath',
    // --print implies --quiet, which would swallow progress output entirely.
    // --progress forces it back on so jobs can report a percentage.
    '--progress',
    '--output', path.join(outputDir, `%(title).120B [%(id)s]${clipTag}.%(ext)s`),
  ];

  // Plenty of sources (film rips, live uploads) carry 5.1 audio. A 6-channel
  // file is awkward to drop into a DAW, so downmix to stereo by default.
  if (stereo) {
    args.push('--postprocessor-args', 'ExtractAudio:-ac 2');
  }

  // Trim to a section. yt-dlp needs ffmpeg for this; force-keyframes keeps the
  // cut accurate, which matters when you're grabbing a specific vocal phrase.
  if (startTime != null || endTime != null) {
    const from = startTime ?? 0;
    const to = endTime ?? 'inf';
    args.push('--download-sections', `*${from}-${to}`, '--force-keyframes-at-cuts');
  }

  args.push('--', url);

  const { stdout } = await run(args, {
    timeoutMs,
    onOutput: onProgress ? (text) => onProgress(text) : undefined,
  });

  // `--print` writes the path to stdout alongside progress lines (which all
  // start with a "[section]" tag), so pick the last bare absolute path.
  const printed = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('/') && line.toLowerCase().endsWith(`.${format}`));

  if (printed.length > 0) {
    return printed[printed.length - 1];
  }

  // Fallback: older yt-dlp builds may not honour after_move:filepath.
  const after = await safeReaddir(outputDir);
  const created = after.filter((name) => !before.has(name) && name.endsWith(`.${format}`));

  if (created.length === 0) {
    throw new Error('Extraction finished but produced no audio file.');
  }

  return path.join(outputDir, created[created.length - 1]);
}

async function safeReaddir(dir) {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

/**
 * Check that the yt-dlp binary is reachable.
 * Timeout is generous by default: on a throttled host the first invocation can
 * be slow, and this gates nothing latency-sensitive — the result is cached.
 */
export async function checkAvailable({ timeoutMs = 30_000 } = {}) {
  try {
    const { stdout } = await run(['--version'], { timeoutMs });
    return { ok: true, version: stdout.trim() };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
