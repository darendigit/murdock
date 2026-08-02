/**
 * Light smoke assertions for pure helpers — no network, no browser. Run with:
 *   node test/smoke.mjs
 * Mirrors the repo's zero-framework style (plain assert + a tiny runner).
 */

import assert from 'node:assert/strict';
import { looksLikeUrl, detectService } from '../src/services.js';
import { isPlaylistUrl } from '../src/playlist.js';
import { compatibleCodes } from '../public/camelot.js';
import { camelotToKey } from '../public/key.js';

let passed = 0;
const t = (name, fn) => {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
};

t('looksLikeUrl: links vs queries', () => {
  assert.equal(looksLikeUrl('https://youtube.com/watch?v=x'), true);
  assert.equal(looksLikeUrl('youtube.com/watch?v=x'), true);
  assert.equal(looksLikeUrl('open.spotify.com/track/abc'), true);
  assert.equal(looksLikeUrl('daft punk one more time'), false);
  assert.equal(looksLikeUrl('adele'), false);
  assert.equal(looksLikeUrl(''), false);
});

t('isPlaylistUrl: collections vs single items', () => {
  assert.equal(isPlaylistUrl('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M'), true);
  assert.equal(isPlaylistUrl('https://open.spotify.com/album/abc'), true);
  assert.equal(isPlaylistUrl('https://www.youtube.com/playlist?list=PLx'), true);
  assert.equal(isPlaylistUrl('https://youtube.com/watch?v=abc&list=PLx'), false); // single video in a list
  assert.equal(isPlaylistUrl('https://open.spotify.com/track/abc'), false);
});

t('detectService: known hosts + unknown fallback', () => {
  assert.equal(detectService('https://youtube.com/watch?v=x').id, 'youtube');
  assert.equal(detectService('https://open.spotify.com/track/x').mode, 'resolve');
  assert.equal(detectService('https://instagram.com/p/x').tier, 'unsupported');
  assert.equal(detectService('https://example.com/audio').id, 'unknown');
});

t('camelot: compatible neighbours', () => {
  const c = compatibleCodes('8A');
  assert.ok(c.has('8A')); // self
  assert.ok(c.has('7A') && c.has('9A')); // ±1 same ring
  assert.ok(c.has('8B')); // relative major/minor
  assert.equal(c.has('8A') && c.size, 4);
});

t('camelotToKey: inverse of key→camelot', () => {
  assert.deepEqual(camelotToKey('8B'), { tonic: 'C', mode: 'major' });
  assert.deepEqual(camelotToKey('5A'), { tonic: 'C', mode: 'minor' });
  assert.deepEqual(camelotToKey('8A'), { tonic: 'A', mode: 'minor' });
  assert.equal(camelotToKey('99Z'), null);
});

console.log(`\n${passed} checks passed.`);
