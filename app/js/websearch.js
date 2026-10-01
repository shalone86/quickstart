// Quick web search through your SearXNG instance.

import { settings, api, hasServer } from './settings.js';

/** Returns [{title, url, content, engine}] */
export async function webSearch(q, { page = 1 } = {}) {
  const inst = (settings().searxngUrl || '').replace(/\/+$/, '');
  if (hasServer()) {
    const j = await api(`/api/search?q=${encodeURIComponent(q)}&page=${page}${inst ? `&instance=${encodeURIComponent(inst)}` : ''}`);
    return normalize(j);
  }
  if (!inst) throw new Error('Add your SearXNG address in Settings → Web search.');
  const res = await fetch(`${inst}/search?q=${encodeURIComponent(q)}&format=json&pageno=${page}`);
  if (!res.ok) throw new Error(`SearXNG ${res.status} — enable the JSON format in its settings.yml (search.formats: [html, json])`);
  return normalize(await res.json());
}

function normalize(j) {
  return (j.results || []).map((r) => ({
    title: r.title || r.url,
    url: r.url,
    content: r.content || '',
    engine: r.engine || (r.engines || []).join(', '),
    image: r.img_src || r.thumbnail || '',
    date: r.publishedDate || '',
  })).filter((r) => r.url);
}

export const searchConfigured = () => hasServer() || !!settings().searxngUrl;
