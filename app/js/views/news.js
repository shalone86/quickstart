// News: "For you" papers (your interests + similar to what you saved), your RSS feeds, and paper search.
// Feeds: search and filter, sorted "For you" (what you read) or by time, featured images, related
// sources to add, and an import of your Google News history.
// Every item has Save → becomes a note in "Saved articles" with text and images.

import * as store from '../store.js';
import { settings, saveSettings, hasServer, api } from '../settings.js';
import { forYou, loadAllFeeds, searchPapers, similarPapers, paperByUrl, PRESET_FEEDS, googleNewsFeed, discoverFeed, searchNews } from '../feeds.js';
import { CATALOG, GROUPS, findSource, sourceForFeed, relatedSources, googleQuery } from '../sources.js';
import { profile, learn, rank, parseTakeout, importHistory, resetProfile } from '../reading.js';
import { saveArticle } from '../article.js';
import { tokenize } from '../text.js';
import { esc, fmtRelative, isUrl } from '../util.js';
import { icon } from '../icons.js';
import { h, sheet, toast, spinner, promptDialog, confirmDialog, pickFiles } from '../ui.js';
import { nav } from './common.js';

const cache = { forYou: null, feeds: null, at: 0 };
let tab = 'foryou';
let feedQuery = '';
let feedSource = 'all';

const local = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(`scriptorium.news.${k}`)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(`scriptorium.news.${k}`, JSON.stringify(v)); } catch { /* private mode */ } },
};

/* featured images + real links for articles whose feed has none (through the server, cached) */
const metaCache = new Map(Object.entries(local.get('meta', {})));
const saveMeta = () => local.set('meta', Object.fromEntries([...metaCache].slice(-600)));
async function articleMeta(it) {
  if (metaCache.has(it.url)) return metaCache.get(it.url);
  const m = await api(`/api/meta?url=${encodeURIComponent(it.url)}`).catch(() => null);
  const v = { image: m?.image || '', url: m?.url || '' };
  metaCache.set(it.url, v);
  saveMeta();
  return v;
}

