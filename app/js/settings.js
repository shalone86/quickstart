// Device settings (kept on this device only — tokens never sync).

import * as db from './db.js';
import { Emitter } from './util.js';

export const DEFAULTS = {
  theme: 'auto', // auto | light | dark
  fontSize: 17,
  fontFamily: 'system', // system | serif | mono
  // Your Cloudflare Worker or home server (same API). Empty = same origin if the app is served by it.
  serverUrl: '',
  serverToken: '',
  serverEnabled: false,
  // GitHub (works with no server at all)
  githubEnabled: false,
  githubToken: '',
  githubRepo: '', // owner/name
  githubBranch: 'main',
  githubPath: 'Notes',
  githubMarkdown: true,
  // Web search
  searxngUrl: '',
  // Articles: use r.jina.ai when no server is configured
  readerFallback: true,
  saveImagesOffline: true,
  // News
  interests: ['large language models', 'Catholic theology', 'music cognition'],
  savedFolder: 'Saved articles',
  openalexKey: '',
  // AI
  aiEnabled: true,
  aiEffort: 'medium',
  aiWeb: true,
  // Audio
  liveTranscribe: true,
  autoTranscribe: true,
  // History
  recordHistory: true,
  // Home
  recentCount: 3,
};

let current = { ...DEFAULTS };
export const events = new Emitter();

export async function loadSettings() {
  const saved = (await db.getMeta('settings')) || {};
  current = { ...DEFAULTS, ...saved };
  // If the app is served by the Worker/server itself, use it automatically.
  if (!current.serverUrl && location.protocol.startsWith('http')) current.sameOrigin = true;
  return current;
}

export const settings = () => current;

export async function saveSettings(patch) {
  current = { ...current, ...patch };
  const toSave = { ...current };
  delete toSave.sameOrigin;
  await db.setMeta('settings', toSave);
  events.emit('change', { patch, settings: current });
  return current;
}

/** Base URL for the API, or null when no server is configured. */
export function apiBase() {
  const s = current;
  if (!s.serverEnabled) return null;
  if (s.serverUrl) return s.serverUrl.replace(/\/+$/, '');
  return location.origin + location.pathname.replace(/\/[^/]*$/, '');
}

export async function api(path, { method = 'GET', body, headers = {}, raw = false, signal } = {}) {
  const base = apiBase();
  if (!base) throw new Error('No server configured. Add your Cloudflare Worker or home server in Settings → Sync.');
  const h = { ...headers };
  if (current.serverToken) h.Authorization = `Bearer ${current.serverToken}`;
  let payload = body;
  if (body && !(body instanceof Blob) && !(body instanceof ArrayBuffer) && typeof body !== 'string') {
    h['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(base + path, { method, body: payload, headers: h, signal });
  if (raw) return res;
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try { const j = await res.json(); msg = j.error || msg; } catch { /* not json */ }
    throw Object.assign(new Error(msg), { status: res.status });
  }
  const ct = res.headers.get('content-type') || '';
  return ct.includes('json') ? res.json() : res.text();
}

export const hasServer = () => !!apiBase();

/**
 * The Daily checklist app lives on the same site (shalone86.github.io), so in the browser its saved
 * GitHub settings are readable here. Returns { owner, repo, branch, token } or null.
 */
export function dailyGithubSettings() {
  try {
    const d = JSON.parse(localStorage.getItem('settings') || 'null');
    return d && d.token && d.owner && d.repo ? d : null;
  } catch { return null; }
}

export async function useDailyGithub() {
  const d = dailyGithubSettings();
  if (!d) return false;
  await saveSettings({ githubEnabled: true, githubToken: d.token, githubRepo: `${d.owner}/${d.repo}`, githubBranch: d.branch || 'main', githubPath: 'Notes' });
  return true;
}
