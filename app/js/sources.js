// A small catalog of news sources with working feeds (checked Oct 2026), grouped so the News tab can
// suggest related outlets ("You follow BBC News — add The Guardian?") and turn a Google News search
// for an outlet ("Google News · BBC") into that outlet's own feed.
// Outlets without a usable RSS feed (CNN, Reuters, AP, ESPN) use a Google News "site:" feed.

import { fold } from './text.js';

const gn = (site) => `https://news.google.com/rss/search?q=${encodeURIComponent(`site:${site} when:2d`)}&hl=en-US&gl=US&ceid=US:en`;

export const CATALOG = [
  // world
  { name: 'BBC News', site: 'bbc.com', alt: ['bbc', 'bbc.co.uk'], url: 'https://feeds.bbci.co.uk/news/rss.xml', groups: ['world', 'us'] },
  { name: 'The Guardian', site: 'theguardian.com', alt: ['guardian'], url: 'https://www.theguardian.com/world/rss', groups: ['world'] },
  { name: 'Al Jazeera', site: 'aljazeera.com', url: 'https://www.aljazeera.com/xml/rss/all.xml', groups: ['world'] },
  { name: 'Reuters', site: 'reuters.com', url: gn('reuters.com'), groups: ['world', 'us', 'business'] },
  { name: 'AP News', site: 'apnews.com', alt: ['associated press', 'ap'], url: gn('apnews.com'), groups: ['world', 'us'] },
  { name: 'NPR', site: 'npr.org', url: 'https://feeds.npr.org/1001/rss.xml', groups: ['us', 'world'] },
  // US
  { name: 'CNN', site: 'cnn.com', url: gn('cnn.com'), groups: ['us', 'world'] },
  { name: 'MS NOW (MSNBC)', site: 'ms.now', alt: ['msnbc', 'msnbc.com', 'ms now'], url: 'https://www.ms.now/feed', groups: ['us'] },
  { name: 'Fox News', site: 'foxnews.com', alt: ['fox'], url: 'https://moxie.foxnews.com/google-publisher/latest.xml', groups: ['us'] },
  { name: 'NBC News', site: 'nbcnews.com', alt: ['nbc'], url: 'https://feeds.nbcnews.com/nbcnews/public/news', groups: ['us'] },
  { name: 'ABC News', site: 'abcnews.go.com', alt: ['abc'], url: 'https://abcnews.go.com/abcnews/topstories', groups: ['us'] },
  { name: 'CBS News', site: 'cbsnews.com', alt: ['cbs'], url: 'https://www.cbsnews.com/latest/rss/main', groups: ['us'] },
  { name: 'PBS NewsHour', site: 'pbs.org', alt: ['pbs'], url: 'https://www.pbs.org/newshour/feeds/rss/headlines', groups: ['us'] },
  { name: 'The New York Times', site: 'nytimes.com', alt: ['nyt', 'new york times'], url: 'https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml', groups: ['us', 'world'] },
  { name: 'The Washington Post', site: 'washingtonpost.com', alt: ['washington post', 'wapo'], url: 'https://feeds.washingtonpost.com/rss/national', groups: ['us'] },
  { name: 'The Wall Street Journal', site: 'wsj.com', alt: ['wsj', 'wall street journal'], url: 'https://feeds.content.dowjones.io/public/rss/RSSWorldNews', groups: ['us', 'business'] },
  { name: 'The Hill', site: 'thehill.com', url: 'https://thehill.com/feed/', groups: ['us'] },
  { name: 'Politico', site: 'politico.com', url: 'https://rss.politico.com/politics-news.xml', groups: ['us'] },
  { name: 'Axios', site: 'axios.com', url: 'https://api.axios.com/feed/', groups: ['us', 'tech'] },
  { name: 'New York Post', site: 'nypost.com', alt: ['ny post'], url: 'https://nypost.com/feed/', groups: ['us'] },
  { name: 'National Review', site: 'nationalreview.com', url: 'https://www.nationalreview.com/feed/', groups: ['us'] },
  { name: 'Washington Examiner', site: 'washingtonexaminer.com', url: 'https://www.washingtonexaminer.com/feed', groups: ['us'] },
  { name: 'The Dispatch', site: 'thedispatch.com', url: 'https://thedispatch.com/feed/', groups: ['us'] },
  { name: 'The Epoch Times', site: 'theepochtimes.com', alt: ['epoch times', 'epoch', 'epochtimes', 'feed.theepochtimes.com'], url: 'https://feed.theepochtimes.com/us/feed', groups: ['us', 'world'] },
  { name: 'Epoch Times · World', site: 'theepochtimes.com/world', url: 'https://feed.theepochtimes.com/world/feed', groups: ['world'] },
  { name: 'Epoch Times · Opinion', site: 'theepochtimes.com/opinion', url: 'https://feed.theepochtimes.com/opinion/feed', groups: ['us'] },
  // Hampton Roads
  { name: 'WAVY 10', site: 'wavy.com', alt: ['wavy'], url: 'https://www.wavy.com/feed/', groups: ['local'] },
  { name: 'WTKR News 3', site: 'wtkr.com', alt: ['wtkr'], url: 'https://www.wtkr.com/news.rss', groups: ['local'] },
  { name: '13News Now', site: '13newsnow.com', alt: ['wvec'], url: 'https://www.13newsnow.com/feeds/syndication/rss/news', groups: ['local'] },
  // Catholic
  { name: 'Vatican News', site: 'vaticannews.va', url: 'https://www.vaticannews.va/en.rss.xml', groups: ['catholic'] },
  { name: 'EWTN News (CNA)', site: 'ewtnnews.com', alt: ['catholic news agency', 'catholicnewsagency.com', 'cna', 'ewtn'], url: 'https://www.ewtnnews.com/rss', groups: ['catholic'] },
  { name: 'National Catholic Register', site: 'ncregister.com', url: 'https://www.ncregister.com/feeds/general-news.xml', groups: ['catholic'] },
  { name: 'The Pillar', site: 'pillarcatholic.com', url: 'https://www.pillarcatholic.com/feed', groups: ['catholic'] },
  { name: 'Aleteia', site: 'aleteia.org', url: 'https://aleteia.org/feed/', groups: ['catholic'] },
  { name: 'Catholic World Report', site: 'catholicworldreport.com', url: 'https://www.catholicworldreport.com/feed/', groups: ['catholic'] },
  { name: 'Crux', site: 'cruxnow.com', url: 'https://cruxnow.com/feed', groups: ['catholic'] },
  { name: 'Word on Fire', site: 'wordonfire.org', url: 'https://www.wordonfire.org/feed/', groups: ['catholic'] },
  // music
  { name: 'Music Business Worldwide', site: 'musicbusinessworldwide.com', alt: ['mbw'], url: 'https://www.musicbusinessworldwide.com/feed/', groups: ['music'] },
  { name: 'Billboard', site: 'billboard.com', url: 'https://www.billboard.com/feed/', groups: ['music'] },
  { name: 'Digital Music News', site: 'digitalmusicnews.com', url: 'https://www.digitalmusicnews.com/feed/', groups: ['music'] },
  { name: 'Pitchfork', site: 'pitchfork.com', url: 'https://pitchfork.com/feed/feed-news/rss', groups: ['music'] },
  { name: 'Rolling Stone', site: 'rollingstone.com', url: 'https://www.rollingstone.com/feed/', groups: ['music'] },
  { name: 'Variety · Music', site: 'variety.com', alt: ['variety'], url: 'https://variety.com/v/music/feed/', groups: ['music'] },
  { name: 'Stereogum', site: 'stereogum.com', url: 'https://www.stereogum.com/feed/', groups: ['music'] },
  // tech
  { name: 'The Verge', site: 'theverge.com', alt: ['verge'], url: 'https://www.theverge.com/rss/index.xml', groups: ['tech'] },
  { name: 'Ars Technica', site: 'arstechnica.com', alt: ['ars'], url: 'https://feeds.arstechnica.com/arstechnica/index', groups: ['tech', 'science'] },
  { name: 'TechCrunch', site: 'techcrunch.com', url: 'https://techcrunch.com/feed/', groups: ['tech', 'business'] },
  { name: 'Wired', site: 'wired.com', url: 'https://www.wired.com/feed/rss', groups: ['tech'] },
  { name: 'Engadget', site: 'engadget.com', url: 'https://www.engadget.com/rss.xml', groups: ['tech'] },
  { name: '9to5Google', site: '9to5google.com', url: 'https://9to5google.com/feed/', groups: ['tech'] },
  { name: 'Hacker News', site: 'news.ycombinator.com', alt: ['hn', 'hnrss.org'], url: 'https://hnrss.org/frontpage', groups: ['tech'] },
  // science
  { name: 'Quanta Magazine', site: 'quantamagazine.org', alt: ['quanta'], url: 'https://www.quantamagazine.org/feed/', groups: ['science'] },
  { name: 'ScienceDaily', site: 'sciencedaily.com', url: 'https://www.sciencedaily.com/rss/all.xml', groups: ['science'] },
  { name: 'Nature', site: 'nature.com', url: 'https://www.nature.com/nature.rss', groups: ['science'] },
  // business
  { name: 'CNBC', site: 'cnbc.com', url: 'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=100003114', groups: ['business'] },
  { name: 'Bloomberg Markets', site: 'bloomberg.com', alt: ['bloomberg'], url: 'https://feeds.bloomberg.com/markets/news.rss', groups: ['business'] },
  { name: 'MarketWatch', site: 'marketwatch.com', url: 'https://feeds.content.dowjones.io/public/rss/mw_topstories', groups: ['business'] },
  // sports
  { name: 'ESPN', site: 'espn.com', url: gn('espn.com'), groups: ['sports'] },
  { name: 'CBS Sports', site: 'cbssports.com', url: 'https://www.cbssports.com/rss/headlines/', groups: ['sports'] },
];

