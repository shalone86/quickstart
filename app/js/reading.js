// What you like to read, learned from what you open and save in News and from a Google Takeout
// export of your Google News history. Used to sort Feeds "For you" and to suggest sources.
// Kept on this device (Settings), like the rest of the News preferences.

import { settings, saveSettings } from './settings.js';
import { tokenize } from './text.js';
import { readZip } from './zip.js';
import { hostOf, googleQuery } from './sources.js';

const STOP = new Set(`a an the and or but if then than of to in on at by for from with without into onto over under about after before
between during as is are was were be been being has have had do does did will would can could should may might must shall not no
yes this that these those it its it's he she they them his her their our we you your i me my mine us who whom whose which what when
where why how all any each every some most more less many much few new news says said say report reports update updates live latest
video photos watch read here just now today week year years day days time first last one two three after amid vs via up out off s t
inc ltd com www http https html amp per also still back get gets got make makes made take takes like over says new old top best`.split(/\s+/));

const MAX_TERMS = 800, MAX_SOURCES = 200;

export const profile = () => settings().readingProfile || { terms: {}, sources: {}, count: 0 };

export function termsOf(text) {
  return [...new Set(tokenize(text).filter((t) => t.length > 2 && !STOP.has(t) && !/^\d+$/.test(t)))];
}

/** Domain an article really comes from (Google News items carry the publisher in <source url>). */
export function articleSite(it) {
  return hostOf(it.sourceUrl || '') || (googleQuery(it.feedUrl || '') ? '' : hostOf(it.url)) || hostOf(it.url);
}

function prune(map, max) {
  const entries = Object.entries(map);
  if (entries.length <= max) return map;
  return Object.fromEntries(entries.sort((a, b) => b[1] - a[1]).slice(0, max));
}

function addTo(p, { title = '', summary = '', site = '' }, weight) {
  for (const t of termsOf(title)) p.terms[t] = (p.terms[t] || 0) + weight;
  for (const t of termsOf(summary).slice(0, 30)) p.terms[t] = (p.terms[t] || 0) + weight * 0.3;
  if (site && !/google\.com$/.test(site)) p.sources[site] = (p.sources[site] || 0) + weight;
  p.count = (p.count || 0) + 1;
}

/** Remember that you opened (weight 1) or saved (weight 2) an article. */
export async function learn(it, weight = 1) {
  const p = structuredClone(profile());
  addTo(p, { title: it.title, summary: it.summary, site: articleSite(it) }, weight);
  p.terms = prune(p.terms, MAX_TERMS);
  p.sources = prune(p.sources, MAX_SOURCES);
  await saveSettings({ readingProfile: p });
}

/** Higher = more like what you read. Mixes topic match, source affinity and freshness. */
export function score(it, p = profile(), now = Date.now()) {
  const terms = termsOf(it.title);
  let topic = 0;
  for (const t of terms) topic += Math.log1p(p.terms[t] || 0);
  topic /= Math.sqrt(Math.max(terms.length, 1));
  const source = Math.log1p(p.sources[articleSite(it)] || 0);
  const ageH = it.date ? Math.max(0, (now - Date.parse(it.date)) / 3600000) : 48;
  const fresh = Math.exp(-ageH / 24);
  return topic + source * 0.6 + fresh * 2.5;
}

/** Sorts by score, but spreads sources out so one busy feed can't fill the top of the list. */
export function rank(list, p = profile(), now = Date.now()) {
  const pool = list.map((it) => ({ it, s: score(it, p, now), src: articleSite(it) || it.source }));
  const used = {};
  const out = [];
  while (pool.length) {
    let best = 0, bestVal = -Infinity;
    for (let i = 0; i < pool.length; i++) {
      const v = pool[i].s - 0.8 * (used[pool[i].src] || 0);
      if (v > bestVal) { bestVal = v; best = i; }
    }
    const [x] = pool.splice(best, 1);
    used[x.src] = (used[x.src] || 0) + 1;
    out.push(x.it);
    if (out.length >= 200) break;
  }
  return out;
}

/* ---------------- Google Takeout import ---------------- */

const VERB = /^(viewed|visited|read|opened|watched|used|clicked|searched for|followed|saved)\s+/i;

