// Ask AI: chat with your notes (and the open web).

import * as store from '../store.js';
import { ask } from '../ai.js';
import { settings, saveSettings, hasServer } from '../settings.js';
import { markdownToHtml } from '../markdown.js';
import { sanitizeHTML } from '../sanitize.js';
import { importSession } from '../history.js';
import { htmlToText } from '../text.js';
import { esc } from '../util.js';
import { icon } from '../icons.js';
import { toast } from '../ui.js';
import { nav } from './common.js';

const convo = []; // kept while the app is open: {role, content, sources, notes}

export function renderAsk(root, params) {
  root.innerHTML = `
    <header class="page-head"><div><div class="eyebrow">Ask AI</div><h1>Ask your notes</h1></div>
      <div class="head-actions"><button class="btn ghost small" data-a="clear">${icon('rotate-ccw')} New chat</button></div></header>
    <div class="chat"></div>
    <form class="chat-input">
      <label class="web-toggle" title="Let the AI search the web too"><input type="checkbox" name="web" ${settings().aiWeb ? 'checked' : ''}>${icon('globe')}<span>Web</span></label>
      <textarea name="q" rows="1" placeholder="Ask about your notes… e.g. “What did I decide about the Roku app?”" enterkeyhint="send"></textarea>
      <button class="btn primary icon-only" aria-label="Send">${icon('send')}</button>
    </form>`;
  const chat = root.querySelector('.chat');
  const form = root.querySelector('.chat-input');
  const ta = form.q;

  const bubble = (m, i) => {
    if (m.role === 'user') return `<div class="msg user"><div class="bubble">${esc(m.content)}</div></div>`;
    return `<div class="msg ai" data-i="${i}"><div class="bubble md">${m.content ? sanitizeHTML(markdownToHtml(m.content, { resolveLink: noteIdFor })) : '<span class="typing"><i></i><i></i><i></i></span>'}</div>
      ${m.status ? `<div class="msg-status">${esc(m.status)}</div>` : ''}
      ${m.notes?.length ? `<div class="msg-refs"><span>${icon('file-text')} Notes used:</span>${m.notes.slice(0, 8).map((n) => `<a class="link-chip" href="#/note/${n.id}">${esc(n.title)}</a>`).join('')}</div>` : ''}
      ${m.sources?.length ? `<div class="msg-refs"><span>${icon('globe')} Web:</span>${m.sources.slice(0, 8).map((s) => `<a class="link-chip" href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">${esc(s.title || new URL(s.url).hostname)}</a>`).join('')}</div>` : ''}
      ${m.done ? `<div class="msg-btns"><button class="chip" data-save="${i}">${icon('download')} Save as note</button><button class="chip" data-copy="${i}">${icon('copy')} Copy</button></div>` : ''}
    </div>`;
  };

  const render = () => {
    if (!convo.length) {
      chat.innerHTML = hasServer() ? `<div class="empty">${icon('sparkles', 'empty-ic')}<h3>Ask anything about your notes</h3>
        <p>The AI reads the notes most related to your question${settings().aiWeb ? ' and can search the web' : ''}. Links to the notes it used appear under each answer.</p>
        <div class="pill-row center">${['What did I write about this week?', 'Summarize my notes tagged #ideas', 'Which papers have I saved about language models?', 'What are my open questions?'].map((q) => `<button class="pill" data-suggest="${esc(q)}">${esc(q)}</button>`).join('')}</div></div>`
        : `<div class="empty">${icon('sparkles', 'empty-ic')}<h3>Connect your Worker to use AI</h3><p>Ask AI runs on your own Cloudflare Worker (or home server) so your API key never sits on your phone. It takes about 5 minutes — see the setup guide.</p><a class="btn primary" href="#/settings">Open settings</a></div>`;
      return;
    }
    chat.innerHTML = convo.map(bubble).join('');
    chat.lastElementChild?.scrollIntoView({ block: 'end' });
  };

  const send = async (q) => {
    q = q.trim();
    if (!q) return;
    const history = convo.filter((m) => m.done || m.role === 'user').map((m) => ({ role: m.role === 'ai' ? 'assistant' : 'user', content: m.content }));
    convo.push({ role: 'user', content: q });
    const m = { role: 'ai', content: '', sources: [], notes: [], status: 'Reading your notes…' };
    convo.push(m);
    render();
    ta.value = '';
    autosize();
    try {
      const res = await ask(q, {
        history,
        web: form.web.checked,
        onEvent: (ev) => {
          if (ev.type === 'text') { m.content += ev.text; m.status = ''; }
          if (ev.type === 'status') m.status = ev.text;
          if (ev.type === 'source') m.sources.push(ev);
          throttledRender();
        },
      });
      m.notes = res.notes;
      m.done = true;
      m.status = '';
    } catch (e) {
      m.content = `**Couldn't get an answer:** ${e.message}`;
      m.done = false;
      m.status = '';
    }
    render();
  };
  let rt = null;
  const throttledRender = () => { if (!rt) rt = setTimeout(() => { rt = null; render(); }, 80); };

  const autosize = () => { ta.style.height = 'auto'; ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`; };
  ta.addEventListener('input', autosize);
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(ta.value); } });
  form.onsubmit = (e) => { e.preventDefault(); send(ta.value); };
  form.web.onchange = () => saveSettings({ aiWeb: form.web.checked });

  root.addEventListener('click', async (e) => {
    const sug = e.target.closest('[data-suggest]');
    if (sug) send(sug.dataset.suggest);
    if (e.target.closest('[data-a="clear"]')) { convo.length = 0; render(); }
    const sv = e.target.closest('[data-save]');
    if (sv) {
      const m = convo[+sv.dataset.save];
      const q = convo[+sv.dataset.save - 1]?.content || 'AI answer';
      let html = `<h1>${esc(q.slice(0, 120))}</h1>${sanitizeHTML(markdownToHtml(m.content, { resolveLink: noteIdFor }))}`;
      if (m.notes?.length) html += `<p><b>From my notes:</b> ${m.notes.map((n) => `<a class="note-link" data-note-id="${n.id}" href="#/note/${n.id}">${esc(n.title)}</a>`).join(', ')}</p>`;
      if (m.sources?.length) html += `<p><b>Sources:</b></p><ul>${m.sources.map((s) => `<li><a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">${esc(s.title || s.url)}</a></li>`).join('')}</ul>`;
      const folder = await store.folderByName('AI answers');
      const note = await store.createNote({ html, folderId: folder.id });
      await store.db.put('history', importSession(note.id, store.deviceId(), htmlToText(html), html, 'a'));
      toast('Saved as a note', { action: 'Open', onAction: () => nav(`#/note/${note.id}`) });
    }
    const cp = e.target.closest('[data-copy]');
    if (cp) { await navigator.clipboard.writeText(convo[+cp.dataset.copy].content); toast('Copied'); }
  });

  render();
  const q0 = params.get('q');
  if (q0 && hasServer()) send(q0);
  else setTimeout(() => ta.focus(), 50);
  return () => clearTimeout(rt);
}

// [[Note title]] in answers → note links
function noteIdFor(title) { return store.findNoteByTitle(title)?.id || null; }
