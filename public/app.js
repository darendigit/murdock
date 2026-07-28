import { createPlayer } from '/player.js';
import { NOTE_NAMES, shiftedKey } from '/key.js';

const form = document.getElementById('grab-form');
const urlInput = document.getElementById('url');
const formatSelect = document.getElementById('format');
const startInput = document.getElementById('start');
const endInput = document.getElementById('end');
const submitBtn = document.getElementById('submit-btn');
const statusEl = document.getElementById('status');
const resultEl = document.getElementById('result');
const providersEl = document.getElementById('providers');

let polling = null;
let destroyPlayer = null;

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function formatDuration(seconds) {
  if (seconds == null) return null;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function showStatus(message, { progress = null, error = false, soft = false } = {}) {
  statusEl.hidden = false;
  // A soft error is recoverable (e.g. YouTube momentarily unreachable) — style
  // it as a calm notice, not a hard failure.
  statusEl.classList.toggle('error', error && !soft);
  statusEl.classList.toggle('notice', error && soft);

  const icon = soft ? '<span class="notice-mark">↻</span>' : error ? '<span>✕</span>' : '<span class="spinner"></span>';

  statusEl.innerHTML = `
    <div class="status-line">
      ${icon}
      <span>${escapeHtml(message)}</span>
    </div>
    ${progress != null ? `
      <div class="bar"><div class="bar-fill" style="width:${progress}%"></div></div>
    ` : ''}
  `;
}

function clearStatus() {
  statusEl.hidden = true;
  statusEl.innerHTML = '';
}

let expiryTimer = null;

/**
 * Files are swept server-side after a TTL, so show a live countdown and mark
 * the row expired rather than letting the download 404 without explanation.
 */
function startExpiryCountdown(el) {
  clearInterval(expiryTimer);
  if (!el) return;

  const expiresAt = Number(el.dataset.expires);
  if (!expiresAt) return;

  const tick = () => {
    const remaining = expiresAt - Date.now();

    if (remaining <= 0) {
      el.textContent = ' · expired';
      el.classList.add('gone');
      resultEl.querySelector('.download-btn')?.classList.add('disabled');
      clearInterval(expiryTimer);
      return;
    }

    const minutes = Math.floor(remaining / 60_000);
    const seconds = Math.floor((remaining % 60_000) / 1000);
    el.textContent = ` · deletes in ${minutes}:${String(seconds).padStart(2, '0')}`;
  };

  tick();
  expiryTimer = setInterval(tick, 1000);
}

function renderResult(probeData, job) {
  const { service, media, resolved, resolvedVia } = probeData;
  const duration = formatDuration(media.durationSeconds);

  const subParts = [media.uploader, duration].filter(Boolean);

  resultEl.hidden = false;
  resultEl.innerHTML = `
    <div class="meta">
      ${media.thumbnail
        ? `<img src="${escapeHtml(media.thumbnail)}" alt="" onerror="this.remove()" />`
        : ''}
      <div class="meta-text">
        <div class="badge">${escapeHtml(service.label)}</div>
        <h2>${escapeHtml(resolved?.title || media.title)}</h2>
        <p class="sub">${escapeHtml(subParts.join('  ·  '))}</p>
        ${resolvedVia === 'youtube-match' ? `
          <p class="note">
            ${escapeHtml(resolved?.source || 'That service')} audio is DRM-protected,
            so murdock matched this track on YouTube instead:
            “${escapeHtml(media.title)}”. Check it's the right take before you sample it.
          </p>` : ''}
      </div>
    </div>
    <div class="player-slot"></div>
    <div class="keybar">
      <span class="key-detected" id="key-detected">detecting key…</span>
      <div class="shift-controls">
        <select id="shift-target" title="Shift to key" disabled>
          <option value="">shift to key…</option>
        </select>
        <span class="shift-steppers">
          <button type="button" class="stepper" data-step="-1" aria-label="down a semitone">−</button>
          <span class="shift-amount" id="shift-amount">0</span>
          <button type="button" class="stepper" data-step="1" aria-label="up a semitone">+</button>
        </span>
        <button type="button" class="shift-btn" id="shift-btn" disabled>Shift key</button>
      </div>
    </div>
    <div class="download-bar">
      <span class="file-info">
        ${escapeHtml(job.filename)} · ${formatBytes(job.sizeBytes)}
        <span class="expiry" data-expires="${job.expiresAt || ''}"></span>
      </span>
      <a class="download-btn" href="${job.downloadUrl}" download>Download</a>
    </div>
  `;

  startExpiryCountdown(resultEl.querySelector('.expiry'));
  wireKeyAndShift(job);
}

/**
 * Wire the detected-key display and the shift controls. Shifts always operate on
 * the original grabbed file (`sourceFilename`), so re-shifting starts from the
 * source, not a previous shift.
 */
function wireKeyAndShift(job) {
  const sourceFilename = job.filename;
  let detectedKey = null;
  let semitones = 0;

  const keyEl = resultEl.querySelector('#key-detected');
  const targetSel = resultEl.querySelector('#shift-target');
  const amountEl = resultEl.querySelector('#shift-amount');
  const shiftBtn = resultEl.querySelector('#shift-btn');

  for (const name of NOTE_NAMES) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = `→ ${name}`;
    targetSel.appendChild(opt);
  }

  const fmtAmount = (n) => (n > 0 ? `+${n}` : `${n}`);
  const setSemitones = (n) => {
    semitones = Math.max(-12, Math.min(12, n));
    amountEl.textContent = fmtAmount(semitones);
    shiftBtn.disabled = semitones === 0;
    // Preview the resulting key next to the amount.
    if (detectedKey && semitones !== 0) {
      const to = shiftedKey(detectedKey, semitones);
      if (to) keyEl.dataset.preview = `→ ${to.label} · ${to.camelot}`;
    } else {
      delete keyEl.dataset.preview;
    }
    renderKeyLine();
  };

  const renderKeyLine = () => {
    if (!detectedKey) {
      keyEl.textContent = 'key not detected';
      return;
    }
    const preview = keyEl.dataset.preview ? `  ${keyEl.dataset.preview}` : '';
    keyEl.textContent = `Key: ${detectedKey.label} · ${detectedKey.camelot}${preview}`;
  };

  targetSel.addEventListener('change', () => {
    if (!detectedKey || !targetSel.value) return;
    const from = NOTE_NAMES.indexOf(detectedKey.tonic);
    const to = NOTE_NAMES.indexOf(targetSel.value);
    let d = (to - from) % 12;
    if (d > 6) d -= 12; // nearest direction, so shifts stay small
    if (d < -6) d += 12;
    setSemitones(d);
  });

  resultEl.querySelectorAll('.stepper').forEach((btn) => {
    btn.addEventListener('click', () => {
      targetSel.value = '';
      setSemitones(semitones + Number(btn.dataset.step));
    });
  });

  shiftBtn.addEventListener('click', () => runShift(job, sourceFilename, semitones, () => detectedKey));

  // Called by the player once it decodes and estimates the key.
  const onKeyDetected = (key) => {
    detectedKey = key;
    targetSel.disabled = false;
    renderKeyLine();
  };

  destroyPlayer?.();
  destroyPlayer = createPlayer(resultEl.querySelector('.player-slot'), {
    streamUrl: job.streamUrl,
    format: job.filename.split('.').pop(),
    onKeyDetected,
  });
}

