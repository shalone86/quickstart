// Formatting toolbar + media actions shared by the composer and the note editor.

import * as store from '../store.js';
import { icon } from '../icons.js';
import { esc } from '../util.js';
import { h, menu, toast, sheet, pickFiles, spinner } from '../ui.js';
import { openSketch } from '../sketch.js';
import { recordVoice, transcribe } from '../voice.js';
import { settings, hasServer } from '../settings.js';
import { webSearch, searchConfigured } from '../websearch.js';
import { saveArticle } from '../article.js';
import { nav } from './common.js';

const btn = (a, ic, label, extra = '') => `<button type="button" class="tb-btn" data-a="${a}" title="${esc(label)}" aria-label="${esc(label)}" ${extra}>${icon(ic)}</button>`;

export function buildToolbar(editor, { compact = false } = {}) {
  const full = !compact;
  const media = `${btn('image', 'image', 'Add image')}${btn('sketch', 'pen-tool', 'Sketch')}${btn('voice', 'mic', 'Voice note')}`;
  const el = h(`<div class="toolbar ${compact ? 'compact' : ''}" role="toolbar" aria-label="Formatting">
    ${compact ? `${media}<span class="tb-sep"></span>` : ''}
    ${full ? btn('style', 'heading', 'Text style') : ''}
    ${btn('bold', 'bold', 'Bold (⌘B)')}${btn('italic', 'italic', 'Italic (⌘I)')}${btn('underline', 'underline', 'Underline (⌘U)')}
    ${full ? btn('strike', 'strikethrough', 'Strikethrough') : ''}
    ${btn('highlight', 'highlighter', 'Highlight (⌘⇧H)')}
    <span class="tb-sep"></span>
    ${btn('ul', 'list', 'Bullets')}${full ? btn('ol', 'list-ordered', 'Numbered list') : ''}${btn('check', 'list-checks', 'Checklist')}
    ${full ? btn('align', 'align-left', 'Alignment') : ''}
    ${full ? `${btn('outdent', 'indent-decrease', 'Outdent')}${btn('indent', 'indent-increase', 'Indent')}` : ''}
    <span class="tb-sep"></span>
    ${btn('link', 'link', 'Link a note or web page (or type @)')}
    ${full ? media : ''}
    ${btn('math', 'sigma', 'Add up numbers')}
    ${full ? btn('web', 'globe', 'Search the web') : ''}
    ${full ? `<span class="tb-sep"></span>${btn('undo', 'undo-2', 'Undo')}${btn('redo', 'redo-2', 'Redo')}` : ''}
  </div>`);
  // keep the editor's selection when tapping toolbar buttons
  el.addEventListener('mousedown', (e) => { if (e.target.closest('button')) e.preventDefault(); });
  el.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-a]');
    if (!b) return;
    runAction(editor, b.dataset.a, b);
  });
  const refresh = () => {
    const q = (c) => { try { return document.queryCommandState(c); } catch { return false; } };
    const set = (a, on) => el.querySelector(`[data-a="${a}"]`)?.classList.toggle('on', !!on);
    set('bold', q('bold')); set('italic', q('italic')); set('underline', q('underline')); set('strike', q('strikeThrough'));
    set('ul', q('insertUnorderedList') && !editor.closest('ul.checklist')); set('ol', q('insertOrderedList'));
    set('check', !!editor.closest('ul.checklist'));
    set('highlight', editor.isHighlighted());
    const al = el.querySelector('[data-a="align"]');
    if (al) al.innerHTML = icon({ left: 'align-left', center: 'align-center', right: 'align-right', justify: 'align-justify' }[editor.currentAlign()] || 'align-left');
  };
  editor.onSelection = refresh;
  return el;
}

