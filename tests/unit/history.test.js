import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diff, applyDiff, Recorder, replay, segments, versions, importSession } from '../../app/js/history.js';

test('diff/applyDiff round-trip', () => {
  const cases = [['', 'abc'], ['hello world', 'hello brave world'], ['abcdef', 'abXYef'], ['same', 'same'], ['abc', '']];
  for (const [a, b] of cases) {
    const d = diff(a, b);
    assert.equal(d ? applyDiff(a, ...d) : a, b);
  }
});

function fakeEditor() {
  const doc = { text: '', html: '' };
  const saved = [];
  const rec = new Recorder({ noteId: 'n1', device: 'd1', getText: () => doc.text, getHtml: () => doc.html, save: async (s) => saved.push(structuredClone(s)) });
  return { doc, rec, saved };
}

test('recorder attributes typed vs pasted text and replays to the final text', async () => {
  const { doc, rec } = fakeEditor();
  for (const ch of 'Hello ') { doc.text += ch; doc.html = `<p>${doc.text}</p>`; rec.record('t'); }
  doc.text += 'PASTED BLOCK'; rec.record('p');
  doc.text += ' world'; rec.record('t');
  doc.text = doc.text.replace('Hello', 'Hi'); rec.record('t');
  await rec.flush();
  const { text, origin, stats } = replay([rec.session]);
  assert.equal(text, 'Hi PASTED BLOCK world');
  assert.equal(stats.pastes.length, 1);
  const segs = segments(text, origin);
  assert.ok(segs.some((s) => s.kind === 'p' && s.text === 'PASTED BLOCK'));
  assert.ok(segs.every((s) => s.kind !== 'p' || s.text === 'PASTED BLOCK'));
});

test('composer recording before the note exists is saved once an id is attached', async () => {
  const doc = { text: '', html: '' };
  const saved = [];
  const rec = new Recorder({ noteId: null, device: 'd', getText: () => doc.text, getHtml: () => doc.html, save: async (s) => saved.push(s) });
  doc.text = 'a'; rec.record('t');
  await rec.flush();
  assert.equal(saved.length, 0);
  rec.setNoteId('n9');
  await rec.flush();
  assert.equal(saved.at(-1).noteId, 'n9');
});

test('sessions from different devices chain, with outside changes marked', () => {
  const s1 = importSession('n', 'a', 'Title', '<p>Title</p>', 'a', 1000);
  const s2 = { id: 'x', noteId: 'n', device: 'b', start: 5000, end: 6000, baseText: 'Title changed', baseHtml: '', ops: [[10, 't', 13, 0, '!']], cps: [], updated: 6000 };
  const { text, origin } = replay([s2, s1]);
  assert.equal(text, 'Title changed!');
  assert.equal(origin.at(-1), 't');
  assert.ok(origin.includes('e'));
  assert.equal(versions([s1]).length, 2);
});
