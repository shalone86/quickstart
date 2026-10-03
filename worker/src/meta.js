// Article metadata for the News tab — shared by the Cloudflare Worker and the Node home server.
// - Google News feed links (news.google.com/rss/articles/…) only open a Google page; resolve them
//   to the publisher's real URL so articles can be saved and their images shown.
// - pageMeta() reads just the <head> of an article for its featured image (og:image) and title.

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';

export const isGoogleNews = (url) => /^https:\/\/news\.google\.com\/(rss\/)?articles\//.test(url);

/** news.google.com/rss/articles/<id> → https://publisher.com/story (or the input if it can't be resolved). */
export async function resolveGoogleNews(url) {
  if (!isGoogleNews(url)) return url;
  try {
    const id = new URL(url).pathname.split('/').pop();
    const page = await (await fetch(`https://news.google.com/rss/articles/${id}`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10000) })).text();
    const sg = page.match(/data-n-a-sg="([^"]+)"/)?.[1];
    const ts = page.match(/data-n-a-ts="([^"]+)"/)?.[1];
    if (!sg || !ts) return url;
    const req = [[['Fbv4je', `["garturlreq",[["X","X",["X","X"],null,null,1,1,"US:en",null,1,null,null,null,null,null,0,1],"X","X",1,[1,1,1],1,1,null,0,0,null,0],"${id}",${ts},"${sg}"]`]]];
    const r = await fetch('https://news.google.com/_/DotsSplashUi/data/batchexecute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8', 'User-Agent': UA },
      body: `f.req=${encodeURIComponent(JSON.stringify(req))}`,
      signal: AbortSignal.timeout(10000),
    });
    const real = JSON.parse(JSON.parse((await r.text()).split('\n\n')[1])[0][2])[1];
    return /^https?:\/\//.test(real) ? real : url;
  } catch { return url; }
}

const attr = (tag, name) => (tag.match(new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i')) || []).slice(2).find((x) => x !== undefined) || '';
const decode = (s) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');

/** Featured image + title from a page's <head> (og:image / twitter:image / first link rel=image_src). */
export function metaFromHTML(html, baseUrl) {
  const head = html.slice(0, 400000);
  const metas = head.match(/<meta\b[^>]*>/gi) || [];
  const get = (...keys) => {
    for (const k of keys) {
      const tag = metas.find((m) => attr(m, 'property').toLowerCase() === k || attr(m, 'name').toLowerCase() === k);
      if (tag && attr(tag, 'content')) return decode(attr(tag, 'content'));
    }
    return '';
  };
  let image = get('og:image:secure_url', 'og:image', 'og:image:url', 'twitter:image', 'twitter:image:src');
  if (!image) image = decode(attr((head.match(/<link\b[^>]*rel=["']?image_src[^>]*>/i) || [''])[0], 'href'));
  try { if (image) image = new URL(image, baseUrl).href; } catch { image = ''; }
  // site logos and placeholders aren't featured images
  if (/(^|[/_-])(logo|default|placeholder|fallback|favicon)[^/]*\.(png|svg|jpe?g|webp)/i.test(image) || /googleusercontent\.com|gstatic\.com/.test(image)) image = '';
  return {
    image,
    title: get('og:title', 'twitter:title'),
    site: get('og:site_name'),
  };
}

/** Feed URLs a web page advertises (<link rel="alternate" type="application/rss+xml">). */
export function feedLinksFromHTML(html, baseUrl) {
  const out = [];
  for (const tag of html.slice(0, 400000).match(/<link\b[^>]*>/gi) || []) {
    if (!/rel\s*=\s*["']?alternate/i.test(tag) || !/(rss|atom)\+xml/i.test(attr(tag, 'type'))) continue;
    try { out.push({ url: new URL(decode(attr(tag, 'href')), baseUrl).href, title: decode(attr(tag, 'title')) }); } catch { /* skip */ }
  }
  return out.filter((f) => !/comments?\/?feed|\/comments\//i.test(f.url));
}

/** { url (resolved), image, title, site } for an article link. */
export async function pageMeta(url) {
  const real = await resolveGoogleNews(url);
  const r = await fetch(real, { headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.9' }, redirect: 'follow', signal: AbortSignal.timeout(12000) });
  if (!r.ok) return { url: real, image: '', title: '', site: '' };
  // the <head> is enough; stop reading after ~400 KB
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let html = '';
  while (html.length < 400000) {
    const { value, done } = await reader.read();
    if (done) break;
    html += dec.decode(value, { stream: true });
    if (/<\/head>/i.test(html)) break;
  }
  reader.cancel().catch(() => {});
  return { url: r.url || real, ...metaFromHTML(html, r.url || real) };
}
