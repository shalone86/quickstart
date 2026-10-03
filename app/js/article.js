// Turn a link into a clean, saved note — text and images intact.
// Order of attempts: your server's /api/fetch + Mozilla Readability → r.jina.ai reader (no setup) → direct fetch.

import * as store from './store.js';
import { settings, api, hasServer } from './settings.js';
import { sanitizeHTML } from './sanitize.js';
import { markdownToHtml } from './markdown.js';
import { importSession } from './history.js';
import { htmlToText } from './text.js';
import { esc, fmtDate } from './util.js';

async function fetchHTML(url) {
  if (hasServer()) return api(`/api/fetch?url=${encodeURIComponent(url)}`);
  const res = await fetch(url, { mode: 'cors' });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.text();
}

function readability(html, url) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const base = doc.createElement('base');
  base.href = url;
  doc.head.prepend(base);
  // lazy-loaded images: promote data-src to src before parsing
  doc.querySelectorAll('img[data-src], img[data-lazy-src], img[data-original]').forEach((img) => {
    img.setAttribute('src', img.getAttribute('data-src') || img.getAttribute('data-lazy-src') || img.getAttribute('data-original'));
  });
  const meta = (sel) => doc.querySelector(sel)?.getAttribute('content') || '';
  const leadImage = meta('meta[property="og:image"]') || meta('meta[name="twitter:image"]');
  const published = meta('meta[property="article:published_time"]') || meta('meta[name="citation_publication_date"]') || meta('meta[name="date"]');
  const doi = meta('meta[name="citation_doi"]') || meta('meta[name="dc.identifier"]');
  if (!window.Readability) throw new Error('Reader not loaded');
  const art = new window.Readability(doc, { charThreshold: 300, keepClasses: false }).parse();
  if (!art || !art.content) throw new Error('Could not find an article on that page');
  const site = art.siteName || meta('meta[property="og:site_name"]') || '';
  return {
    title: cleanTitle(art.title || doc.title, site),
    byline: art.byline || meta('meta[name="author"]') || meta('meta[name="citation_author"]'),
    siteName: art.siteName || meta('meta[property="og:site_name"]') || new URL(url).hostname.replace(/^www\./, ''),
    excerpt: art.excerpt,
    html: sanitizeHTML(art.content, { baseUrl: url }),
    leadImage: leadImage ? new URL(leadImage, url).href : '',
    published, doi,
  };
}

/** "Story title | Site Name" → "Story title" */
function cleanTitle(title, site) {
  const t = String(title || '').trim();
  const m = t.match(/^(.{12,}?)\s+[|–—·-]\s+([^|–—·]{2,60})$/);
  if (m && (!site || m[2].toLowerCase().includes(site.toLowerCase().slice(0, 8)) || site.toLowerCase().includes(m[2].toLowerCase()))) return m[1];
  return t;
}

async function viaJina(url) {
  const res = await fetch(`https://r.jina.ai/${url}`, { headers: { Accept: 'application/json', 'X-Return-Format': 'markdown' } });
  if (!res.ok) throw new Error(`Reader service ${res.status}`);
  const j = await res.json();
  const d = j.data || j;
  return {
    title: d.title || url,
    byline: '',
    siteName: new URL(url).hostname.replace(/^www\./, ''),
    excerpt: d.description || '',
    html: sanitizeHTML(markdownToHtml(d.content || ''), { baseUrl: url }),
    leadImage: '',
    published: d.publishedTime || '',
  };
}

export async function fetchArticle(url) {
  const errors = [];
  if (hasServer()) {
    try { return readability(await fetchHTML(url), url); } catch (e) { errors.push(`server: ${e.message}`); }
  }
  if (settings().readerFallback) {
    try { return await viaJina(url); } catch (e) { errors.push(`reader: ${e.message}`); }
  }
  try { return readability(await fetchHTML(url), url); } catch (e) { errors.push(`direct: ${e.message}`); }
  throw new Error(`Couldn't read that page (${errors.join('; ')}). Connect your Worker/server in Settings for best results.`);
}

const JUNK = /^(advertisement|ad|sponsored|read more|read next|related( stories| articles| coverage| content)?|more from|recommended|see also|also read|most read|trending|watch:?|listen:?|sign up|subscribe|get the newsletter|newsletter|follow us|share( this)?( article| story)?|click here|copy link|comments?|image credit|getty images|tags?:|topics?:)\b/i;

/**
 * Keeps the article body only: drops link lists, "Read more"/newsletter/share blocks and other
 * page furniture, and turns the remaining links into plain text. Images and headings stay.
 */
