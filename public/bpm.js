/**
 * Tempo (BPM) detection — runs in the browser off the same decoded AudioBuffer
 * the waveform/key already use, so there's no extra fetch or server cost
 * (mirrors key.js).
 *
 * Method: build an onset-strength envelope (positive energy flux per frame),
 * then autocorrelate it across the lags that correspond to 70–180 BPM. The
 * strongest lag is the beat period. Octave errors are the classic failure, so
 * the result is folded into a musical 80–160 range. It's an estimate — that's
 * why the UI also offers a manual ± nudge and a target-BPM box.
 */

const FRAME = 1024;
const HOP = 512;
const MIN_BPM = 70;
const MAX_BPM = 180;

/**
 * @param {AudioBuffer} audioBuffer
 * @returns {{bpm:number, confidence:number}|null}
 */
export function detectBPM(audioBuffer) {
  try {
    const sr = audioBuffer.sampleRate;
    const length = audioBuffer.length;
    if (!length || length < sr) return null; // need at least ~1s

    // Downmix to mono.
    const channels = audioBuffer.numberOfChannels;
    const mono = new Float32Array(length);
    for (let c = 0; c < channels; c++) {
      const data = audioBuffer.getChannelData(c);
      for (let i = 0; i < length; i++) mono[i] += data[i] / channels;
    }

    // Onset envelope: positive frame-to-frame rise in RMS energy.
    const frames = Math.floor((length - FRAME) / HOP);
    if (frames < 8) return null;
    const flux = new Float32Array(frames);
    let prev = 0;
    for (let f = 0; f < frames; f++) {
      const start = f * HOP;
      let energy = 0;
      for (let i = 0; i < FRAME; i++) {
        const s = mono[start + i];
        energy += s * s;
      }
      energy = Math.sqrt(energy / FRAME);
      flux[f] = Math.max(0, energy - prev);
      prev = energy;
    }

    // Normalize + remove DC so autocorrelation is well-behaved.
    let mean = 0;
    for (let i = 0; i < frames; i++) mean += flux[i];
    mean /= frames;
    for (let i = 0; i < frames; i++) flux[i] -= mean;

    const fps = sr / HOP; // onset frames per second
    const minLag = Math.floor((60 * fps) / MAX_BPM);
    const maxLag = Math.ceil((60 * fps) / MIN_BPM);

    let bestLag = 0;
    let bestScore = -Infinity;
    for (let lag = minLag; lag <= maxLag; lag++) {
      let sum = 0;
      for (let i = lag; i < frames; i++) sum += flux[i] * flux[i - lag];
      if (sum > bestScore) {
        bestScore = sum;
        bestLag = lag;
      }
    }
    if (bestLag === 0) return null;

    let bpm = (60 * fps) / bestLag;

    // Fold octave errors into a musical range.
    while (bpm < 80) bpm *= 2;
    while (bpm > 160) bpm /= 2;

    // Normalized confidence: peak strength vs. total energy.
    let total = 0;
    for (let i = 0; i < frames; i++) total += flux[i] * flux[i];
    const confidence = total > 0 ? bestScore / total : 0;

    return { bpm: Math.round(bpm), confidence };
  } catch {
    return null; // best-effort; never break the player
  }
}