export function renderNews(root) {
  root.innerHTML = `
    <header class="page-head"><div><div class="eyebrow">Your feed</div><h1>News & papers</h1></div>
      <div class="head-actions"><button class="icon-btn" data-a="refresh" aria-label="Refresh">${icon('refresh-cw')}</button><button class="icon-btn" data-a="manage" aria-label="Manage sources">${icon('settings')}</button></div></header>
    <div class="seg wide tabs"><button data-tab="foryou">${icon('sparkles')} For you</button><button data-tab="feeds">${icon('newspaper')} Feeds</button><button data-tab="search">${icon('search')} Search</button></div>
    <form class="search-bar news-save">${icon('link')}<input class="input" name="url" placeholder="Paste any article or paper link to save it" inputmode="url" autocomplete="off"></form>
    <div class="news-body"></div>`;
  const body = root.querySelector('.news-body');
  const items = new Map();
  let observer = null;

  const isSaved = (it) => store.liveNotes().some((n) => n.source && ((it.kind === 'paper' && n.source.openalex === it.id) || n.source.url === it.url || (it.realUrl && n.source.url === it.realUrl)));
  const saveBtn = (it) => {
    const saved = isSaved(it);
    return `<button class="btn small ${saved ? '' : 'primary'}" data-a="save" ${saved ? 'disabled' : ''}>${icon(saved ? 'check' : 'download')} ${saved ? 'Saved' : 'Save'}</button>`;
  };

  const paperCard = (it) => {
    items.set(it.id, it);
    return `<article class="news-card" data-id="${esc(it.id)}">
      <div class="news-src">${icon('book-open')} ${esc(it.venue || 'Paper')}${it.date ? ` · ${esc(it.date)}` : ''}${it.open ? ' · <span class="oa">Open access</span>' : ''}</div>
      <h3><a href="${esc(it.url)}" target="_blank" rel="noopener noreferrer" data-a="open">${esc(it.title)}</a></h3>
      <div class="news-authors">${esc(it.authors.slice(0, 5).join(', '))}${it.authors.length > 5 ? ' et al.' : ''}</div>
      ${it.abstract ? `<p class="news-sum clamp">${esc(it.abstract)}</p>` : ''}
      ${it.reason ? `<div class="news-reason">${icon('sparkles')} ${esc(it.reason)}</div>` : ''}
      <div class="news-btns">${saveBtn(it)}
        <button class="btn small ghost" data-a="similar">${icon('layers')} Similar</button>
        <a class="btn small ghost" href="${esc(it.url)}" target="_blank" rel="noopener noreferrer" data-a="open">${icon('external-link')} Open</a>
      </div></article>`;
  };

  // hero = big featured image on top; row = thumbnail beside the headline
  const articleCard = (it, variant = 'row') => {
    items.set(it.id, it);
    const img = it.image || metaCache.get(it.url)?.image || '';
    const needImg = !img && hasServer() && !metaCache.has(it.url);
    const href = it.realUrl || metaCache.get(it.url)?.url || it.url;
    const meta = `<div class="news-src">${esc(it.source || '')}${it.date ? ` · ${esc(fmtRelative(Date.parse(it.date)))}` : ''}</div>`;
    const btns = `<div class="news-btns">${saveBtn(it)}<a class="btn small ghost" href="${esc(href)}" target="_blank" rel="noopener noreferrer" data-a="open">${icon('external-link')} Open</a></div>`;
    if (variant === 'hero') {
      return `<article class="news-card news-hero ${img ? '' : 'no-img'}" data-id="${esc(it.id)}" ${needImg ? 'data-needimg' : ''}>
        <div class="news-hero-img">${img ? `<img src="${esc(img)}" alt="" referrerpolicy="no-referrer">` : ''}</div>
        <div class="news-hero-text">${meta}<h3><a href="${esc(href)}" target="_blank" rel="noopener noreferrer" data-a="open">${esc(it.title)}</a></h3>
        ${it.summary ? `<p class="news-sum clamp">${esc(it.summary)}</p>` : ''}${btns}</div></article>`;
    }
    return `<article class="news-card news-row ${img ? '' : 'no-img'}" data-id="${esc(it.id)}" ${needImg ? 'data-needimg' : ''}>
      <div class="news-row-main">${meta}<h3><a href="${esc(href)}" target="_blank" rel="noopener noreferrer" data-a="open">${esc(it.title)}</a></h3>
        ${it.summary ? `<p class="news-sum clamp2">${esc(it.summary)}</p>` : ''}</div>
      <div class="news-thumb">${img ? `<img src="${esc(img)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ''}</div>
      ${btns}</article>`;
  };

  const fillImages = (el) => {
    observer?.disconnect();
    if (!hasServer()) return;
    observer = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const cardEl = e.target;
        observer.unobserve(cardEl);
        cardEl.removeAttribute('data-needimg');
        const it = items.get(cardEl.dataset.id);
        if (!it) continue;
        articleMeta(it).then((m) => {
          if (m.url) { it.realUrl = m.url; cardEl.querySelectorAll('a[data-a="open"]').forEach((a) => { a.href = m.url; }); }
          if (!m.image) return;
          it.image = m.image;
          const slot = cardEl.querySelector('.news-thumb, .news-hero-img');
          if (slot && !slot.querySelector('img')) {
            const img = new Image();
            img.alt = '';
            img.referrerPolicy = 'no-referrer';
            img.onload = () => cardEl.classList.remove('no-img');
            img.onerror = () => img.remove();
            img.src = m.image;
            slot.appendChild(img);
          }
        });
      }
    }, { rootMargin: '400px 0px' });
    el.querySelectorAll('[data-needimg]').forEach((c) => observer.observe(c));
  };

  /* ---------------- Feeds tab ---------------- */

  const renderFeeds = () => {
    const { articles, errors } = cache.feeds;
    const feeds = store.feeds();
    const sort = local.get('sort', 'foryou');
    body.innerHTML = `
      <div class="feed-tools">
        <form class="search-bar feed-search">${icon('search')}<input class="input" name="q" placeholder="Search your feeds" autocomplete="off" enterkeyhint="search" value="${esc(feedQuery)}">
          <button type="button" class="icon-btn small" data-a="clear-q" aria-label="Clear search" ${feedQuery ? '' : 'hidden'}>${icon('x')}</button></form>
        <div class="seg feed-sort"><button data-sort="foryou" class="${sort === 'foryou' ? 'on' : ''}">${icon('sparkles')} For you</button><button data-sort="latest" class="${sort === 'latest' ? 'on' : ''}">Latest</button></div>
      </div>
      <div class="chip-scroll">${[{ id: 'all', title: 'All' }, ...feeds].map((f) => `<button class="filter-chip ${feedSource === f.id ? 'on' : ''}" data-src="${esc(f.id)}">${esc(shortName(f))}</button>`).join('')}</div>
      <div class="feed-notices"></div>
      <div class="feed-results"></div>`;
    renderNotices(errors);
    renderResults(articles);
    const f = body.querySelector('.feed-search');
    const clearBtn = f.querySelector('[data-a="clear-q"]');
    f.q.oninput = () => { feedQuery = f.q.value; clearBtn.hidden = !feedQuery; renderResults(articles); };
    f.onsubmit = (e) => { e.preventDefault(); f.q.blur(); if (feedQuery.trim()) webSearch(feedQuery.trim()); };
  };

  const shortName = (f) => f.title === 'All' ? 'All' : (sourceForFeed(f)?.name || f.title.replace(/^Google News · /, '')).trim();

  const renderResults = (articles) => {
    const out = body.querySelector('.feed-results');
    const terms = tokenize(feedQuery);
    let list = articles.filter((a) => feedSource === 'all' || a.feedId === feedSource);
    if (terms.length) list = list.filter((a) => { const hay = tokenize(`${a.title} ${a.summary} ${a.source}`).join(' '); return terms.every((t) => hay.includes(t)); });
    if (local.get('sort', 'foryou') === 'foryou') {
      list = rank(list);
    }
    list = list.slice(0, 150);
    if (!list.length) {
      out.innerHTML = terms.length
        ? `<div class="empty small">${icon('search', 'empty-ic')}<h3>Nothing in your feeds matches “${esc(feedQuery)}”</h3><button class="btn primary" data-a="web-search">${icon('search')} Search all news for “${esc(feedQuery)}”</button></div>`
        : '<p class="muted hint">No articles right now.</p>';
      return;
    }
    const heroIdx = Math.max(0, list.findIndex((a) => a.image || metaCache.get(a.url)?.image));
    const hero = heroIdx < 5 ? list.splice(heroIdx, 1)[0] : list.shift();
    out.innerHTML = `<div class="news-list">${articleCard(hero, 'hero')}${list.map((a) => articleCard(a)).join('')}</div>
      ${terms.length ? `<button class="btn ghost wide-btn" data-a="web-search">${icon('search')} Search all news for “${esc(feedQuery)}”</button>` : ''}`;
    fillImages(out);
  };

  const webSearch = async (q) => {
    const out = body.querySelector('.feed-results');
    out.innerHTML = spinner(`Searching news for “${q}”…`);
    try {
      const res = await searchNews(q);
      const followed = store.feeds().some((f) => googleQuery(f.url) === q);
      out.innerHTML = `<div class="web-head"><div><div class="eyebrow">Google News</div><h3>“${esc(q)}”</h3></div>
          ${followed ? `<span class="muted small">${icon('check')} Following</span>` : `<button class="btn small primary" data-a="follow-q">${icon('plus')} Follow topic</button>`}</div>
        ${res.length ? `<div class="news-list">${articleCard(res[0], 'hero')}${res.slice(1, 60).map((a) => articleCard(a)).join('')}</div>` : '<p class="muted hint">No news found.</p>'}`;
      out.querySelector('[data-a="follow-q"]')?.addEventListener('click', async (e) => {
        await store.saveFeed({ url: googleNewsFeed(q), title: `Google News · ${q}` });
        e.target.closest('button').outerHTML = `<span class="muted small">${icon('check')} Following</span>`;
        cache.feeds = null;
        toast(`Following “${q}”`);
      });
      fillImages(out);
    } catch (err) { out.innerHTML = `<p class="error">${esc(err.message)}</p>`; }
  };

  // Broken-feed warning (dismissible, with Fix/Remove) and source suggestions
  const renderNotices = (errors) => {
    const box = body.querySelector('.feed-notices');
    const errKey = errors.map((e) => e.id).sort().join(',');
    const parts = [];
    if (errors.length && local.get('dismissedErrors', '') !== errKey) {
      parts.push(`<div class="notice warn-card" data-key="${esc(errKey)}">
        <div class="notice-head">${icon('cloud-off')}<b>Couldn't load ${errors.length === 1 ? 'a feed' : `${errors.length} feeds`}</b><button class="icon-btn small" data-a="dismiss-warn" aria-label="Dismiss">${icon('x')}</button></div>
        ${errors.map((e) => `<div class="notice-row" data-feed="${esc(e.id)}"><div><b>${esc(e.title)}</b><small>${esc(/Failed to fetch/.test(e.error) && !hasServer() ? 'Needs your server (Settings → Sync)' : e.error)}</small></div>
          <button class="btn small" data-a="fix-feed">${icon('wand-sparkles')} Fix</button><button class="btn small ghost" data-a="remove-feed">${icon('trash-2')}</button></div>`).join('')}
      </div>`);
    }
    // Google News searches for an outlet → that outlet's own feed
    const upgrades = store.feeds().map((f) => [f, googleQuery(f.url) && findSource(googleQuery(f.url))]).filter(([f, s]) => s && s.url !== f.url && !store.feeds().some((x) => x.url === s.url));
    const dismissed = local.get('dismissedSources', []);
    const related = relatedSources(store.feeds(), { affinity: profile().sources, dismissed, limit: 5 });
    if (upgrades.length || related.length) {
      parts.push(`<div class="notice suggest-card">
        <div class="notice-head">${icon('sparkles')}<b>${related[0]?.because ? `Because you follow ${esc(related[0].because)}` : 'Sources for you'}</b><button class="icon-btn small" data-a="dismiss-suggest" aria-label="Not now">${icon('x')}</button></div>
        <div class="pill-row">
          ${upgrades.map(([f, s]) => `<button class="pill" data-upgrade="${esc(f.id)}" data-name="${esc(s.name)}">${icon('wand-sparkles')} Use ${esc(s.name)}'s own feed</button>`).join('')}
          ${related.map((r) => `<button class="pill" data-add-source="${esc(r.source.name)}">${icon('plus')} ${esc(r.source.name)}</button>`).join('')}
        </div></div>`);
    }
    box.innerHTML = parts.join('');
  };

  const reloadFeeds = async () => { cache.feeds = null; await show(true); };

  const show = async (force = false) => {
    observer?.disconnect();
    root.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
    if (tab === 'foryou') {
      if (!settings().interests?.length && !store.liveNotes().some((n) => n.source?.openalex)) {
        body.innerHTML = `<div class="empty">${icon('sparkles', 'empty-ic')}<h3>Tell me what you like to read</h3><p>Add a few interests and I'll pull in new papers every day, plus papers similar to the ones you save.</p><button class="btn primary" data-a="manage">Add interests</button></div>`;
        return;
      }
      body.innerHTML = spinner('Finding new papers…');
      try {
        if (force || !cache.forYou || Date.now() - cache.at > 30 * 60 * 1000) { cache.forYou = await forYou(); cache.at = Date.now(); }
        body.innerHTML = cache.forYou.length ? `<div class="news-list">${cache.forYou.map(paperCard).join('')}</div>` : '<p class="muted hint">Nothing new right now.</p>';
      } catch (e) { body.innerHTML = `<p class="error">${esc(e.message)}</p>`; }
    } else if (tab === 'feeds') {
      if (!store.feeds().length) {
        body.innerHTML = `<div class="empty">${icon('newspaper', 'empty-ic')}<h3>No feeds yet</h3><p>Add news sites, journals, blogs or a Google News topic.</p><button class="btn primary" data-a="manage">Add feeds</button></div>`;
        return;
      }
      if (!store.feeds().some((f) => f.id === feedSource)) feedSource = 'all';
      if (force || !cache.feeds) {
        body.innerHTML = spinner('Loading feeds…');
        try { cache.feeds = await loadAllFeeds(); } catch (e) { body.innerHTML = `<p class="error">${esc(e.message)}</p>`; return; }
      }
      renderFeeds();
    } else {
      body.innerHTML = `<form class="search-bar paper-search">${icon('search')}<input class="input" name="q" placeholder="Search 250M+ papers (OpenAlex)" autocomplete="off" enterkeyhint="search"></form><div class="paper-results"></div>`;
      const f = body.querySelector('.paper-search');
      f.onsubmit = async (e) => {
        e.preventDefault();
        const out = body.querySelector('.paper-results');
        out.innerHTML = spinner('Searching papers…');
        try { const res = await searchPapers(f.q.value.trim()); out.innerHTML = `<div class="news-list">${res.map(paperCard).join('')}</div>`; } catch (err) { out.innerHTML = `<p class="error">${esc(err.message)}</p>`; }
      };
      f.q.focus();
    }
  };

  const doSave = async (b, it) => {
    b.disabled = true;
    b.innerHTML = `${icon('refresh-cw', 'spin')} Saving…`;
    try {
      const note = await saveArticle(it.realUrl || it.url, it.kind === 'paper' ? { paper: it, fallbackHTML: '' } : {});
      b.innerHTML = `${icon('check')} Saved`;
      b.classList.remove('primary');
      if (it.kind !== 'paper') learn(it, 2);
      toast('Saved to your notes', { action: 'Open', onAction: () => nav(`#/note/${note.id}`) });
    } catch (err) {
      b.disabled = false;
      b.innerHTML = `${icon('download')} Save`;
      toast(err.message, { kind: 'error' });
    }
  };

  root.addEventListener('click', async (e) => {
    const tb = e.target.closest('[data-tab]');
    if (tb) { tab = tb.dataset.tab; show(); return; }
    const sortBtn = e.target.closest('[data-sort]');
    if (sortBtn) { local.set('sort', sortBtn.dataset.sort); body.querySelectorAll('[data-sort]').forEach((x) => x.classList.toggle('on', x === sortBtn)); renderResults(cache.feeds.articles); return; }
    const srcChip = e.target.closest('[data-src]');
    if (srcChip) { feedSource = srcChip.dataset.src; body.querySelectorAll('[data-src]').forEach((x) => x.classList.toggle('on', x === srcChip)); renderResults(cache.feeds.articles); return; }
    const addSrc = e.target.closest('[data-add-source]');
    if (addSrc) {
      const s = CATALOG.find((c) => c.name === addSrc.dataset.addSource);
      if (s) { await store.saveFeed({ url: s.url, title: s.name }); toast(`Added ${s.name}`); reloadFeeds(); }
      return;
    }
    const up = e.target.closest('[data-upgrade]');
    if (up) {
      const f = store.feeds().find((x) => x.id === up.dataset.upgrade);
      const s = CATALOG.find((c) => c.name === up.dataset.name);
      if (f && s) { await store.saveFeed({ ...f, url: s.url, title: s.name }); toast(`Switched to ${s.name}'s own feed`); reloadFeeds(); }
      return;
    }
    const b = e.target.closest('[data-a]');
    if (!b) return;
    const a = b.dataset.a;
    if (a === 'refresh') { show(true); return; }
    if (a === 'manage') { manageSources(() => { cache.forYou = null; cache.feeds = null; show(true); }); return; }
    if (a === 'clear-q') { feedQuery = ''; renderFeeds(); return; }
    if (a === 'web-search') { webSearch(feedQuery.trim()); return; }
    if (a === 'dismiss-warn') { local.set('dismissedErrors', b.closest('.notice').dataset.key); b.closest('.notice').remove(); return; }
    if (a === 'dismiss-suggest') {
      const names = [...b.closest('.notice').querySelectorAll('[data-add-source]')].map((x) => x.dataset.addSource);
      local.set('dismissedSources', [...local.get('dismissedSources', []), ...names]);
      b.closest('.notice').remove();
      return;
    }
    if (a === 'fix-feed' || a === 'remove-feed') {
      const f = store.feeds().find((x) => x.id === b.closest('[data-feed]').dataset.feed);
      if (!f) return;
      if (a === 'remove-feed') { await store.saveFeed({ ...f, deleted: true }); toast(`Removed ${f.title}`); reloadFeeds(); return; }
      b.disabled = true;
      b.innerHTML = `${icon('refresh-cw', 'spin')} Fixing…`;
      try {
        const known = sourceForFeed(f);
        const found = known && known.url !== f.url ? { url: known.url, title: known.name } : await discoverFeed(f.url);
        await store.saveFeed({ ...f, url: found.url, title: found.title || f.title });
        toast(`Fixed ${found.title || f.title}`);
        reloadFeeds();
      } catch (err) { b.disabled = false; b.innerHTML = `${icon('wand-sparkles')} Fix`; toast(`${err.message}. Try removing it and adding the site by name.`, { kind: 'error', timeout: 6000 }); }
      return;
    }
    const cardEl = b.closest('.news-card');
    const it = cardEl && items.get(cardEl.dataset.id);
    if (!it) return;
    if (a === 'open' && it.kind !== 'paper') learn(it, 1);
    if (a === 'save') doSave(b, it);
    if (a === 'similar') {
      const s = sheet({ title: 'Similar papers', body: spinner('Looking…'), full: true });
      try {
        const res = await similarPapers(it.id);
        s.body.innerHTML = res.length ? `<div class="news-list">${res.map(paperCard).join('')}</div>` : '<p class="muted hint">No related papers found.</p>';
        bindSaveIn(s.body);
      } catch (err) { s.body.innerHTML = `<p class="error">${esc(err.message)}</p>`; }
    }
  });

  // saves inside the "Similar" sheet (outside root)
  const bindSaveIn = (el) => el.addEventListener('click', (ev) => {
    const x = ev.target.closest('[data-a="save"]');
    if (x) doSave(x, items.get(x.closest('.news-card').dataset.id));
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
  return () => { observer?.disconnect(); };
}

/* ---------------- Manage sources ---------------- */

/** Adds a feed from a URL, a site/homepage link, or an outlet's name ("BBC"). Returns the saved feed. */
async function addFeedFrom(input) {
  const known = findSource(input.replace(/^https?:\/\//, '').replace(/\/.*$/, ''));
  if (known && (!isUrl(input) || !/\b(rss|feed|xml|atom)\b/i.test(input))) return store.saveFeed({ url: known.url, title: known.name });
  if (!isUrl(input)) return store.saveFeed({ url: googleNewsFeed(input), title: `Google News · ${input}` });
  let found = { url: input, title: new URL(input).hostname.replace(/^www\./, '') };
  if (hasServer()) found = await discoverFeed(input);
  return store.saveFeed({ url: found.url, title: found.title || new URL(input).hostname.replace(/^www\./, '') });
}

function manageSources(onDone) {
  const s0 = settings();
  const followed = new Set(store.feeds().map((f) => sourceForFeed(f)?.name).filter(Boolean));
  const p = profile();
  const topSites = Object.entries(p.sources || {}).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([s]) => s);
  const body = h(`<div class="manage">
    <h3 class="sec-title">${icon('newspaper')} Your feeds</h3>
    <div class="feed-list">${store.feeds().map((f) => `<div class="feed-row"><div><b>${esc(f.title)}</b><small>${esc(f.url)}</small></div><button class="icon-btn" data-del-feed="${f.id}" aria-label="Remove">${icon('trash-2')}</button></div>`).join('') || '<p class="muted small">No feeds yet.</p>'}</div>
    <form class="row-form feed-form"><input class="input" name="u" placeholder="Site name, website or feed link (e.g. BBC, wavy.com)"><button class="btn">Add</button></form>
    <button class="btn ghost" data-a="gnews">${icon('search')} Follow a Google News topic…</button>

    <h3 class="sec-title">${icon('layers')} Browse sources</h3>
    ${Object.entries(GROUPS).map(([g, label]) => `<h4 class="muted small">${esc(label)}</h4>
      <div class="pill-row">${CATALOG.filter((c) => c.groups[0] === g).map((c) => followed.has(c.name)
        ? `<span class="pill ghost">${icon('check')} ${esc(c.name)}</span>`
        : `<button class="pill" data-catalog="${esc(c.name)}">${icon('plus')} ${esc(c.name)}</button>`).join('')}</div>`).join('')}

    <h3 class="sec-title">${icon('history')} What you read</h3>
    <p class="muted small">Feeds → “For you” puts stories like the ones you open and save first.${p.count ? ` Learned from ${p.count.toLocaleString()} articles${topSites.length ? ` — most from ${esc(topSites.join(', '))}` : ''}.` : ''}</p>
    <div class="pill-row"><button class="pill" data-a="import-google">${icon('upload')} Import Google News history</button>${p.count ? `<button class="pill ghost" data-a="reset-reading">Forget</button>` : ''}</div>
    <details class="howto"><summary>How to get your Google News history</summary>
      <ol><li>Go to <b>takeout.google.com</b> and press <b>Deselect all</b>.</li>
      <li>Tick <b>My Activity</b>, press <b>All activity data included</b>, choose only <b>Google News</b>, and set the format to <b>JSON</b> (HTML works too).</li>
      <li>Create the export, download the zip, and pick it here. Only your Google News reading is used, and it stays on this device.</li></ol></details>

    <h3 class="sec-title">${icon('sparkles')} Interests (papers)</h3>
    <p class="muted small">New papers matching these appear in “For you”, along with papers similar to ones you save.</p>
    <div class="chip-edit interests">${(s0.interests || []).map((t) => `<span class="chip">${esc(t)}<button data-del-int="${esc(t)}" aria-label="Remove">${icon('x')}</button></span>`).join('')}</div>
    <form class="row-form int-form"><input class="input" name="t" placeholder="Add an interest, e.g. sacred music"><button class="btn">Add</button></form>
    <h4 class="muted small">Journals & papers</h4>
    <div class="pill-row">${PRESET_FEEDS.map((pf, i) => `<button class="pill" data-preset="${i}">${icon('plus')} ${esc(pf.title)}</button>`).join('')}</div>
  </div>`);
  const sh = sheet({ title: 'News sources', body, full: true, onClose: onDone });
  const refresh = () => { const top = sh.body.scrollTop; sh.close(); manageSources(onDone); requestAnimationFrame(() => { document.querySelector('.sheet-backdrop:last-child .sheet-body')?.scrollTo(0, top); }); };
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
    if (!u) return;
    const btn = e.target.querySelector('button');
    btn.disabled = true;
    try { const f = await addFeedFrom(u); toast(`Added ${f.title}`); refresh(); } catch (err) { btn.disabled = false; toast(err.message, { kind: 'error' }); }
  };
  body.addEventListener('click', async (e) => {
    const di = e.target.closest('[data-del-int]');
    if (di) { await saveSettings({ interests: settings().interests.filter((x) => x !== di.dataset.delInt) }); refresh(); }
    const df = e.target.closest('[data-del-feed]');
    if (df && await confirmDialog('Remove this feed?', { ok: 'Remove', danger: true })) { const f = store.feeds().find((x) => x.id === df.dataset.delFeed); await store.saveFeed({ ...f, deleted: true }); refresh(); }
    const pr = e.target.closest('[data-preset]');
    if (pr) { const pf = PRESET_FEEDS[+pr.dataset.preset]; if (!store.feeds().some((f) => f.url === pf.url)) await store.saveFeed(pf); refresh(); }
    const cat = e.target.closest('[data-catalog]');
    if (cat) { const c = CATALOG.find((x) => x.name === cat.dataset.catalog); await store.saveFeed({ url: c.url, title: c.name }); toast(`Added ${c.name}`); refresh(); }
    if (e.target.closest('[data-a="gnews"]')) {
      const q = await promptDialog('Google News topic', { placeholder: 'e.g. Pope Leo, Roku apps, lofi music' });
      if (q) { await store.saveFeed({ url: googleNewsFeed(q), title: `Google News · ${q}` }); refresh(); }
    }
    if (e.target.closest('[data-a="reset-reading"]') && await confirmDialog('Forget what you read? “For you” will start learning again.', { ok: 'Forget', danger: true })) { await resetProfile(); refresh(); }
    if (e.target.closest('[data-a="import-google"]')) importGoogle(refresh);
  });
}

async function importGoogle(onDone) {
  const files = await pickFiles({ accept: '.zip,.json,.html,application/zip,application/json,text/html', multiple: true });
  if (!files.length) return;
  const close = toast('Reading your Google News history…', { timeout: 120000 });
  let parsed;
  try { parsed = await parseTakeout(files); } catch (err) { close(); toast(`Couldn't read that file: ${err.message}`, { kind: 'error' }); return; }
  close();
  if (!parsed.items.length) {
    toast('No Google News activity found in that file. Export My Activity → Google News (see the steps below the button).', { kind: 'error', timeout: 8000 });
    return;
  }
  const sum = await importHistory(parsed.items);
  const have = new Set(store.feeds().map((f) => sourceForFeed(f)?.name).filter(Boolean));
  const sources = [...new Map([...sum.topSites, ...sum.topNames].map((x) => findSource(x)).filter((s) => s && !have.has(s.name)).map((s) => [s.name, s])).values()].slice(0, 10);
  const topics = sum.topics.filter((t) => !store.feeds().some((f) => googleQuery(f.url) === t));
  const body = h(`<div class="manage">
    <p>Learned from <b>${sum.count.toLocaleString()}</b> articles you read on Google News. Feeds → <b>For you</b> now puts stories like these first.</p>
    ${sources.length ? `<h3 class="sec-title">${icon('newspaper')} Sources you read most</h3><div class="pill-row">${sources.map((s) => `<button class="pill" data-catalog="${esc(s.name)}">${icon('plus')} ${esc(s.name)}</button>`).join('')}</div>` : ''}
    ${topics.length ? `<h3 class="sec-title">${icon('sparkles')} Topics you follow</h3><div class="pill-row">${topics.map((t) => `<button class="pill" data-topic="${esc(t)}">${icon('plus')} ${esc(t)}</button>`).join('')}</div>` : ''}
  </div>`);
  const sh = sheet({ title: 'Google News imported', body, onClose: onDone });
  body.addEventListener('click', async (e) => {
    const c = e.target.closest('[data-catalog]');
    const t = e.target.closest('[data-topic]');
    if (!c && !t) return;
    const btn = c || t;
    if (c) { const s = CATALOG.find((x) => x.name === c.dataset.catalog); await store.saveFeed({ url: s.url, title: s.name }); }
    if (t) await store.saveFeed({ url: googleNewsFeed(t.dataset.topic), title: `Google News · ${t.dataset.topic}` });
    btn.outerHTML = `<span class="pill ghost">${icon('check')} ${esc(btn.textContent.trim())}</span>`;
  });
  return sh;
}
