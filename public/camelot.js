/**
 * Camelot wheel — the DJ's harmonic-mixing map, drawn as SVG.
 *
 * The outer ring is B (major), the inner ring is A (minor); 12 "hours" around.
 * The detected/target key is lit brightest; its harmonically-compatible
 * neighbours (same key, ±1 hour same ring, and the relative major/minor across
 * the ring) are lit dimly. Clicking any segment asks the shifter to move the
 * track to that key — turning the wheel into a one-click "mix into" control.
 */

const CX = 100;
const CY = 100;
const R_OUTER = 92;
const R_MID = 62;
const R_INNER = 34;

function polar(r, deg) {
  const a = ((deg - 90) * Math.PI) / 180; // 0° at 12 o'clock, clockwise
  return [CX + r * Math.cos(a), CY + r * Math.sin(a)];
}

/** Annular sector path between two radii and two angles (degrees). */
function sector(r0, r1, a0, a1) {
  const [x0, y0] = polar(r1, a0);
  const [x1, y1] = polar(r1, a1);
  const [x2, y2] = polar(r0, a1);
  const [x3, y3] = polar(r0, a0);
  const large = a1 - a0 > 180 ? 1 : 0;
  return `M${x0} ${y0} A${r1} ${r1} 0 ${large} 1 ${x1} ${y1} L${x2} ${y2} A${r0} ${r0} 0 ${large} 0 ${x3} ${y3} Z`;
}

/** Parse "11A" → { num: 11, letter: 'A' }, or null. */
function parseCode(code) {
  const m = String(code || '').trim().toUpperCase().match(/^(\d{1,2})([AB])$/);
  if (!m) return null;
  const num = Number(m[1]);
  if (num < 1 || num > 12) return null;
  return { num, letter: m[2] };
}

const wrap = (n) => ((n - 1 + 12) % 12) + 1;

/** The set of Camelot codes that mix harmonically with `code`. */
export function compatibleCodes(code) {
  const c = parseCode(code);
  if (!c) return new Set();
  const other = c.letter === 'A' ? 'B' : 'A';
  return new Set([
    `${c.num}${c.letter}`,
    `${wrap(c.num - 1)}${c.letter}`,
    `${wrap(c.num + 1)}${c.letter}`,
    `${c.num}${other}`,
  ]);
}

/**
 * Render/refresh the wheel into `container`. `onSelect(code)` fires when a
 * segment is clicked. Re-call with a new `activeCode` to move the highlight.
 */
export function renderCamelot(container, activeCode, { onSelect } = {}) {
  const compatible = compatibleCodes(activeCode);
  const active = parseCode(activeCode);
  const activeStr = active ? `${active.num}${active.letter}` : null;

  const segs = [];
  const labels = [];
  for (let num = 1; num <= 12; num++) {
    const a0 = (num - 1) * 30 - 15;
    const a1 = a0 + 30;
    for (const [letter, r0, r1, rLabel] of [
      ['B', R_MID, R_OUTER, (R_MID + R_OUTER) / 2],
      ['A', R_INNER, R_MID, (R_INNER + R_MID) / 2],
    ]) {
      const code = `${num}${letter}`;
      const cls =
        code === activeStr ? 'cam-seg active' : compatible.has(code) ? 'cam-seg compat' : 'cam-seg';
      segs.push(`<path class="${cls}" data-code="${code}" d="${sector(r0, r1, a0, a1)}"></path>`);
      const [lx, ly] = polar(rLabel, (a0 + a1) / 2);
      labels.push(
        `<text class="cam-label ${code === activeStr ? 'on' : ''}" x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" dy="0.32em" text-anchor="middle">${code}</text>`
      );
    }
  }

  container.innerHTML = `
    <svg class="camelot" viewBox="0 0 200 200" role="img" aria-label="Camelot wheel">
      ${segs.join('')}
      ${labels.join('')}
    </svg>
  `;

  if (onSelect) {
    container.querySelectorAll('.cam-seg').forEach((el) => {
      el.addEventListener('click', () => onSelect(el.dataset.code));
    });
  }
}
