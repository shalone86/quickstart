// Version history & proof of authorship: replay, typed-vs-pasted breakdown, restore, and exports
// (WebM/MP4 video of the writing process, a printable provenance report, and the raw signed log).

import * as store from './store.js';
import * as db from './db.js';
import { replay, segments, versions, KIND_LABEL } from './history.js';
import { esc, fmtDateTime, fmtDuration, downloadBlob, safeFileName, sha256Hex } from './util.js';
import { icon } from './icons.js';
import { h, toast, confirmDialog, spinner } from './ui.js';

export async function loadSessions(noteId) {
  return (await db.getByIndex('history', 'noteId', noteId)).filter((s) => !s.deleted).sort((a, b) => a.start - b.start);
}

const KIND_CLASS = { t: 'k-typed', p: 'k-pasted', r: 'k-pasted', v: 'k-voice', a: 'k-app', e: 'k-ext', b: 'k-base', u: 'k-typed', x: 'k-typed' };

function originHTML(text, origin) {
  return segments(text, origin).map((s) => `<span class="${KIND_CLASS[s.kind] || ''}">${esc(s.text)}</span>`).join('');
}

/** Renders the history view into `root`. `onRestore(html)` swaps the note's content. */
export async function renderHistory(root, note, { onRestore }) {
  root.innerHTML = spinner('Reading history…');
  const sessions = await loadSessions(note.id);
  if (!sessions.length) {
    root.innerHTML = `<div class="empty">${icon('history', 'empty-ic')}<h3>No history yet</h3><p>Every keystroke is recorded from the moment you start editing this note.</p></div>`;
    return;
  }
  const frames = [];
  const result = replay(sessions, (f) => frames.push({ t: f.t, kind: f.kind, text: f.text, origin: f.origin }));
  const st = result.stats;
  const finalLen = result.text.length || 1;
  const counts = {};
  for (const c of result.origin) counts[c] = (counts[c] || 0) + 1;
  const pct = (k) => Math.round(((counts[k] || 0) / finalLen) * 100);
  const typedPct = pct('t') + pct('u') + pct('x');
  const pastedPct = pct('p') + pct('r');
  const vers = versions(sessions);

  root.innerHTML = `
    <section class="prov-summary">
      <div class="prov-stat"><b>${typedPct}%</b><span>typed here</span></div>
      <div class="prov-stat"><b>${pastedPct}%</b><span>pasted</span></div>
      <div class="prov-stat"><b>${pct('v')}%</b><span>dictated</span></div>
      <div class="prov-stat"><b>${pct('a') + pct('e') + pct('b')}%</b><span>app / other</span></div>
      <div class="prov-stat"><b>${fmtDuration(st.activeMs)}</b><span>writing time</span></div>
      <div class="prov-stat"><b>${st.ops.toLocaleString()}</b><span>edits · ${st.sessions} session${st.sessions > 1 ? 's' : ''}</span></div>
    </section>
    <div class="prov-legend"><span class="k-typed">Typed</span><span class="k-pasted">Pasted</span><span class="k-voice">Dictated</span><span class="k-app">App / import / AI</span><span class="k-ext">Edited on another device</span></div>
    <section class="prov-player">
      <div class="prov-controls">
        <button class="icon-btn" data-a="play" aria-label="Play">${icon('play')}</button>
        <input type="range" class="prov-scrub" min="0" max="${frames.length - 1}" value="${frames.length - 1}" aria-label="Scrub through history">
        <select class="prov-speed" aria-label="Speed"><option value="1">1×</option><option value="4">4×</option><option value="16" selected>16×</option><option value="64">64×</option></select>
      </div>
      <div class="prov-time"></div>
      <div class="prov-text"></div>
    </section>
    <section class="prov-actions">
      <button class="btn" data-a="video">${icon('video')} Export video</button>
      <button class="btn" data-a="report">${icon('file-text')} Provenance report</button>
      <button class="btn" data-a="json">${icon('download')} Raw log (JSON)</button>
    </section>
    ${st.pastes.length ? `<section><h3 class="sec-title">Pasted content (${st.pastes.length})</h3><div class="prov-pastes">${st.pastes.slice(-50).reverse().map((p) => `<div class="prov-paste"><time>${esc(fmtDateTime(p.t))}</time><p>${esc(p.text.slice(0, 400))}${p.text.length > 400 ? '…' : ''}</p></div>`).join('')}</div></section>` : ''}
    <section><h3 class="sec-title">Restore points</h3><div class="prov-versions">${vers.slice(0, 200).map((v, i) => `<div class="prov-ver"><div><b>${esc(fmtDateTime(v.t))}</b><small>${v.label || ''} ${esc(v.session.device === store.deviceId() ? 'this device' : 'another device')}</small></div><div class="prov-ver-btns"><button class="chip" data-v="${i}" data-a="preview">Preview</button><button class="chip" data-v="${i}" data-a="restore">Restore</button></div></div>`).join('')}</div></section>`;

  const scrub = root.querySelector('.prov-scrub');
  const textEl = root.querySelector('.prov-text');
  const timeEl = root.querySelector('.prov-time');
  const show = (i) => {
    const f = frames[i];
    textEl.innerHTML = originHTML(f.text, f.origin) || '<span class="muted">(empty)</span>';
    timeEl.textContent = `${fmtDateTime(f.t)} · ${KIND_LABEL[f.kind] || 'Session start'}`;
  };
  show(frames.length - 1);
  scrub.addEventListener('input', () => { stop(); show(+scrub.value); });

  let playing = null;
  const stop = () => { if (playing) { clearTimeout(playing); playing = null; root.querySelector('[data-a="play"]').innerHTML = icon('play'); } };
  const play = () => {
    let i = +scrub.value >= frames.length - 1 ? 0 : +scrub.value;
    root.querySelector('[data-a="play"]').innerHTML = icon('pause');
    const step = () => {
      show(i);
      scrub.value = i;
      if (i >= frames.length - 1) { stop(); return; }
      const speed = +root.querySelector('.prov-speed').value;
      const gap = Math.min(frames[i + 1].t - frames[i].t, 2000) / speed;
      i++;
      playing = setTimeout(step, Math.max(8, gap));
    };
    step();
  };

  root.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const a = b.dataset.a;
    if (a === 'play') playing ? stop() : play();
    if (a === 'preview') {
      const v = vers[+b.dataset.v];
      const wrap = h(`<div class="prov-preview note-body">${v.html}</div>`);
      await store.hydrateMedia(wrap);
      textEl.replaceChildren(wrap);
      timeEl.textContent = `Preview · ${fmtDateTime(v.t)}`;
    }
    if (a === 'restore') {
      const v = vers[+b.dataset.v];
      if (await confirmDialog(`Restore the version from ${fmtDateTime(v.t)}? Your current text stays in history.`, { ok: 'Restore' })) onRestore(v.html);
    }
    if (a === 'json') {
      const log = await provenanceLog(note, sessions);
      downloadBlob(new Blob([JSON.stringify(log, null, 1)], { type: 'application/json' }), `${safeFileName(note.title)} - history.json`);
    }
    if (a === 'report') {
      const html = await provenanceReport(note, sessions, result);
      downloadBlob(new Blob([html], { type: 'text/html' }), `${safeFileName(note.title)} - provenance.html`);
    }
    if (a === 'video') {
      b.disabled = true;
      const old = b.innerHTML;
      try {
        const blob = await exportVideo(note, frames, result, (p) => { b.textContent = `Rendering… ${Math.round(p * 100)}%`; });
        downloadBlob(blob, `${safeFileName(note.title)} - writing replay.${blob.type.includes('mp4') ? 'mp4' : 'webm'}`);
      } catch (err) { toast(`Video export failed: ${err.message}`, { kind: 'error' }); }
      b.disabled = false;
      b.innerHTML = old;
    }
  });
}