export async function runAction(editor, a, anchor) {
  switch (a) {
    case 'bold': return editor.cmd('bold');
    case 'italic': return editor.cmd('italic');
    case 'underline': return editor.cmd('underline');
    case 'strike': return editor.cmd('strikeThrough');
    case 'highlight': {
      if (editor.isHighlighted() || document.getSelection().isCollapsed) return editor.highlight();
      const pick = await menu([
        { label: 'Yellow', icon: 'highlighter', c: 'yellow' }, { label: 'Green', icon: 'highlighter', c: 'green' },
        { label: 'Blue', icon: 'highlighter', c: 'blue' }, { label: 'Pink', icon: 'highlighter', c: 'pink' }, { label: 'Purple', icon: 'highlighter', c: 'purple' },
      ], anchor);
      return pick && editor.highlight(pick.c);
    }
    case 'ul': return editor.cmd('insertUnorderedList');
    case 'ol': return editor.cmd('insertOrderedList');
    case 'check': return editor.checklist();
    case 'indent': return editor.cmd('indent');
    case 'outdent': return editor.cmd('outdent');
    case 'undo': return editor.cmd('undo');
    case 'redo': return editor.cmd('redo');
    case 'style': {
      const pick = await menu([
        { label: 'Title', icon: 'heading', t: 'h1' }, { label: 'Heading', icon: 'heading', t: 'h2' }, { label: 'Subheading', icon: 'heading', t: 'h3' },
        { label: 'Body', icon: 'type', t: 'p' }, { label: 'Quote', icon: 'text-quote', t: 'blockquote' }, { label: 'Monospaced', icon: 'code', t: 'pre' },
      ], anchor);
      return pick && editor.block(pick.t);
    }
    case 'align': {
      const cur = editor.currentAlign();
      const pick = await menu([
        { label: 'Left', icon: 'align-left', v: 'left', checked: cur === 'left' || cur === 'start' },
        { label: 'Center', icon: 'align-center', v: 'center', checked: cur === 'center' },
        { label: 'Right', icon: 'align-right', v: 'right', checked: cur === 'right' },
        { label: 'Justify', icon: 'align-justify', v: 'justify', checked: cur === 'justify' },
      ], anchor);
      return pick && editor.align(pick.v);
    }
    case 'link': return editor.linkPrompt(anchor);
    case 'math': return editor.mathPanel(anchor);
    case 'image': return addImages(editor);
    case 'sketch': return addSketch(editor);
    case 'voice': return addVoice(editor);
    case 'web': return webSearchPanel(editor);
    default: return null;
  }
}

export async function addImages(editor) {
  const files = await pickFiles({ accept: 'image/*', multiple: true });
  for (const f of files) await editor.insertImage(f, 'a');
}

export async function addSketch(editor, attId = null) {
  let vector = null;
  if (attId) {
    const att = store.getAttachment(attId);
    const vb = att?.vectorId ? await store.getAttachmentBlob(att.vectorId) : null;
    if (vb) { try { vector = JSON.parse(await vb.text()); } catch { /* fall through */ } }
    if (!vector) { toast('This sketch can’t be edited (its drawing data is missing)', { kind: 'error' }); return; }
  }
  const res = await openSketch(vector);
  if (!res) return;
  await editor.insertSketch(res.png, res.vector, attId);
}

export async function addVoice(editor) {
  const res = await recordVoice();
  if (!res || !res.blob.size) return;
  let transcript = res.transcript;
  const s = settings();
  let att;
  if (hasServer() && s.autoTranscribe) {
    const close = toast('Transcribing…', { timeout: 60000 });
    try { transcript = (await transcribe(res.blob)) || transcript; } catch (e) { if (!transcript && e.status !== 501) toast(`Transcription failed: ${e.message}`, { kind: 'error' }); }
    close();
  }
  att = await editor.insertAudio(res.blob, transcript);
  return att;
}

export async function transcribeBlock(editor, block) {
  const id = block?.dataset.att;
  if (!id) return;
  const blob = await store.getAttachmentBlob(id);
  if (!blob) { toast('Audio not available on this device yet', { kind: 'error' }); return; }
  const close = toast('Transcribing…', { timeout: 60000 });
  try {
    const text = await transcribe(blob);
    close();
    if (!text) { toast('No speech found'); return; }
    const p = document.createElement('p');
    p.textContent = text;
    editor.recorder?.mark('v');
    block.after(p);
    editor.changed('v');
    store.updateAttachment(id, { transcript: text });
  } catch (e) { close(); toast(e.message, { kind: 'error' }); }
}