export function cleanArticleHTML(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  const root = tpl.content;
  root.querySelectorAll('nav, aside, footer, form, button, iframe, script, style, noscript, svg, [role="navigation"], [aria-hidden="true"]').forEach((el) => el.remove());
  const textLen = (el) => el.textContent.replace(/\s+/g, ' ').trim().length;
  const linkLen = (el) => [...el.querySelectorAll('a')].reduce((n, a) => n + textLen(a), 0);
  for (const el of [...root.querySelectorAll('p, li, ul, ol, div, section, h2, h3, h4, h5, h6, figcaption, blockquote, table')]) {
    if (!el.isConnected) continue;
    const t = textLen(el);
    if (el.querySelector('img') && t < 300) continue; // a figure: keep the picture
    const text = el.textContent.replace(/\s+/g, ' ').trim();
    if (!t) { if (!el.querySelector('img')) el.remove(); continue; }
    // mostly links (related stories, tag lists, "follow us on…"), or a short furniture line
    if ((linkLen(el) / t > 0.6 && t < 600) || (t < 120 && JUNK.test(text))) el.remove();
  }
  // links → plain text
  root.querySelectorAll('a').forEach((a) => a.replaceWith(...a.childNodes));
  // trailing horizontal rules / empty blocks
  root.querySelectorAll('hr').forEach((el) => el.remove());
  return tpl.innerHTML;
}

/** Downloads remote images into the note so they survive link rot and work offline. */
async function localizeImages(html, noteId) {
  if (!hasServer() || !settings().saveImagesOffline) return html;
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  const imgs = Array.from(tpl.content.querySelectorAll('img[src^="http"]')).slice(0, 40);
  await Promise.all(imgs.map(async (img) => {
    try {
      const res = await api(`/api/fetch?url=${encodeURIComponent(img.src)}&binary=1`, { raw: true });
      if (!res.ok) return;
      const blob = await res.blob();
      if (!blob.type.startsWith('image/') || blob.size > 8e6) return;
      const att = await store.addAttachment(blob, { kind: 'image', noteId, extra: { source: img.src } });
      img.dataset.remote = img.src;
      img.removeAttribute('src');
      img.dataset.att = att.id;
    } catch { /* keep the remote image */ }
  }));
  return tpl.innerHTML;
}

/**
 * Saves a web page as a note in the "Saved articles" folder (or `folderName`).
 * `paper` adds scholarly metadata (authors, venue, DOI, abstract) above the article.
 */
export async function saveArticle(url, { folderName, paper = null, fallbackHTML = '' } = {}) {
  // Google News links only open a Google page: save (and link to) the publisher's article instead
  if (/^https:\/\/news\.google\.com\/(rss\/)?articles\//.test(url) && hasServer()) {
    try { url = (await api(`/api/meta?url=${encodeURIComponent(url)}`)).url || url; } catch { /* keep the Google link */ }
  }
  let art = null, err = null;
  try { art = await fetchArticle(url); } catch (e) { err = e; }
  if (!art && !paper && !fallbackHTML) throw err;
  const title = paper?.title || art?.title || url;
  const meta = [];
  const by = paper?.authors?.length ? paper.authors.slice(0, 8).join(', ') + (paper.authors.length > 8 ? ' et al.' : '') : art?.byline;
  if (by) meta.push(esc(by));
  const venue = paper?.venue || art?.siteName;
  if (venue) meta.push(`<i>${esc(venue)}</i>`);
  const date = paper?.date || art?.published;
  if (date && !Number.isNaN(Date.parse(date))) meta.push(esc(fmtDate(Date.parse(date))));
  let html = `<h1>${esc(title)}</h1><p><small>${meta.join(' · ')}</small></p><p><a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(url.replace(/^https?:\/\//, '').slice(0, 80))}</a>${paper?.doi ? ` · DOI <a href="https://doi.org/${esc(paper.doi)}" target="_blank" rel="noopener noreferrer">${esc(paper.doi)}</a>` : ''}</p>`;
  if (paper?.abstract) html += `<blockquote><p><b>Abstract.</b> ${esc(paper.abstract)}</p></blockquote>`;
  if (art?.leadImage && !art.html.includes(art.leadImage)) html += `<p><img src="${esc(art.leadImage)}" alt=""></p>`;
  html += art ? (settings().cleanArticles ? cleanArticleHTML(art.html) : art.html) : fallbackHTML;
  if (!art && err) html += `<p><small>Full text could not be fetched (${esc(err.message)}).</small></p>`;
  html = sanitizeHTML(html);

  const folder = await store.folderByName(folderName || settings().savedFolder || 'Saved articles');
  const note = await store.createNote({
    html: '', title, titleManual: true, folderId: folder.id,
    source: { url, site: venue || '', kind: paper ? 'paper' : 'article', openalex: paper?.id || null, doi: paper?.doi || null },
  });
  html = await localizeImages(html, note.id);
  await store.updateNote(note.id, { html });
  await store.db.put('history', importSession(note.id, store.deviceId(), htmlToText(html), html, 'a'));
  return note;
}
