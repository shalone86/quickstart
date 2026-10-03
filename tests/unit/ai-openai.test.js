import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { answer } from '../../worker/src/ai.js';

// A fake Open WebUI (/api/chat/completions, streaming) and SearXNG (/search) on one port.
function fakeServer() {
  const seen = [];
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      seen.push({ url: req.url, auth: req.headers.authorization, body: raw ? JSON.parse(raw) : null });
      if (req.url.startsWith('/search')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ results: [{ title: 'Example', url: 'https://example.com/a', content: 'A snippet' }] }));
      }
      if (req.headers.authorization !== 'Bearer sk-test') { res.writeHead(401); return res.end('{"detail":"Not authenticated"}'); }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      // <think> split across chunks to check it is hidden
      for (const t of ['<thi', 'nk>hmm</th', 'ink>Hello ', 'from [[My note]]']) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  return new Promise((ok) => srv.listen(0, () => ok({ srv, seen, base: `http://127.0.0.1:${srv.address().port}` })));
}

async function run(opts, body = {}) {
  const events = [];
  await answer({ question: 'What did I write?', notes: [{ title: 'My note', text: 'hi', created: 'x', updated: 'x' }], ...body }, { ...opts, send: (e) => events.push(e) });
  return events;
}

test('streams an answer from Open WebUI, hiding <think> and using the key', async () => {
  const { srv, seen, base } = await fakeServer();
  try {
    const events = await run({ aiUrl: `${base}/api`, aiKey: 'sk-test', model: 'qwen3.6:latest' });
    const text = events.filter((e) => e.type === 'text').map((e) => e.text).join('');
    assert.equal(text, 'Hello from [[My note]]');
    assert.equal(events.at(-1).type, 'done');
    const call = seen.find((s) => s.url === '/api/chat/completions');
    assert.equal(call.body.model, 'qwen3.6:latest');
    assert.match(call.body.messages[0].content, /<note title="My note"/);
  } finally { srv.close(); }
});

test('web search goes through SearXNG and emits sources', async () => {
  const { srv, seen, base } = await fakeServer();
  try {
    const events = await run({ aiUrl: `${base}/api`, aiKey: 'sk-test', model: 'm', searxng: base }, { web: true });
    assert.deepEqual(events.find((e) => e.type === 'source'), { type: 'source', url: 'https://example.com/a', title: 'Example' });
    assert.match(seen.find((s) => s.url === '/api/chat/completions').body.messages[0].content, /<web>[\s\S]*A snippet/);
  } finally { srv.close(); }
});

test('clear errors for a bad key or a missing model', async () => {
  const { srv, base } = await fakeServer();
  try {
    let events = await run({ aiUrl: `${base}/api`, aiKey: 'wrong', model: 'm' });
    assert.match(events.at(-1).error, /rejected the API key/);
    events = await run({ aiUrl: `${base}/api`, model: 'claude-opus-5-5' });
    assert.match(events.at(-1).error, /AI_MODEL/);
  } finally { srv.close(); }
});