/**
 * Kick off an async shift, poll it to completion, and swap the player + download
 * to the shifted file. A full-track shift is CPU-heavy (can take a minute+ on
 * the free tier), so the button shows a live elapsed counter rather than a
 * frozen "Shifting…".
 */
async function runShift(job, sourceFilename, semitones, getKey) {
  if (!semitones) return;
  const shiftBtn = resultEl.querySelector('#shift-btn');
  shiftBtn.disabled = true;

  const started = Date.now();
  shiftBtn.textContent = 'Shifting… 0s';
  const ticker = setInterval(() => {
    shiftBtn.textContent = `Shifting… ${Math.round((Date.now() - started) / 1000)}s`;
  }, 1000);

  try {
    const res = await fetch('/api/shift', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: sourceFilename, semitones }),
    });
    const kickoff = await res.json();
    if (!res.ok) throw new Error(kickoff.error || 'Shift failed.');

    const data = await new Promise((resolve, reject) => {
      const poll = setInterval(async () => {
        try {
          const r = await fetch(`/api/job/${kickoff.jobId}`);
          const j = await r.json();
          if (j.status === 'done') {
            clearInterval(poll);
            resolve(j);
          } else if (j.status === 'error') {
            clearInterval(poll);
            reject(new Error(j.error || 'Shift failed.'));
          }
        } catch {
          clearInterval(poll);
          reject(new Error('Lost connection during shift.'));
        }
      }, 800);
    });

    clearInterval(ticker);

    // Swap the player + download to the shifted file.
    destroyPlayer?.();
    destroyPlayer = createPlayer(resultEl.querySelector('.player-slot'), {
      streamUrl: data.streamUrl,
      format: data.filename.split('.').pop(),
    });
    const dl = resultEl.querySelector('.download-btn');
    dl.href = data.downloadUrl;
    resultEl.querySelector('.file-info').innerHTML =
      `${escapeHtml(data.filename)} · ${formatBytes(data.sizeBytes)} ` +
      `<span class="expiry" data-expires="${data.expiresAt || ''}"></span>`;
    startExpiryCountdown(resultEl.querySelector('.expiry'));

    const to = shiftedKey(getKey(), semitones);
    resultEl.querySelector('#key-detected').textContent = to
      ? `Shifted ${semitones > 0 ? '+' : ''}${semitones} st → ${to.label} · ${to.camelot}`
      : `Shifted ${semitones > 0 ? '+' : ''}${semitones} st`;
    shiftBtn.textContent = 'Shifted ✓';
  } catch (err) {
    clearInterval(ticker);
    shiftBtn.textContent = 'Shift key';
    shiftBtn.disabled = false;
    showStatus(err.message, { error: true });
  }
}

