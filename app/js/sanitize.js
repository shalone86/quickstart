// Allowlist HTML sanitizer for note bodies, pasted content and parsed articles.

const ALLOWED = new Set([
  'P', 'DIV', 'BR', 'B', 'STRONG', 'I', 'EM', 'U', 'S', 'DEL', 'STRIKE', 'MARK', 'SUB', 'SUP', 'SMALL',
  'H1', 'H2', 'H3', 'H4', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'PRE', 'CODE', 'A', 'IMG', 'FIGURE', 'FIGCAPTION',
  'HR', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TD', 'TH', 'AUDIO', 'SPAN',
]);
const DROP_WITH_CONTENT = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'MATH', 'FORM', 'INPUT', 'BUTTON', 'SELECT', 'TEXTAREA', 'VIDEO', 'CANVAS', 'HEAD', 'META', 'LINK', 'TITLE']);
const RENAME = { H5: 'H4', H6: 'H4', ARTICLE: 'DIV', SECTION: 'DIV', MAIN: 'DIV', HEADER: 'DIV', FOOTER: 'DIV', ASIDE: 'DIV', NAV: 'DIV', DETAILS: 'DIV', SUMMARY: 'P', CAPTION: 'P', PICTURE: 'SPAN', TT: 'CODE', KBD: 'CODE', VAR: 'I', CITE: 'I', DFN: 'I', INS: 'U', ADDRESS: 'P', CENTER: 'DIV', DL: 'UL', DT: 'LI', DD: 'LI', FONT: 'SPAN', LABEL: 'SPAN', TIME: 'SPAN', ABBR: 'SPAN' };
const ALIGN = /^(left|center|right|justify)$/;
const MARK_COLORS = /^(yellow|green|blue|pink|purple)$/;