/** Full log with a SHA-256 over every session, so a copy can be checked for tampering. */
export async function provenanceLog(note, sessions) {
  const body = sessions.map((s) => ({ id: s.id, device: s.device, start: new Date(s.start).toISOString(), end: new Date(s.end).toISOString(), baseText: s.baseText, ops: s.ops }));
  const chain = [];
  let prev = '';
  for (const s of body) { prev = await sha256Hex(prev + JSON.stringify(s)); chain.push(prev); }
  return {
    format: 'scriptorium-provenance/1',
    note: { id: note.id, title: note.title, created: new Date(note.created).toISOString() },
    exported: new Date().toISOString(),
    legend: { t: 'typed', p: 'pasted', r: 'dropped', x: 'cut', v: 'dictated', a: 'inserted by app (import, article, AI, math)', u: 'undo/redo/restore', e: 'edited on another device' },
    opFormat: '[msSinceSessionStart, kind, position, deletedChars, insertedText, lastKeystrokeMs?]',
    sessions: body,
    hashChain: chain,
    digest: chain[chain.length - 1] || null,
  };
}

async function provenanceReport(note, sessions, result) {
  const log = await provenanceLog(note, sessions);
  const st = result.stats;
  const len = result.text.length || 1;
  const counts = {};
  for (const c of result.origin) counts[c] = (counts[c] || 0) + 1;
  const pc = (ks) => ((ks.reduce((a, k) => a + (counts[k] || 0), 0) / len) * 100).toFixed(1);
  return `<!doctype html><html><head><meta charset="utf-8"><title>Provenance — ${esc(note.title)}</title><style>
body{font:15px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;max-width:820px;margin:32px auto;padding:0 20px;color:#1d1d1f}
h1{font-size:24px;margin-bottom:4px} .muted{color:#6e6e73} table{border-collapse:collapse;width:100%;margin:16px 0}
td,th{border-bottom:1px solid #e5e5e5;padding:6px 8px;text-align:left} .text{white-space:pre-wrap;border:1px solid #e5e5e5;border-radius:10px;padding:16px;background:#fffdf8}
.k-pasted{background:#ffd8a8} .k-voice{background:#c3fae8} .k-app{background:#d0ebff} .k-ext{background:#eee} code{font-size:12px;word-break:break-all}
.legend span{display:inline-block;padding:0 6px;margin-right:6px;border-radius:4px}
</style></head><body>
<h1>${esc(note.title)}</h1>
<div class="muted">Provenance report generated ${esc(fmtDateTime(Date.now()))} by Scriptorium</div>
<table>
<tr><th>Note created</th><td>${esc(fmtDateTime(note.created))}</td></tr>
<tr><th>Editing sessions</th><td>${st.sessions} (${esc(fmtDateTime(sessions[0].start))} → ${esc(fmtDateTime(sessions[sessions.length - 1].end))})</td></tr>
<tr><th>Active writing time</th><td>${fmtDuration(st.activeMs)}</td></tr>
<tr><th>Recorded edits</th><td>${st.ops.toLocaleString()}</td></tr>
<tr><th>Final text typed in the app</th><td><b>${pc(['t', 'u', 'x'])}%</b></td></tr>
<tr><th>Final text pasted / dropped in</th><td>${pc(['p', 'r'])}% (${st.pastes.length} paste events)</td></tr>
<tr><th>Dictated</th><td>${pc(['v'])}%</td></tr>
<tr><th>Inserted by the app (import, article, AI, math) / other</th><td>${pc(['a', 'b', 'e'])}%</td></tr>
<tr><th>Log digest (SHA-256 chain)</th><td><code>${esc(log.digest || '')}</code></td></tr>
</table>
<p class="legend"><span>typed</span><span class="k-pasted">pasted</span><span class="k-voice">dictated</span><span class="k-app">app / AI / import</span><span class="k-ext">other device</span></p>
<div class="text">${originHTML(result.text, result.origin)}</div>
${st.pastes.length ? `<h2>Paste events</h2><table><tr><th>When</th><th>Content</th></tr>${st.pastes.map((p) => `<tr><td>${esc(fmtDateTime(p.t))}</td><td>${esc(p.text.slice(0, 300))}${p.text.length > 300 ? '…' : ''}</td></tr>`).join('')}</table>` : ''}
<h2>How to verify</h2>
<p class="muted">Every edit was recorded as it happened, with millisecond timestamps, and synced to backups (for GitHub, each sync is a dated commit containing the log in <code>.scriptorium/history/${esc(note.id)}.json</code>). The digest above is a SHA-256 hash chain over the sessions in the attached raw log; recomputing it from the log proves the log was not altered after export.</p>
<script type="application/json" id="log">${JSON.stringify(log).replace(/</g, '\\u003c')}</script>
</body></html>`;
}