export const GROUPS = { world: 'World', us: 'U.S. news', local: 'Hampton Roads', catholic: 'Catholic', music: 'Music business', tech: 'Tech', science: 'Science', business: 'Business', sports: 'Sports' };

export const hostOf = (url) => { try { return new URL(url).hostname.replace(/^(www|feeds|rss|api|moxie|search)\./, ''); } catch { return ''; } };

const keyOf = (s) => fold(s).replace(/^www\./, '').replace(/\s+/g, ' ').trim();

/** The Google News search behind a "Google News · X" feed, or ''. */
export function googleQuery(url) {
  try {
    const u = new URL(url);
    return u.hostname === 'news.google.com' ? (u.searchParams.get('q') || '') : '';
  } catch { return ''; }
}

/** Catalog entry for a site name, domain, or Google News query ("BBC", "Wavy.com", "site:cnn.com"). */
export function findSource(text) {
  const k = keyOf(String(text || '').replace(/\bsite:|\bwhen:\w+/g, ''));
  if (!k) return null;
  return CATALOG.find((c) => keyOf(c.name) === k || c.site === k || hostOf(`https://${k}`) === c.site || (c.alt || []).includes(k)) || null;
}

/** Catalog entry a stored feed corresponds to (its own feed, its site, or a Google News search for it). */
export function sourceForFeed(feed) {
  const host = hostOf(feed.url);
  const q = googleQuery(feed.url);
  return CATALOG.find((c) => c.url === feed.url) ||
    (q ? findSource(q) : CATALOG.find((c) => c.site === host || host.endsWith(`.${c.site}`) || hostOf(c.url) === host)) || null;
}

/** Outlets related to the ones you follow, best first: [{ source, because }]. `affinity` = { domain: weight }. */
export function relatedSources(feeds, { affinity = {}, dismissed = [], limit = 6 } = {}) {
  const followed = feeds.map((f) => sourceForFeed(f)).filter(Boolean);
  const have = new Set(followed.map((s) => s.name));
  const groups = new Map();
  for (const s of followed) for (const g of s.groups) if (!groups.has(g)) groups.set(g, s);
  const scored = CATALOG.filter((c) => !have.has(c.name) && !dismissed.includes(c.name)).map((c) => {
    const shared = c.groups.filter((g) => groups.has(g));
    return { source: c, because: shared.length ? groups.get(shared[0]).name : '', score: shared.length * 2 + Math.log1p(affinity[c.site] || 0) * 3 };
  }).filter((x) => x.score > 0);
  return scored.sort((a, b) => b.score - a.score).slice(0, limit);
}
