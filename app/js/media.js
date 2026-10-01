// Images (compression) and audio recording / transcription.

import { blobToBase64 } from './util.js';

/** Downscales large photos so notes stay light. Keeps PNG for images with transparency. */
export async function compressImage(file, { maxSize = 2048, quality = 0.85 } = {}) {
  if (!file.type.startsWith('image/') || file.type === 'image/gif' || file.type === 'image/svg+xml') return file;
  let bitmap;
  try { bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch { return file; }
  const scale = Math.min(1, maxSize / Math.max(bitmap.width, bitmap.height));
  if (scale === 1 && file.size < 1.5 * 1024 * 1024) { bitmap.close?.(); return file; }
  const w = Math.round(bitmap.width * scale), h = Math.round(bitmap.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();
  const type = file.type === 'image/png' && hasAlpha(ctx, w, h) ? 'image/png' : 'image/jpeg';
  const blob = await new Promise((r) => canvas.toBlob(r, type, quality));
  return blob && blob.size < file.size ? blob : file;
}

function hasAlpha(ctx, w, h) {
  const step = Math.max(1, Math.floor(Math.min(w, h) / 40));
  const data = ctx.getImageData(0, 0, w, h).data;
  for (let y = 0; y < h; y += step) for (let x = 0; x < w; x += step) if (data[(y * w + x) * 4 + 3] < 250) return true;
  return false;
}

/* ---------------- audio ---------------- */

export function pickAudioMime() {
  const types = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg;codecs=opus'];
  return types.find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported?.(t)) || '';
}

export const speechSupported = () => !!(window.SpeechRecognition || window.webkitSpeechRecognition);

/**
 * Records audio and (when the browser supports it) live speech-to-text at the same time.
 * Callbacks: onLevel(0..1), onTranscript(finalText, interimText).
 */
export class AudioRecorder {
  constructor({ onLevel, onTranscript, liveTranscribe = true, lang } = {}) {
    Object.assign(this, { onLevel, onTranscript, liveTranscribe, lang: lang || navigator.language || 'en-US' });
    this.chunks = [];
    this.finalText = '';
  }

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    const mimeType = pickAudioMime();
    this.rec = new MediaRecorder(this.stream, mimeType ? { mimeType } : undefined);
    this.rec.ondataavailable = (e) => { if (e.data.size) this.chunks.push(e.data); };
    this.rec.start(1000);
    this.started = Date.now();
    // level meter
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ac = new AC();
      const src = this.ac.createMediaStreamSource(this.stream);
      const an = this.ac.createAnalyser();
      an.fftSize = 512;
      src.connect(an);
      const buf = new Uint8Array(an.fftSize);
      const tick = () => {
        if (!this.ac) return;
        an.getByteTimeDomainData(buf);
        let sum = 0;
        for (const v of buf) sum += ((v - 128) / 128) ** 2;
        this.onLevel?.(Math.min(1, Math.sqrt(sum / buf.length) * 4));
        this.raf = requestAnimationFrame(tick);
      };
      tick();
    } catch { /* meter is optional */ }
    if (this.liveTranscribe && speechSupported()) this.startSpeech();
  }

  startSpeech() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const sr = new SR();
    sr.continuous = true;
    sr.interimResults = true;
    sr.lang = this.lang;
    sr.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) this.finalText += (this.finalText && !this.finalText.endsWith(' ') ? ' ' : '') + r[0].transcript.trim();
        else interim += r[0].transcript;
      }
      this.onTranscript?.(this.finalText, interim);
    };
    sr.onerror = (e) => { if (e.error === 'not-allowed' || e.error === 'service-not-allowed') this.speechFailed = true; };
    sr.onend = () => { if (this.rec?.state === 'recording' && !this.speechFailed) { try { sr.start(); } catch { /* ignore */ } } };
    try { sr.start(); this.sr = sr; } catch { this.sr = null; }
  }

  pause() { if (this.rec?.state === 'recording') { this.rec.pause(); this.sr?.stop(); } }
  resume() { if (this.rec?.state === 'paused') { this.rec.resume(); if (this.liveTranscribe && speechSupported()) this.startSpeech(); } }

  async stop() {
    const done = new Promise((r) => { this.rec.onstop = r; });
    if (this.rec.state !== 'inactive') this.rec.stop();
    try { this.sr?.stop(); } catch { /* ignore */ }
    await done;
    this.cleanup();
    const type = (this.rec.mimeType || 'audio/webm').split(';')[0];
    return { blob: new Blob(this.chunks, { type }), duration: Date.now() - this.started, transcript: this.finalText.trim() };
  }

  cancel() {
    try { this.rec?.state !== 'inactive' && this.rec.stop(); } catch { /* ignore */ }
    try { this.sr?.abort(); } catch { /* ignore */ }
    this.cleanup();
  }

  cleanup() {
    cancelAnimationFrame(this.raf);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.ac?.close().catch(() => {});
    this.ac = null;
  }
}

/** Builds the JSON body for /api/transcribe. */
export async function transcribePayload(blob) {
  return { audio: await blobToBase64(blob), mime: blob.type };
}