async function pollJob(jobId, probeData) {
  clearInterval(polling);

  polling = setInterval(async () => {
    try {
      const res = await fetch(`/api/job/${jobId}`);
      const job = await res.json();

      if (job.status === 'done') {
        clearInterval(polling);
        clearStatus();
        renderResult(probeData, job);
        setBusy(false);
      } else if (job.status === 'error') {
        clearInterval(polling);
        showStatus(job.error || 'Extraction failed.', { error: true, soft: job.soft });
        setBusy(false);
      } else {
        showStatus(job.stage || 'Working', { progress: job.progress ?? 0 });
      }
    } catch {
      clearInterval(polling);
      showStatus('Lost connection to the murdock server.', { error: true });
      setBusy(false);
    }
  }, 600);
}

function setBusy(busy) {
  submitBtn.disabled = busy;
  submitBtn.textContent = busy ? 'Working…' : 'Grab';
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();

  const url = urlInput.value.trim();
  if (!url) return;

  destroyPlayer?.();
  destroyPlayer = null;
  resultEl.hidden = true;
  resultEl.innerHTML = '';
  setBusy(true);
  showStatus('Identifying link');

  const payload = {
    url,
    format: formatSelect.value,
    startTime: startInput.value.trim() || null,
    endTime: endInput.value.trim() || null,
    stereo: document.getElementById('stereo').checked,
  };

  try {
    const probeRes = await fetch('/api/probe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const probeData = await probeRes.json();

    if (!probeRes.ok) throw Object.assign(new Error(probeData.error || 'Could not read that link.'), { soft: probeData.soft });

    const bestEffort = probeData.service?.tier === 'bestEffort';
    showStatus(
      bestEffort
        ? `Found: ${probeData.media.title} · ${probeData.service.label} is best-effort — may fail`
        : `Found: ${probeData.media.title}`
    );

    const extractRes = await fetch('/api/extract', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const extractData = await extractRes.json();

    if (!extractRes.ok) throw Object.assign(new Error(extractData.error || 'Could not start extraction.'), { soft: extractData.soft });

    pollJob(extractData.jobId, probeData);
  } catch (err) {
    showStatus(err.message, { error: true, soft: err.soft });
    setBusy(false);
  }
});

// Populate the supported-services line from the server.
fetch('/api/health')
  .then((r) => r.json())
  .then((health) => {
    const names = health.providers
      .map((p) => (p.tier === 'bestEffort' ? `${p.label}*` : p.label))
      .join(' · ');
    const hasBestEffort = health.providers.some((p) => p.tier === 'bestEffort');
    providersEl.textContent =
      `${names} — plus ~1000 more sites via yt-dlp.` +
      (hasBestEffort ? '  * best-effort, may fail.' : '');
    if (!health.ok) {
      showStatus(`yt-dlp unavailable: ${health.ytdlp.error}`, { error: true });
    }
  })
  .catch(() => {});
