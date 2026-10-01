// Voice notes: recording sheet with live transcript, and server transcription.

import { AudioRecorder, speechSupported, transcribePayload } from './media.js';
import { settings, api, hasServer } from './settings.js';
import { fmtDuration, esc } from './util.js';
import { icon } from './icons.js';
import { h, sheet, toast } from './ui.js';

/** Opens the recorder. Resolves { blob, transcript, duration } or null. */
export function recordVoice() {
  return new Promise((resolve) => {
    const s = settings();
    const live = s.liveTranscribe && speechSupported();
    const body = h(`<div class="voice">
      <div class="voice-meter"><span class="voice-dot"></span><span class="voice-time">0:00</span></div>
      <div class="voice-wave">${Array.from({ length: 28 }, () => '<i></i>').join('')}</div>
      <div class="voice-transcript ${live ? '' : 'hidden'}"><span class="final"></span><span class="interim"></span></div>
      <p class="voice-hint">${live ? 'Live transcript on. ' : ''}${hasServer() && s.autoTranscribe ? 'A cleaner transcript is made by your server when you stop.' : ''}</p>
      <div class="voice-btns">
        <button class="btn ghost" data-a="cancel">Cancel</button>
        <button class="voice-main" data-a="pause" aria-label="Pause">${icon('pause')}</button>
        <button class="btn primary" data-a="stop">${icon('check')} Save</button>
      </div></div>`);
    let result = null;
    const sh = sheet({ title: 'Voice note', body, className: 'voice-sheet', onClose: () => { if (!result) rec.cancel(); clearInterval(timer); resolve(result); } });
    const bars = body.querySelectorAll('.voice-wave i');
    const levels = new Array(bars.length).fill(0);
    const rec = new AudioRecorder({
      liveTranscribe: live,
      onLevel: (l) => { levels.push(l); levels.shift(); },
      onTranscript: (fin, interim) => {
        body.querySelector('.final').textContent = fin;
        body.querySelector('.interim').textContent = interim ? ` ${interim}` : '';
        const t = body.querySelector('.voice-transcript');
        t.scrollTop = t.scrollHeight;
      },
    });
    let paused = false;
    let elapsed = 0, last = Date.now();
    const timer = setInterval(() => {
      if (!paused) elapsed += Date.now() - last;
      last = Date.now();
      body.querySelector('.voice-time').textContent = fmtDuration(elapsed);
      bars.forEach((b, i) => { b.style.transform = `scaleY(${0.08 + levels[i] * 0.92})`; });
    }, 100);
    rec.start().catch((e) => {
      toast(e.name === 'NotAllowedError' ? 'Microphone permission was denied' : `Can't record: ${e.message}`, { kind: 'error' });
      sh.close();
    });
    body.addEventListener('click', async (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.a === 'cancel') sh.close();
      if (b.dataset.a === 'pause') {
        paused = !paused;
        paused ? rec.pause() : rec.resume();
        b.innerHTML = icon(paused ? 'mic' : 'pause');
        body.querySelector('.voice-dot').classList.toggle('paused', paused);
      }
      if (b.dataset.a === 'stop') {
        b.disabled = true;
        result = await rec.stop();
        sh.close();
      }
    });
  });
}

/** Server-side transcription (Workers AI Whisper on Cloudflare, or your own server). */
export async function transcribe(blob) {
  if (!hasServer()) throw new Error('Transcription needs your Cloudflare Worker or home server (Settings → Sync).');
  const res = await api('/api/transcribe', { method: 'POST', body: await transcribePayload(blob) });
  return (res.text || '').trim();
}

export function transcriptHTML(text) {
  return text.split(/\n{2,}/).map((p) => `<p>${esc(p)}</p>`).join('');
}
