// "Ask your notes" — shared by the Cloudflare Worker and the Node home server.
// Streams Claude's answer back to the app as Server-Sent Events.

import Anthropic from '@anthropic-ai/sdk';

const SYSTEM = `You are the assistant built into Scriptorium, the user's personal notes app.
You answer questions using the user's own notes, which are provided below inside <notes>. Each note has a title, dates, folder, tags and text.

How to answer:
- Ground answers in the notes. When you use a note, name it in double brackets exactly like [[Note title]] so the app can link to it.
- If the notes don't contain the answer, say so plainly. If web search is available and the question needs outside facts, search the web and cite the pages you used.
- Be concise and direct. Use short paragraphs or bullet lists; use Markdown.
- For questions about dates ("what did I write last week"), use the created/updated dates of the notes and today's date given in the request.
- Never invent the contents of a note. The <index> lists other note titles that exist but whose text was not included; you may mention that they might be relevant.`;

function notesBlock(notes = [], index = []) {
  const parts = notes.map((n) => [
    `<note title="${esc(n.title)}" created="${n.created}" updated="${n.updated}"${n.folder ? ` folder="${esc(n.folder)}"` : ''}${n.tags?.length ? ` tags="${esc(n.tags.join(', '))}"` : ''}${n.source ? ` source="${esc(n.source)}"` : ''}>`,
    n.text || '',
    '</note>',
  ].join('\n'));
  return `<notes>\n${parts.join('\n\n') || '(no matching notes)'}\n</notes>\n\n<index>\n${index.join('\n')}\n</index>`;
}

