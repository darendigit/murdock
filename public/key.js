/**
 * Musical key detection — runs in the browser off the AudioBuffer the player
 * already decodes for the waveform, so there's no extra fetch or server cost.
 *
 * Method: build a 12-bin chromagram (energy per pitch class) via a windowed
 * FFT, then correlate it against the 24 Krumhansl-Schmuckler key profiles
 * (major/minor × 12 tonics). Best correlation wins. Returns a Camelot code too,
 * since that's how DJs match keys.
 *
 * It's an estimate — short loops and ambiguous material can fool it, which is
 * why shifting also offers a raw ±semitone control. Zero dependencies.
 */

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

// Camelot wheel, indexed by pitch class (0 = C … 11 = B).
const CAMELOT_MAJOR = ['8B', '3B', '10B', '5B', '12B', '7B', '2B', '9B', '4B', '11B', '6B', '1B'];
const CAMELOT_MINOR = ['5A', '12A', '7A', '2A', '9A', '4A', '11A', '6A', '1A', '8A', '3A', '10A'];

// Krumhansl-Schmuckler tonal profiles.
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

const FFT_SIZE = 4096;
const MAX_FRAMES = 1200; // cap work so a full track analyzes in well under a second
const MIN_HZ = 65; // ~C2 — ignore sub-bass rumble
const MAX_HZ = 2000; // ~B6 — ignore hiss/harmonics above the fundamental range

/** In-place iterative radix-2 Cooley-Tukey FFT on real+imag arrays (length = 2^k). */
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = i + k + len / 2;
        const tRe = re[b] * curRe - im[b] * curIm;
        const tIm = re[b] * curIm + im[b] * curRe;
        re[b] = re[a] - tRe;
        im[b] = im[a] - tIm;
        re[a] += tRe;
        im[a] += tIm;
        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }
}

/** Pearson correlation of two equal-length arrays. */
function correlate(a, b) {
  const n = a.length;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) {
    ma += a[i];
    mb += b[i];
  }
  ma /= n;
  mb /= n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma;
    const y = b[i] - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  const denom = Math.sqrt(da * db);
  return denom === 0 ? 0 : num / denom;
}

/**
 * @param {AudioBuffer} audioBuffer
 * @returns {{tonic:string, mode:'major'|'minor', camelot:string, label:string, confidence:number}|null}
 */
export function detectKey(audioBuffer) {
  try {
    const sampleRate = audioBuffer.sampleRate;
    const length = audioBuffer.length;
    if (!length || length < FFT_SIZE) return null;

    // Downmix to mono.
    const channels = audioBuffer.numberOfChannels;
    const mono = new Float32Array(length);
    for (let c = 0; c < channels; c++) {
      const data = audioBuffer.getChannelData(c);
      for (let i = 0; i < length; i++) mono[i] += data[i] / channels;
    }

    // Hann window.
    const win = new Float32Array(FFT_SIZE);
    for (let i = 0; i < FFT_SIZE; i++) win[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1)));

    // Hop sized so we analyze at most MAX_FRAMES frames across the whole track.
    const usable = length - FFT_SIZE;
    const hop = Math.max(FFT_SIZE / 2, Math.floor(usable / MAX_FRAMES) || FFT_SIZE / 2);

    const minBin = Math.max(1, Math.floor((MIN_HZ * FFT_SIZE) / sampleRate));
    const maxBin = Math.min(FFT_SIZE / 2, Math.ceil((MAX_HZ * FFT_SIZE) / sampleRate));

    const chroma = new Float32Array(12);
    const re = new Float64Array(FFT_SIZE);
    const im = new Float64Array(FFT_SIZE);

    let frames = 0;
    for (let start = 0; start + FFT_SIZE <= length; start += hop) {
      for (let i = 0; i < FFT_SIZE; i++) {
        re[i] = mono[start + i] * win[i];
        im[i] = 0;
      }
      fft(re, im);
      for (let bin = minBin; bin <= maxBin; bin++) {
        const mag = Math.sqrt(re[bin] * re[bin] + im[bin] * im[bin]);
        if (mag <= 0) continue;
        const freq = (bin * sampleRate) / FFT_SIZE;
        const midi = 69 + 12 * Math.log2(freq / 440);
        const pc = ((Math.round(midi) % 12) + 12) % 12;
        chroma[pc] += mag;
      }
      frames++;
    }
    if (frames === 0) return null;

    // Correlate against all 24 rotated profiles.
    let best = { score: -Infinity, tonic: 0, mode: 'major' };
    for (let tonic = 0; tonic < 12; tonic++) {
      const maj = new Float32Array(12);
      const min = new Float32Array(12);
      for (let i = 0; i < 12; i++) {
        maj[i] = MAJOR_PROFILE[(i - tonic + 12) % 12];
        min[i] = MINOR_PROFILE[(i - tonic + 12) % 12];
      }
      const sMaj = correlate(chroma, maj);
      const sMin = correlate(chroma, min);
      if (sMaj > best.score) best = { score: sMaj, tonic, mode: 'major' };
      if (sMin > best.score) best = { score: sMin, tonic, mode: 'minor' };
    }

    const camelot = best.mode === 'major' ? CAMELOT_MAJOR[best.tonic] : CAMELOT_MINOR[best.tonic];
    const tonicName = NOTE_NAMES[best.tonic];
    return {
      tonic: tonicName,
      mode: best.mode,
      camelot,
      label: `${tonicName} ${best.mode}`,
      confidence: best.score,
    };
  } catch {
    return null; // detection is best-effort; never break the player
  }
}

/** Pitch class (0-11) for a note name, for computing shift deltas to a target key. */
export function pitchClass(noteName) {
  return NOTE_NAMES.indexOf(noteName);
}

/** The key you'd land in after shifting `detected` by `semitones` (mode unchanged). */
export function shiftedKey(detected, semitones) {
  if (!detected) return null;
  const fromPc = NOTE_NAMES.indexOf(detected.tonic);
  if (fromPc < 0) return null;
  const pc = (((fromPc + semitones) % 12) + 12) % 12;
  const camelot = detected.mode === 'major' ? CAMELOT_MAJOR[pc] : CAMELOT_MINOR[pc];
  return { tonic: NOTE_NAMES[pc], mode: detected.mode, camelot, label: `${NOTE_NAMES[pc]} ${detected.mode}` };
}

export { NOTE_NAMES };
