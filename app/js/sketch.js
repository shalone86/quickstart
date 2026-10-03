// Full-screen sketch pad: pen (pressure), highlighter, eraser, lines, arrows, boxes, circles.
// Strokes are kept as vectors so a sketch can be re-opened and edited; a PNG goes into the note.

import { icon } from './icons.js';
import { h } from './ui.js';
import { esc } from './util.js';

const COLORS = ['#1d1d1f', '#e03131', '#f08c00', '#2f9e44', '#1971c2', '#7048e8', '#ffffff'];
const WIDTHS = [2, 4, 8];
const PAGE_W = 1400;

/** Opens the sketch pad. Resolves { png: Blob, vector } or null if cancelled. */
export function openSketch(vector = null) {
  return new Promise((resolve) => {
    const data = vector ? structuredClone(vector) : { w: PAGE_W, h: 1000, bg: 'grid', strokes: [] };
    const state = { tool: 'pen', color: COLORS[0], width: 4, redo: [] };
    const el = h(`<div class="sketch-pad" role="dialog" aria-label="Sketch">
      <header class="sketch-bar">
        <button class="btn ghost" data-a="cancel">Cancel</button>
        <div class="sketch-history">
          <button class="icon-btn" data-a="undo" title="Undo" aria-label="Undo">${icon('undo-2')}</button>
          <button class="icon-btn" data-a="redo" title="Redo" aria-label="Redo">${icon('redo-2')}</button>
          <button class="icon-btn" data-a="bg" title="Paper: grid, dots, blank, lines" aria-label="Change paper">${icon('grid-3x3')}</button>
          <button class="icon-btn" data-a="clear" title="Clear" aria-label="Clear">${icon('trash-2')}</button>
        </div>
        <button class="btn primary" data-a="done">Done</button>
      </header>
      <div class="sketch-tools">
        ${tool('pen', 'pen-tool', 'Pen')}${tool('marker', 'highlighter', 'Highlighter')}${tool('eraser', 'eraser', 'Eraser')}
        <span class="sep"></span>
        ${tool('line', 'minus', 'Line')}${tool('arrow', 'move-up-right', 'Arrow')}${tool('rect', 'square', 'Box')}${tool('ellipse', 'circle', 'Circle')}
      </div>
      <div class="sketch-sub">
        <div class="swatches">${COLORS.map((c) => `<button class="swatch" data-color="${c}" style="--c:${c}" aria-label="Color ${c}"></button>`).join('')}</div>
        <div class="widths">${WIDTHS.map((w) => `<button class="wbtn" data-width="${w}" aria-label="Width ${w}"><span style="--w:${w * 1.5}px"></span></button>`).join('')}</div>
      </div>
      <div class="sketch-scroll"><canvas class="sketch-canvas"></canvas><button class="btn ghost more-space" data-a="more">${icon('plus')} More space</button></div>
    </div>`);
    document.body.appendChild(el);
    document.body.classList.add('no-scroll');
    const canvas = el.querySelector('canvas');
    const ctx = canvas.getContext('2d');
    const scroller = el.querySelector('.sketch-scroll');
    let scale = 1;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    const layout = () => {
      const avail = scroller.clientWidth - 16;
      scale = Math.min(1, avail / data.w);
      canvas.style.width = `${data.w * scale}px`;
      canvas.style.height = `${data.h * scale}px`;
      canvas.width = Math.round(data.w * scale * dpr);
      canvas.height = Math.round(data.h * scale * dpr);
      redraw();
    };

    function redraw(preview) {
      ctx.setTransform(dpr * scale, 0, 0, dpr * scale, 0, 0);
      paintBackground(ctx, data);
      for (const s of data.strokes) drawStroke(ctx, s);
      if (preview) drawStroke(ctx, preview);
    }

    const syncUI = () => {
      el.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('on', b.dataset.tool === state.tool));
      el.querySelectorAll('.swatch').forEach((b) => b.classList.toggle('on', b.dataset.color === state.color));
      el.querySelectorAll('.wbtn').forEach((b) => b.classList.toggle('on', +b.dataset.width === state.width));
    };

    // ---- drawing ----
    let current = null;
    const pt = (e) => {
      const r = canvas.getBoundingClientRect();
      const p = e.pressure && e.pointerType === 'pen' ? e.pressure : 0.5;
      return [Math.round(((e.clientX - r.left) / scale) * 10) / 10, Math.round(((e.clientY - r.top) / scale) * 10) / 10, Math.round(p * 100) / 100];
    };
    canvas.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'touch' && e.isPrimary === false) return;
      canvas.setPointerCapture(e.pointerId);
      const p = pt(e);
      if (state.tool === 'eraser') { current = { tool: 'eraser' }; eraseAt(p); return; }
      current = { tool: state.tool, color: state.color, width: state.tool === 'marker' ? state.width * 4 : state.width, points: [p] };
      if (['line', 'arrow', 'rect', 'ellipse'].includes(state.tool)) current.points.push(p);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!current) return;
      const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
      if (current.tool === 'eraser') { evs.forEach((ev) => eraseAt(pt(ev))); return; }
      if (current.points.length >= 2 && ['line', 'arrow', 'rect', 'ellipse'].includes(current.tool)) current.points[1] = pt(e);
      else evs.forEach((ev) => current.points.push(pt(ev)));
      redraw(current);
    });
    const end = () => {
      if (!current) return;
      if (current.tool !== 'eraser' && current.points.length) { data.strokes.push(current); state.redo = []; }
      current = null;
      redraw();
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    canvas.style.touchAction = 'none';

    function eraseAt([x, y]) {
      const r = 12;
      const before = data.strokes.length;
      data.strokes = data.strokes.filter((s) => !s.points.some(([px, py], i) => {
        if (Math.hypot(px - x, py - y) < r + s.width) return true;
        const q = s.points[i + 1];
        return q && distToSeg(x, y, px, py, q[0], q[1]) < r;
      }));
      if (data.strokes.length !== before) { state.redo = []; redraw(); }
    }

    // ---- toolbar ----
    el.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.tool) { state.tool = b.dataset.tool; if (state.tool === 'marker' && state.color === COLORS[0]) state.color = '#fcc419'; }
      if (b.dataset.color) state.color = b.dataset.color;
      if (b.dataset.width) state.width = +b.dataset.width;
      const a = b.dataset.a;
      if (a === 'undo' && data.strokes.length) { state.redo.push(data.strokes.pop()); redraw(); }
      if (a === 'redo' && state.redo.length) { data.strokes.push(state.redo.pop()); redraw(); }
      if (a === 'clear' && data.strokes.length && confirm('Clear the whole sketch?')) { data.strokes = []; redraw(); }
      if (a === 'bg') { data.bg = { grid: 'dots', dots: 'blank', blank: 'lines', lines: 'grid' }[data.bg] || 'grid'; redraw(); }
      if (a === 'more') { data.h += 600; layout(); scroller.scrollTop = scroller.scrollHeight; }
      if (a === 'cancel') {
        if (!data.strokes.length || JSON.stringify(data.strokes) === JSON.stringify(vector?.strokes || []) || confirm('Discard this sketch?')) close(null);
      }
      if (a === 'done') {
        if (!data.strokes.length) { close(null); return; }
        renderPNG(data).then((png) => close({ png, vector: data }));
      }
      syncUI();
    });

    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'z') { e.preventDefault(); el.querySelector(`[data-a="${e.shiftKey ? 'redo' : 'undo'}"]`).click(); }
    };
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', layout);

    function close(result) {
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', layout);
      document.body.classList.remove('no-scroll');
      el.remove();
      resolve(result);
    }

    syncUI();
    requestAnimationFrame(layout);
  });
}

