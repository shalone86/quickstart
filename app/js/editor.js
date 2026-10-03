// The rich-text editor used by both the home composer and the full note view.

import * as store from './store.js';
import { settings } from './settings.js';
import { Recorder } from './history.js';
import { nodeText } from './text.js';
import { sanitizeHTML } from './sanitize.js';
import { extractNumbers, summarize, formatNumber, inlineCalc } from './mathx.js';
import { compressImage } from './media.js';
import { notePicker } from './pickers.js';
import { esc, debounce, isUrl } from './util.js';
import { icon } from './icons.js';
import { h, popover, menu, toast, promptDialog } from './ui.js';

const INPUT_KIND = {
  insertFromPaste: 'p', insertFromPasteAsQuotation: 'p', insertFromDrop: 'r', deleteByCut: 'x',
  historyUndo: 'u', historyRedo: 'u', insertFromYank: 'p',
};

export class Editor {
  /**
   * @param {HTMLElement} mount
   * @param {object} o
   * @param {object|null} o.note        note to edit (null = composer creates one on first input)
   * @param {string} o.placeholder
   * @param {boolean} o.compact
   * @param {(note) => void} o.onCreate
   * @param {(note) => void} o.onSaved
   * @param {(e) => void} o.onSubmit    Cmd/Ctrl+Enter
   * @param {object} o.hooks            { openSketch(att?), recordAudio(), webSearch(), navigate(id) }
   */
  constructor(mount, o = {}) {
    Object.assign(this, { compact: false, hooks: {}, ...o });
    this.mount = mount;
    this.el = h(`<div class="editor ${this.compact ? 'compact' : ''}" contenteditable="true" spellcheck="true" autocapitalize="sentences" role="textbox" aria-multiline="true" data-placeholder="${esc(o.placeholder || 'Start writing…')}"></div>`);
    mount.appendChild(this.el);
    this.save = debounce(() => this.persist(), 400);
    this.savedRange = null;
    this.bind();
    this.setNote(o.note || null);
  }

  setNote(note) {
    this.flush();
    this.recorder?.endSession();
    this.note = note;
    this.el.innerHTML = note?.html || '';
    marksToSpans(this.el);
    this.normalize();
    this.updateEmpty();
    store.hydrateMedia(this.el);
    this.decorate();
    this.recorder = this.makeRecorder(note, note ? undefined : '', note ? undefined : '');
    this.lastSavedHtml = note?.html || '';
  }

  makeRecorder(note, initialText, initialHtml) {
    if (!settings().recordHistory) return null;
    return new Recorder({
      noteId: note?.id || null,
      device: store.deviceId(),
      getText: () => this.getText(),
      getHtml: () => this.getHTML(),
      initialText, initialHtml,
      save: (session) => store.db.put('history', { ...session }).then(() => store.events.emit('history', { noteId: session.noteId })),
    });
  }

  /* ---------- content ---------- */

  getText() { return nodeText(this.el); }

  getHTML() {
    const clone = this.el.cloneNode(true);
    clone.querySelectorAll('img[data-att], audio[data-att]').forEach((m) => { m.removeAttribute('src'); m.classList.remove('missing', 'selected'); if (!m.className) m.removeAttribute('class'); });
    clone.querySelectorAll('[data-ui]').forEach((x) => x.remove());
    spansToMarks(clone);
    clone.querySelectorAll('.audio-block').forEach((b) => { b.innerHTML = `<audio controls preload="metadata" data-att="${b.dataset.att}"></audio>`; });
    let html = clone.innerHTML;
    if (!nodeText(clone).trim() && !clone.querySelector('img, audio, hr')) html = '';
    return html;
  }

  isEmpty() { return !this.getText().trim() && !this.el.querySelector('img, audio'); }

  updateEmpty() { this.el.classList.toggle('is-empty', this.isEmpty()); }

  normalize() {
    this.fixNesting();
    if (this.el.querySelector('mark')) keepCaret(() => marksToSpans(this.el)); // e.g. after pasting highlighted text
    // Make sure checklists have state and audio blocks are not editable.
    this.el.querySelectorAll('ul.checklist > li:not([data-checked])').forEach((li) => { li.dataset.checked = 'false'; });
    this.el.querySelectorAll('.audio-block').forEach((b) => b.setAttribute('contenteditable', 'false'));
  }