function safeUrl(u, allowData = false) {
  const s = String(u || '').trim();
  if (/^(https?:|mailto:|tel:|#)/i.test(s)) return s;
  if (allowData && /^data:image\/(png|jpe?g|gif|webp);/i.test(s)) return s;
  if (/^blob:/i.test(s)) return s;
  return '';
}

/**
 * Cleans `html`. Options:
 *  - baseUrl: resolve relative links/images against it (articles)
 *  - keepClasses: keep the app's own classes (note bodies)
 */
export function sanitizeHTML(html, opts = {}) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html || '';
  cleanChildren(tpl.content, opts);
  return tpl.innerHTML;
}

function cleanChildren(parent, opts) {
  for (const node of Array.from(parent.childNodes)) cleanNode(node, opts);
}

function cleanNode(node, opts) {
  if (node.nodeType === 3) return;
  if (node.nodeType !== 1) { node.remove(); return; }
  let el = node;
  let tag = el.tagName;
  if (DROP_WITH_CONTENT.has(tag)) { el.remove(); return; }
  if (RENAME[tag]) {
    const n = el.ownerDocument.createElement(RENAME[tag]);
    while (el.firstChild) n.appendChild(el.firstChild);
    for (const a of Array.from(el.attributes)) n.setAttribute(a.name, a.value);
    el.replaceWith(n);
    el = n;
    tag = n.tagName;
  }
  if (!ALLOWED.has(tag)) {
    // unwrap unknown element, keep its children
    cleanChildren(el, opts);
    el.replaceWith(...Array.from(el.childNodes));
    return;
  }
  const keep = {};
  const style = el.getAttribute('style') || '';
  const align = (style.match(/text-align\s*:\s*([a-z]+)/i) || [])[1] || el.getAttribute('align');
  const bg = (style.match(/background(?:-color)?\s*:\s*([^;]+)/i) || [])[1];
  const fw = (style.match(/font-weight\s*:\s*(bold|[6-9]00)/i) || [])[1];
  const fs = (style.match(/font-style\s*:\s*italic/i) || [])[0];
  const td = (style.match(/text-decoration[^:]*:\s*[^;]*underline/i) || [])[0];
  const ds = el.dataset || {};
  switch (tag) {
    case 'A': {
      const href = safeUrl(el.getAttribute('href') && opts.baseUrl ? resolve(el.getAttribute('href'), opts.baseUrl) : el.getAttribute('href'));
      if (ds.noteId) { keep['data-note-id'] = ds.noteId; keep.class = 'note-link'; keep.href = `#/note/${ds.noteId}`; }
      else if (href) { keep.href = href; if (!href.startsWith('#')) { keep.target = '_blank'; keep.rel = 'noopener noreferrer'; } }
      break;
    }
    case 'IMG': {
      if (ds.att) keep['data-att'] = ds.att;
      if (ds.sketch) keep['data-sketch'] = ds.sketch;
      let src = el.getAttribute('src') || el.getAttribute('data-src') || '';
      if (!src && el.getAttribute('srcset')) src = el.getAttribute('srcset').split(',').pop().trim().split(/\s+/)[0];
      if (opts.baseUrl && src && !/^(data|blob):/.test(src)) src = resolve(src, opts.baseUrl);
      src = safeUrl(src, true);
      if (!ds.att && !src) { el.remove(); return; }
      if (!ds.att) keep.src = src;
      if (el.getAttribute('alt')) keep.alt = el.getAttribute('alt').slice(0, 300);
      if (ds.remote) keep['data-remote'] = ds.remote;
      keep.loading = 'lazy';
      break;
    }
    case 'AUDIO': {
      if (ds.att) keep['data-att'] = ds.att; else { el.remove(); return; }
      keep.controls = '';
      keep.preload = 'metadata';
      break;
    }
    case 'MARK':
      if (ds.color && MARK_COLORS.test(ds.color)) keep['data-color'] = ds.color;
      break;
    case 'LI':
      if (ds.checked === 'true' || ds.checked === 'false') keep['data-checked'] = ds.checked;
      break;
    case 'UL':
      if (el.classList.contains('checklist')) keep.class = 'checklist';
      break;
    case 'DIV':
      if (opts.keepClasses && el.classList.contains('audio-block') && ds.att) {
        keep.class = 'audio-block'; keep['data-att'] = ds.att; keep.contenteditable = 'false';
      }
      break;
    case 'TD': case 'TH':
      if (el.getAttribute('colspan')) keep.colspan = String(parseInt(el.getAttribute('colspan'), 10) || 1);
      break;
    default: break;
  }
  if (align && ALIGN.test(align.toLowerCase()) && /^(P|DIV|H1|H2|H3|H4|LI|BLOCKQUOTE|FIGURE)$/.test(tag)) {
    keep.style = `text-align:${align.toLowerCase()}`;
  }
  for (const a of Array.from(el.attributes)) el.removeAttribute(a.name);
  for (const [k, v] of Object.entries(keep)) el.setAttribute(k, v);

  // Inline-style formatting from pasted Google Docs / Word HTML → semantic tags.
  if (tag === 'SPAN') {
    let wrapper = el;
    const wrap = (t) => {
      const w = el.ownerDocument.createElement(t);
      while (wrapper.firstChild) w.appendChild(wrapper.firstChild);
      wrapper.appendChild(w);
      return w;
    };
    let inner = el;
    if (bg && !/transparent|rgba\(0,\s*0,\s*0,\s*0\)|inherit|initial|white|#fff/i.test(bg)) { inner = wrap('MARK'); wrapper = inner; }
    if (fw) { inner = wrap('B'); wrapper = inner; }
    if (fs) { inner = wrap('I'); wrapper = inner; }
    if (td) { inner = wrap('U'); wrapper = inner; }
    cleanChildren(inner, opts);
    el.replaceWith(...Array.from(el.childNodes));
    return;
  }
  if (tag === 'DIV' && el.classList.contains('audio-block')) {
    // rebuild the block's internals from scratch
    el.innerHTML = `<audio controls preload="metadata" data-att="${keep['data-att']}"></audio>`;
    return;
  }
  cleanChildren(el, opts);
}

function resolve(u, base) {
  try { return new URL(u, base).href; } catch { return ''; }
}
