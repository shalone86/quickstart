// Your own news: research papers (OpenAlex — free, no key) for your interests and papers similar
// to ones you saved, plus any RSS/Atom feeds (news sites, journals, arXiv, Google News searches).

import * as store from './store.js';
import { settings, api, hasServer } from './settings.js';
import { sourceForFeed, googleQuery } from './sources.js';

const OA = 'https://api.openalex.org';
const MAILTO = 'mailto=scriptorium-notes@users.noreply.github.com';

export const PRESET_FEEDS = [
  { title: 'arXiv · AI (cs.AI)', url: 'https://rss.arxiv.org/rss/cs.AI' },
  { title: 'arXiv · Computation & Language', url: 'https://rss.arxiv.org/rss/cs.CL' },
  { title: 'Nature', url: 'https://www.nature.com/nature.rss' },
  { title: 'Science (current issue)', url: 'https://www.science.org/action/showFeed?type=etoc&feed=rss&jc=science' },
  { title: 'Vatican News', url: 'https://www.vaticannews.va/en.rss.xml' },
  { title: 'Hacker News (front page)', url: 'https://hnrss.org/frontpage' },
];

export function googleNewsFeed(query) {
  return `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
}

/* ---------------- OpenAlex ---------------- */

function abstractFrom(inv) {
  if (!inv) return '';
  const words = [];
  for (const [w, idxs] of Object.entries(inv)) for (const i of idxs) words[i] = w;
  return words.filter(Boolean).join(' ');
}

export function paperFromWork(w) {
  const id = String(w.id || '').split('/').pop();
  const loc = w.primary_location || {};
  const doi = w.doi ? w.doi.replace(/^https?:\/\/doi\.org\//, '') : '';
  return {
    kind: 'paper',
    id,
    title: w.display_name || w.title || 'Untitled',
    authors: (w.authorships || []).map((a) => a.author?.display_name).filter(Boolean),
    venue: loc.source?.display_name || '',
    date: w.publication_date || '',
    abstract: abstractFrom(w.abstract_inverted_index),
    url: w.open_access?.oa_url || loc.landing_page_url || (doi ? `https://doi.org/${doi}` : w.id),
    doi,
    cited: w.cited_by_count || 0,
    open: !!w.open_access?.is_oa,
    topic: w.primary_topic?.display_name || '',
  };
}

async function oa(path) {
  // OpenAlex has a free daily budget per IP address; a free personal key (Settings → News) raises it.
  const key = settings().openalexKey;
  const auth = key ? `api_key=${encodeURIComponent(key)}` : MAILTO;
  const res = await fetch(`${OA}${path}${path.includes('?') ? '&' : '?'}${auth}`);
  if (res.status === 429) throw new Error('OpenAlex daily free limit reached — add a free OpenAlex key in Settings → News');
  if (!res.ok) throw new Error(`OpenAlex ${res.status}`);
  return res.json();
}

/** Recent papers for one interest (last ~120 days, most relevant first). */
export async function papersFor(query, { days = 120, perPage = 15 } = {}) {
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const j = await oa(`/works?search=${encodeURIComponent(query)}&filter=from_publication_date:${since},has_abstract:true&sort=relevance_score:desc&per-page=${perPage}`);
  return (j.results || []).map(paperFromWork).map((p) => ({ ...p, reason: query }));
}

/** Papers related to a saved paper (OpenAlex "related works"). */
export async function similarPapers(openalexId, { perPage = 10 } = {}) {
  const j = await oa(`/works?filter=related_to:${encodeURIComponent(openalexId)}&sort=publication_date:desc&per-page=${perPage}`);
  return (j.results || []).map(paperFromWork);
}

export async function searchPapers(q, { perPage = 20 } = {}) {
  const j = await oa(`/works?search=${encodeURIComponent(q)}&per-page=${perPage}`);
  return (j.results || []).map(paperFromWork);
}