  /** Browsers sometimes put lists/blocks inside a <p>; unwrap them (keeping the caret where it was). */
  fixNesting() {
    const bad = this.el.querySelectorAll('p > ul, p > ol, p > blockquote, p > pre, p > h1, p > h2, p > h3, p > h4, p > p, p > div');
    if (!bad.length) return;
    const sel = document.getSelection();
    const saved = sel.rangeCount ? [sel.anchorNode, sel.anchorOffset, sel.focusNode, sel.focusOffset] : null;
    const parents = new Set(Array.from(bad, (b) => b.parentElement));
    for (const p of parents) {
      if (!p.isConnected) continue;
      // split the paragraph around block children
      const frag = [];
      let inline = null;
      for (const child of Array.from(p.childNodes)) {
        if (child.nodeType === 1 && /^(UL|OL|BLOCKQUOTE|PRE|H[1-4]|P|DIV)$/.test(child.tagName)) { inline = null; frag.push(child); }
        else if (child.nodeType === 1 && child.tagName === 'BR' && !inline) { /* drop stray <br> */ }
        else {
          if (!inline) { inline = document.createElement('p'); frag.push(inline); }
          inline.appendChild(child);
        }
      }
      p.replaceWith(...frag.filter((n) => n.tagName !== 'P' || n.textContent.trim() || n.querySelector('img,br')));
    }
    if (saved && saved[0]?.isConnected && saved[2]?.isConnected) {
      try { sel.setBaseAndExtent(saved[0], saved[1], saved[2], saved[3]); } catch { /* ignore */ }
    }
  }

  /** Adds UI affordances to embedded media (transcribe / edit buttons) — stripped on save. */
  decorate() {
    this.el.querySelectorAll('.audio-block').forEach((b) => {
      if (b.querySelector('[data-ui]')) return;
      const bar = h(`<div class="audio-tools" data-ui="1"><button class="chip" data-act="transcribe" type="button">${icon('type')} Transcribe</button></div>`);
      b.appendChild(bar);
    });
  }

  async persist() {
    if (this.persisting) { this.persistAgain = true; return; }
    this.persisting = true;
    try {
      const html = this.getHTML();
      if (!this.note) {
        if (!html) return;
        this.note = await store.createNote({ html, ...(this.newNoteFields?.() || {}) });
        this.recorder?.setNoteId(this.note.id);
        this.onCreate?.(this.note);
      } else if (html !== this.lastSavedHtml) {
        await store.updateNote(this.note.id, { html });
      }
      this.lastSavedHtml = html;
      this.onSaved?.(this.note);
    } finally {
      this.persisting = false;
      if (this.persistAgain) { this.persistAgain = false; this.persist(); }
    }
  }

  flush() {
    this.save.flush();
    this.recorder?.flush();
  }

  destroy() {
    this.flush();
    this.recorder?.endSession();
    document.removeEventListener('selectionchange', this.onSel);
    this.el.remove();
  }

  changed(kind = 't') {
    this.updateEmpty();
    this.recorder?.record(kind);
    this.save();
  }

  /** Replace contents programmatically (restore version, AI insert). */
  setHTML(html, kind = 'u') {
    this.el.innerHTML = html;
    marksToSpans(this.el);
    this.normalize();
    store.hydrateMedia(this.el);
    this.decorate();
    this.changed(kind);
  }

  /* ---------- events ---------- */

