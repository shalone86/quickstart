// News: "For you" papers (your interests + similar to what you saved), your RSS feeds, and paper search.
// Every item has Save → becomes a note in "Saved articles" with text and images.

import * as store from '../store.js';
import { settings, saveSettings, hasServer, api } from '../settings.js';
import { forYou, loadAllFeeds, searchPapers, similarPapers, paperByUrl, PRESET_FEEDS, googleNewsFeed, parseFeed } from '../feeds.js';
import { saveArticle } from '../article.js';
import { esc, fmtRelative, isUrl } from '../util.js';
import { icon } from '../icons.js';
import { h, sheet, toast, spinner, promptDialog, confirmDialog } from '../ui.js';
import { nav } from './common.js';

const cache = { forYou: null, feeds: null, at: 0 };
let tab = 'foryou';

export function renderNews(root) {
  root.innerHTML = `
    <header class="page-head"><div><div class="eyebrow">Your feed</div><h1>News & papers</h1></div>
      <div class="head-actions"><button class="icon-btn" data-a="refresh" aria-label="Refresh">${icon('refresh-cw')}</button><button class="icon-btn" data-a="manage" aria-label="Manage sources">${icon('settings')}</button></div></header>
    <div class="seg wide tabs"><button data-tab="foryou">${icon('sparkles')} For you</button><button data-tab="feeds">${icon('newspaper')} Feeds</button><button data-tab="search">${icon('search')} Search</button></div>
    <form class="search-bar news-save">${icon('link')}<input class="input" name="url" placeholder="Paste any article or paper link to save it" inputmode="url" autocomplete="off"></form>
    <div class="news-body"></div>`;
  const body = root.querySelector('.news-body');
  const items = new Map();

  const card = (it) => {
    items.set(it.id, it);
    const saved = isSaved(it);
    if (it.kind === 'paper') {
      return `<article class="news-card" data-id="${esc(it.id)}">
        <div class="news-src">${icon('book-open')} ${esc(it.venue || 'Paper')}${it.date ? ` · ${esc(it.date)}` : ''}${it.open ? ' · <span class="oa">Open access</span>' : ''}</div>
        <h3><a href="${esc(it.url)}" target="_blank" rel="noopener noreferrer">${esc(it.title)}</a></h3>
        <div class="news-authors">${esc(it.authors.slice(0, 5).join(', '))}${it.authors.length > 5 ? ' et al.' : ''}</div>
        ${it.abstract ? `<p class="news-sum clamp">${esc(it.abstract)}</p>` : ''}
        ${it.reason ? `<div class="news-reason">${icon('sparkles')} ${esc(it.reason)}</div>` : ''}
        <div class="news-btns">
          <button class="btn small ${saved ? '' : 'primary'}" data-a="save" ${saved ? 'disabled' : ''}>${icon(saved ? 'check' : 'download')} ${saved ? 'Saved' : 'Save'}</button>
          <button class="btn small ghost" data-a="similar">${icon('layers')} Similar</button>
          <a class="btn small ghost" href="${esc(it.url)}" target="_blank" rel="noopener noreferrer">${icon('external-link')} Open</a>
        </div></article>`;
    }
    return `<article class="news-card" data-id="${esc(it.id)}">
      ${it.image ? `<img class="news-img" src="${esc(it.image)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ''}
      <div class="news-src">${icon('newspaper')} ${esc(it.source || '')}${it.date ? ` · ${esc(fmtRelative(Date.parse(it.date)))}` : ''}</div>
      <h3><a href="${esc(it.url)}" target="_blank" rel="noopener noreferrer">${esc(it.title)}</a></h3>
      ${it.summary ? `<p class="news-sum clamp">${esc(it.summary)}</p>` : ''}
      <div class="news-btns">
        <button class="btn small ${saved ? '' : 'primary'}" data-a="save" ${saved ? 'disabled' : ''}>${icon(saved ? 'check' : 'download')} ${saved ? 'Saved' : 'Save'}</button>
        <a class="btn small ghost" href="${esc(it.url)}" target="_blank" rel="noopener noreferrer">${icon('external-link')} Open</a>
      </div></article>`;
  };

  const isSaved = (it) => store.liveNotes().some((n) => n.source && ((it.kind === 'paper' && n.source.openalex === it.id) || n.source.url === it.url));

  const show = async (force = false) => {
    root.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
    if (tab === 'foryou') {
      if (!settings().interests?.length && !store.liveNotes().some((n) => n.source?.openalex)) {
        body.innerHTML = `<div class="empty">${icon('sparkles', 'empty-ic')}<h3>Tell me what you like to read</h3><p>Add a few interests and I'll pull in new papers every day, plus papers similar to the ones you save.</p><button class="btn primary" data-a="manage">Add interests</button></div>`;
        return;
      }
      body.innerHTML = spinner('Finding new papers…');
      try {
        if (force || !cache.forYou || Date.now() - cache.at > 30 * 60 * 1000) { cache.forYou = await forYou(); cache.at = Date.now(); }
        body.innerHTML = cache.forYou.length ? `<div class="news-list">${cache.forYou.map(card).join('')}</div>` : '<p class="muted hint">Nothing new right now.</p>';
      } catch (e) { body.innerHTML = `<p class="error">${esc(e.message)}</p>`; }
    } else if (tab === 'feeds') {
      if (!store.feeds().length) {
        body.innerHTML = `<div class="empty">${icon('newspaper', 'empty-ic')}<h3>No feeds yet</h3><p>Add news sites, journals, blogs or a Google News topic.</p><button class="btn primary" data-a="manage">Add feeds</button></div>`;
        return;
      }
      body.innerHTML = spinner('Loading feeds…');
      try {
        if (force || !cache.feeds) cache.feeds = await loadAllFeeds();
        const { articles, errors } = cache.feeds;
        body.innerHTML = `${errors.length ? `<p class="warn">${icon('cloud-off')} Couldn't load: ${errors.map((e) => esc(e.title)).join(', ')}. ${errors[0].error.includes('Failed to fetch') ? 'Most feeds need your Worker/server to get around browser restrictions.' : esc(errors[0].error)}</p>` : ''}
          <div class="news-list">${articles.slice(0, 150).map(card).join('')}</div>`;
      } catch (e) { body.innerHTML = `<p class="error">${esc(e.message)}</p>`; }
    } else {
      body.innerHTML = `<form class="search-bar paper-search">${icon('search')}<input class="input" name="q" placeholder="Search 250M+ papers (OpenAlex)" autocomplete="off" enterkeyhint="search"></form><div class="paper-results"></div>`;
      const f = body.querySelector('.paper-search');
      f.onsubmit = async (e) => {
        e.preventDefault();
        const out = body.querySelector('.paper-results');
        out.innerHTML = spinner('Searching papers…');
        try { const res = await searchPapers(f.q.value.trim()); out.innerHTML = `<div class="news-list">${res.map(card).join('')}</div>`; } catch (err) { out.innerHTML = `<p class="error">${esc(err.message)}</p>`; }
      };
      f.q.focus();
    }
  };

  root.addEventListener('click', async (e) => {
    const tb = e.target.closest('[data-tab]');
    if (tb) { tab = tb.dataset.tab; show(); return; }
    const b = e.target.closest('[data-a]');
    if (!b) return;
    if (b.dataset.a === 'refresh') show(true);
    if (b.dataset.a === 'manage') manageSources(() => { cache.forYou = null; cache.feeds = null; show(true); });
    const cardEl = b.closest('.news-card');
    const it = cardEl && items.get(cardEl.dataset.id);
    if (!it) return;
    if (b.dataset.a === 'save') {
      b.disabled = true;
      b.innerHTML = `${icon('refresh-cw', 'spin')} Saving…`;
      try {
        const note = await saveArticle(it.url, it.kind === 'paper' ? { paper: it, fallbackHTML: '' } : {});
        b.innerHTML = `${icon('check')} Saved`;
        b.classList.remove('primary');
        toast('Saved to your notes', { action: 'Open', onAction: () => nav(`#/note/${note.id}`) });
      } catch (err) {
        b.disabled = false;
        b.innerHTML = `${icon('download')} Save`;
        toast(err.message, { kind: 'error' });
      }
    }
    if (b.dataset.a === 'similar') {
      const s = sheet({ title: 'Similar papers', body: spinner('Looking…'), full: true });
      try {
        const res = await similarPapers(it.id);
        s.body.innerHTML = res.length ? `<div class="news-list">${res.map(card).join('')}</div>` : '<p class="muted hint">No related papers found.</p>';
        bindSaveIn(s.body);
      } catch (err) { s.body.innerHTML = `<p class="error">${esc(err.message)}</p>`; }
    }
  });

  // saves inside the "Similar" sheet (outside root)
  const bindSaveIn = (el) => el.addEventListener('click', async (ev) => {
    const x = ev.target.closest('[data-a="save"]');
    if (!x) return;
    const it = items.get(x.closest('.news-card').dataset.id);
    x.disabled = true;
    x.innerHTML = `${icon('refresh-cw', 'spin')} Saving…`;
    try { await saveArticle(it.url, { paper: it }); x.innerHTML = `${icon('check')} Saved`; toast('Saved to your notes'); } catch (err) { x.disabled = false; x.innerHTML = 'Save'; toast(err.message, { kind: 'error' }); }
  });

  const form = root.querySelector('.news-save');
  form.onsubmit = async (e) => {
    e.preventDefault();
    const url = form.url.value.trim();
    if (!isUrl(url)) { toast('Paste a full link starting with https://'); return; }
    const close = toast('Saving…', { timeout: 60000 });
    try {
      const paper = await paperByUrl(url).catch(() => null);
      const note = await saveArticle(url, paper ? { paper } : {});
      close();
      form.url.value = '';
      toast('Saved to your notes', { action: 'Open', onAction: () => nav(`#/note/${note.id}`) });
    } catch (err) { close(); toast(err.message, { kind: 'error' }); }
  };

  show();
  return () => {};
}