/** SearXNG search panel: insert links/snippets into the note or save pages as notes. */
export function webSearchPanel(editor, initial = '') {
  const range = editor?.savedRange?.cloneRange();
  const body = h(`<div class="websearch">
    <form class="search-bar">${icon('search')}<input class="input" name="q" placeholder="Search the web…" value="${esc(initial)}" enterkeyhint="search" autocomplete="off"></form>
    <div class="ws-results">${searchConfigured() ? '<p class="muted center">Results from your SearXNG.</p>' : `<div class="empty small">${icon('globe', 'empty-ic')}<h3>Connect SearXNG</h3><p>Add your SearXNG address (or your Worker) in Settings to search from here.</p><button class="btn" data-a="settings">Open settings</button></div>`}</div>
  </div>`);
  const s = sheet({ title: 'Web search', body, full: true, className: 'ws-sheet' });
  const input = body.querySelector('input');
  const results = body.querySelector('.ws-results');
  let items = [];
  const run = async () => {
    const q = input.value.trim();
    if (!q) return;
    results.innerHTML = spinner('Searching…');
    try {
      items = await webSearch(q);
      results.innerHTML = items.length ? items.map((r, i) => `<div class="ws-item">
        <a class="ws-title" href="${esc(r.url)}" target="_blank" rel="noopener noreferrer">${esc(r.title)}</a>
        <div class="ws-url">${esc(r.url.replace(/^https?:\/\//, '').slice(0, 90))}</div>
        <p>${esc(r.content)}</p>
        <div class="ws-btns">${editor ? `<button class="chip" data-i="${i}" data-a="link">${icon('link')} Insert link</button><button class="chip" data-i="${i}" data-a="quote">${icon('text-quote')} Insert snippet</button>` : ''}<button class="chip" data-i="${i}" data-a="save">${icon('download')} Save page as note</button></div>
      </div>`).join('') : '<p class="muted center">No results.</p>';
    } catch (e) { results.innerHTML = `<p class="error">${esc(e.message)}</p>`; }
  };
  body.querySelector('form').onsubmit = (e) => { e.preventDefault(); run(); };
  body.addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-a]');
    if (!b) return;
    if (b.dataset.a === 'settings') { s.close(); nav('#/settings'); return; }
    const r = items[+b.dataset.i];
    if (!r) return;
    const restore = () => { if (range) { editor.savedRange = range; editor.restoreRange(); } };
    if (b.dataset.a === 'link') { restore(); editor.insertHTML(`<a href="${esc(r.url)}" target="_blank" rel="noopener noreferrer">${esc(r.title)}</a>&nbsp;`, 'a'); toast('Link added'); }
    if (b.dataset.a === 'quote') { restore(); editor.insertHTML(`<blockquote><p>${esc(r.content)}</p><p><small><a href="${esc(r.url)}" target="_blank" rel="noopener noreferrer">${esc(r.title)}</a></small></p></blockquote><p><br></p>`, 'a'); toast('Snippet added'); }
    if (b.dataset.a === 'save') {
      b.disabled = true;
      b.innerHTML = `${icon('refresh-cw', 'spin')} Saving…`;
      try {
        const note = await saveArticle(r.url);
        toast('Saved to notes', { action: 'Open', onAction: () => { s.close(); nav(`#/note/${note.id}`); } });
        b.innerHTML = `${icon('check')} Saved`;
      } catch (err) { b.disabled = false; b.innerHTML = `${icon('download')} Save page as note`; toast(err.message, { kind: 'error' }); }
    }
  });
  setTimeout(() => input.focus(), 50);
  if (initial) run();
}

/** Editor callbacks that need app-level UI. */
export function editorHooks(editor) {
  return {
    navigate: (id) => nav(`#/note/${id}`),
    openSketch: (attId) => addSketch(editor, attId),
    transcribe: (block) => transcribeBlock(editor, block),
    saveArticle: async (url) => {
      const close = toast('Saving page…', { timeout: 60000 });
      try {
        const note = await saveArticle(url);
        close();
        toast('Saved as a note', { action: 'Open', onAction: () => nav(`#/note/${note.id}`) });
      } catch (e) { close(); toast(e.message, { kind: 'error' }); }
    },
  };
}