/** Look up a DOI / arXiv / OpenAlex link the user pasted. */
export async function paperByUrl(url) {
  const m = url.match(/10\.\d{4,9}\/[^\s?#]+/);
  if (m) return paperFromWork(await oa(`/works/doi:${encodeURIComponent(m[0])}`));
  const arx = url.match(/arxiv\.org\/(?:abs|pdf)\/(\d{4}\.\d{4,5})/);
  if (arx) return paperFromWork(await oa(`/works/doi:10.48550/arXiv.${arx[1]}`));
  return null;
}

/** "For you": interests + papers similar to the ones you saved, de-duplicated. */
export async function forYou() {
  const s = settings();
  const saved = store.liveNotes().filter((n) => n.source?.openalex).sort((a, b) => b.created - a.created).slice(0, 4);
  const savedIds = new Set(store.liveNotes().map((n) => n.source?.openalex).filter(Boolean));
  let lastError = null;
  const soft = (e) => { lastError = e; return []; };
  const jobs = [
    ...(s.interests || []).filter(Boolean).map((q) => papersFor(q).catch(soft)),
    ...saved.map((n) => similarPapers(n.source.openalex).then((ps) => ps.map((p) => ({ ...p, reason: `Similar to “${n.title}”` }))).catch(soft)),
  ];
  const lists = await Promise.all(jobs);
  if (lastError && lists.every((l) => !l.length)) throw lastError;
  // interleave so every interest shows up near the top
  const seen = new Set(), out = [];
  const max = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < max; i++) {
    for (const l of lists) {
      const p = l[i];
      if (!p || seen.has(p.id) || savedIds.has(p.id)) continue;
      seen.add(p.id);
      out.push(p);
    }
  }
  return out;
}

/* ---------------- RSS / Atom ---------------- */

async function fetchText(url) {
  if (hasServer()) return api(`/api/fetch?url=${encodeURIComponent(url)}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status}`);
  return res.text();
}

/** Best image for a feed item: media:content/thumbnail (largest), image enclosure, then the first <img> in the text. */
function feedImage(it, summaryDoc) {
  const media = [...it.getElementsByTagNameNS('*', 'content'), ...it.getElementsByTagNameNS('*', 'thumbnail')]
    .filter((m) => m.getAttribute('url') && (m.localName === 'thumbnail' || /image/.test(m.getAttribute('medium') || m.getAttribute('type') || 'image') || /\.(jpe?g|png|webp|avif)(\?|$)/i.test(m.getAttribute('url'))))
    .sort((a, b) => (+b.getAttribute('width') || 0) - (+a.getAttribute('width') || 0));
  const enclosure = [...it.querySelectorAll('enclosure, link[rel="enclosure"]')].find((e) => /^image/.test(e.getAttribute('type') || '') || /\.(jpe?g|png|webp)(\?|$)/i.test(e.getAttribute('url') || e.getAttribute('href') || ''));
  const encoded = it.getElementsByTagNameNS('*', 'encoded')[0]?.textContent || '';
  const inline = summaryDoc.querySelector('img')?.getAttribute('src') || (encoded && new DOMParser().parseFromString(encoded, 'text/html').querySelector('img')?.getAttribute('src')) || '';
  const url = media[0]?.getAttribute('url') || enclosure?.getAttribute('url') || enclosure?.getAttribute('href') || inline || '';
  // tracking pixels and feed logos aren't images worth showing
  return /^https?:/.test(url) && !/(pixel|spacer|1x1|feedburner|gravatar)/i.test(url) ? url : '';
}

export function parseFeed(xml, feedTitle = '') {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('Not a valid feed');
  const text = (el, sel) => el.querySelector(sel)?.textContent?.trim() || '';
  const channelTitle = text(doc, 'channel > title') || text(doc, 'feed > title') || feedTitle;
  const items = [];
  for (const it of doc.querySelectorAll('item, entry')) {
    const linkEl = it.querySelector('link[rel="alternate"]') || it.querySelector('link');
    const link = linkEl?.getAttribute('href') || linkEl?.textContent?.trim() || text(it, 'guid');
    const rawSummary = text(it, 'description') || text(it, 'summary') || text(it, 'content');
    const summaryDoc = new DOMParser().parseFromString(rawSummary, 'text/html');
    const img = feedImage(it, summaryDoc);
    const date = text(it, 'pubDate') || text(it, 'published') || text(it, 'updated') || it.getElementsByTagNameNS('*', 'date')[0]?.textContent || '';
    items.push({
      kind: 'article',
      id: link,
      title: text(it, 'title') || link,
      url: link,
      summary: summaryDoc.body.textContent.replace(/\s+/g, ' ').trim().slice(0, 400),
      date: date && !Number.isNaN(Date.parse(date)) ? new Date(date).toISOString() : '',
      source: it.querySelector('source')?.textContent?.trim() || channelTitle,
      sourceUrl: it.querySelector('source')?.getAttribute('url') || '',
      image: img,
    });
  }
  return { title: channelTitle, items };
}

const looksLikeHTML = (text) => /^\s*(<!doctype html|<html)/i.test(text) || (/<html[\s>]/i.test(text.slice(0, 2000)) && !/<(rss|feed|rdf:RDF)[\s>]/i.test(text.slice(0, 2000)));

/**
 * The RSS/Atom feed behind a link: the link itself if it's a feed, else the feed the page advertises,
 * else the usual /feed, /rss paths. Returns { url, title } or throws.
 */
export async function discoverFeed(url) {
  const text = await fetchText(url);
  if (!looksLikeHTML(text)) return { url, title: parseFeed(text).title };
  const doc = new DOMParser().parseFromString(text, 'text/html');
  const links = [...doc.querySelectorAll('link[rel~="alternate"]')]
    .filter((l) => /(rss|atom)\+xml/i.test(l.getAttribute('type') || '') && !/comments?/i.test(l.getAttribute('href') || ''))
    .map((l) => new URL(l.getAttribute('href'), url).href);
  const origin = new URL(url).origin;
  for (const candidate of [...links, `${origin}/feed/`, `${origin}/rss`, `${origin}/rss.xml`, `${origin}/feed.xml`, `${origin}/index.xml`]) {
    try {
      const xml = await fetchText(candidate);
      if (looksLikeHTML(xml)) continue;
      const parsed = parseFeed(xml);
      if (parsed.items.length) return { url: candidate, title: parsed.title };
    } catch { /* try the next one */ }
  }
  throw new Error("That page doesn't have an RSS feed");
}

export async function loadFeed(feed) {
  let xml = await fetchText(feed.url);
  if (looksLikeHTML(xml)) {
    // a homepage was added instead of its feed: find the real feed once and remember it
    const found = await discoverFeed(feed.url);
    const title = sourceForFeed(feed)?.name || (feed.title && !/^[\w.-]+\.\w+$/.test(feed.title) ? feed.title : found.title || feed.title);
    await store.saveFeed({ ...feed, url: found.url, title });
    feed = { ...feed, url: found.url, title };
    xml = await fetchText(found.url);
  }
  const parsed = parseFeed(xml, feed.title);
  // Google News items name their publisher; elsewhere the feed's own name reads better than its channel title
  const google = !!googleQuery(feed.url);
  return parsed.items.map((i) => ({ ...i, feedId: feed.id, feedUrl: feed.url, source: (google && i.source) || feed.title || i.source }));
}

/** One-off Google News search (not saved as a feed). */
export async function searchNews(query) {
  const parsed = parseFeed(await fetchText(googleNewsFeed(query)), 'Google News');
  return parsed.items.map((i) => ({ ...i, feedUrl: googleNewsFeed(query) }));
}

export async function loadAllFeeds() {
  const all = await Promise.all(store.feeds().map((f) => loadFeed(f).catch((e) => [{ kind: 'error', id: f.id, title: f.title, url: f.url, error: e.message }])));
  const items = all.flat();
  const errors = items.filter((i) => i.kind === 'error');
  const articles = items.filter((i) => i.kind !== 'error').sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  return { articles, errors };
}