/* ---------------- video ---------------- */

function pickVideoMime() {
  const opts = ['video/mp4;codecs=avc1', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4'];
  return opts.find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || '';
}

/** Renders the writing process to a video (~45s max), pasted text highlighted, with a clock. */
export async function exportVideo(note, frames, result, onProgress) {
  if (!window.MediaRecorder || !HTMLCanvasElement.prototype.captureStream) throw new Error('This browser cannot record video');
  const W = 1280, H = 720, FPS = 30;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  // compress idle gaps, then fit to a target duration
  const times = [0];
  for (let i = 1; i < frames.length; i++) times.push(times[i - 1] + Math.min(frames[i].t - frames[i - 1].t, 1500));
  const total = times[times.length - 1] || 1;
  const duration = Math.min(45000, Math.max(6000, total / 8));
  const stream = canvas.captureStream(FPS);
  const mime = pickVideoMime();
  const rec = new MediaRecorder(stream, { mimeType: mime || undefined, videoBitsPerSecond: 2_500_000 });
  const chunks = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const done = new Promise((r) => { rec.onstop = r; });
  rec.start(500);
  const colors = { p: '#ffd8a8', r: '#ffd8a8', v: '#c3fae8', a: '#d0ebff', e: '#e9ecef' };
  const draw = (fi, progress) => {
    const f = frames[fi];
    ctx.fillStyle = '#fffdf8';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#1d1d1f';
    ctx.font = '600 28px -apple-system, Segoe UI, Roboto, sans-serif';
    ctx.fillText(note.title.slice(0, 60), 48, 60);
    ctx.font = '16px -apple-system, Segoe UI, Roboto, sans-serif';
    ctx.fillStyle = '#6e6e73';
    ctx.fillText(`${new Date(f.t).toLocaleString()} · ${KIND_LABEL[f.kind] || 'Session'}`, 48, 88);
    // wrapped text, showing the tail so the caret area stays visible
    ctx.font = '20px Georgia, serif';
    const lines = wrapRuns(ctx, f.text, f.origin, W - 96);
    const maxLines = Math.floor((H - 170) / 30);
    const start = Math.max(0, lines.length - maxLines);
    let y = 130;
    for (const line of lines.slice(start)) {
      let x = 48;
      for (const run of line) {
        const w = ctx.measureText(run.text).width;
        if (colors[run.kind]) { ctx.fillStyle = colors[run.kind]; ctx.fillRect(x, y - 20, w, 27); }
        ctx.fillStyle = '#1d1d1f';
        ctx.fillText(run.text, x, y);
        x += w;
      }
      y += 30;
    }
    ctx.fillStyle = '#eee';
    ctx.fillRect(0, H - 6, W, 6);
    ctx.fillStyle = '#d4a017';
    ctx.fillRect(0, H - 6, W * progress, 6);
    ctx.fillStyle = '#6e6e73';
    ctx.font = '14px -apple-system, Segoe UI, Roboto, sans-serif';
    ctx.fillText('Recorded with Scriptorium · orange = pasted · green = dictated · blue = app', 48, H - 20);
  };
  const frameCount = Math.ceil((duration / 1000) * FPS);
  let fi = 0;
  for (let k = 0; k <= frameCount; k++) {
    const target = (k / frameCount) * total;
    while (fi < frames.length - 1 && times[fi + 1] <= target) fi++;
    draw(fi, k / frameCount);
    onProgress?.(k / frameCount);
    await new Promise((r) => setTimeout(r, 1000 / FPS));
  }
  // hold the final frame for a second
  for (let k = 0; k < FPS; k++) { draw(frames.length - 1, 1); await new Promise((r) => setTimeout(r, 1000 / FPS)); }
  rec.stop();
  await done;
  return new Blob(chunks, { type: (mime || 'video/webm').split(';')[0] });
}

function wrapRuns(ctx, text, origin, maxW) {
  const lines = [];
  for (const para of splitKeep(text, origin)) {
    let line = [], lineW = 0;
    // break into words while keeping origin per character
    const words = para.text.match(/\S+\s*|\s+/g) || [''];
    let pos = 0;
    for (const w of words) {
      const ww = ctx.measureText(w).width;
      if (lineW + ww > maxW && line.length) { lines.push(line); line = []; lineW = 0; }
      // split word into runs by origin
      let i = 0;
      while (i < w.length) {
        const k = para.origin[pos + i];
        let j = i + 1;
        while (j < w.length && para.origin[pos + j] === k) j++;
        line.push({ text: w.slice(i, j), kind: k });
        i = j;
      }
      lineW += ww;
      pos += w.length;
    }
    lines.push(line);
  }
  return lines;
}

function splitKeep(text, origin) {
  const out = [];
  let start = 0;
  for (let i = 0; i <= text.length; i++) {
    if (i === text.length || text[i] === '\n') {
      out.push({ text: text.slice(start, i), origin: origin.slice(start, i) });
      start = i + 1;
    }
  }
  return out;
}
