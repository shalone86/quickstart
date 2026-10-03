// Settings: sync (server / Cloudflare Worker, GitHub), web search, AI, audio, appearance, backup & import.

import * as store from '../store.js';
import * as db from '../db.js';
import { settings, saveSettings, dailyGithubSettings, useDailyGithub } from '../settings.js';
import { syncNow, syncStatus, syncEvents, testBackend } from '../sync/engine.js';
import { exportAll, importFiles } from '../exporter.js';
import { esc, fmtRelative, fmtBytes } from '../util.js';
import { icon } from '../icons.js';
import { toast, confirmDialog, pickFiles } from '../ui.js';
import { applyAppearance } from '../theme.js';

export function renderSettings(root) {
  const s = settings();
  const field = (key, label, { type = 'text', placeholder = '', hint = '', autocomplete = 'off' } = {}) => `
    <label class="field"><span>${label}</span><input class="input" data-k="${key}" type="${type}" value="${esc(s[key] ?? '')}" placeholder="${esc(placeholder)}" autocomplete="${autocomplete}" spellcheck="false">${hint ? `<small>${hint}</small>` : ''}</label>`;
  const toggle = (key, label, hint = '') => `<label class="toggle"><input type="checkbox" data-k="${key}" ${s[key] ? 'checked' : ''}><span class="switch"></span><span class="toggle-text"><b>${label}</b>${hint ? `<small>${hint}</small>` : ''}</span></label>`;
  const select = (key, label, opts) => `<label class="field"><span>${label}</span><select class="input" data-k="${key}">${opts.map(([v, l]) => `<option value="${v}" ${String(s[key]) === String(v) ? 'selected' : ''}>${l}</option>`).join('')}</select></label>`;

  root.innerHTML = `
    <header class="page-head"><div><div class="eyebrow">Scriptorium</div><h1>Settings</h1></div></header>

    <section class="card settings-card">
      <h2>${icon('cloud')} Sync & backup</h2>
      <div class="sync-summary"></div>
      <p class="muted small">Notes always live on this device first, so the app works offline. Turn on one or both destinations and every change is copied automatically.</p>

      <h3>Your server or Cloudflare Worker</h3>
      ${toggle('serverEnabled', 'Sync with my server', 'Cloudflare Worker (D1 + R2 bucket) or the home server in <code>server/</code>. Also powers AI, transcription, share links, web search and news feeds.')}
      ${field('serverUrl', 'Server address', { placeholder: 'https://notes.yourname.workers.dev', hint: 'Leave empty if this app is being served by the Worker itself.' })}
      ${field('serverToken', 'Access token', { type: 'password', placeholder: 'The APP_TOKEN secret you set on the server' })}
      <div class="btn-row"><button class="btn" data-a="test-server">${icon('refresh-cw')} Test connection</button></div>

      <h3>GitHub</h3>
      ${dailyGithubSettings() && !s.githubToken ? `<div class="banner">Your Daily app is already connected to <b>${esc(dailyGithubSettings().owner)}/${esc(dailyGithubSettings().repo)}</b>. Use the same account? Notes go in a <code>Notes/</code> folder next to <code>Todo/</code>. <button class="btn small primary" data-a="use-daily">Use Daily’s settings</button></div>` : ''}
      ${toggle('githubEnabled', 'Back up to GitHub', 'Notes become Markdown files your Obsidian vault can read. Each sync is one commit — a full, timestamped backup.')}
      ${field('githubRepo', 'Repository', { placeholder: 'yourname/notes-data' })}
      ${field('githubPath', 'Folder in the repo', { placeholder: 'Notes', hint: 'Use a folder inside your Obsidian vault repo to see notes in Obsidian.' })}
      ${field('githubBranch', 'Branch', { placeholder: 'main' })}
      ${field('githubToken', 'Fine-grained token', { type: 'password', placeholder: 'github_pat_…', hint: 'GitHub → Settings → Developer settings → Fine-grained tokens. Give it only this repository with <b>Contents: Read and write</b>.' })}
      ${toggle('githubMarkdown', 'Write Markdown files', 'Turn off to store only the app’s data file.')}
      <div class="btn-row"><button class="btn" data-a="test-github">${icon('refresh-cw')} Test connection</button><button class="btn primary" data-a="sync">${icon('cloud')} Sync now</button></div>
    </section>

    ${window.AndroidApp ? '' : `<section class="card settings-card">
      <h2>${icon('download')} Android app</h2>
      <p class="muted small">Opens Scriptorium full-screen like Daily does, and adds <b>Share → Save to Scriptorium</b> from Google News, Chrome and other apps.</p>
      <div class="btn-row"><a class="btn primary" href="scriptorium.apk" download>${icon('download')} Get the Android app</a></div>
    </section>`}

    <section class="card settings-card">
      <h2>${icon('globe')} Web, news & reading</h2>
      ${field('searxngUrl', 'SearXNG address', { placeholder: 'https://search.yourserver.com', hint: 'JSON output must be enabled in SearXNG’s settings.yml (<code>formats: [html, json]</code>).' })}
      ${toggle('readerFallback', 'Use the free r.jina.ai reader when no server is connected', 'Lets “save article” work before you set up your Worker. The link is sent to Jina’s reader service.')}
      ${toggle('cleanArticles', 'Clean saved articles', 'Keeps just the headline, article text and pictures: removes links, “Read more”, related stories, share and newsletter boxes.')}
      ${toggle('saveImagesOffline', 'Keep article images in the note', 'Downloads images through your server so saved articles keep their pictures forever.')}
      ${field('savedFolder', 'Folder for saved articles', { placeholder: 'Saved articles' })}
      ${field('openalexKey', 'OpenAlex key (optional)', { type: 'password', placeholder: 'free key from openalex.org', hint: 'Papers come from OpenAlex. It is free without a key up to a daily limit; a free key raises it.' })}
    </section>

    <section class="card settings-card">
      <h2>${icon('sparkles')} AI</h2>
      ${toggle('aiWeb', 'Allow web search in answers', 'The AI can search and read web pages when your notes are not enough.')}
      ${select('aiEffort', 'Answer depth', [['low', 'Quick'], ['medium', 'Balanced'], ['high', 'Thorough'], ['xhigh', 'Deep research']])}
      <p class="muted small">Uses Claude through your Worker/server. Set <code>ANTHROPIC_API_KEY</code> there — it never touches this device.</p>
    </section>

    <section class="card settings-card">
      <h2>${icon('mic')} Voice notes</h2>
      ${toggle('liveTranscribe', 'Live transcript while recording', 'Uses your browser’s speech recognition (Chrome, Safari).')}
      ${toggle('autoTranscribe', 'Clean transcript from my server', 'Whisper on Cloudflare Workers AI (free tier) or your server.')}
    </section>

    <section class="card settings-card">
      <h2>${icon('history')} Writing history</h2>
      ${toggle('recordHistory', 'Record keystroke-level history', 'Every edit, with timestamps and whether it was typed, pasted or dictated. Replay it, restore any version, or export a video and report as proof of authorship.')}
    </section>

    <section class="card settings-card">
      <h2>${icon('sun')} Appearance</h2>
      ${select('theme', 'Theme', [['auto', 'Match device'], ['light', 'Light'], ['dark', 'Dark']])}
      ${select('fontFamily', 'Note font', [['system', 'System'], ['serif', 'Serif (book)'], ['mono', 'Monospaced']])}
      ${select('fontSize', 'Text size', [[15, 'Small'], [17, 'Medium'], [19, 'Large'], [21, 'Extra large']])}
      ${select('recentCount', 'Recent notes on home', [[3, '3'], [5, '5'], [8, '8']])}
    </section>

    <section class="card settings-card">
      <h2>${icon('archive')} Import & export</h2>
      <div class="btn-row wrap">
        <button class="btn" data-a="export">${icon('download')} Download everything (.zip)</button>
        <button class="btn" data-a="import-files">${icon('upload')} Import Markdown / backup</button>
        <button class="btn" data-a="import-folder">${icon('folder')} Import an Obsidian folder</button>
      </div>
      <p class="muted small">The zip is an Obsidian-ready vault (Markdown + attachments) plus a full backup file you can import here.</p>
      <div class="storage-info muted small"></div>
    </section>

    <section class="card settings-card danger-zone">
      <h2>${icon('trash-2')} This device</h2>
      <div class="btn-row wrap"><button class="btn danger" data-a="wipe">Erase all data on this device</button></div>
      <p class="muted small">Only affects this device. Synced copies on your server and GitHub are kept.</p>
    </section>
    <p class="muted small center">Scriptorium · local-first notes · <a href="https://github.com/shalone86/quickstart" target="_blank" rel="noopener">source & setup guide</a></p>`;

  const renderSync = () => {
    const st = syncStatus();
    const per = Object.entries(st.per).map(([id, r]) => `<div class="sync-line ${r.ok ? 'ok' : 'bad'}">${icon(r.ok ? 'check' : 'x')} <b>${id === 'github' ? 'GitHub' : 'Server'}</b> ${r.ok ? `synced ${esc(fmtRelative(r.at))}${r.pulled || r.pushed ? ` · ${r.pushed || 0} up, ${r.pulled || 0} down` : ''}` : esc(r.error)}</div>`).join('');
    root.querySelector('.sync-summary').innerHTML = `<div class="sync-state" data-state="${st.state}">${st.state === 'local' ? 'Only on this device' : st.state === 'synced' ? 'Everything synced' : st.state === 'syncing' ? 'Syncing…' : st.state === 'pending' ? 'Waiting to sync' : st.state === 'offline' ? 'Offline' : 'Sync problem'}</div>${per}`;
  };
  renderSync();
  const offSync = syncEvents.on('status', () => { if (root.isConnected) renderSync(); });

  root.addEventListener('change', async (e) => {
    const k = e.target.dataset.k;
    if (!k) return;
    let v = e.target.type === 'checkbox' ? e.target.checked : e.target.value.trim();
    if (['fontSize', 'recentCount'].includes(k)) v = +v;
    await saveSettings({ [k]: v });
    if (['theme', 'fontFamily', 'fontSize'].includes(k)) applyAppearance();
    toast('Saved');
  });

  root.addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-a]');
    if (!b) return;
    const a = b.dataset.a;
    try {
      if (a === 'test-server' || a === 'test-github') {
        b.disabled = true;
        const msg = await testBackend(a === 'test-server' ? 'server' : 'github');
        toast(msg, { timeout: 6000 });
      }
      if (a === 'use-daily') { await useDailyGithub(); toast('Connected to GitHub with Daily’s settings'); window.dispatchEvent(new Event('app:rerender')); }
      if (a === 'sync') { await syncNow(); const st = syncStatus(); toast(st.state === 'error' ? `Sync problem: ${st.error}` : st.state === 'local' ? 'Turn on a sync destination first' : 'Synced'); }
      if (a === 'export') { toast('Preparing download…'); await exportAll(); }
      if (a === 'import-files' || a === 'import-folder') {
        const files = await pickFiles({ accept: '.md,.markdown,.txt,.zip,.json,image/*,audio/*', multiple: true, directory: a === 'import-folder' });
        if (!files.length) return;
        const close = toast(`Importing ${files.length} file${files.length > 1 ? 's' : ''}…`, { timeout: 120000 });
        const n = await importFiles(files);
        close();
        toast(`Imported ${n} item${n === 1 ? '' : 's'}`);
      }
      if (a === 'wipe' && await confirmDialog('Erase every note, setting and token on this device?', { ok: 'Erase', danger: true })) {
        await db.wipeAll();
        location.reload();
      }
    } catch (err) {
      toast(err.message, { kind: 'error', timeout: 7000 });
    } finally { b.disabled = false; }
  });

  (async () => {
    const est = await navigator.storage?.estimate?.();
    const persisted = await navigator.storage?.persisted?.();
    const notes = store.liveNotes().length;
    root.querySelector('.storage-info').innerHTML = `${notes} notes · ${est ? `${fmtBytes(est.usage || 0)} used on this device` : ''}${persisted ? ' · protected from automatic clearing' : ''}`;
  })();

  return () => offSync();
}
