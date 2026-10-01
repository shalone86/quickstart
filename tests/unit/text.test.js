import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoTitle, snippet, wordCount, tokenize } from '../../app/js/text.js';
import { parseQuery } from '../../app/js/search.js';
import { safeFileName, dateGroup } from '../../app/js/util.js';

test('automatic titles', () => {
  assert.equal(autoTitle('Groceries for the week\nmilk'), 'Groceries for the week');
  assert.equal(autoTitle('- [ ] buy cables'), 'buy cables');
  assert.ok(autoTitle('word '.repeat(40)).endsWith('…'));
  assert.ok(autoTitle('[sketch]', Date.UTC(2026, 9, 1, 12)).startsWith('Sketch ·'));
  assert.ok(autoTitle('[audio]').startsWith('Voice note'));
  assert.equal(autoTitle(''), 'New note');
});

test('snippet skips the title line', () => {
  assert.equal(snippet('Title\nBody text here', 'Title'), 'Body text here');
});

test('word count and tokenizing fold accents', () => {
  assert.equal(wordCount("It's a café, isn't it?"), 5);
  assert.deepEqual(tokenize('Café NOËL'), ['cafe', 'noel']);
});

test('search query syntax', () => {
  const q = parseQuery('roku "family player" #ideas folder:church is:pinned');
  assert.deepEqual(q.terms, ['roku']);
  assert.deepEqual(q.phrases, ['family player']);
  assert.deepEqual(q.tags, ['ideas']);
  assert.equal(q.folder, 'church');
  assert.deepEqual(q.flags, ['pinned']);
});

test('safe file names for Obsidian', () => {
  assert.equal(safeFileName('a/b: c?'), 'a b c');
  assert.equal(safeFileName(''), 'Untitled');
});

test('date groups', () => {
  const now = Date.now();
  assert.equal(dateGroup(now, now), 'Today');
  assert.equal(dateGroup(now - 86400000, now), 'Yesterday');
});