function manageSources(onDone) {
  const s0 = settings();
  const body = h(`<div class="manage">
    <h3 class="sec-title">${icon('sparkles')} Interests (papers)</h3>
    <p class="muted small">New papers matching these appear in “For you”, along with papers similar to ones you save.</p>
    <div class="chip-edit interests">${(s0.interests || []).map((t) => `<span class="chip">${esc(t)}<button data-del-int="${esc(t)}" aria-label="Remove">${icon('x')}</button></span>`).join('')}</div>
    <form class="row-form int-form"><input class="input" name="t" placeholder="Add an interest, e.g. sacred music"><button class="btn">Add</button></form>
    <h3 class="sec-title">${icon('newspaper')} Feeds</h3>
    <div class="feed-list">${store.feeds().map((f) => `<div class="feed-row"><div><b>${esc(f.title)}</b><small>${esc(f.url)}</small></div><button class="icon-btn" data-del-feed="${f.id}" aria-label="Remove">${icon('trash-2')}</button></div>`).join('') || '<p class="muted small">No feeds yet.</p>'}</div>
    <form class="row-form feed-form"><input class="input" name="u" placeholder="RSS/Atom feed URL" inputmode="url"><button class="btn">Add</button></form>
    <button class="btn ghost" data-a="gnews">${icon('search')} Add a Google News topic…</button>
    <h4 class="muted small">Suggestions</h4>
    <div class="pill-row">${PRESET_FEEDS.map((p, i) => `<button class="pill" data-preset="${i}">${icon('plus')} ${esc(p.title)}</button>`).join('')}</div>
  </div>`);
  const sh = sheet({ title: 'News sources', body, full: true, onClose: onDone });
  const refresh = () => { sh.close(); manageSources(onDone); };
  body.querySelector('.int-form').onsubmit = async (e) => {
    e.preventDefault();
    const t = e.target.t.value.trim();
    if (!t) return;
    await saveSettings({ interests: [...new Set([...(settings().interests || []), t])] });
    refresh();
  };
  body.querySelector('.feed-form').onsubmit = async (e) => {
    e.preventDefault();
    const u = e.target.u.value.trim();
    if (!isUrl(u)) { toast('Enter a full feed URL'); return; }
    let title = new URL(u).hostname.replace(/^www\./, '');
    try { if (hasServer()) title = parseFeed(await api(`/api/fetch?url=${encodeURIComponent(u)}`)).title || title; } catch { /* keep hostname */ }
    await store.saveFeed({ url: u, title });
    refresh();
  };
  body.addEventListener('click', async (e) => {
    const di = e.target.closest('[data-del-int]');
    if (di) { await saveSettings({ interests: settings().interests.filter((x) => x !== di.dataset.delInt) }); refresh(); }
    const df = e.target.closest('[data-del-feed]');
    if (df && await confirmDialog('Remove this feed?', { ok: 'Remove', danger: true })) { const f = store.feeds().find((x) => x.id === df.dataset.delFeed); await store.saveFeed({ ...f, deleted: true }); refresh(); }
    const pr = e.target.closest('[data-preset]');
    if (pr) { const p = PRESET_FEEDS[+pr.dataset.preset]; if (!store.feeds().some((f) => f.url === p.url)) await store.saveFeed(p); refresh(); }
    if (e.target.closest('[data-a="gnews"]')) {
      const q = await promptDialog('Google News topic', { placeholder: 'e.g. Pope Leo, Roku apps, lofi music' });
      if (q) { await store.saveFeed({ url: googleNewsFeed(q), title: `Google News · ${q}` }); refresh(); }
    }
  });
}
