/**
 * Waveform preview player.
 *
 * Playback runs through a plain <audio> element (the browser handles buffering
 * and Range requests); the canvas is purely a visualization and seek surface.
 * Peaks come from decoding the file once via Web Audio — no dependencies.
 *
 * If decoding fails, or the browser can't play the codec at all, the caller
 * gets a native <audio controls> fallback rather than a dead UI.
 */

import { detectKey } from '/key.js';

const BAR_WIDTH = 2;
const BAR_GAP = 1;

function cssVar(name, fallback) {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * Reduce raw samples to one peak per bar. Uses max absolute amplitude across
 * channels, which keeps transients visible — averaging flattens them out and
 * makes it hard to see where a vocal enters.
 */
function computePeaks(audioBuffer, barCount) {
  const channels = Math.min(audioBuffer.numberOfChannels, 2);
  const data = [];
  for (let c = 0; c < channels; c++) data.push(audioBuffer.getChannelData(c));

  const samplesPerBar = Math.floor(data[0].length / barCount) || 1;
  const peaks = new Float32Array(barCount);

  for (let bar = 0; bar < barCount; bar++) {
    const start = bar * samplesPerBar;
    const end = Math.min(start + samplesPerBar, data[0].length);
    let peak = 0;

    // Step through long buckets rather than reading every sample; at these
    // bucket sizes the visual result is identical and it keeps decode snappy.
    const step = Math.max(1, Math.floor((end - start) / 400));
    for (const channel of data) {
      for (let i = start; i < end; i += step) {
        const value = Math.abs(channel[i]);
        if (value > peak) peak = value;
      }
    }
    peaks[bar] = peak;
  }

  // Normalize so quiet sources still fill the display.
  const max = peaks.reduce((a, b) => Math.max(a, b), 0) || 1;
  for (let i = 0; i < peaks.length; i++) peaks[i] /= max;

  return peaks;
}

export function createPlayer(container, { streamUrl, format, onKeyDetected }) {
  container.innerHTML = `
    <div class="player">
      <button class="play-btn" type="button" aria-label="Play">
        <span class="play-icons">
          <svg viewBox="0 0 24 24" class="icon-play" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>
          <svg viewBox="0 0 24 24" class="icon-pause" aria-hidden="true"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>
        </span>
      </button>
      <div class="wave-wrap">
        <canvas class="wave" role="slider" tabindex="0"
                aria-label="Seek" aria-valuemin="0" aria-valuenow="0"></canvas>
        <div class="wave-loading">reading waveform…</div>
      </div>
      <span class="time">0:00 / 0:00</span>
    </div>
  `;

  const audio = new Audio();
  audio.preload = 'metadata';
  audio.src = streamUrl;

  const playBtn = container.querySelector('.play-btn');
  const canvas = container.querySelector('.wave');
  const loading = container.querySelector('.wave-loading');
  const timeEl = container.querySelector('.time');
  const ctx = canvas.getContext('2d');

  let peaks = null;
  let raf = null;
  let scrubbing = false;
  let destroyed = false;

  const colors = {
    played: cssVar('--accent', '#d6f45a'),
    idle: cssVar('--line', '#2a2e35'),
    idleLit: '#454b55',
  };

  function draw() {
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0) return;

    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.floor(rect.width * dpr)) {
      canvas.width = Math.floor(rect.width * dpr);
      canvas.height = Math.floor(rect.height * dpr);
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);

    const barCount = Math.floor(rect.width / (BAR_WIDTH + BAR_GAP));
    const mid = rect.height / 2;
    const progress = audio.duration ? audio.currentTime / audio.duration : 0;
    // Continuous pixel position of the playhead, not snapped to a bar.
    const progressX = progress * rect.width;

    const drawBars = () => {
      for (let i = 0; i < barCount; i++) {
        const x = i * (BAR_WIDTH + BAR_GAP);
        // Before decode finishes, render a flat idle bed rather than nothing.
        const peak = peaks ? peaks[Math.floor((i / barCount) * peaks.length)] : 0.12;
        const height = Math.max(2, peak * (rect.height - 4));
        ctx.fillRect(x, mid - height / 2, BAR_WIDTH, height);
      }
    };

    // Idle bed first, then the played portion clipped to the exact playhead x.
    // Clipping the fill (rather than colouring whole bars) lets the boundary bar
    // fill partially, so the edge glides smoothly instead of jumping bar to bar.
    ctx.fillStyle = colors.idleLit;
    drawBars();

    if (progressX > 0) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, progressX, rect.height);
      ctx.clip();
      ctx.fillStyle = colors.played;
      drawBars();
      ctx.restore();
    }
  }

  function tick() {
    if (destroyed) return;
    draw();
    updateTime();
    raf = requestAnimationFrame(tick);
  }

  function updateTime() {
    const total = Number.isFinite(audio.duration) ? audio.duration : 0;
    timeEl.textContent = `${formatTime(audio.currentTime)} / ${formatTime(total)}`;
    canvas.setAttribute('aria-valuenow', String(Math.floor(audio.currentTime)));
    canvas.setAttribute('aria-valuemax', String(Math.floor(total)));
  }

  function setPlayingUI(playing) {
    // CSS crossfades the two icons based on this class — only one shows at a time.
    playBtn.classList.toggle('playing', playing);
    playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  }

  playBtn.addEventListener('click', () => {
    if (audio.paused) {
      audio.play().catch((err) => showUnplayable(err));
    } else {
      audio.pause();
    }
  });

  audio.addEventListener('play', () => {
    setPlayingUI(true);
    cancelAnimationFrame(raf);
    tick();
  });

  audio.addEventListener('pause', () => {
    setPlayingUI(false);
    cancelAnimationFrame(raf);
    draw();
  });

  audio.addEventListener('ended', () => {
    setPlayingUI(false);
    cancelAnimationFrame(raf);
    audio.currentTime = 0;
    draw();
    updateTime();
  });

  audio.addEventListener('loadedmetadata', () => {
    updateTime();
    draw();
  });

  audio.addEventListener('error', () => showUnplayable());

  function seekFromEvent(event) {
    const rect = canvas.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    if (Number.isFinite(audio.duration)) {
      audio.currentTime = ratio * audio.duration;
      draw();
      updateTime();
    }
  }

  canvas.addEventListener('pointerdown', (event) => {
    scrubbing = true;
    canvas.setPointerCapture(event.pointerId);
    seekFromEvent(event);
  });

  canvas.addEventListener('pointermove', (event) => {
    if (scrubbing) seekFromEvent(event);
  });

  canvas.addEventListener('pointerup', (event) => {
    scrubbing = false;
    canvas.releasePointerCapture(event.pointerId);
  });

  canvas.addEventListener('keydown', (event) => {
    if (!Number.isFinite(audio.duration)) return;
    if (event.key === 'ArrowRight') {
      audio.currentTime = Math.min(audio.duration, audio.currentTime + 5);
    } else if (event.key === 'ArrowLeft') {
      audio.currentTime = Math.max(0, audio.currentTime - 5);
    } else if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault();
      audio.paused ? audio.play().catch(() => {}) : audio.pause();
      return;
    } else {
      return;
    }
    draw();
    updateTime();
  });

  const onResize = () => draw();
  window.addEventListener('resize', onResize);

  /** Codec the browser can't decode or play — hand back a native control. */
  function showUnplayable(err) {
    if (destroyed) return;
    container.innerHTML = `
      <p class="player-fallback">
        This browser can't preview ${format ? format.toUpperCase() : 'this format'} inline.
        The file downloaded fine — open it in your DAW, or try MP3/WAV for preview.
      </p>
    `;
    if (err) console.warn('murdock: preview unavailable —', err.message);
  }

  /** Decode once for peaks. Playback does not wait on this. */
  (async () => {
    try {
      const res = await fetch(streamUrl);
      if (!res.ok) throw new Error(`stream returned ${res.status}`);
      const bytes = await res.arrayBuffer();

      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      const audioCtx = new AudioCtx();
      const buffer = await audioCtx.decodeAudioData(bytes);
      audioCtx.close();

      if (destroyed) return;

      const rect = canvas.getBoundingClientRect();
      peaks = computePeaks(buffer, Math.max(1, Math.floor(rect.width / (BAR_WIDTH + BAR_GAP))));
      loading.remove();
      draw();

      // Detect musical key off the same decoded buffer. Deferred so the
      // waveform paints first — detection is a ~1s synchronous pass.
      if (onKeyDetected) {
        setTimeout(() => {
          if (destroyed) return;
          const key = detectKey(buffer);
          if (key && !destroyed) onKeyDetected(key);
        }, 0);
      }
    } catch (err) {
      // Decoding is a nicety — if it fails but playback works, keep the
      // transport usable with the flat idle bed.
      if (!destroyed) {
        loading.remove();
        draw();
        console.warn('murdock: waveform unavailable —', err.message);
      }
    }
  })();

  draw();

  return function destroy() {
    destroyed = true;
    cancelAnimationFrame(raf);
    window.removeEventListener('resize', onResize);
    audio.pause();
    audio.src = '';
  };
}