function activityItem(title, url, time, sourceName = '') {
  title = String(title || '').replace(/ /g, ' ').replace(VERB, '').trim();
  if (!title || /^https?:\/\//.test(title) || title.length < 12) return null;
  const site = hostOf(url || '');
  return { title, site: /google\.com$/.test(site) ? '' : site, sourceName, time: time ? Date.parse(time) : NaN };
}

/** My Activity JSON (array of { header, title, titleUrl, time, products, subtitles }). */
function fromActivityJSON(data, newsOnly) {
  if (!Array.isArray(data)) return [];
  return data.filter((e) => e && typeof e === 'object' && e.title && (!newsOnly || /news/i.test(`${e.header} ${(e.products || []).join(' ')} ${e.titleUrl || ''}`)))
    .map((e) => activityItem(e.title, e.titleUrl, e.time, (e.subtitles || []).map((s) => s.name).filter(Boolean)[0] || ''))
    .filter(Boolean);
}

/** My Activity HTML: one .outer-cell per entry, "Viewed <a href>Headline</a><br>date". */
function fromActivityHTML(html, newsOnly) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const cells = [...doc.querySelectorAll('.outer-cell')];
  const out = [];
  for (const cell of cells.length ? cells : [doc.body]) {
    if (newsOnly && cells.length && !/news/i.test(cell.querySelector('.header-cell')?.textContent || cell.textContent.slice(0, 200))) continue;
    for (const a of cell.querySelectorAll('.content-cell a, a')) {
      const after = a.nextSibling?.nextSibling?.textContent || '';
      const it = activityItem(a.textContent, a.getAttribute('href'), /\d{4}/.test(after) ? after.replace(/\s+[A-Z]{2,4}$/, '') : '');
      if (it) out.push(it);
      if (cells.length) break;
    }
  }
  return out;
}

/**
 * Reads Google Takeout files: the whole Takeout .zip, or My Activity → Google News (MyActivity.json / .html).
 * Returns { items, files }.
 */
export async function parseTakeout(files) {
  const items = [];
  const used = [];
  const take = async (name, text) => {
    const newsOnly = !/news/i.test(name); // a file inside a News folder is all news
    let got = [];
    if (/\.json$/i.test(name)) { try { got = fromActivityJSON(JSON.parse(text), newsOnly); } catch { /* not JSON */ } }
    else if (/\.html?$/i.test(name)) got = fromActivityHTML(text, newsOnly);
    if (got.length) { items.push(...got); used.push(name); }
  };
  for (const f of files) {
    if (/\.zip$/i.test(f.name)) {
      const entries = await readZip(f, { filter: (n) => /\.(json|html?)$/i.test(n) && /news/i.test(n) });
      for (const e of entries) await take(e.name, new TextDecoder().decode(e.data));
    } else await take(f.name, await f.text());
  }
  return { items, files: used };
}

/** Adds imported history to the profile (recent reads count more) and returns a summary. */
export async function importHistory(items) {
  const p = structuredClone(profile());
  const now = Date.now();
  const names = {};
  for (const it of items) {
    const ageDays = Number.isNaN(it.time) ? 180 : (now - it.time) / 86400000;
    addTo(p, { title: it.title, site: it.site }, 0.4 + 0.6 * Math.exp(-ageDays / 120));
    if (it.sourceName) names[it.sourceName] = (names[it.sourceName] || 0) + 1;
  }
  p.terms = prune(p.terms, MAX_TERMS);
  p.sources = prune(p.sources, MAX_SOURCES);
  p.imported = { count: (p.imported?.count || 0) + items.length, at: now };
  await saveSettings({ readingProfile: p });
  const topSites = Object.entries(p.sources).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([s]) => s);
  const topNames = Object.entries(names).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([s]) => s);
  return { count: items.length, topSites, topNames, topics: topTopics(items) };
}

/** Repeated two-word phrases in headlines ("pope leo", "virginia beach") → topic suggestions. */
export function topTopics(items, limit = 8) {
  const counts = {};
  for (const it of items) {
    const words = tokenize(it.title).filter((t) => t.length > 1);
    const seen = new Set();
    for (let i = 0; i < words.length - 1; i++) {
      const [a, b] = [words[i], words[i + 1]];
      if (STOP.has(a) || STOP.has(b) || /^\d+$/.test(a + b)) continue;
      const k = `${a} ${b}`;
      if (!seen.has(k)) { counts[k] = (counts[k] || 0) + 1; seen.add(k); }
    }
  }
  return Object.entries(counts).filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]).slice(0, limit).map(([k]) => k);
}

export async function resetProfile() { await saveSettings({ readingProfile: { terms: {}, sources: {}, count: 0 } }); }
