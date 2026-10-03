import { test } from 'node:test';
import assert from 'node:assert/strict';
import { metaFromHTML, feedLinksFromHTML, isGoogleNews } from '../../worker/src/meta.js';
import { findSource, sourceForFeed, relatedSources, googleQuery } from '../../app/js/sources.js';
import { parseTakeout, termsOf, score, topTopics } from '../../app/js/reading.js';

test('featured image from og/twitter tags, skipping logos', () => {
  const page = (img) => `<html><head><meta property="og:title" content="Big story"><meta property="og:image" content="${img}"></head></html>`;
  assert.equal(metaFromHTML(page('/img/story.jpg?w=1200&amp;h=630'), 'https://news.example.com/a/b').image, 'https://news.example.com/img/story.jpg?w=1200&h=630');
  assert.equal(metaFromHTML(page('https://x.com/images/logo_social.png'), 'https://x.com/').image, '');
  assert.equal(metaFromHTML(`<meta name=twitter:image content=https://cdn.x.com/p.webp>`, 'https://x.com/').image, 'https://cdn.x.com/p.webp');
  assert.equal(metaFromHTML(page('/a.jpg'), 'https://x.com/').title, 'Big story');
});

test('feed links advertised by a homepage (not comment feeds)', () => {
  const html = `<link rel=alternate type=application/rss+xml title="MBW Feed" href=https://www.musicbusinessworldwide.com/feed/ >
    <link rel="alternate" type="application/rss+xml" title="Comments" href="/comments/feed/">`;
  assert.deepEqual(feedLinksFromHTML(html, 'https://www.musicbusinessworldwide.com/'), [{ url: 'https://www.musicbusinessworldwide.com/feed/', title: 'MBW Feed' }]);
  assert.ok(isGoogleNews('https://news.google.com/rss/articles/CBMiabc?oc=5'));
  assert.ok(!isGoogleNews('https://www.bbc.com/news'));
});

test('matching outlets by name, domain, homepage and Google News search', () => {
  assert.equal(findSource('BBC').name, 'BBC News');
  assert.equal(findSource('Wavy.com').name, 'WAVY 10');
  assert.equal(findSource('msnbc').name, 'MS NOW (MSNBC)');
  assert.equal(findSource('site:cnn.com when:2d').name, 'CNN');
  assert.equal(findSource('nonsense outlet'), null);
  const gn = (q) => `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US`;
  assert.equal(googleQuery(gn('BBC ')), 'BBC ');
  assert.equal(sourceForFeed({ url: gn('BBC ') }).name, 'BBC News');
  assert.equal(sourceForFeed({ url: 'https://www.foxnews.com/' }).name, 'Fox News');
  assert.equal(sourceForFeed({ url: 'https://feeds.bbci.co.uk/news/rss.xml' }).name, 'BBC News');
});

test('related sources share a group with what you follow', () => {
  const rel = relatedSources([{ url: 'https://feeds.bbci.co.uk/news/rss.xml' }, { url: 'https://www.wavy.com/feed/' }], { limit: 30 });
  const names = rel.map((r) => r.source.name);
  assert.ok(names.includes('The Guardian'));
  assert.ok(names.includes('WTKR News 3'));
  assert.ok(!names.includes('BBC News') && !names.includes('WAVY 10'));
  assert.ok(!names.includes('Pitchfork')); // unrelated group
  const dismissed = relatedSources([{ url: 'https://feeds.bbci.co.uk/news/rss.xml' }], { dismissed: ['The Guardian'], limit: 30 });
  assert.ok(!dismissed.some((r) => r.source.name === 'The Guardian'));
});

test('Google Takeout: My Activity JSON, News only', async () => {
  const activity = [
    { header: 'Google News', title: 'Viewed Pope Leo visits Lebanon on first trip', titleUrl: 'https://www.vaticannews.va/en/pope/news/x.html', time: '2026-09-30T10:00:00Z', products: ['Google News'] },
    { header: 'Google News', title: 'Read Virginia Beach council approves budget', titleUrl: 'https://www.wavy.com/news/x', time: '2026-09-29T10:00:00Z', products: ['Google News'] },
    { header: 'Search', title: 'Searched for pizza near me', titleUrl: 'https://www.google.com/search?q=pizza', time: '2026-09-29T10:00:00Z', products: ['Search'] },
  ];
  const file = new File([JSON.stringify(activity)], 'MyActivity.json', { type: 'application/json' });
  const { items } = await parseTakeout([file]);
  assert.equal(items.length, 2);
  assert.equal(items[0].title, 'Pope Leo visits Lebanon on first trip');
  assert.equal(items[1].site, 'wavy.com');
});

test('ranking: topic and source matches beat fresh but unrelated stories', () => {
  const now = Date.parse('2026-10-03T12:00:00Z');
  const p = { terms: Object.fromEntries(termsOf('Pope Leo Vatican synod Pope').map((t) => [t, 5])), sources: { 'vaticannews.va': 4 }, count: 3 };
  const liked = { title: 'Pope Leo names new bishops', url: 'https://www.vaticannews.va/x', date: '2026-10-03T06:00:00Z' };
  const other = { title: 'Stocks slip as oil rises', url: 'https://www.cnbc.com/x', date: '2026-10-03T11:00:00Z' };
  assert.ok(score(liked, p, now) > score(other, p, now));
  assert.deepEqual(termsOf('The latest: Pope Leo says'), ['pope', 'leo']);
  const items = ['Pope Leo meets', 'Pope Leo travels', 'Pope Leo prays', 'Weather today'].map((title) => ({ title }));
  assert.deepEqual(topTopics(items), ['pope leo']);
});

test('For you mixes sources instead of stacking one busy feed', async () => {
  const { rank } = await import('../../app/js/reading.js');
  const now = Date.parse('2026-10-03T12:00:00Z');
  const fox = Array.from({ length: 5 }, (_, i) => ({ title: `Fox story ${i}`, url: `https://www.foxnews.com/${i}`, date: new Date(now - i * 60000).toISOString() }));
  const bbc = { title: 'BBC story', url: 'https://www.bbc.com/news/1', date: new Date(now - 3 * 3600000).toISOString() };
  const top3 = rank([...fox, bbc], { terms: {}, sources: {} }, now).slice(0, 3).map((a) => a.title);
  assert.ok(top3.includes('BBC story'));
});

test('Epoch Times by name, domain and feed', () => {
  assert.equal(findSource('Epoch Times').name, 'The Epoch Times');
  assert.equal(findSource('theepochtimes.com').name, 'The Epoch Times');
  assert.equal(sourceForFeed({ url: 'https://feed.theepochtimes.com/us/feed' }).name, 'The Epoch Times');
  assert.equal(sourceForFeed({ url: 'https://www.theepochtimes.com/' }).name, 'The Epoch Times');
});