function tool(id, ic, label) {
  return `<button class="icon-btn" data-tool="${id}" title="${esc(label)}" aria-label="${esc(label)}">${icon(ic)}</button>`;
}

function paintBackground(ctx, data) {
  ctx.fillStyle = '#fffdf8';
  ctx.fillRect(0, 0, data.w, data.h);
  ctx.save();
  if (data.bg === 'grid' || data.bg === 'lines') {
    ctx.strokeStyle = 'rgba(30, 60, 120, 0.09)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let y = 40; y < data.h; y += 40) { ctx.moveTo(0, y); ctx.lineTo(data.w, y); }
    if (data.bg === 'grid') for (let x = 40; x < data.w; x += 40) { ctx.moveTo(x, 0); ctx.lineTo(x, data.h); }
    ctx.stroke();
  } else if (data.bg === 'dots') {
    ctx.fillStyle = 'rgba(30, 60, 120, 0.22)';
    for (let y = 40; y < data.h; y += 40) for (let x = 40; x < data.w; x += 40) { ctx.beginPath(); ctx.arc(x, y, 1.6, 0, Math.PI * 2); ctx.fill(); }
  }
  ctx.restore();
}

export function drawStroke(ctx, s) {
  const pts = s.points;
  if (!pts?.length) return;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = s.color;
  ctx.fillStyle = s.color;
  if (s.tool === 'marker') { ctx.globalAlpha = 0.35; ctx.globalCompositeOperation = 'multiply'; }
  const [a, b = a] = pts;
  if (s.tool === 'line' || s.tool === 'arrow') {
    ctx.lineWidth = s.width;
    ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
    if (s.tool === 'arrow') {
      const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
      const len = 10 + s.width * 3;
      ctx.beginPath();
      ctx.moveTo(b[0], b[1]);
      ctx.lineTo(b[0] - len * Math.cos(ang - 0.45), b[1] - len * Math.sin(ang - 0.45));
      ctx.moveTo(b[0], b[1]);
      ctx.lineTo(b[0] - len * Math.cos(ang + 0.45), b[1] - len * Math.sin(ang + 0.45));
      ctx.stroke();
    }
  } else if (s.tool === 'rect') {
    ctx.lineWidth = s.width;
    ctx.strokeRect(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));
  } else if (s.tool === 'ellipse') {
    ctx.lineWidth = s.width;
    ctx.beginPath();
    ctx.ellipse((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, Math.abs(b[0] - a[0]) / 2, Math.abs(b[1] - a[1]) / 2, 0, 0, Math.PI * 2);
    ctx.stroke();
  } else if (pts.length === 1) {
    ctx.beginPath(); ctx.arc(a[0], a[1], s.width / 2, 0, Math.PI * 2); ctx.fill();
  } else {
    // smooth freehand with pressure-varying width (segment by segment)
    for (let i = 1; i < pts.length; i++) {
      const p0 = pts[i - 1], p1 = pts[i];
      const p = s.tool === 'marker' ? 0.5 : (p0[2] + p1[2]) / 2;
      ctx.lineWidth = s.width * (0.55 + p * 0.9);
      ctx.beginPath();
      if (i === 1) ctx.moveTo(p0[0], p0[1]);
      else { const pm = pts[i - 2]; ctx.moveTo((pm[0] + p0[0]) / 2, (pm[1] + p0[1]) / 2); }
      ctx.quadraticCurveTo(p0[0], p0[1], (p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2);
      ctx.stroke();
    }
    const last = pts[pts.length - 1], prev = pts[pts.length - 2];
    ctx.beginPath(); ctx.moveTo((prev[0] + last[0]) / 2, (prev[1] + last[1]) / 2); ctx.lineTo(last[0], last[1]); ctx.stroke();
  }
  ctx.restore();
}

function distToSeg(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const l = dx * dx + dy * dy;
  let t = l ? ((px - x1) * dx + (py - y1) * dy) / l : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

/** Renders the sketch cropped to its content (with padding) at 2x. */
export async function renderPNG(data) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of data.strokes) for (const [x, y] of s.points) { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); }
  const pad = 40;
  minX = Math.max(0, minX - pad); minY = Math.max(0, minY - pad);
  maxX = Math.min(data.w, maxX + pad); maxY = Math.min(data.h, maxY + pad);
  // keep a sensible minimum size so small doodles are not tiny
  if (maxX - minX < 600) { const c = (minX + maxX) / 2; minX = Math.max(0, c - 300); maxX = Math.min(data.w, minX + 600); }
  if (maxY - minY < 300) { maxY = Math.min(data.h, minY + 300); }
  const w = maxX - minX, hgt = maxY - minY, k = 2;
  const c = document.createElement('canvas');
  c.width = Math.round(w * k); c.height = Math.round(hgt * k);
  const ctx = c.getContext('2d');
  ctx.setTransform(k, 0, 0, k, -minX * k, -minY * k);
  paintBackground(ctx, data);
  for (const s of data.strokes) drawStroke(ctx, s);
  return new Promise((r) => c.toBlob(r, 'image/png'));
}
