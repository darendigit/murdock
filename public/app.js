import { createPlayer } from '/player.js';
import { NOTE_NAMES, shiftedKey, camelotToKey } from '/key.js';
import { renderCamelot } from '/camelot.js';

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
let player = null;
let features = {};
let isLocal = false;

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
  const tools = isLocal; // power-mode sampling toolkit; hosted keeps the plain card

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
    ${tools ? `<p class="clip-hint">drag across the waveform to pick a clip</p>` : ''}
    <div class="keybar">
      <span class="key-detected" id="key-detected">detecting key…</span>
      ${tools ? `<span class="bpm-detected" id="bpm-detected">· detecting tempo…</span>
      <button type="button" class="wheel-toggle" id="wheel-toggle" aria-expanded="false">◒ Camelot wheel</button>` : `
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
      </div>`}
    </div>
    ${tools ? `
    <div class="camelot-panel" id="camelot-panel" hidden></div>
    <div class="tools">
      <div class="tool-group" id="clip-group" hidden>
        <span class="tool-label">Clip</span>
        <span class="clip-range" id="clip-range"></span>
        <label class="mini-toggle"><input type="checkbox" id="loop-toggle" /> loop</label>
        <button type="button" class="tool-btn" id="clip-btn">Save clip</button>
      </div>
      <div class="tool-group">
        <span class="tool-label">Key</span>
        <select id="shift-target" title="Shift to key" disabled><option value="">to…</option></select>
        <span class="shift-steppers">
          <button type="button" class="stepper" data-step="-1" aria-label="down a semitone">−</button>
          <span class="shift-amount" id="shift-amount">0</span>
          <button type="button" class="stepper" data-step="1" aria-label="up a semitone">+</button>
        </span>
        <button type="button" class="tool-btn" id="shift-btn" disabled>Shift</button>
      </div>
      <div class="tool-group">
        <span class="tool-label">Tempo</span>
        <span class="shift-steppers">
          <button type="button" class="stepper" data-tempo="-1" aria-label="slower">−</button>
          <input id="tempo-target" class="tempo-input" type="number" inputmode="numeric" disabled />
          <button type="button" class="stepper" data-tempo="1" aria-label="faster">+</button>
        </span>
        <span class="tool-unit">bpm</span>
        <button type="button" class="tool-btn" id="tempo-btn" disabled>Change</button>
      </div>
      <div class="tool-group">
        <button type="button" class="tool-btn" id="normalize-btn">Normalize</button>
        ${features.stems ? `
        <span class="tool-label">Stems</span>
        <select id="stems-mode" class="stems-mode" title="How to split">
          <option value="two">vocals + instrumental</option>
          <option value="full">4 stems (vox/drums/bass/other)</option>
        </select>
        <button type="button" class="tool-btn" id="stems-btn">Split</button>` : ''}
      </div>
    </div>
    <div class="stems-slot" id="stems-slot" hidden></div>` : ''}
    <div class="download-bar">
      <span class="file-info" id="file-info">
        ${escapeHtml(job.filename)} · ${formatBytes(job.sizeBytes)}
        <span class="expiry" data-expires="${job.expiresAt || ''}"></span>
      </span>
      <a class="download-btn" href="${job.downloadUrl}" download>Download</a>
    </div>
  `;

  startExpiryCountdown(resultEl.querySelector('.expiry'));
  wireResult(job);
}

/**
 * Wire the result card. In local power mode this is a small state machine: every
 * transform (clip / shift / tempo / normalize / stems) runs on the *current*
 * file and the result becomes the new current file, so operations compound
 * (grab → clip → shift → normalize). After each swap the player re-decodes the
 * new audio and re-detects key + BPM, so the readouts always match what you'll
 * download. On hosted (tools off) it's just the original key + shift controls.
 */
function wireResult(job) {
  const tools = isLocal;
  const state = {
    filename: job.filename,
    streamUrl: job.streamUrl,
    downloadUrl: job.downloadUrl,
    key: null,
    bpm: null,
    semitones: 0,
    region: null,
    tagged: null,
  };

  const keyEl = resultEl.querySelector('#key-detected');
  const bpmEl = resultEl.querySelector('#bpm-detected');
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
  const renderKeyLine = () => {
    if (!state.key) {
      keyEl.textContent = 'key not detected';
      return;
    }
    const preview = keyEl.dataset.preview ? `  ${keyEl.dataset.preview}` : '';
    keyEl.textContent = `Key: ${state.key.label} · ${state.key.camelot}${preview}`;
  };
  const setSemitones = (n) => {
    state.semitones = Math.max(-12, Math.min(12, n));
    amountEl.textContent = fmtAmount(state.semitones);
    shiftBtn.disabled = state.semitones === 0;
    if (state.key && state.semitones !== 0) {
      const to = shiftedKey(state.key, state.semitones);
      if (to) keyEl.dataset.preview = `→ ${to.label} · ${to.camelot}`;
    } else {
      delete keyEl.dataset.preview;
    }
    renderKeyLine();
  };

  targetSel.addEventListener('change', () => {
    if (!state.key || !targetSel.value) return;
    const from = NOTE_NAMES.indexOf(state.key.tonic);
    const to = NOTE_NAMES.indexOf(targetSel.value);
    let d = (to - from) % 12;
    if (d > 6) d -= 12;
    if (d < -6) d += 12;
    setSemitones(d);
  });
  resultEl.querySelectorAll('.stepper[data-step]').forEach((btn) => {
    btn.addEventListener('click', () => {
      targetSel.value = '';
      setSemitones(state.semitones + Number(btn.dataset.step));
    });
  });
  shiftBtn.addEventListener('click', () => {
    if (!state.semitones) return;
    runTool(shiftBtn, 'Shifting', '/api/shift', { filename: state.filename, semitones: state.semitones });
  });

  // ---- local-only tools ----
  let wheelPanel, tempoInput, tempoBtn, clipGroup, clipRange, clipBtn, loopToggle, normalizeBtn, stemsBtn;
  let tempoTouched = false;

  if (tools) {
    wheelPanel = resultEl.querySelector('#camelot-panel');
    const wheelToggle = resultEl.querySelector('#wheel-toggle');
    tempoInput = resultEl.querySelector('#tempo-target');
    tempoBtn = resultEl.querySelector('#tempo-btn');
    clipGroup = resultEl.querySelector('#clip-group');
    clipRange = resultEl.querySelector('#clip-range');
    clipBtn = resultEl.querySelector('#clip-btn');
    loopToggle = resultEl.querySelector('#loop-toggle');
    normalizeBtn = resultEl.querySelector('#normalize-btn');
    stemsBtn = resultEl.querySelector('#stems-btn');

    wheelToggle.addEventListener('click', () => {
      const show = wheelPanel.hidden;
      wheelPanel.hidden = !show;
      wheelToggle.setAttribute('aria-expanded', String(show));
      if (show) updateWheel();
    });

    const setTempoTarget = (v) => {
      const n = Math.max(20, Math.min(300, Math.round(v)));
      tempoInput.value = n;
      tempoBtn.disabled = !state.bpm || n === state.bpm.bpm;
    };
    resultEl.querySelectorAll('.stepper[data-tempo]').forEach((btn) => {
      btn.addEventListener('click', () => {
        tempoTouched = true;
        setTempoTarget(Number(tempoInput.value || 0) + Number(btn.dataset.tempo));
      });
    });
    tempoInput.addEventListener('input', () => {
      tempoTouched = true;
      tempoBtn.disabled = !state.bpm || Number(tempoInput.value) === state.bpm.bpm;
    });
    tempoBtn.addEventListener('click', () => {
      if (!state.bpm) return;
      const target = Number(tempoInput.value);
      if (!target || target === state.bpm.bpm) return;
      runTool(tempoBtn, 'Retiming', '/api/tempo', {
        filename: state.filename,
        ratio: target / state.bpm.bpm,
        label: `${target}bpm`,
      });
    });

    clipBtn.addEventListener('click', () => {
      if (!state.region) return;
      runTool(clipBtn, 'Trimming', '/api/clip', {
        filename: state.filename,
        start: state.region.start,
        end: state.region.end,
      });
    });
    loopToggle.addEventListener('change', () => player?.setLoop(loopToggle.checked));

    normalizeBtn.addEventListener('click', () =>
      runTool(normalizeBtn, 'Normalizing', '/api/normalize', { filename: state.filename })
    );

    if (stemsBtn && typeof runStems === 'function') {
      stemsBtn.addEventListener('click', () => runStems(stemsBtn, state));
    }
  }

  function updateWheel() {
    if (!tools || !wheelPanel || wheelPanel.hidden || !state.key) return;
    renderCamelot(wheelPanel, state.key.camelot, {
      onSelect: (code) => {
        const target = camelotToKey(code);
        if (!target || !state.key) return;
        const from = NOTE_NAMES.indexOf(state.key.tonic);
        const to = NOTE_NAMES.indexOf(target.tonic);
        let d = (to - from) % 12;
        if (d > 6) d -= 12;
        if (d < -6) d += 12;
        if (d === 0) return;
        targetSel.value = '';
        setSemitones(d);
        shiftBtn.click();
      },
    });
  }

  function renderClip() {
    if (!tools) return;
    if (state.region) {
      clipGroup.hidden = false;
      clipRange.textContent = `${formatDuration(Math.floor(state.region.start))}–${formatDuration(Math.floor(state.region.end))}`;
      clipBtn.disabled = false;
    } else {
      clipGroup.hidden = true;
    }
  }

  // Auto-write detected key + BPM into the file's metadata (once per file).
  function maybeTag() {
    if (!features.tag || !state.key || !state.bpm) return;
    if (state.tagged === state.filename) return;
    state.tagged = state.filename;
    const body = {
      filename: state.filename,
      keyLabel: state.key.label,
      camelot: state.key.camelot,
      bpm: state.bpm.bpm,
    };
    setTimeout(() => {
      fetch('/api/tag', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }).catch(() => {});
    }, 1500);
  }

  function loadPlayer() {
    player?.destroy();
    player = createPlayer(resultEl.querySelector('.player-slot'), {
      streamUrl: state.streamUrl,
      format: state.filename.split('.').pop(),
      selectable: tools,
      onKeyDetected: (k) => {
        state.key = k;
        delete keyEl.dataset.preview;
        setSemitones(0);
        targetSel.disabled = false;
        renderKeyLine();
        updateWheel();
        maybeTag();
      },
      onBpmDetected: tools
        ? (b) => {
            state.bpm = b;
            bpmEl.textContent = `· ${b.bpm} BPM`;
            if (tempoInput) {
              tempoInput.disabled = false;
              if (!tempoTouched) tempoInput.value = b.bpm;
              tempoBtn.disabled = true;
            }
            maybeTag();
          }
        : undefined,
      onRegionChange: tools
        ? (r) => {
            state.region = r;
            renderClip();
          }
        : undefined,
    });
    if (tools && loopToggle) player.setLoop(loopToggle.checked);
  }

  function swapTo(data) {
    state.filename = data.filename;
    state.streamUrl = data.streamUrl;
    state.downloadUrl = data.downloadUrl;
    state.region = null;
    state.tagged = null;
    tempoTouched = false;
    setSemitones(0);
    if (tools && loopToggle) loopToggle.checked = false;
    renderClip();
    const dl = resultEl.querySelector('.download-btn');
    dl.href = data.downloadUrl;
    resultEl.querySelector('#file-info').innerHTML =
      `${escapeHtml(data.filename)} · ${formatBytes(data.sizeBytes)} ` +
      `<span class="expiry" data-expires="${data.expiresAt || ''}"></span>`;
    startExpiryCountdown(resultEl.querySelector('.expiry'));
    loadPlayer();
  }

  /**
   * Generic transform runner: POST an endpoint that returns a jobId, poll it to
   * completion showing live progress on the button, then swap to the result.
   */
  async function runTool(btn, workingText, endpoint, body) {
    const original = btn.textContent;
    btn.disabled = true;
    const started = Date.now();
    btn.textContent = `${workingText}… 0s`;
    const ticker = setInterval(() => {
      btn.textContent = `${workingText}… ${Math.round((Date.now() - started) / 1000)}s`;
    }, 1000);

    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const kickoff = await res.json();
      if (!res.ok) throw new Error(kickoff.error || `${workingText} failed.`);

      const data = await pollJobDone(kickoff.jobId, (j) => {
        if (j.progress != null && j.progress > 0 && j.progress < 100) {
          btn.textContent = `${workingText}… ${Math.round(j.progress)}%`;
        }
      });
      clearInterval(ticker);
      swapTo(data);
      btn.textContent = 'Done ✓';
      setTimeout(() => {
        btn.textContent = original;
        btn.disabled = false;
      }, 1400);
    } catch (err) {
      clearInterval(ticker);
      btn.textContent = original;
      btn.disabled = false;
      showStatus(err.message, { error: true });
    }
  }

  loadPlayer();
}

/** Poll a job to done/error. Calls onTick(job) each poll; resolves the done job. */
function pollJobDone(jobId, onTick) {
  return new Promise((resolve, reject) => {
    const poll = setInterval(async () => {
      try {
        const r = await fetch(`/api/job/${jobId}`);
        const j = await r.json();
        onTick?.(j);
        if (j.status === 'done') {
          clearInterval(poll);
          resolve(j);
        } else if (j.status === 'error') {
          clearInterval(poll);
          reject(new Error(j.error || 'Job failed.'));
        }
      } catch {
        clearInterval(poll);
        reject(new Error('Lost connection.'));
      }
    }, 700);
  });
}

/** Split the current file into stems (Demucs) and render playable stem rows. */
async function runStems(btn, state) {
  const slot = document.getElementById('stems-slot');
  const mode = document.getElementById('stems-mode')?.value || 'two';
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Splitting… 0%';
  try {
    const res = await fetch('/api/stems', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: state.filename, mode }),
    });
    const kickoff = await res.json();
    if (!res.ok) throw new Error(kickoff.error || 'Stem split failed.');

    const data = await pollJobDone(kickoff.jobId, (j) => {
      if (j.progress != null) btn.textContent = `Splitting… ${Math.round(j.progress)}%`;
    });

    renderStems(slot, data.stems || []);
    btn.textContent = 'Split again';
    btn.disabled = false;
  } catch (err) {
    btn.textContent = original;
    btn.disabled = false;
    showStatus(err.message, { error: true });
  }
}

function renderStems(slot, stems) {
  if (!stems.length) {
    slot.hidden = true;
    return;
  }
  slot.hidden = false;
  slot.innerHTML =
    `<div class="stems-head">Stems</div>` +
    stems
      .map(
        (s) => `
        <div class="stem-row">
          <span class="stem-name">${escapeHtml(s.stem)}</span>
          <audio class="stem-audio" controls preload="none" src="${s.streamUrl}"></audio>
          <a class="stem-dl" href="${s.downloadUrl}" download>↓ ${formatBytes(s.sizeBytes)}</a>
        </div>`
      )
      .join('');
}

/** Open the local library view: a searchable list of everything grabbed. */
async function openLibrary() {
  player?.destroy();
  player = null;
  resultEl.hidden = true;
  resultEl.innerHTML = '';
  setBusy(false);
  showStatus('Loading library');

  try {
    const res = await fetch('/api/library');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not load library.');
    clearStatus();
    renderLibrary(data);
  } catch (err) {
    showStatus(err.message, { error: true });
  }
}

function renderLibrary(data) {
  const items = data.items || [];
  resultEl.hidden = false;
  resultEl.innerHTML = `
    <div class="lib-head">
      <span>Library · ${data.total} file${data.total === 1 ? '' : 's'}</span>
      <span class="lib-actions">
        <input id="lib-search" class="lib-search" type="search" placeholder="filter…" spellcheck="false" />
        ${features.reveal ? `<button type="button" class="wheel-toggle" id="lib-reveal">Reveal folder</button>` : ''}
      </span>
    </div>
    <ul class="lib-list" id="lib-list">
      ${items.map((it, i) => libraryRow(it, i)).join('') || '<li class="lib-empty">Nothing grabbed yet.</li>'}
    </ul>
  `;

  const listEl = resultEl.querySelector('#lib-list');
  listEl.querySelectorAll('.lib-open').forEach((btn) => {
    btn.addEventListener('click', () => openLibraryItem(items[Number(btn.dataset.i)]));
  });
  listEl.querySelectorAll('.lib-reveal-one').forEach((btn) => {
    btn.addEventListener('click', () => reveal(items[Number(btn.dataset.i)].name));
  });
  resultEl.querySelector('#lib-reveal')?.addEventListener('click', () => reveal());

  const search = resultEl.querySelector('#lib-search');
  search.addEventListener('input', () => {
    const q = search.value.toLowerCase();
    listEl.querySelectorAll('li[data-name]').forEach((li) => {
      li.style.display = li.dataset.name.includes(q) ? '' : 'none';
    });
  });
}

function libraryRow(it, i) {
  const bits = [
    it.key ? escapeHtml(it.key) : null,
    it.bpm ? `${it.bpm} BPM` : null,
    it.durationSeconds ? formatDuration(it.durationSeconds) : null,
    formatBytes(it.sizeBytes),
  ].filter(Boolean);
  return `
    <li data-name="${escapeHtml(it.name.toLowerCase())}">
      <div class="lib-info">
        <span class="lib-name">${escapeHtml(it.name)}</span>
        <span class="lib-meta">${bits.join('  ·  ')}</span>
      </div>
      <div class="lib-row-actions">
        <button type="button" class="lib-open" data-i="${i}">Open</button>
        <a class="lib-dl" href="${it.downloadUrl}" download>↓</a>
        ${features.reveal ? `<button type="button" class="lib-reveal-one" data-i="${i}" title="Reveal in Finder">⤷</button>` : ''}
      </div>
    </li>`;
}

/** Load a library file into the full result card (all tools apply). */
function openLibraryItem(it) {
  resultEl.hidden = true;
  resultEl.innerHTML = '';
  const probeData = {
    service: { label: 'Library' },
    media: { title: it.name, uploader: null, durationSeconds: it.durationSeconds, thumbnail: null },
  };
  const job = {
    filename: it.name,
    sizeBytes: it.sizeBytes,
    downloadUrl: it.downloadUrl,
    streamUrl: it.streamUrl,
  };
  renderResult(probeData, job);
}

function reveal(filename) {
  fetch('/api/reveal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(filename ? { filename } : {}),
  }).catch(() => {});
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

/** A link if it has a scheme or a dotted host; otherwise a free-text query. */
function looksLikeUrl(text) {
  const t = String(text || '').trim();
  if (!t || /\s/.test(t)) return false;
  if (/^https?:\/\//i.test(t)) return true;
  return /^[\w-]+(\.[\w-]+)+(\/|$|\?|#|:)/.test(t);
}

/** Mirrors server isPlaylistUrl — a collection link, not a single item. */
function isPlaylistUrl(text) {
  const u = String(text || '');
  if (/open\.spotify\.com\/(?:intl-[\w-]+\/)?(?:playlist|album)\//.test(u)) return true;
  if (/music\.apple\.com\/.+\/playlist\//.test(u)) return true;
  if (/youtube\.com\/playlist\?/.test(u)) return true;
  if (/[?&]list=/.test(u) && !/[?&]v=/.test(u)) return true;
  return false;
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();

  const input = urlInput.value.trim();
  if (!input) return;

  // Playlist/album → bulk ZIP. Free text (no link) → search picker. Otherwise a
  // single link → grab it. The extra branches are power-mode only.
  if (features.playlist && isPlaylistUrl(input)) {
    runPlaylist(input);
  } else if (features.search && !looksLikeUrl(input)) {
    runSearch(input);
  } else {
    startGrab(input);
  }
});

/** Enumerate a playlist, show a confirmation card, then bulk-grab to a ZIP. */
async function runPlaylist(url) {
  player?.destroy();
  player = null;
  resultEl.hidden = true;
  resultEl.innerHTML = '';
  setBusy(true);
  showStatus('Reading playlist');

  try {
    const res = await fetch('/api/playlist/enumerate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not read that playlist.');

    clearStatus();
    setBusy(false);
    renderPlaylistCard(url, data);
  } catch (err) {
    showStatus(err.message, { error: true });
    setBusy(false);
  }
}

function renderPlaylistCard(url, data) {
  resultEl.hidden = false;
  resultEl.innerHTML = `
    <div class="pl-head">
      <div>
        <div class="badge">${escapeHtml(data.service || 'Playlist')}</div>
        <h2>${escapeHtml(data.title)}</h2>
        <p class="sub">${data.count} track${data.count === 1 ? '' : 's'} · grabs to a single ZIP (${escapeHtml((formatSelect.value || 'flac').toUpperCase())})</p>
      </div>
      <button type="button" class="tool-btn" id="pl-grab">Grab all → ZIP</button>
    </div>
    <ol class="pl-list">
      ${data.entries.map((e) => `<li>${escapeHtml(e.title)}</li>`).join('')}
      ${data.count > data.entries.length ? `<li class="pl-more">…and ${data.count - data.entries.length} more</li>` : ''}
    </ol>
    <div class="pl-status" id="pl-status" hidden></div>
    <div class="download-bar" id="pl-download" hidden>
      <span class="file-info" id="pl-file-info"></span>
      <a class="download-btn" id="pl-download-link" href="#" download>Download ZIP</a>
    </div>
  `;

  resultEl.querySelector('#pl-grab').addEventListener('click', () => runPlaylistGrab(url));
}

async function runPlaylistGrab(url) {
  const btn = resultEl.querySelector('#pl-grab');
  const statusEl2 = resultEl.querySelector('#pl-status');
  btn.disabled = true;
  statusEl2.hidden = false;

  try {
    const res = await fetch('/api/playlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, format: formatSelect.value, stereo: document.getElementById('stereo').checked }),
    });
    const kickoff = await res.json();
    if (!res.ok) throw new Error(kickoff.error || 'Bulk grab failed.');

    const data = await pollJobDone(kickoff.jobId, (j) => {
      statusEl2.innerHTML = `
        <div class="status-line"><span class="spinner"></span><span>${escapeHtml(j.stage || 'Working')}</span></div>
        <div class="bar"><div class="bar-fill" style="width:${j.progress ?? 0}%"></div></div>`;
    });

    btn.textContent = 'Done ✓';
    const failedNote = data.failedTracks?.length ? ` · ${data.failedTracks.length} failed` : '';
    statusEl2.innerHTML = `<div class="status-line"><span>✓</span><span>Zipped ${data.count} track${data.count === 1 ? '' : 's'}${failedNote}</span></div>`;

    const dl = resultEl.querySelector('#pl-download');
    dl.hidden = false;
    resultEl.querySelector('#pl-file-info').textContent = `${data.filename} · ${formatBytes(data.sizeBytes)}`;
    resultEl.querySelector('#pl-download-link').href = data.downloadUrl;
  } catch (err) {
    btn.disabled = false;
    statusEl2.innerHTML = `<div class="status-line error"><span>✕</span><span>${escapeHtml(err.message)}</span></div>`;
  }
}

/** Search YouTube by name and render a picker; choosing a result grabs it. */
async function runSearch(query) {
  player?.destroy();
  player = null;
  resultEl.hidden = true;
  resultEl.innerHTML = '';
  setBusy(true);
  showStatus(`Searching for “${query}”`);

  try {
    const res = await fetch('/api/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Search failed.');

    clearStatus();
    setBusy(false);
    renderSearchResults(data.results, query);
  } catch (err) {
    showStatus(err.message, { error: true });
    setBusy(false);
  }
}

function renderSearchResults(results, query) {
  resultEl.hidden = false;
  resultEl.innerHTML = `
    <div class="search-head">
      <span>Results for “${escapeHtml(query)}”</span>
      <span class="search-hint">pick one to grab</span>
    </div>
    <ul class="search-list">
      ${results.map((r, i) => `
        <li>
          <button type="button" class="search-item" data-i="${i}">
            ${r.thumbnail ? `<img src="${escapeHtml(r.thumbnail)}" alt="" onerror="this.remove()" />` : '<span class="search-thumb-blank"></span>'}
            <span class="search-item-text">
              <span class="search-item-title">${escapeHtml(r.title)}</span>
              <span class="search-item-sub">${escapeHtml([r.uploader, formatDuration(r.durationSeconds)].filter(Boolean).join('  ·  '))}</span>
            </span>
          </button>
        </li>
      `).join('')}
    </ul>
  `;

  resultEl.querySelectorAll('.search-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      const chosen = results[Number(btn.dataset.i)];
      resultEl.hidden = true;
      resultEl.innerHTML = '';
      startGrab(chosen.webpageUrl);
    });
  });
}

/** Probe a link, then extract it, then poll to completion. */
async function startGrab(url) {
  player?.destroy();
  player = null;
  resultEl.hidden = true;
  resultEl.innerHTML = '';
  setBusy(true);
  showStatus('Identifying link');

  const payload = {
    url,
    format: formatSelect.value,
    startTime: startInput?.value.trim() || null,
    endTime: endInput?.value.trim() || null,
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
}

// Populate the supported-services line from the server, and pick up power-mode
// features so the UI adapts (search box, default format) without hardcoding.
fetch('/api/health')
  .then((r) => r.json())
  .then((health) => {
    features = health.features || {};
    isLocal = Boolean(health.local);

    // Local default: FLAC (lossless). Hosted stays on its own default.
    if (features.defaultFormat && [...formatSelect.options].some((o) => o.value === features.defaultFormat)) {
      formatSelect.value = features.defaultFormat;
    }

    // With search on, the one box takes a name or a link.
    if (features.search) {
      urlInput.placeholder = 'paste a link — or type a song name';
    }

    // In power mode, clipping is done visually on the waveform after the grab,
    // so the up-front Start/End timecode fields are redundant — hide them.
    if (features.tools) {
      const sf = startInput?.closest('.field');
      const ef = endInput?.closest('.field');
      if (sf) sf.style.display = 'none';
      if (ef) ef.style.display = 'none';
    }

    // Library button in the masthead (the persistent local sample archive).
    if (features.library) {
      const header = document.querySelector('.masthead');
      if (header && !header.querySelector('.lib-toggle')) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'lib-toggle';
        btn.textContent = 'library';
        btn.addEventListener('click', openLibrary);
        header.appendChild(btn);
      }
    }

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
