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
 * @param {object} opts   { apiKey, model, send(event) }
 */
export async function answer(body, { apiKey, model, send }) {
  if (!apiKey) { send({ type: 'error', error: 'ANTHROPIC_API_KEY is not set on the server.' }); return; }
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
