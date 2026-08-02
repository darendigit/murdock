/**
 * Embed detected key + BPM into a file's metadata (not its name).
 *
 * Key and BPM are detected client-side off the decoded audio; the browser posts
 * them here and we write them into the file's tags so a sample library and DJ
 * software (Rekordbox/Serato/Traktor read BPM + INITIALKEY) can see them. FLAC —
 * the local default — carries these as Vorbis comments. Tags are copied in with
 * `-c copy`, so there's no re-encode: fast and lossless.
 *
 * We can't rewrite a file in place, so we write a sibling temp file and rename
 * it over the original, keeping the same name the user already has.
 */

import { rename, stat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ffmpeg } from './ffmpeg.js';

export async function tagAudio(filePath, { keyLabel, camelot, bpm } = {}, { timeoutMs = 120_000 } = {}) {
  await stat(filePath); // throws if the file vanished

  const ext = path.extname(filePath);
  const tmp = path.join(path.dirname(filePath), `.murdock-tag-${randomUUID()}${ext}`);

  const meta = [];
  const push = (k, v) => {
    if (v != null && v !== '') meta.push('-metadata', `${k}=${v}`);
  };

  const bpmRounded = Number.isFinite(Number(bpm)) ? Math.round(Number(bpm)) : null;
  // Multiple keys so different players/containers each find one they read.
  push('BPM', bpmRounded);
  push('TBPM', bpmRounded);
  push('INITIALKEY', keyLabel);
  push('TKEY', keyLabel);
  push('KEY', keyLabel);
  const commentParts = [
    keyLabel ? `Key ${keyLabel}${camelot ? ` (${camelot})` : ''}` : null,
    bpmRounded ? `${bpmRounded} BPM` : null,
  ].filter(Boolean);
  push('comment', commentParts.join(' · ') || null);

  if (meta.length === 0) return filePath; // nothing to write

  await ffmpeg(['-y', '-i', filePath, '-map', '0', '-c', 'copy', ...meta, tmp], { timeoutMs });
  await rename(tmp, filePath);
  return filePath;
}