  bind() {
    const el = this.el;
    try { document.execCommand('defaultParagraphSeparator', false, 'p'); } catch { /* old browsers */ }

    this.onSel = () => {
      const sel = document.getSelection();
      if (sel.rangeCount && el.contains(sel.anchorNode)) {
        this.savedRange = sel.getRangeAt(0).cloneRange();
        this.onSelection?.(sel);
      }
    };
    document.addEventListener('selectionchange', this.onSel);

    el.addEventListener('beforeinput', (e) => {
      this.ensureParagraph();
      this.inputKind = INPUT_KIND[e.inputType] || (e.inputType === 'insertReplacementText' ? 't' : 't');
      if (e.inputType === 'insertText' && e.data === ' ' && this.markdownShortcut()) { e.preventDefault(); }
      if (e.inputType === 'insertParagraph' && this.exitEmptyChecklist()) { /* handled */ }
    });

    el.addEventListener('input', (e) => {
      const kind = this.inputKind || 't';
      this.inputKind = null;
      this.normalize();
      this.changed(kind);
      if (e.inputType === 'insertText' && e.data === '@' && /(^|[\s(\u00a0])@$/.test(this.textBeforeCaret())) this.openMention();
      if (e.inputType === 'insertText' && e.data === '=') this.tryInlineCalc();
      if (e.inputType === 'insertParagraph' || e.inputType === 'insertText') this.ensureChecklistState();
      if (e.inputType === 'insertParagraph') this.resetTypingStyle();
    });

    el.addEventListener('keydown', (e) => this.onKey(e));
    el.addEventListener('paste', (e) => this.onPaste(e));
    el.addEventListener('drop', (e) => this.onDrop(e));
    el.addEventListener('click', (e) => this.onClick(e));
    el.addEventListener('blur', () => this.flush());
  }

  onKey(e) {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key === 'Enter') { e.preventDefault(); this.onSubmit?.(e); return; }
    if (mod && e.shiftKey && (e.key === 'h' || e.key === 'H')) { e.preventDefault(); this.highlight(); return; }
    if (mod && e.shiftKey && e.key === '8') { e.preventDefault(); this.cmd('insertUnorderedList'); return; }
    if (mod && e.shiftKey && e.key === '7') { e.preventDefault(); this.cmd('insertOrderedList'); return; }
    if (mod && e.shiftKey && e.key === '9') { e.preventDefault(); this.checklist(); return; }
    if (mod && e.shiftKey && (e.key === 'x' || e.key === 'X')) { e.preventDefault(); this.cmd('strikeThrough'); return; }
    if (mod && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); this.linkPrompt(); return; }
    if (e.key === 'Tab') {
      const li = this.closest('li');
      e.preventDefault();
      if (li) this.cmd(e.shiftKey ? 'outdent' : 'indent');
      else if (!e.shiftKey) this.insertText('    ');
    }
  }

  /** Typing into an empty editor (or straight into the root) should happen inside a <p>. */
  ensureParagraph() {
    const sel = document.getSelection();
    if (!sel.rangeCount) return;
    const n = sel.anchorNode;
    const atRoot = n === this.el || (n?.nodeType === 3 && n.parentNode === this.el);
    if (!atRoot) return;
    if (n === this.el && this.el.children.length && this.el.textContent.trim()) return;
    if (n === this.el && !this.el.childNodes.length) {
      const p = document.createElement('p');
      p.appendChild(document.createElement('br'));
      this.el.appendChild(p);
      const r = document.createRange();
      r.setStart(p, 0);
      r.collapse(true);
      sel.removeAllRanges();
      sel.addRange(r);
      return;
    }
    if (n.nodeType === 3) {
      const off = sel.anchorOffset;
      const p = document.createElement('p');
      n.replaceWith(p);
      p.appendChild(n);
      const r = document.createRange();
      r.setStart(n, off);
      r.collapse(true);
      sel.removeAllRanges();
      sel.addRange(r);
    }
  }

  /* ---------- selection helpers ---------- */

  focus() { this.el.focus(); }

  restoreRange() {
    if (!this.savedRange) { this.placeCaretAtEnd(); return; }
    this.el.focus({ preventScroll: true });
    const sel = document.getSelection();
    sel.removeAllRanges();
    sel.addRange(this.savedRange);
  }

  placeCaretAtEnd() {
    this.el.focus({ preventScroll: true });
    const r = document.createRange();
    r.selectNodeContents(this.el);
    r.collapse(false);
    const sel = document.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
    this.savedRange = r.cloneRange();
  }

  closest(selector) {
    const sel = document.getSelection();
    let n = sel.anchorNode;
    if (!n || !this.el.contains(n)) return null;
    if (n.nodeType === 3) n = n.parentNode;
    const found = n.closest(selector);
    return found && this.el.contains(found) ? found : null;
  }

  currentBlock() {
    const sel = document.getSelection();
    let n = sel.anchorNode;
    if (!n || n === this.el || !this.el.contains(n)) return null;
    while (n.parentNode && n.parentNode !== this.el) {
      if (n.nodeType === 1 && n.tagName === 'LI') return n;
      n = n.parentNode;
    }
    return n;
  }

  /** Text from the start of the caret's block up to the caret. */
  textBeforeCaret() {
    const sel = document.getSelection();
    if (!sel.rangeCount) return '';
    const block = this.currentBlock();
    if (!block) return '';
    const r = sel.getRangeAt(0).cloneRange();
    r.setStart(block, 0);
    return r.toString();
  }

  /* ---------- commands ---------- */

  cmd(name, value = null) {
    this.restoreRangeIfNeeded();
    document.execCommand(name, false, value);
    this.normalize();
    this.changed('f');
  }

  restoreRangeIfNeeded() {
    const sel = document.getSelection();
    if (!sel.rangeCount || !this.el.contains(sel.anchorNode)) this.restoreRange();
  }

  insertHTML(html, kind = 'a') {
    this.restoreRangeIfNeeded();
    this.inputKind = kind;
    this.recorder?.mark(kind);
    document.execCommand('insertHTML', false, html);
    this.normalize();
    store.hydrateMedia(this.el);
    this.decorate();
    this.changed(kind);
  }

  insertText(text, kind = 'a') {
    this.restoreRangeIfNeeded();
    this.recorder?.mark(kind);
    document.execCommand('insertText', false, text);
    this.changed(kind);
  }

  block(tag) { this.cmd('formatBlock', `<${tag}>`); }

  align(where) {
    this.cmd({ left: 'justifyLeft', center: 'justifyCenter', right: 'justifyRight', justify: 'justifyFull' }[where]);
  }

  currentAlign() {
    const b = this.closest('p,h1,h2,h3,h4,li,div,blockquote');
    return (b && b !== this.el && b.style.textAlign) || 'left';
  }

  checklist() {
    this.restoreRangeIfNeeded();
    const ul = this.closest('ul');
    if (ul && ul.classList.contains('checklist')) {
      ul.classList.remove('checklist');
      ul.querySelectorAll(':scope > li').forEach((li) => li.removeAttribute('data-checked'));
      this.changed('f');
      return;
    }
    if (!ul) document.execCommand('insertUnorderedList');
    const list = this.closest('ul');
    if (list) {
      list.classList.add('checklist');
      list.querySelectorAll(':scope > li').forEach((li) => { if (!li.dataset.checked) li.dataset.checked = 'false'; });
    }
    this.changed('f');
  }

  ensureChecklistState() {
    this.el.querySelectorAll('ul.checklist > li:not([data-checked])').forEach((li) => { li.dataset.checked = 'false'; });
    // a new item created from a checked item should start unchecked
    const li = this.closest('ul.checklist > li');
    if (li && !li.textContent.trim() && li.dataset.checked === 'true') li.dataset.checked = 'false';
  }

  exitEmptyChecklist() { return false; }

  /**
   * Toggle highlight on the selection using the browser's own hiliteColor command, so applying and
   * removing highlights are both on the native undo stack (⌘Z / the undo button).
   * While editing, highlights are <span style="background-color">; they are saved as <mark>.
   */
  highlight(color = 'yellow') {
    this.restoreRangeIfNeeded();
    const sel = document.getSelection();
    if (!sel.rangeCount) return;
    try { document.execCommand('styleWithCSS', false, true); } catch { /* ignore */ }
    const range = sel.getRangeAt(0);
    if (range.collapsed) {
      // caret inside a highlight: remove that whole highlight
      const hl = highlightAncestor(range.startContainer, this.el);
      if (!hl) return;
      const r = document.createRange();
      r.selectNodeContents(hl);
      sel.removeAllRanges();
      sel.addRange(r);
      document.execCommand('hiliteColor', false, 'transparent');
      sel.collapse(r.endContainer, r.endOffset);
    } else {
      const texts = textNodesInRange(range, this.el).filter((t) => t.nodeValue.trim());
      const allMarked = texts.length > 0 && texts.every((t) => highlightAncestor(t, this.el));
      document.execCommand('hiliteColor', false, allMarked ? 'transparent' : (HL[color] || HL.yellow));
    }
    try { document.execCommand('styleWithCSS', false, false); } catch { /* ignore */ }
    this.changed('f');
  }

  isHighlighted() {
    const sel = document.getSelection();
    return !!(sel.rangeCount && highlightAncestor(sel.anchorNode, this.el));
  }

  /** After Enter, a fresh empty line starts as plain text (no highlight, bold, italic…). */
  resetTypingStyle() {
    const block = this.currentBlock();
    if (!block || block.nodeType !== 1 || block.textContent.replace(/\u200b/g, '').trim()) return;
    if (block.querySelector('mark, b, strong, i, em, u, s, strike, span, font, sub, sup, code, a')) {
      block.innerHTML = '<br>';
      const r = document.createRange();
      r.setStart(block, 0);
      r.collapse(true);
      const sel = document.getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
    }
    for (const c of ['bold', 'italic', 'underline', 'strikeThrough']) {
      try { if (document.queryCommandState(c)) document.execCommand(c); } catch { /* ignore */ }
    }
    // the browser carries the highlight color onto the new line as "typing style"; clear it
    const prev = block.previousElementSibling;
    if (prev && prev.querySelector('span[style*="background"], mark')) {
      try {
        document.execCommand('styleWithCSS', false, true);
        document.execCommand('hiliteColor', false, 'transparent');
        document.execCommand('styleWithCSS', false, false);
      } catch { /* ignore */ }
    }
  }

  /* ---------- markdown-style shortcuts ---------- */

  markdownShortcut() {
    const before = this.textBeforeCaret();
    const block = this.currentBlock();
    if (!block || block.tagName === 'LI' || block.closest?.('li')) {
      if (block?.tagName === 'LI' && /^\[\s?\]$/.test(before)) {
        // "[] " at start of a bullet turns the list into a checklist
        this.deleteBefore(before.length);
        this.checklist();
        return true;
      }
      return false;
    }
    const rules = [
      [/^[-*•]$/, () => this.cmd('insertUnorderedList')],
      [/^1[.)]$/, () => this.cmd('insertOrderedList')],
      [/^\[\s?\]$/, () => this.checklist()],
      [/^#$/, () => this.block('h1')],
      [/^##$/, () => this.block('h2')],
      [/^###$/, () => this.block('h3')],
      [/^>$/, () => this.block('blockquote')],
    ];
    for (const [re, fn] of rules) {
      if (re.test(before)) {
        this.deleteBefore(before.length);
        fn();
        return true;
      }
    }
    return false;
  }

  deleteBefore(n) {
    const sel = document.getSelection();
    for (let i = 0; i < n; i++) sel.modify ? sel.modify('extend', 'backward', 'character') : null;
    if (sel.modify) document.execCommand('delete');
  }

  /* ---------- math ---------- */

  tryInlineCalc() {
    const line = this.textBeforeCaret();
    const res = inlineCalc(line);
    if (!res) return;
    this.recorder?.mark('a');
    document.execCommand('insertText', false, ` ${res.text}`);
    this.changed('a');
  }

  /** Σ: summarise numbers in the selection, the current list, or the current paragraph. */
  mathPanel(anchor) {
    this.restoreRangeIfNeeded();
    const sel = document.getSelection();
    let text = '', target = null, scope = '';
    if (sel.rangeCount && !sel.isCollapsed && this.el.contains(sel.anchorNode)) { text = sel.toString(); scope = 'selection'; }
    else {
      target = this.closest('ul,ol') || this.currentBlock();
      if (target) { text = target.nodeType === 3 ? target.nodeValue : nodeText(target); scope = /^(UL|OL)$/.test(target.tagName) ? 'list' : 'line'; }
      if (!extractNumbers(text).length) { text = this.getText(); target = null; scope = 'note'; }
    }
    const nums = extractNumbers(text);
    const range = sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
    const stats = summarize(nums);
    const rows = stats ? [
      ['Sum', stats.sum, 'sum'], ['Average', stats.average, 'average'], ['Count', stats.count, 'count'],
      ['Min', stats.min, 'min'], ['Max', stats.max, 'max'], ['Difference', stats.difference, 'difference'],
      ['Product', stats.product, 'product'], ['Quotient', stats.quotient, 'quotient'],
    ] : [];
    const body = h(`<div class="math-panel">
      <div class="math-head">${icon('sigma')}<div><b>${stats ? `${nums.length} number${nums.length > 1 ? 's' : ''}` : 'No numbers found'}</b><small>in this ${scope || 'note'}${nums.length ? ': ' + esc(nums.slice(0, 8).map(formatNumber).join(', ')) + (nums.length > 8 ? '…' : '') : ''}</small></div></div>
      ${rows.map(([label, v, key]) => `<button class="math-row" data-key="${key}" data-v="${v}"><span>${label}</span><b>${formatNumber(v)}</b><span class="math-ins">Insert</span></button>`).join('')}
      <p class="math-tip">Tip: type an expression like <code>12*4 + 3 =</code> and the answer appears.</p>
    </div>`);
    const pop = popover(anchor, body, { className: 'math-pop' });
    body.addEventListener('click', (e) => {
      const row = e.target.closest('.math-row');
      if (!row) return;
      pop.close();
      const label = row.querySelector('span').textContent;
      const value = formatNumber(+row.dataset.v);
      if (target && /^(UL|OL)$/.test(target.tagName)) {
        const p = document.createElement('p');
        p.innerHTML = `<b>${esc(label)}: ${esc(value)}</b>`;
        this.recorder?.mark('a');
        target.after(p);
        this.changed('a');
      } else {
        if (range) {
          const sel2 = document.getSelection();
          sel2.removeAllRanges();
          range.collapse(false);
          sel2.addRange(range);
          this.savedRange = range;
        }
        this.insertText(` = ${value}`, 'a');
      }
    });
  }

  /* ---------- links ---------- */

  openMention() {
    const sel = document.getSelection();
    const range = sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
    const anchor = caretRect() || this.el;
    notePicker(anchor, {
      exclude: this.note?.id,
      onPick: async (res) => {
        if (range) { sel.removeAllRanges(); sel.addRange(range); this.el.focus({ preventScroll: true }); }
        // remove the "@" that opened the picker
        if (sel.modify) { sel.modify('extend', 'backward', 'character'); if (sel.toString() === '@') document.execCommand('delete'); else sel.collapseToEnd(); }
        await this.insertNoteLink(res);
      },
      onClose: () => { if (range) { sel.removeAllRanges(); sel.addRange(range); this.el.focus({ preventScroll: true }); } },
    });
  }

  async insertNoteLink(res) {
    let id = res.id, title = res.title;
    if (res.create) {
      const n = await store.createNote({ html: `<h1>${esc(res.create)}</h1><p></p>`, title: res.create, titleManual: true, folderId: this.note?.folderId || null });
      id = n.id; title = n.title;
    }
    this.insertHTML(`<a class="note-link" data-note-id="${id}" href="#/note/${id}">${esc(title)}</a>&nbsp;`, 'a');
  }

  /** Toolbar link button: link selected text to a note, or to a web address. */
  async linkPrompt(anchor) {
    this.restoreRangeIfNeeded();
    const sel = document.getSelection();
    const text = sel.toString();
    const choice = await menu([
      { label: 'Link to a note', icon: 'at-sign', key: 'note' },
      { label: 'Link to a web address', icon: 'globe', key: 'url' },
    ], anchor);
    if (!choice) return;
    if (choice.key === 'note') {
      const range = sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
      notePicker(anchor || caretRect() || this.el, {
        exclude: this.note?.id,
        initial: text,
        onPick: async (res) => {
          if (range) { this.savedRange = range; this.restoreRange(); }
          let id = res.id;
          if (res.create) id = (await store.createNote({ html: `<h1>${esc(res.create)}</h1><p></p>`, title: res.create, titleManual: true })).id;
          const label = text || store.getNote(id)?.title || 'note';
          this.insertHTML(`<a class="note-link" data-note-id="${id}" href="#/note/${id}">${esc(label)}</a>${text ? '' : '&nbsp;'}`, 'a');
        },
      });
    } else {
      const range = sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
      const url = await promptDialog('Web address', { placeholder: 'https://…', ok: 'Link' });
      if (!url) return;
      const href = /^https?:/i.test(url) ? url : `https://${url}`;
      if (range) { this.savedRange = range; this.restoreRange(); }
      this.insertHTML(`<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(text || href)}</a>${text ? '' : '&nbsp;'}`, 'a');
    }
  }

  /* ---------- paste / drop / media ---------- */

  async onPaste(e) {
    const cd = e.clipboardData;
    if (!cd) return;
    const files = Array.from(cd.files || []).filter((f) => f.type.startsWith('image/'));
    if (files.length) {
      e.preventDefault();
      for (const f of files) await this.insertImage(f, 'p');
      return;
    }
    const html = cd.getData('text/html');
    const text = cd.getData('text/plain');
    if (text && isUrl(text) && !html) {
      e.preventDefault();
      const sel = document.getSelection();
      if (!sel.isCollapsed) { this.recorder?.mark('p'); document.execCommand('createLink', false, text.trim()); this.changed('p'); return; }
      this.insertHTML(`<a href="${esc(text.trim())}" target="_blank" rel="noopener noreferrer">${esc(text.trim())}</a>&nbsp;`, 'p');
      this.hooks.onUrlPasted?.(text.trim());
      return;
    }
    if (html) {
      e.preventDefault();
      const clean = sanitizeHTML(html.replace(/<!--StartFragment-->|<!--EndFragment-->/g, ''));
      this.insertHTML(clean, 'p');
      return;
    }
    // plain text: let the browser insert it, recorded as a paste via beforeinput
  }

  async onDrop(e) {
    const files = Array.from(e.dataTransfer?.files || []);
    const imgs = files.filter((f) => f.type.startsWith('image/'));
    const audio = files.filter((f) => f.type.startsWith('audio/'));
    if (!imgs.length && !audio.length) return;
    e.preventDefault();
    if (document.caretRangeFromPoint) {
      const r = document.caretRangeFromPoint(e.clientX, e.clientY);
      if (r && this.el.contains(r.startContainer)) { this.savedRange = r; this.restoreRange(); }
    }
    for (const f of imgs) await this.insertImage(f, 'r');
    for (const f of audio) await this.insertAudio(f, '', 'r');
  }

  async insertImage(file, kind = 'a') {
    await this.ensureNote();
    const blob = await compressImage(file);
    const att = await store.addAttachment(blob, { kind: 'image', noteId: this.note.id, name: file.name || '' });
    this.insertHTML(`<p><img data-att="${att.id}" alt=""></p><p><br></p>`, kind);
    return att;
  }

  async insertSketch(pngBlob, vector, existingAttId) {
    await this.ensureNote();
    if (existingAttId) {
      await store.replaceAttachmentBlob(existingAttId, pngBlob);
      const att = store.getAttachment(existingAttId);
      if (att?.vectorId) await store.replaceAttachmentBlob(att.vectorId, new Blob([JSON.stringify(vector)], { type: 'application/json' }));
      this.el.querySelectorAll(`img[data-att="${existingAttId}"]`).forEach((img) => { img.removeAttribute('src'); });
      await store.hydrateMedia(this.el);
      this.changed('a');
      return;
    }
    const vec = await store.addAttachment(new Blob([JSON.stringify(vector)], { type: 'application/json' }), { kind: 'vector', noteId: this.note.id });
    const att = await store.addAttachment(pngBlob, { kind: 'sketch', noteId: this.note.id, extra: { vectorId: vec.id } });
    this.insertHTML(`<p><img data-att="${att.id}" data-sketch="1" alt="Sketch"></p><p><br></p>`, 'a');
  }

  async insertAudio(blob, transcript = '', kind = 'a') {
    await this.ensureNote();
    const att = await store.addAttachment(blob, { kind: 'audio', noteId: this.note.id, extra: { transcript } });
    const tx = transcript ? `<p>${esc(transcript)}</p>` : '';
    this.insertHTML(`<div class="audio-block" contenteditable="false" data-att="${att.id}"><audio controls preload="metadata" data-att="${att.id}"></audio></div>${tx}<p><br></p>`, transcript ? 'v' : kind);
    return att;
  }

  /** The composer creates its note lazily; media insertion needs one right away. */
  async ensureNote() {
    if (this.note) return this.note;
    this.note = await store.createNote({ html: '', ...(this.newNoteFields?.() || {}) });
    this.recorder?.setNoteId(this.note.id);
    this.onCreate?.(this.note);
    return this.note;
  }

  /* ---------- clicks ---------- */

  onClick(e) {
    const t = e.target;
    // checklist toggle: tap the box area
    const li = t.closest('ul.checklist > li');
    if (li && e.target === li) {
      const rect = li.getBoundingClientRect();
      const x = getComputedStyle(li).direction === 'rtl' ? rect.right - e.clientX : e.clientX - rect.left;
      if (x < 30) {
        e.preventDefault();
        li.dataset.checked = li.dataset.checked === 'true' ? 'false' : 'true';
        this.changed('f');
        return;
      }
    }
    const link = t.closest('a');
    if (link && this.el.contains(link)) {
      e.preventDefault();
      if (link.dataset.noteId) { this.flush(); this.hooks.navigate?.(link.dataset.noteId); return; }
      const href = link.getAttribute('href');
      menu([
        { label: 'Open link', icon: 'external-link', action: () => window.open(href, '_blank', 'noopener') },
        this.hooks.saveArticle ? { label: 'Save page as a note', icon: 'newspaper', action: () => this.hooks.saveArticle(href) } : null,
        { label: 'Copy link', icon: 'copy', action: () => navigator.clipboard?.writeText(href).then(() => toast('Link copied')) },
        { label: 'Remove link', icon: 'x', action: () => { link.replaceWith(...link.childNodes); this.changed('f'); } },
      ], link);
      return;
    }
    const img = t.closest('img[data-att], img[src]');
    if (img && this.el.contains(img)) {
      const items = [];
      if (img.dataset.sketch) items.push({ label: 'Edit sketch', icon: 'pen-tool', action: () => this.hooks.openSketch?.(img.dataset.att) });
      items.push({ label: 'View full size', icon: 'image', action: () => viewImage(img.src) });
      items.push({ label: 'Delete', icon: 'trash-2', danger: true, action: () => { (img.closest('p') && img.closest('p').textContent.trim() === '' ? img.closest('p') : img).remove(); this.changed('a'); } });
      menu(items, img);
      return;
    }
    const tbtn = t.closest('[data-act="transcribe"]');
    if (tbtn) { e.preventDefault(); this.hooks.transcribe?.(tbtn.closest('.audio-block')); }
  }
}

/* ---------- helpers ---------- */

/** Highlight colors (translucent so they work in light and dark mode). */
export const HL = {
  yellow: 'rgba(255, 212, 0, 0.42)', green: 'rgba(64, 192, 87, 0.35)', blue: 'rgba(51, 154, 240, 0.32)',
  pink: 'rgba(240, 101, 149, 0.32)', purple: 'rgba(132, 94, 247, 0.32)',
};
const isClearBg = (c) => !c || /transparent|rgba\(0, 0, 0, 0\)|initial|inherit/.test(c);

function highlightAncestor(node, root) {
  let el = node?.nodeType === 3 ? node.parentNode : node;
  while (el && el !== root) {
    if (el.nodeType === 1 && (el.tagName === 'MARK' || !isClearBg(el.style?.backgroundColor))) return el;
    el = el.parentNode;
  }
  return null;
}

function colorName(css) {
  const m = String(css).match(/\d+(\.\d+)?/g);
  if (!m) return 'yellow';
  const [r, g, b] = m.map(Number);
  let best = 'yellow', dist = Infinity;
  for (const [name, v] of Object.entries(HL)) {
    const [r2, g2, b2] = v.match(/\d+/g).map(Number);
    const d = (r - r2) ** 2 + (g - g2) ** 2 + (b - b2) ** 2;
    if (d < dist) { dist = d; best = name; }
  }
  return best;
}

/** <mark> (stored) → <span style="background-color"> (editable with native undo). */
function marksToSpans(root) {
  root.querySelectorAll('mark').forEach((m) => {
    const span = document.createElement('span');
    span.style.backgroundColor = HL[m.dataset.color] || HL.yellow;
    while (m.firstChild) span.appendChild(m.firstChild);
    m.replaceWith(span);
  });
}

/** Editing spans → clean stored HTML: highlighted spans become <mark>, other spans are unwrapped. */
function spansToMarks(root) {
  root.querySelectorAll('span').forEach((sp) => {
    if (sp.closest('[data-ui]')) return;
    const bg = sp.style.backgroundColor;
    if (!isClearBg(bg)) {
      const mark = document.createElement('mark');
      const name = colorName(bg);
      if (name !== 'yellow') mark.dataset.color = name;
      while (sp.firstChild) mark.appendChild(sp.firstChild);
      sp.replaceWith(mark);
    } else {
      sp.replaceWith(...sp.childNodes);
    }
  });
  root.querySelectorAll('[style=""]').forEach((el) => el.removeAttribute('style'));
  root.querySelectorAll('mark mark').forEach((m) => m.replaceWith(...m.childNodes));
}

function keepCaret(fn) {
  const sel = document.getSelection();
  const saved = sel.rangeCount ? [sel.anchorNode, sel.anchorOffset, sel.focusNode, sel.focusOffset] : null;
  fn();
  if (saved && saved[0]?.isConnected && saved[2]?.isConnected) {
    try { sel.setBaseAndExtent(saved[0], saved[1], saved[2], saved[3]); } catch { /* ignore */ }
  }
}

function textNodesInRange(range, root) {
  const out = [];
  const walker = document.createTreeWalker(range.commonAncestorContainer.nodeType === 3 ? range.commonAncestorContainer.parentNode : range.commonAncestorContainer, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walker.nextNode())) {
    if (!root.contains(n) || !n.nodeValue.length) continue;
    if (range.intersectsNode(n)) {
      if (n === range.endContainer && range.endOffset === 0) continue;
      if (n === range.startContainer && range.startOffset === n.length) continue;
      out.push(n);
    }
  }
  return out;
}

export function caretRect() {
  const sel = document.getSelection();
  if (!sel.rangeCount) return null;
  const r = sel.getRangeAt(0).cloneRange();
  r.collapse(true);
  const rects = r.getClientRects();
  if (rects.length) return rects[0];
  const n = sel.anchorNode?.nodeType === 1 ? sel.anchorNode : sel.anchorNode?.parentElement;
  return n ? n.getBoundingClientRect() : null;
}

export function viewImage(src) {
  if (!src) return;
  const el = h(`<div class="lightbox" role="dialog"><img src="${esc(src)}" alt=""><button class="icon-btn lightbox-close" aria-label="Close">${icon('x')}</button></div>`);
  el.onclick = () => el.remove();
  document.body.appendChild(el);
}
