// Ask AI from inside a note: the note being edited is always included, plus related notes.
// Answers can be inserted into the note, copied, or saved as a new note.

import * as store from '../store.js';
import { ask } from '../ai.js';
import { settings, hasServer } from '../settings.js';
import { markdownToHtml } from '../markdown.js';
import { sanitizeHTML } from '../sanitize.js';
import { esc } from '../util.js';
import { icon } from '../icons.js';
import { h, sheet, toast } from '../ui.js';
import { nav } from './common.js';

const QUICK = [
  ['Summarize this note', 'Summarize this note in a few bullet points.'],
  ['Next steps', 'Based on this note, what are the concrete next steps? Answer as a short checklist.'],
  ['Related notes', 'Which of my other notes relate to this one, and how? Link them.'],
  ['Questions to research', 'What open questions does this note raise that I should look into? Use the web if it helps.'],
];

const noteIdFor = (title) => store.findNoteByTitle(title)?.id || null;

export function openNoteAsk(editor) {
  const note = editor.note;
  const convo = [];
  const body = h(`<div class="note-ask">
    <div class="chat"></div>
    <form class="chat-input in-sheet">
      <label class="web-toggle" title="Let the AI search the web too"><input type="checkbox" name="web" ${settings().aiWeb ? 'checked' : ''}>${icon('globe')}<span>Web</span></label>
      <textarea name="q" rows="1" placeholder="Ask about this note…" enterkeyhint="send"></textarea>
      <button class="btn primary icon-only" aria-label="Send">${icon('send')}</button>
    </form></div>`);
  const s = sheet({ title: `Ask AI · ${note?.title || 'this note'}`, body, full: true, className: 'ask-sheet' });
  const chat = body.querySelector('.chat');
  const form = body.querySelector('form');
  const ta = form.q;

  const render = () => {
    if (!hasServer()) {
      chat.innerHTML = `<div class="empty small">${icon('sparkles', 'empty-ic')}<h3>Connect your Worker to use AI</h3><p>Ask AI runs on your own Cloudflare Worker or home server. Set it up in Settings → Sync.</p></div>`;
      form.classList.add('hidden');
      return;
    }
    if (!convo.length) {
      chat.innerHTML = `<div class="pill-row quick">${QUICK.map(([label], i) => `<button class="pill" data-quick="${i}">${icon('sparkles')} ${esc(label)}</button>`).join('')}</div>
        <p class="muted small center">The AI reads this note and your most related notes.</p>`;
      return;
    }
    chat.innerHTML = convo.map((m, i) => (m.role === 'user'
      ? `<div class="msg user"><div class="bubble">${esc(m.label || m.content)}</div></div>`
      : `<div class="msg ai"><div class="bubble md">${m.content ? sanitizeHTML(markdownToHtml(m.content, { resolveLink: noteIdFor })) : '<span class="typing"><i></i><i></i><i></i></span>'}</div>
        ${m.status ? `<div class="msg-status">${esc(m.status)}</div>` : ''}
        ${m.sources?.length ? `<div class="msg-refs"><span>${icon('globe')} Web:</span>${m.sources.slice(0, 6).map((x) => `<a class="link-chip" href="${esc(x.url)}" target="_blank" rel="noopener noreferrer">${esc(x.title || new URL(x.url).hostname)}</a>`).join('')}</div>` : ''}
        ${m.done ? `<div class="msg-btns"><button class="chip" data-insert="${i}">${icon('plus')} Insert into note</button><button class="chip" data-copy="${i}">${icon('copy')} Copy</button><button class="chip" data-new="${i}">${icon('file-text')} New note</button></div>` : ''}
      </div>`)).join('');
    chat.lastElementChild?.scrollIntoView({ block: 'end' });
  };

  let rt = null;
  const later = () => { if (!rt) rt = setTimeout(() => { rt = null; render(); }, 80); };

  const send = async (q, label) => {
    q = q.trim();
    if (!q) return;
    editor.flush();
    const history = convo.filter((m) => m.role === 'user' || m.done).map((m) => ({ role: m.role === 'ai' ? 'assistant' : 'user', content: m.content }));
    convo.push({ role: 'user', content: q, label });
    const m = { role: 'ai', content: '', sources: [], status: 'Reading your notes…' };
    convo.push(m);
    ta.value = '';
    render();
    try {
      await ask(`About my note “${note.title}”: ${q}`, {
        history,
        web: form.web.checked,
        focusId: note.id,
        onEvent: (ev) => {
          if (ev.type === 'text') { m.content += ev.text; m.status = ''; }
          if (ev.type === 'status') m.status = ev.text;
          if (ev.type === 'source') m.sources.push(ev);
          later();
        },
      });
      m.done = true;
    } catch (e) {
      m.content = `**Couldn't get an answer:** ${e.message}`;
    }
    m.status = '';
    render();
  };

  form.onsubmit = (e) => { e.preventDefault(); send(ta.value); };
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(ta.value); } });
  body.addEventListener('click', async (e) => {
    const qb = e.target.closest('[data-quick]');
    if (qb) { const [label, prompt] = QUICK[+qb.dataset.quick]; send(prompt, label); return; }
    const ins = e.target.closest('[data-insert]');
    if (ins) {
      const m = convo[+ins.dataset.insert];
      const html = sanitizeHTML(markdownToHtml(m.content, { resolveLink: noteIdFor }));
      s.close();
      editor.placeCaretAtEnd();
      editor.insertHTML(`<blockquote>${html}</blockquote><p><br></p>`, 'a');
      toast('Added to the note');
    }
    const cp = e.target.closest('[data-copy]');
    if (cp) { await navigator.clipboard.writeText(convo[+cp.dataset.copy].content); toast('Copied'); }
    const nw = e.target.closest('[data-new]');
    if (nw) {
      const m = convo[+nw.dataset.new];
      const q = convo[+nw.dataset.new - 1];
      const html = `<h1>${esc((q.label || q.content).slice(0, 100))} — ${esc(note.title)}</h1>${sanitizeHTML(markdownToHtml(m.content, { resolveLink: noteIdFor }))}<p>From <a class="note-link" data-note-id="${note.id}" href="#/note/${note.id}">${esc(note.title)}</a></p>`;
      const n = await store.createNote({ html, folderId: note.folderId || null });
      toast('Saved as a new note', { action: 'Open', onAction: () => { s.close(); nav(`#/note/${n.id}`); } });
    }
  });
  render();
  if (hasServer()) setTimeout(() => ta.focus(), 50);
}