function esc(s) { return String(s || '').replace(/"/g, '&quot;'); }

/**
 * @param {object} body   { question, history, notes, index, web, effort, today }
 * @param {object} opts   { apiKey, model, send(event) } — or, for Ollama / Open WebUI / any
 *                        OpenAI-compatible server: { aiUrl, aiKey, model, searxng, send }
 */
export async function answer(body, opts) {
  if (opts.aiUrl) return answerOpenAI(body, opts);
  const { apiKey, model, send } = opts;
  if (!apiKey) { send({ type: 'error', error: 'No AI is set up on the server: set AI_URL + AI_MODEL (Ollama / Open WebUI) or ANTHROPIC_API_KEY.' }); return; }
  const client = new Anthropic({ apiKey });
  const effort = ['low', 'medium', 'high', 'xhigh', 'max'].includes(body.effort) ? body.effort : 'medium';
  const tools = body.web ? [
    { type: 'web_search_20260209', name: 'web_search', max_uses: 5 },
    { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 5 },
  ] : [];
  const history = (body.history || []).filter((m) => m && m.content && (m.role === 'user' || m.role === 'assistant')).map((m) => ({ role: m.role, content: String(m.content) }));
  const messages = [...history, { role: 'user', content: `Today is ${body.today || new Date().toString()}.\n\n${String(body.question || '').slice(0, 8000)}` }];
  const system = [
    { type: 'text', text: SYSTEM },
    { type: 'text', text: notesBlock(body.notes, body.index), cache_control: { type: 'ephemeral' } },
  ];

  try {
    // Server tools (web search/fetch) can pause a long turn; continue it a few times.
    for (let round = 0; round < 4; round++) {
      const stream = client.beta.messages.stream({
        model: model || 'claude-opus-5-5',
        max_tokens: 64000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort },
        system,
        messages,
        ...(tools.length ? { tools } : {}),
      });
      for await (const ev of stream) {
        if (ev.type === 'content_block_start') {
          const b = ev.content_block;
          if (b.type === 'server_tool_use') send({ type: 'status', text: b.name === 'web_fetch' ? 'Reading a web page…' : 'Searching the web…' });
          if (b.type === 'web_search_tool_result' && Array.isArray(b.content)) {
            for (const r of b.content.slice(0, 5)) if (r.url) send({ type: 'source', url: r.url, title: r.title || '' });
          }
        } else if (ev.type === 'content_block_delta') {
          if (ev.delta.type === 'text_delta') send({ type: 'text', text: ev.delta.text });
          if (ev.delta.type === 'citations_delta' && ev.delta.citation?.url) send({ type: 'source', url: ev.delta.citation.url, title: ev.delta.citation.title || '' });
        }
      }
      const msg = await stream.finalMessage();
      if (msg.stop_reason === 'refusal') { send({ type: 'text', text: '\n\n_I can’t help with that request._' }); break; }
      if (msg.stop_reason !== 'pause_turn') break;
      messages.push({ role: 'assistant', content: msg.content });
    }
    send({ type: 'done' });
  } catch (e) {
    let msg = e?.message || String(e);
    if (e instanceof Anthropic.AuthenticationError) msg = 'The Anthropic API key on the server is invalid.';
    else if (e instanceof Anthropic.RateLimitError) msg = 'Rate limited by the AI provider — try again in a minute.';
    else if (e instanceof Anthropic.APIError) msg = `AI error ${e.status}: ${e.message}`;
    send({ type: 'error', error: msg });
  }
}

/* ---------------- Ollama / Open WebUI (OpenAI-compatible chat completions) ---------------- */

// AI_URL is the API base: Open WebUI → https://host/api, Ollama → http://host:11434/v1.
// Web search uses SearXNG (the model has no built-in search): top results go into the prompt.
async function webResults(searxng, q, send) {
  if (!searxng) return '';
  send({ type: 'status', text: 'Searching the web…' });
  try {
    const r = await fetch(`${searxng.replace(/\/+$/, '')}/search?q=${encodeURIComponent(q.slice(0, 300))}&format=json`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) return '';
    const results = ((await r.json()).results || []).filter((x) => x.url).slice(0, 6);
    for (const x of results) send({ type: 'source', url: x.url, title: x.title || '' });
    return results.map((x, i) => `<result n="${i + 1}" title="${esc(x.title)}" url="${esc(x.url)}">\n${x.content || ''}\n</result>`).join('\n');
  } catch { return ''; }
}

export async function answerOpenAI(body, { aiUrl, aiKey, model, searxng, send }) {
  if (!model || model.startsWith('claude')) { send({ type: 'error', error: 'Set AI_MODEL to your Ollama model name (e.g. qwen3.6:latest).' }); return; }
  const question = String(body.question || '').slice(0, 8000);
  const web = body.web ? await webResults(searxng, question, send) : '';
  const history = (body.history || []).filter((m) => m && m.content && (m.role === 'user' || m.role === 'assistant')).map((m) => ({ role: m.role, content: String(m.content) }));
  const system = `${SYSTEM}\n\n${notesBlock(body.notes, body.index)}${web ? `\n\nWeb search results (cite them as links when you use them):\n<web>\n${web}\n</web>` : ''}`;
  const messages = [{ role: 'system', content: system }, ...history, { role: 'user', content: `Today is ${body.today || new Date().toString()}.\n\n${question}` }];

  try {
    const r = await fetch(`${aiUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(aiKey ? { Authorization: `Bearer ${aiKey}` } : {}) },
      body: JSON.stringify({ model, messages, stream: true }),
    });
    if (!r.ok || !r.body) {
      const detail = (await r.text().catch(() => '')).slice(0, 200);
      send({ type: 'error', error: r.status === 401 || r.status === 403 ? 'The AI server rejected the API key (AI_API_KEY).' : `AI error ${r.status}${detail ? `: ${detail}` : ''}` });
      return;
    }
    // Reasoning models (qwen, deepseek…) may stream <think>…</think> first; hide it.
    let inThink = false, pending = '';
    const emit = (chunk) => {
      pending += chunk;
      for (;;) {
        const tag = inThink ? '</think>' : '<think>';
        const i = pending.indexOf(tag);
        if (i >= 0) {
          if (!inThink && i) send({ type: 'text', text: pending.slice(0, i) });
          if (!inThink) send({ type: 'status', text: 'Thinking…' });
          inThink = !inThink;
          pending = pending.slice(i + tag.length);
          continue;
        }
        // keep a possible partial tag at the end for the next chunk
        const keep = Math.min(pending.length, tag.length - 1);
        const out = pending.slice(0, pending.length - keep);
        pending = pending.slice(pending.length - keep);
        if (out && !inThink) send({ type: 'text', text: out });
        return;
      }
    };
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        let ev;
        try { ev = JSON.parse(data); } catch { continue; }
        if (ev.error) { send({ type: 'error', error: ev.error.message || String(ev.error) }); return; }
        const text = ev.choices?.[0]?.delta?.content;
        if (text) emit(text);
      }
    }
    if (pending && !inThink) send({ type: 'text', text: pending });
    send({ type: 'done' });
  } catch (e) {
    send({ type: 'error', error: `Couldn't reach the AI server at ${aiUrl}: ${e?.message || e}` });
  }
}

/** Wraps `answer` in an SSE Response (Worker / fetch-style runtimes). */
export function answerResponse(body, opts, headers = {}) {
  const ts = new TransformStream();
  const writer = ts.writable.getWriter();
  const enc = new TextEncoder();
  const send = (ev) => writer.write(enc.encode(`data: ${JSON.stringify(ev)}\n\n`)).catch(() => {});
  (async () => {
    try { await answer(body, { ...opts, send }); } finally { writer.close().catch(() => {}); }
  })();
  return new Response(ts.readable, { headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', ...headers } });
}
