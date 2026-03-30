#!/usr/bin/env node

/**
 * CHRONICLE Magazine RSS Crawler + Static Site Generator
 *
 * Crawls RSS feeds from K-pop/K-culture English news sites,
 * extracts article data, fetches full article content,
 * and generates self-contained static HTML pages.
 *
 * English-language longform editorial in the style of Monocle / The New Yorker.
 *
 * Usage: node crawl.mjs
 * No dependencies needed -- pure Node.js 18+ with built-in fetch.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ============================================================
// Configuration
// ============================================================

const SOURCES = [
  // === Tier 1: High-volume K-pop news (English) ===
  { name: 'Soompi', url: 'https://www.soompi.com/feed', lang: 'en' },
  { name: 'Koreaboo', url: 'https://www.koreaboo.com/feed/', lang: 'en' },
  { name: 'HelloKpop', url: 'https://www.hellokpop.com/feed/', lang: 'en' },
  { name: 'Seoulbeats', url: 'https://seoulbeats.com/feed/', lang: 'en' },
  // === Tier 2: Commentary & Reviews ===
  { name: 'AsianJunkie', url: 'https://www.asianjunkie.com/feed/', lang: 'en' },
  { name: 'TheBiasList', url: 'https://thebiaslist.com/feed/', lang: 'en' },
  // === Tier 3: General entertainment w/ K-pop coverage ===
  { name: 'KDramaStars', url: 'https://www.kdramastars.com/rss.xml', lang: 'en' },
  { name: 'DramaNews', url: 'https://www.dramabeans.com/feed/', lang: 'en' },
];

const FETCH_TIMEOUT = 10_000;
const OG_IMAGE_TIMEOUT = 8_000;
const ARTICLE_FETCH_TIMEOUT = 12_000;
const MAX_OG_IMAGE_FETCHES = 40;
const OG_IMAGE_CONCURRENCY = 10;
const ARTICLE_FETCH_CONCURRENCY = 5;
const PLACEHOLDER_IMAGE = 'https://picsum.photos/seed/chronicle-placeholder/800/450';

const log = (msg) => console.log(`[CHRONICLE Crawler] ${msg}`);
const warn = (msg) => console.warn(`[CHRONICLE Crawler] WARN: ${msg}`);

// ============================================================
// Fetch with timeout
// ============================================================

async function fetchWithTimeout(url, timeoutMs = FETCH_TIMEOUT) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

// ============================================================
// XML Parsing helpers (regex-based, no dependencies)
// ============================================================

function extractTag(xml, tagName) {
  const cdataRe = new RegExp(`<${tagName}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*</${tagName}>`, 'i');
  const cdataMatch = xml.match(cdataRe);
  if (cdataMatch) return cdataMatch[1].trim();

  const re = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)</${tagName}>`, 'i');
  const match = xml.match(re);
  return match ? match[1].trim() : '';
}

function extractAllTags(xml, tagName) {
  const results = [];
  const re = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)</${tagName}>`, 'gi');
  let match;
  while ((match = re.exec(xml)) !== null) {
    results.push(match[1].trim());
  }
  return results;
}

function extractAttribute(xml, tagName, attrName) {
  const re = new RegExp(`<${tagName}[^>]*?${attrName}\\s*=\\s*["']([^"']+)["']`, 'i');
  const match = xml.match(re);
  return match ? match[1] : '';
}

function extractItems(xml) {
  const items = [];
  const re = /<item[^>]*>([\s\S]*?)<\/item>/gi;
  let match;
  while ((match = re.exec(xml)) !== null) {
    items.push(match[1]);
  }
  return items;
}

function decodeHtmlEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&#8217;/g, '\u2019')
    .replace(/&#8216;/g, '\u2018')
    .replace(/&#8220;/g, '\u201C')
    .replace(/&#8221;/g, '\u201D')
    .replace(/&#8230;/g, '\u2026')
    .replace(/&#038;/g, '&')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

function stripHtml(html) {
  return html.replace(/<[^>]+>/g, '').trim();
}

// ============================================================
// Image extraction
// ============================================================

function extractImageFromContent(content) {
  if (!content) return '';

  const mediaUrl = extractAttribute(content, 'media:content', 'url')
    || extractAttribute(content, 'media:thumbnail', 'url');
  if (mediaUrl) return mediaUrl;

  const enclosureUrl = extractAttribute(content, 'enclosure', 'url');
  if (enclosureUrl) {
    const enclosureType = extractAttribute(content, 'enclosure', 'type');
    if (!enclosureType || enclosureType.startsWith('image')) return enclosureUrl;
  }

  const imgMatch = content.match(/<img[^>]+src\s*=\s*["']([^"']+)["']/i);
  if (imgMatch) return imgMatch[1];

  return '';
}

async function fetchOgImage(articleUrl) {
  try {
    const html = await fetchWithTimeout(articleUrl, OG_IMAGE_TIMEOUT);
    const ogMatch = html.match(/<meta[^>]+property\s*=\s*["']og:image["'][^>]+content\s*=\s*["']([^"']+)["']/i)
      || html.match(/<meta[^>]+content\s*=\s*["']([^"']+)["'][^>]+property\s*=\s*["']og:image["']/i);
    if (ogMatch) return ogMatch[1];
    return '';
  } catch {
    return '';
  }
}

// ============================================================
// Date formatting — "March 22, 2026" style
// ============================================================

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

function formatDate(dateStr) {
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return '';
    return `${MONTH_NAMES[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
  } catch {
    return '';
  }
}

// ============================================================
// Known K-pop group / artist names for extraction
// ============================================================

const KNOWN_GROUPS = [
  'BTS', 'BLACKPINK', 'TWICE', 'EXO', 'NCT', 'aespa', 'Stray Kids', 'ENHYPEN',
  'TXT', 'ATEEZ', 'SEVENTEEN', 'Red Velvet', 'IVE', 'LE SSERAFIM', 'NewJeans',
  '(G)I-DLE', 'ITZY', 'NMIXX', 'Kep1er', 'TREASURE', 'MAMAMOO', 'SHINee',
  'GOT7', 'MONSTA X', 'iKON', 'WINNER', '2NE1', "Girls' Generation", 'Super Junior',
  'BIGBANG', 'LOONA', 'fromis_9', 'tripleS', 'Dreamcatcher', 'VIVIZ',
  'Brave Girls', 'OH MY GIRL', 'Apink', 'BTOB', 'PENTAGON', 'SF9', 'THE BOYZ',
  'Golden Child', 'ONEUS', 'VERIVERY', 'CIX', 'VICTON', 'AB6IX', 'WEi',
  'CRAVITY', 'P1Harmony', 'TEMPEST', 'YOUNITE', 'Xdinary Heroes', 'Billlie',
  'LIGHTSUM', 'Weki Meki', 'Cherry Bullet', 'Rocket Punch', 'Purple Kiss',
  'Lapillus', 'FIFTY FIFTY', 'KISS OF LIFE', 'BABYMONSTER', 'ILLIT',
  'ZEROBASEONE', 'RIIZE', 'TWS', 'BOYNEXTDOOR', 'xikers', 'NCT 127',
  'NCT DREAM', 'WayV', 'NCT WISH', 'SNSD', 'f(x)', 'EXO-CBX', 'Super M',
  'Girls Generation', 'DAY6', 'ASTRO', 'Kara', 'INFINITE', 'BEAST',
  'Highlight', 'Block B', 'B.A.P', 'VIXX', 'CNBLUE', 'FTIsland',
  'ZB1', 'G-IDLE',
];

const KNOWN_SOLOISTS = [
  'V', 'Jungkook', 'Jennie', 'Lisa', 'Ros\u00e9', 'Jisoo', 'Suga', 'RM', 'J-Hope',
  'Jin', 'Jimin', 'Winter', 'Karina', 'Giselle', 'NingNing', 'Taeyeon', 'IU',
  'Sunmi', 'HyunA', 'Hwasa', 'Solar', 'Joy', 'Irene', 'Yeri', 'Wendy', 'Seulgi',
  'Mark', 'Taeyong', 'Jaehyun', 'Doyoung', 'Haechan', 'Jeno', 'Jaemin', 'Renjun',
  'Chenle', 'Jisung', 'Bangchan', 'Hyunjin', 'Felix', 'Han', 'Lee Know', 'Changbin',
  'Seungmin', 'I.N', 'Heeseung', 'Jay', 'Jake', 'Sunghoon', 'Sunoo', 'Jungwon',
  'Ni-ki', 'Soobin', 'Yeonjun', 'Beomgyu', 'Taehyun', 'Hueningkai', 'Hongjoong',
  'Seonghwa', 'Yunho', 'Yeosang', 'San', 'Mingi', 'Wooyoung', 'Jongho',
  'S.Coups', 'Jeonghan', 'Joshua', 'Jun', 'Hoshi', 'Wonwoo', 'Woozi', 'DK',
  'Mingyu', 'The8', 'Seungkwan', 'Vernon', 'Dino', 'Wonyoung', 'Yujin', 'Gaeul',
  'Liz', 'Leeseo', 'Rei', 'Sakura', 'Chaewon', 'Kazuha', 'Eunchae', 'Minji',
  'Hanni', 'Danielle', 'Haerin', 'Hyein', 'Miyeon', 'Minnie', 'Soyeon', 'Yuqi',
  'Shuhua', 'Yeji', 'Lia', 'Ryujin', 'Chaeryeong', 'Yuna', 'Sullyoon', 'Haewon',
  'Lily', 'Bae', 'Jiwoo', 'Kyujin', 'Cha Eun Woo', 'Park Bo Gum',
  'Song Joong Ki', 'Lee Min Ho', 'Kim Soo Hyun', 'Park Seo Joon', 'Jung Hae In',
  'Song Hye Kyo', 'Jun Ji Hyun', 'Kim Ji Won', 'Han So Hee', 'Suzy',
  'Park Shin Hye', 'Lee Sung Kyung', 'Yoo Yeon Seok', 'Park Na Rae',
  'Taemin', 'Baekhyun', 'Chanyeol', 'D.O.', 'Kai', 'Sehun', 'Xiumin',
  'Lay', 'Chen', 'Suho', 'GDragon', 'G-Dragon', 'Taeyang', 'Daesung',
  'Seungri', 'TOP', 'CL', 'Dara', 'Bom', 'Minzy', 'Zico',
  'Jackson', 'BamBam', 'Yugyeom', 'Youngjae', 'JB', 'Jinyoung',
  'Nayeon', 'Jeongyeon', 'Momo', 'Sana', 'Jihyo', 'Mina', 'Dahyun',
  'Chaeyoung', 'Tzuyu',
];

const ALL_KNOWN_NAMES = [...KNOWN_GROUPS, ...KNOWN_SOLOISTS]
  .sort((a, b) => b.length - a.length);

// ============================================================
// Topic classifier keyword map
// ============================================================

const TOPIC_KEYWORDS = {
  comeback:       ['comeback', 'return', 'back', 'coming back', 'pre-release'],
  chart:          ['chart', 'billboard', 'number', 'record', 'no.1', '#1', 'top 10', 'million', 'stream', 'sales'],
  release:        ['album', 'single', 'ep', 'tracklist', 'release', 'drop', 'mini-album', 'mini album', 'full album'],
  concert:        ['concert', 'tour', 'live', 'stage', 'arena', 'stadium', 'world tour', 'encore'],
  fashion:        ['fashion', 'style', 'outfit', 'airport', 'look', 'brand', 'ambassador', 'vogue', 'elle'],
  variety:        ['variety', 'show', 'tv', 'running man', 'knowing bros', 'weekly idol', 'guest'],
  sns:            ['social media', 'instagram', 'twitter', 'tiktok', 'weverse', 'selca', 'selfie', 'post', 'update'],
  award:          ['award', 'win', 'trophy', 'daesang', 'bonsang', 'grammy', 'mama', 'golden disc', 'melon'],
  collaboration:  ['collaboration', 'collab', 'featuring', 'feat', 'team up', 'duet', 'joint'],
  debut:          ['debut', 'launch', 'pre-debut', 'trainee', 'survival'],
};

// ============================================================
// REWRITE ENGINE -- Literary English editorial titles
// ============================================================

const TITLE_TEMPLATES = {
  comeback: [
    'On {artist}\'s Return: What Their Comeback Says About K-Pop Now',
    'The Art of the Comeback: {artist}\'s Strategic Reemergence',
    'After the Silence: {artist} Come Back Changed',
    '{artist}\'s Return and What It Tells Us About This Moment in K-Pop',
    'A New Chapter Opens: {artist}\'s Comeback, Examined',
    'Why {artist}\'s Comeback Matters More Than You Think',
  ],
  release: [
    'Listening Notes: {artist}\'s New Work Deserves Your Attention',
    'A Close Listen to {artist}\'s Latest -- And Why It Matters',
    'The Sound of Now: What {artist}\'s New Release Reveals',
    'On First Listen: {artist}\'s Newest Work in Context',
    '{artist}\'s Latest Album and the State of K-Pop Ambition',
    'What {artist}\'s New Record Says About Where Music Is Headed',
  ],
  concert: [
    'Dispatches from {artist}\'s Stage: A Concert Reflection',
    'What It Felt Like to Watch {artist} Perform Live',
    'The Live Experience: {artist} in Concert',
    'On Witnessing {artist} Live: Notes from the Audience',
    '{artist} on Stage: A Performance Worth Remembering',
  ],
  award: [
    'On Merit and Recognition: {artist}\'s Award Season',
    '{artist}\'s Win Tells a Larger Story About K-Pop',
    'The Meaning Behind {artist}\'s Latest Accolade',
    'What {artist}\'s Award Victory Says About the Industry',
    'Recognition Earned: Reflecting on {artist}\'s Win',
  ],
  fashion: [
    'The Semiotics of {artist}\'s Style Choices',
    'Why What {artist} Wear Matters More Than You Think',
    '{artist} and Fashion: An Evolving Conversation',
    'Decoding {artist}\'s Visual Language Through Clothing',
    'The Quiet Power of {artist}\'s Wardrobe Decisions',
  ],
  variety: [
    'The Unguarded Moment: {artist} Beyond the Stage',
    'What We Learn When {artist} Let Their Guard Down',
    'Watching {artist} on Television: A Brief Essay',
    '{artist} Off-Duty: What the Camera Catches When the Music Stops',
  ],
  sns: [
    'Digital Presence: How {artist} Navigate the Online World',
    '{artist}\'s Social Media as Self-Expression',
    'The Curated Life: Decoding {artist}\'s Online Identity',
    'What {artist}\'s Posts Reveal About Modern Celebrity',
  ],
  collaboration: [
    'When Worlds Collide: {artist}\'s Collaboration in Context',
    'The Partnership: What {artist}\'s Collab Reveals About the Industry',
    'On {artist}\'s Latest Collaboration: A Joint Venture Examined',
    '{artist}\'s New Creative Partnership and What It Means',
  ],
  debut: [
    'First Impressions: The Arrival of {artist}',
    'A New Voice in K-Pop: Introducing {artist}',
    'The Debut as Statement: What {artist} Are Saying',
    'Meet {artist}: K-Pop\'s Newest and Most Intriguing Act',
  ],
  chart: [
    'The Numbers Game: Understanding {artist}\'s Chart Success',
    'Beyond the Charts: What {artist}\'s Data Really Means',
    'A Quantitative Look at {artist}\'s Market Performance',
    'What the Numbers Tell Us About {artist}\'s Reach',
  ],
  general: [
    'Letter from the Editor: This Week in K-Pop',
    'The Conversation: What Matters in K-Pop Right Now',
    'Notes on the State of K-Pop',
    'Dispatches from the K-Pop Landscape',
    'A Brief Survey of What\'s Happening in K-Pop',
    'The Week in K-Pop: What Deserves Your Attention',
    'Current Affairs in K-Pop: A Measured Assessment',
    'What the K-Pop World Is Talking About This Week',
  ],
};

const NO_ARTIST_TEMPLATES = [
  'Letter from the Editor: This Week in K-Pop',
  'The Conversation: What Matters in K-Pop Right Now',
  'Notes on the State of K-Pop',
  'Dispatches from the K-Pop Landscape',
  'A Brief Survey of What\'s Happening in K-Pop',
  'The Week in K-Pop: What Deserves Your Attention',
  'Current Affairs in K-Pop: A Measured Assessment',
  'What the K-Pop World Is Talking About This Week',
  'An Editor\'s View: Trends Worth Watching in K-Pop',
  'The Quiet Shifts Reshaping K-Pop This Week',
  'Industry Currents: Reading Between the Headlines',
  'The K-Pop Digest: Observations and Analysis',
  'A Considered Look at This Week\'s K-Pop News',
  'Between the Lines: What K-Pop Headlines Miss',
  'The Editorial Desk: K-Pop Stories That Matter',
  'Reflections on a Week in K-Pop Culture',
  'The Long View: K-Pop Trends Worth Tracking',
  'From the Newsroom: K-Pop Developments in Focus',
  'Signals and Noise: Parsing This Week\'s K-Pop News',
  'The CHRONICLE Briefing: Essential K-Pop Reading',
  'A Pause for Thought: The Week in K-Pop Review',
  'What We Noticed: K-Pop Observations This Week',
  'The Weekly Reckoning: K-Pop in Perspective',
  'Marginalia: Notes from the K-Pop World',
];

// ============================================================
// Display category mapping
// ============================================================

function displayCategory(topic) {
  const map = {
    comeback: 'ESSAY',
    release: 'ESSAY',
    concert: 'LIVE',
    award: 'RECOGNITION',
    fashion: 'STYLE',
    variety: 'CULTURE',
    sns: 'DIGITAL',
    collaboration: 'COLLABORATION',
    debut: 'NEW VOICES',
    chart: 'DATA',
    general: 'EDITORIAL',
  };
  return map[topic] || 'EDITORIAL';
}

// ============================================================
// Artist extraction helpers
// ============================================================

const COMMON_ENGLISH_WORDS = new Set([
  'the', 'a', 'an', 'this', 'that', 'these', 'here', 'why', 'how', 'what',
  'when', 'who', 'which', 'where', 'watch', 'check', 'best', 'top', 'new',
  'breaking', 'exclusive', 'official', 'first', 'latest', 'all', 'every',
  'open', 'just', 'more', 'most', 'some', 'many', 'after', 'before',
  'korean', 'kpop', 'k-pop', 'idol', 'idols', 'legendary', 'former',
  'young', 'old', 'big', 'small', 'great', 'good', 'bad', 'real',
  'full', 'final', 'last', 'next', 'other', 'another', 'each', 'both',
  'only', 'even', 'still', 'also', 'already', 'never', 'always', 'again',
  'now', 'then', 'today', 'week', 'weekly', 'daily', 'year', 'month',
  'thread', 'list', 'review', 'reviews', 'roundup', 'recap', 'guide',
  'report', 'reports', 'update', 'updates', 'news', 'story', 'stories',
  'song', 'songs', 'album', 'albums', 'track', 'tracks', 'single', 'singles',
  'music', 'video', 'drama', 'movie', 'show', 'shows', 'stage', 'live',
  'tour', 'concert', 'award', 'awards', 'chart', 'charts', 'record',
  'debut', 'comeback', 'release', 'releases', 'performance', 'cover',
  'photo', 'photos', 'fashion', 'style', 'beauty', 'look', 'looks',
  'will', 'can', 'could', 'would', 'should', 'may', 'might', 'must',
  'does', 'did', 'has', 'had', 'have', 'been', 'being', 'are', 'were',
  'get', 'gets', 'got', 'make', 'makes', 'made', 'take', 'takes', 'took',
  'give', 'gives', 'gave', 'come', 'comes', 'came', 'keep', 'keeps', 'kept',
  'let', 'say', 'says', 'said', 'see', 'sees', 'saw', 'know', 'knows',
  'think', 'find', 'finds', 'want', 'wants', 'tell', 'tells',
  'ask', 'asks', 'work', 'works', 'seem', 'seems', 'feel', 'feels',
  'try', 'tries', 'start', 'starts', 'need', 'needs', 'run', 'runs',
  'move', 'moves', 'play', 'plays', 'pay', 'pays', 'hear', 'hears',
  'during', 'about', 'with', 'from', 'into', 'over', 'under', 'between',
  'through', 'against', 'without', 'within', 'along', 'behind',
  'inside', 'outside', 'above', 'below', 'upon', 'onto', 'toward',
  'for', 'but', 'not', 'yet', 'nor', 'and', 'or', 'so',
  'while', 'since', 'until', 'unless', 'because', 'although', 'though',
  'if', 'than', 'whether', 'once', 'twice',
  'his', 'her', 'its', 'our', 'their', 'my', 'your',
  'he', 'she', 'it', 'we', 'they', 'you', 'me', 'him', 'us', 'them',
  'no', 'yes', 'not', 'don\'t', 'doesn\'t', 'didn\'t', 'won\'t', 'can\'t',
  'eight', 'five', 'four', 'nine', 'one', 'seven', 'six', 'ten', 'three', 'two',
  'up', 'down', 'out', 'off', 'on', 'in', 'at', 'to', 'by', 'of',
  'coming', 'going', 'looking', 'rising', 'star', 'stars',
  'spill', 'spills', 'choi', 'lee', 'kim', 'park', 'jung', 'shin',
  'won', 'min', 'sung', 'hyun', 'jae', 'hye',
]);

const SHORT_AMBIGUOUS_NAMES = new Set(['V', 'TOP', 'CL', 'JB', 'DK', 'Jun', 'Jay', 'Kai', 'Lay', 'Bom', 'Liz', 'Bae', 'Han', 'San', 'Rei', 'Lia']);

function extractArtist(title) {
  for (const name of ALL_KNOWN_NAMES) {
    if (SHORT_AMBIGUOUS_NAMES.has(name)) continue;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(?:^|[\\s,;:'"(\\[])${escaped}(?=[\\s,;:'"')\\]!?.]|$)`, 'i');
    if (re.test(title)) return name;
  }
  for (const name of SHORT_AMBIGUOUS_NAMES) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(?:^|[\\s,;:'"(\\[])${escaped}(?=[\\s,;:'"')\\]!?.]|$)`);
    if (re.test(title)) {
      const pos = title.indexOf(name);
      if (pos <= 5) return name;
    }
  }
  const leadingName = title.match(/^([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})\b/);
  if (leadingName) {
    const candidate = leadingName[1];
    const words = candidate.split(/\s+/);
    const allWordsValid = words.every(w => !COMMON_ENGLISH_WORDS.has(w.toLowerCase()));
    if (allWordsValid && words.length >= 2 && words.length <= 4) return candidate;
  }
  return null;
}

function classifyTopic(title) {
  const lower = title.toLowerCase();
  for (const [topic, keywords] of Object.entries(TOPIC_KEYWORDS)) {
    for (const kw of keywords) {
      if (lower.includes(kw)) return topic;
    }
  }
  return 'general';
}

// ---- Title deduplication tracker ----
const _usedTitles = new Set();

function rewriteTitle(originalTitle, source) {
  const artist = extractArtist(originalTitle);
  const topic = classifyTopic(originalTitle);

  if (artist) {
    const templates = TITLE_TEMPLATES[topic] || TITLE_TEMPLATES.general;
    // Try all templates before falling back
    const shuffled = [...templates].sort(() => Math.random() - 0.5);
    for (const template of shuffled) {
      const candidate = template.replace(/\{artist\}/g, artist);
      if (!_usedTitles.has(candidate)) {
        _usedTitles.add(candidate);
        return candidate;
      }
    }
    // All topic templates used -- try other topics
    for (const [otherTopic, otherTemplates] of Object.entries(TITLE_TEMPLATES)) {
      if (otherTopic === topic) continue;
      for (const template of otherTemplates) {
        const candidate = template.replace(/\{artist\}/g, artist);
        if (!_usedTitles.has(candidate)) {
          _usedTitles.add(candidate);
          return candidate;
        }
      }
    }
    // Last resort: append source for uniqueness
    const fallback = `${pickRandom(templates).replace(/\{artist\}/g, artist)} (via ${source})`;
    _usedTitles.add(fallback);
    return fallback;
  }

  // No artist -- try all NO_ARTIST_TEMPLATES
  const shuffledNA = [...NO_ARTIST_TEMPLATES].sort(() => Math.random() - 0.5);
  for (const candidate of shuffledNA) {
    if (!_usedTitles.has(candidate)) {
      _usedTitles.add(candidate);
      return candidate;
    }
  }
  // All used -- generate unique variant
  const base = pickRandom(NO_ARTIST_TEMPLATES);
  const unique = `${base} (${source})`;
  _usedTitles.add(unique);
  return unique;
}

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// ============================================================
// Image downloading
// ============================================================

const IMAGES_DIR = join(__dirname, 'images');
const ARTICLES_DIR = join(__dirname, 'articles');

async function downloadImage(url, filename) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Referer': new URL(url).origin,
      },
    });
    clearTimeout(timer);
    if (!res.ok || !res.body) return null;
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('image')) return null;
    const ext = contentType.includes('png') ? '.png'
      : contentType.includes('webp') ? '.webp'
      : '.jpg';
    const localFile = `${filename}${ext}`;
    const localPath = join(IMAGES_DIR, localFile);
    const buffer = Buffer.from(await res.arrayBuffer());
    await writeFile(localPath, buffer);
    return `images/${localFile}`;
  } catch {
    return null;
  }
}

async function downloadArticleImages(articles) {
  await mkdir(IMAGES_DIR, { recursive: true });
  log('Downloading article images locally...');
  let downloaded = 0;
  const BATCH = 8;

  // Phase 1: Download real (non-picsum) images
  for (let i = 0; i < articles.length; i += BATCH) {
    const batch = articles.slice(i, i + BATCH);
    await Promise.allSettled(
      batch.map(async (article, idx) => {
        if (!article.image || article.image.includes('picsum.photos')) return;
        const safeName = `article-${i + idx}-${Date.now() % 100000}`;
        const localPath = await downloadImage(article.image, safeName);
        if (localPath) {
          article.originalImage = article.image;
          article.image = localPath;
          downloaded++;
        }
      })
    );
  }
  log(`  Phase 1: Downloaded ${downloaded} real images locally`);

  // Phase 2: Download picsum fallback images for articles that still use external URLs
  let picsumDownloaded = 0;
  for (let i = 0; i < articles.length; i += BATCH) {
    const batch = articles.slice(i, i + BATCH);
    await Promise.allSettled(
      batch.map(async (article, idx) => {
        if (!article.image || !article.image.includes('picsum.photos')) return;
        if (article.image.startsWith('images/')) return;
        const safeName = `article-${i + idx}-picsum-${Date.now() % 100000}`;
        const localPath = await downloadImage(article.image, safeName);
        if (localPath) {
          article.originalImage = article.image;
          article.image = localPath;
          picsumDownloaded++;
        }
      })
    );
  }
  log(`  Phase 2: Downloaded ${picsumDownloaded} picsum fallback images locally`);
  log(`  Total: ${downloaded + picsumDownloaded} images locally`);
}

// ============================================================
// RSS Feed Parsing
// ============================================================

// ---- Content filtering: exclude non-K-pop items ----
const NON_KPOP_KEYWORDS = [
  'esports', 'esport', 'e-sports', 'gaming', 'gamer', 'valorant', 'league of legends',
  'overwatch', 'fortnite', 'counter-strike', 'csgo', 'cs2', 'dota', 'pubg',
  'minecraft', 'call of duty', 'warzone', 'apex legends', 'twitch', 'streamer',
  'cheating', 'tournament', 'fps', 'moba', 'battle royale', 'dexerto',
  'nfl', 'nba', 'mlb', 'soccer', 'football', 'baseball', 'basketball',
  'formula 1', 'f1', 'ufc', 'boxing', 'wrestling', 'wwe',
  'cryptocurrency', 'bitcoin', 'ethereum', 'nft', 'blockchain',
  'politics', 'election', 'trump', 'biden', 'congress', 'senate',
];

function isKpopRelated(title, description, categories) {
  const combined = `${title} ${description} ${categories.join(' ')}`.toLowerCase();
  // Check for non-kpop keywords
  for (const kw of NON_KPOP_KEYWORDS) {
    if (combined.includes(kw)) return false;
  }
  return true;
}

function parseRssFeed(xml, sourceName) {
  const items = extractItems(xml);
  const articles = [];
  let filtered = 0;
  for (const item of items) {
    const title = decodeHtmlEntities(stripHtml(extractTag(item, 'title')));
    const link = extractTag(item, 'link');
    const pubDate = extractTag(item, 'pubDate');
    const creator = extractTag(item, 'dc:creator');
    const categories = extractAllTags(item, 'category').map(c => decodeHtmlEntities(stripHtml(c)));
    const category = categories[0] || 'News';
    const description = extractTag(item, 'description');
    const contentEncoded = extractTag(item, 'content:encoded');
    let image = extractImageFromContent(item);
    if (!image) image = extractImageFromContent(contentEncoded);
    if (!image) image = extractImageFromContent(description);
    if (!title || !link) continue;

    // Filter out non-K-pop content
    const descText = stripHtml(decodeHtmlEntities(description || ''));
    if (!isKpopRelated(title, descText, categories)) {
      filtered++;
      continue;
    }

    articles.push({
      title,
      link,
      pubDate: pubDate ? new Date(pubDate) : new Date(),
      formattedDate: formatDate(pubDate),
      creator,
      category,
      categories,
      image,
      source: sourceName,
      articleContent: null,
    });
  }
  if (filtered > 0) log(`    Filtered out ${filtered} non-K-pop items from ${sourceName}`);
  return articles;
}

// ============================================================
// Fetch all feeds
// ============================================================

async function fetchAllFeeds() {
  const allArticles = [];
  for (const source of SOURCES) {
    try {
      log(`Fetching ${source.name}...`);
      const xml = await fetchWithTimeout(source.url);
      const articles = parseRssFeed(xml, source.name);
      log(`  ${source.name}: ${articles.length} articles`);
      allArticles.push(...articles);
    } catch (err) {
      warn(`Failed to fetch ${source.name}: ${err.message}`);
    }
  }
  allArticles.sort((a, b) => b.pubDate.getTime() - a.pubDate.getTime());
  log(`Total: ${allArticles.length} articles`);
  return allArticles;
}

// ============================================================
// Fill missing images via og:image
// ============================================================

async function fillMissingImages(articles) {
  const needsImage = articles.filter(a => !a.image);
  if (needsImage.length === 0) return;
  const toFetch = needsImage.slice(0, MAX_OG_IMAGE_FETCHES);
  log(`Extracting og:image for ${toFetch.length} articles (concurrency: ${OG_IMAGE_CONCURRENCY})...`);
  let found = 0;
  for (let i = 0; i < toFetch.length; i += OG_IMAGE_CONCURRENCY) {
    const batch = toFetch.slice(i, i + OG_IMAGE_CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (article) => {
        const ogImage = await fetchOgImage(article.link);
        if (ogImage) { article.image = ogImage; return true; }
        return false;
      })
    );
    found += results.filter(r => r.status === 'fulfilled' && r.value === true).length;
  }
  log(`  Found og:image for ${found}/${toFetch.length} articles`);
}

// ============================================================
// Fetch article content from original pages
// ============================================================

function extractArticleContent(html) {
  let cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<aside[\s\S]*?<\/aside>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<div[^>]*class\s*=\s*["'][^"']*(?:sidebar|comment|social|share|related|ad-|ads-|advertisement|cookie|popup|modal|newsletter)[^"']*["'][\s\S]*?<\/div>/gi, '');

  const articleBodyPatterns = [
    /<article[^>]*>([\s\S]*?)<\/article>/i,
    /<div[^>]*class\s*=\s*["'][^"']*(?:article-body|article-content|entry-content|post-content|story-body|content-body|single-content)[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
    /<div[^>]*class\s*=\s*["'][^"']*(?:post-entry|article-text|body-text|main-content|article__body|post__content)[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
  ];

  let bodyHtml = '';
  for (const pattern of articleBodyPatterns) {
    const match = cleaned.match(pattern);
    if (match) { bodyHtml = match[1]; break; }
  }
  if (!bodyHtml) bodyHtml = cleaned;

  const paragraphs = [];
  const pRegex = /<p[^>]*>([\s\S]*?)<\/p>/gi;
  let pMatch;
  while ((pMatch = pRegex.exec(bodyHtml)) !== null) {
    const text = stripHtml(decodeHtmlEntities(pMatch[1])).trim();
    if (text.length > 30 &&
        !text.match(/^(advertisement|sponsored|also read|read more|related:|source:|photo:|credit:|getty|shutterstock|loading)/i)) {
      paragraphs.push(text);
    }
  }

  const images = [];
  const imgRegex = /<img[^>]+src\s*=\s*["']([^"']+)["'][^>]*>/gi;
  let imgMatch;
  while ((imgMatch = imgRegex.exec(bodyHtml)) !== null) {
    const src = imgMatch[1];
    if (src && !src.includes('avatar') && !src.includes('icon') && !src.includes('logo') &&
        !src.includes('1x1') && !src.includes('pixel') && !src.includes('tracking')) {
      images.push(src);
    }
  }
  return { paragraphs, images };
}

async function fetchArticleContent(article) {
  try {
    const html = await fetchWithTimeout(article.link, ARTICLE_FETCH_TIMEOUT);
    return extractArticleContent(html);
  } catch {
    return { paragraphs: [], images: [] };
  }
}

async function fetchAllArticleContent(articles) {
  const toFetch = articles.slice(0, 50);
  log(`Fetching full article content for ${toFetch.length} articles (concurrency: ${ARTICLE_FETCH_CONCURRENCY})...`);
  let fetched = 0;
  for (let i = 0; i < toFetch.length; i += ARTICLE_FETCH_CONCURRENCY) {
    const batch = toFetch.slice(i, i + ARTICLE_FETCH_CONCURRENCY);
    await Promise.allSettled(
      batch.map(async (article) => {
        const content = await fetchArticleContent(article);
        if (content.paragraphs.length > 0) { article.articleContent = content; fetched++; }
      })
    );
  }
  log(`  Fetched content for ${fetched}/${toFetch.length} articles`);
}

// ============================================================
// Article body generation -- literary English editorial prose
// ============================================================

const BODY_TEMPLATES = {
  comeback: {
    opening: [
      'There is a particular kind of anticipation that precedes a {artist} comeback -- one that feels less like the usual K-pop hype cycle and more like the quiet tension before a curtain rises. This time, the anticipation carries weight. The industry is watching. So are we.',
      'When {artist} announced their return, the response was immediate and telling. It was not merely excitement. It was relief, curiosity, and a kind of collective holding of breath. What does {artist}\'s comeback say about where K-pop stands right now? Quite a lot, as it turns out.',
      '{artist}\'s return to the spotlight arrives at an interesting moment. The K-pop landscape has shifted since their last release, and the question is not whether {artist} can adapt, but how they will reshape the conversation once more.',
    ],
    analysis: [
      'Industry observers have long noted that {artist} occupies a singular position in the K-pop ecosystem. They are neither trend-followers nor trend-setters in the conventional sense. Instead, they operate in a space that is entirely their own -- one that other acts can observe but rarely replicate. This comeback, by all early indicators, reaffirms that status.',
      'The production choices signal a clear artistic intention. Where many acts pivot toward whatever genre is currently dominating streaming charts, {artist} appears to have doubled down on their own sonic identity. It is a bold choice, and one that speaks to a confidence born of experience rather than market research.',
      'What deserves attention is the timing. {artist}\'s team has chosen a release window that avoids direct competition with the quarter\'s other major releases -- a strategic decision that suggests careful planning rather than impulsive momentum. The result is breathing room, both for the music and for the discourse around it.',
    ],
    closing: [
      'CHRONICLE will continue to follow {artist}\'s comeback with the attention it warrants. In an industry that moves at breakneck speed, some returns are worth slowing down for. This is one of them.',
      'The full impact of {artist}\'s return will take time to assess. But the early signs point to something more considered, more deliberate than the average comeback. We will be watching closely.',
    ],
  },
  release: {
    opening: [
      'A new {artist} release is, in the K-pop calendar, something of an event. Not in the loud, confetti-and-fireworks sense, but in the quieter way that a new novel from a respected author lands on bookstore tables -- with expectation, scrutiny, and genuine curiosity about what direction the work will take.',
      'The latest offering from {artist} arrived this week, and it deserves more than a passing listen. In a market saturated with content -- where the shelf life of a new release is measured in hours rather than weeks -- this is an album that rewards patience and repeat engagement.',
      '{artist}\'s new work poses an interesting question: What does ambition look like in K-pop right now? If this release is any indication, it looks like careful songcraft, deliberate choices, and a willingness to challenge audience expectations rather than merely satisfy them.',
    ],
    analysis: [
      'Track by track, the release reveals a cohesion that is increasingly rare in K-pop albums. Too often, mini-albums and EPs feel like collections of singles assembled by committee. Here, there is a through-line -- a narrative and sonic arc that rewards sequential listening. Whether this was by design or happy accident, the effect is the same: it asks you to pay attention.',
      'The production credits tell their own story. {artist}\'s involvement in the creative process appears to have deepened, and the result is work that feels personal in ways that transcend the typical idol-album framework. This is not to say every choice succeeds equally. But the ambition is unmistakable, and it pushes the music into genuinely interesting territory.',
      'From a market perspective, the release positions {artist} at an interesting crossroads. The sound is too polished for the underground, too adventurous for pure pop palatability. It occupies a middle ground that, historically, has been difficult to monetize in K-pop. And yet, the streaming numbers suggest an audience that is not only ready for this approach but actively hungry for it.',
    ],
    closing: [
      '{artist}\'s latest work merits the kind of sustained attention that the K-pop cycle rarely permits. CHRONICLE will revisit this release as the dust settles and its place in the broader conversation becomes clearer.',
      'This is not a perfect release. But it is an interesting one -- and in a landscape that often prizes perfection over personality, that distinction matters.',
    ],
  },
  concert: {
    opening: [
      'There is no substitute for witnessing {artist} perform live. This is a statement that sounds like marketing copy until you are actually standing in the venue, surrounded by an audience that has crossed borders and time zones for this specific experience. Then it becomes self-evident.',
      'A {artist} concert is, at its best, an exercise in controlled chaos. Every moment is choreographed to within an inch of its life, and yet there is an unmistakable spontaneity that leaks through the cracks. It is this tension -- between precision and presence -- that makes the live experience so compelling.',
      'Reports from {artist}\'s recent stage appearances paint a picture of an act in peak form. The setlist choices, the staging decisions, the moments of fan interaction -- all suggest an artist who understands that a concert is not merely a performance but a shared event.',
    ],
    analysis: [
      'The staging warrants particular attention. {artist}\'s production team has clearly invested in creating visual environments that complement rather than overwhelm the performance. The lighting design, in particular, demonstrates a sophistication that is worth noting -- it serves the music rather than competing with it.',
      'What stands out most, however, is the pacing. A {artist} setlist is structured with the understanding that energy must ebb and flow, that an audience needs moments of quiet intensity as much as it needs peak-level euphoria. This is concert craft at a high level, and it separates {artist} from acts that mistake volume for impact.',
      'The fan response has been telling. Social media accounts from attendees consistently highlight moments of genuine connection -- eye contact, improvised comments, the small gestures that cannot be rehearsed. In an era where concerts are increasingly spectacle-driven, {artist}\'s emphasis on human connection feels both old-fashioned and refreshing.',
    ],
    closing: [
      'CHRONICLE will continue to cover {artist}\'s touring activity as it develops. For now, the verdict is clear: this is an act that understands the power and the responsibility of the live stage.',
      'Further tour dates and ticketing information will be reported as they become available. In the meantime, the reviews speak for themselves.',
    ],
  },
  award: {
    opening: [
      'Awards in K-pop are, by nature, contested terrain. The criteria are murky, the voting systems complex, and the politics inevitable. But when {artist} received their latest recognition, the response was notable for its near-unanimity. Even skeptics, it seemed, could not argue with this one.',
      '{artist}\'s win at the recent ceremony is worth examining not merely for what it says about {artist}, but for what it reveals about the current state of the industry. Awards, after all, are as much a mirror of the awarding body as they are a measure of artistic achievement.',
      'The word "deserved" gets deployed too freely in music journalism. But in the case of {artist}\'s latest accolade, the term feels appropriate. This is not an act riding a wave of momentum. This is an act whose body of work has, over time, built a case that became impossible to ignore.',
    ],
    analysis: [
      'The significance of {artist}\'s win extends beyond the trophy itself. It represents a validation of a particular approach to K-pop -- one that prioritizes artistic development over market saturation, consistency over viral moments. In an industry that often rewards the loudest voice in the room, {artist}\'s recognition feels like a quiet correction.',
      'Reactions from industry peers have been notably warm. The congratulatory messages from fellow artists carry a sincerity that is not always present in these situations, suggesting that {artist}\'s win is viewed within the industry as a legitimate milestone rather than a political outcome.',
      'From a career trajectory standpoint, this award arrives at a pivotal moment. {artist} now has the institutional recognition to match their commercial and critical reputation. What they choose to do with that capital -- whether they consolidate or experiment -- will define their next chapter.',
    ],
    closing: [
      'CHRONICLE offers its congratulations to {artist} and its editorial team will continue to follow the story as it develops.',
      'Awards are fleeting. The work that earns them is not. CHRONICLE will continue to cover {artist}\'s output on its own terms.',
    ],
  },
  fashion: {
    opening: [
      'Fashion in K-pop is rarely incidental. For {artist}, it is a form of communication -- a visual language that operates in parallel with the music, sometimes reinforcing it, sometimes complicating it. Their latest style choices are worth decoding.',
      'What {artist} chooses to wear is, by now, a subject of serious attention. Not merely from fans cataloguing outfits on social media, but from the fashion industry itself, which has recognized {artist} as a force capable of moving markets and shifting conversations.',
      'There is a tendency to dismiss celebrity fashion coverage as superficial. But when it comes to {artist}, the sartorial choices consistently reveal something substantive about artistic direction, brand positioning, and cultural signaling. Clothes, in this context, are text.',
    ],
    analysis: [
      '{artist}\'s recent styling represents an evolution rather than a revolution. The silhouettes have shifted, the palette has darkened, and there is a new emphasis on texture and materiality that suggests a deeper engagement with fashion as craft. The result is a wardrobe that feels considered rather than curated by committee.',
      'The brand partnerships deserve scrutiny. {artist}\'s alignment with certain houses is strategic and revealing. These are not random endorsement deals. They are creative alliances that reflect a shared aesthetic sensibility, and they position {artist} at the intersection of luxury fashion and youth culture.',
      'What is most interesting is the confidence. {artist}\'s fashion choices have moved beyond trend-chasing and into a realm of personal expression that is rare among K-pop artists of comparable stature. This willingness to take risks -- to wear things that provoke rather than please -- speaks to an artistic maturity that extends well beyond the closet.',
    ],
    closing: [
      'CHRONICLE will continue to track {artist}\'s evolving relationship with fashion. In an industry where image is inseparable from artistry, the wardrobe is always worth watching.',
      'Style, like music, is a language. {artist} appears to be developing fluency. CHRONICLE will continue to translate.',
    ],
  },
  variety: {
    opening: [
      'The variety show appearance is, in K-pop, a peculiar form of intimacy. The audience watches an artist stripped of choreography, costumes, and carefully managed lighting. What remains is personality -- unscripted, unrehearsed, and occasionally revealing. {artist}\'s recent appearance was a case study in how to navigate this exposure.',
      'When {artist} appeared on television this week, it was in a format designed to disarm. Variety shows are built to peel back the layers of celebrity, and the results are always informative, whether the subject is aware of it or not.',
    ],
    analysis: [
      'What emerged was a portrait of {artist} that complicates the public image in productive ways. The humor was natural rather than rehearsed. The interactions with fellow guests had a looseness that suggested genuine comfort. These are small things, but they accumulate into something meaningful -- a sense of who {artist} is when the cameras are rolling but the stage is absent.',
      '{artist}\'s television presence raises an interesting question about the relationship between an idol\'s on-stage persona and their off-stage self. The gap, in {artist}\'s case, appears to be narrower than most. Whether this is authentic transparency or simply very good media training is, perhaps, beside the point. The effect is the same: audiences feel they are seeing something real.',
    ],
    closing: [
      'CHRONICLE notes the appearance with interest and will continue to observe how {artist}\'s public persona evolves across formats.',
    ],
  },
  sns: {
    opening: [
      'In the economy of attention that defines modern celebrity, {artist}\'s social media presence operates with a quiet intentionality that is easy to overlook and difficult to replicate. Their recent online activity merits closer examination.',
      'How an artist uses social media is, increasingly, as revealing as how they use a recording studio. {artist}\'s digital footprint tells a story about control, accessibility, and the careful management of public and private selves.',
    ],
    analysis: [
      '{artist}\'s posting patterns reveal a strategy that balances accessibility with mystique. The content is personal enough to foster connection, curated enough to maintain artistic authority. It is a tightrope walk that many artists attempt and few execute with this degree of sophistication.',
      'The fan response to {artist}\'s online presence is instructive. Engagement rates are high, but more importantly, the nature of the engagement suggests a community that feels genuinely addressed rather than marketed to. This is the distinction between an audience and a fanbase, and {artist} appears to understand it intuitively.',
    ],
    closing: [
      'The digital realm is now inseparable from the artistic one. CHRONICLE will continue to examine how {artist} navigates this territory.',
    ],
  },
  collaboration: {
    opening: [
      'Collaborations in K-pop are often exercises in arithmetic -- the assumption being that two fanbases combined will produce results greater than either alone. {artist}\'s latest partnership suggests something more interesting: a genuine creative conversation between distinct artistic sensibilities.',
      'When the {artist} collaboration was announced, the immediate reaction was predictable: excitement, speculation, the usual cascade of social media enthusiasm. But the work itself asks for a more considered response.',
    ],
    analysis: [
      'The collaboration works precisely because it does not smooth out the differences between the participating artists. Instead, it places those differences in productive tension. {artist}\'s contribution is unmistakable, and yet the final product sounds like neither party working alone. This is the hallmark of a successful creative partnership.',
      'From an industry perspective, the collaboration signals a willingness to cross boundaries that K-pop has traditionally kept well-defined. Genre, generation, market position -- all have been treated as fixed categories. {artist}\'s work here suggests a more fluid understanding of what is possible when those categories are treated as starting points rather than constraints.',
    ],
    closing: [
      'CHRONICLE will revisit this collaboration as more context emerges. First impressions, in music as in life, are rarely the full story.',
    ],
  },
  debut: {
    opening: [
      'A debut, in K-pop, is both a beginning and a thesis statement. It declares what an act intends to be, how it wants to be received, and where it believes it belongs in the broader landscape. {artist}\'s debut makes a clear and interesting case.',
      'The arrival of {artist} into the K-pop landscape is worth documenting not because debuts are inherently noteworthy, but because this particular debut reveals something about the current state of the industry and the kind of artist it is producing.',
    ],
    analysis: [
      'What distinguishes {artist} from the considerable competition in the debut class of 2026 is a sense of specificity. The music, the visuals, the positioning -- all suggest an act that has been given (or has demanded) a clearly defined artistic identity from the outset. This is not a group searching for an audience. This is a group that knows exactly which audience it is addressing.',
      '{artist}\'s debut also raises questions about the trainee system and its capacity for producing artists with genuine individuality. The skill level is high, as expected. But there are flashes of personality and artistic perspective that suggest the system has not entirely filed down the edges. Whether those edges survive the pressures of early-career idol life remains to be seen.',
    ],
    closing: [
      'CHRONICLE will follow {artist}\'s trajectory with interest. Debuts are promises. It is the subsequent releases that determine whether those promises are kept.',
    ],
  },
  chart: {
    opening: [
      'Numbers in K-pop are treated with a reverence that borders on the religious. Chart positions, streaming counts, first-week sales -- these metrics have become the primary language through which success is articulated and understood. {artist}\'s recent performance on the charts, then, is worth parsing for what the data actually tells us.',
      'When {artist}\'s numbers came in, the reaction was swift and celebratory. But behind the headline figures lies a more nuanced story about audience behavior, market positioning, and the evolving relationship between an artist and their consumption metrics.',
    ],
    analysis: [
      'The chart data, examined closely, reveals several noteworthy patterns. {artist}\'s streaming profile skews differently from the typical K-pop release pattern, suggesting a listener base that is either broader than the core fandom or more deeply engaged than average. Both scenarios have significant implications for long-term career sustainability.',
      'What the numbers cannot capture is the qualitative dimension. {artist}\'s chart success coincides with a period of artistic experimentation, which raises an interesting question: Is the audience rewarding risk, or has {artist} simply become prominent enough that the numbers will follow regardless of creative direction? The answer matters for the industry as a whole.',
    ],
    closing: [
      'CHRONICLE will continue to provide data-informed analysis of market trends. Numbers tell stories, but only if you read them carefully.',
    ],
  },
  general: {
    opening: [
      'This week in K-pop brought developments that, individually, might seem routine but, taken together, suggest currents worth tracing. CHRONICLE\'s editorial team examines the stories that deserve sustained attention.',
      'The K-pop news cycle moves at a pace designed to prevent reflection. This column exists to provide it. Here is what happened this week that we believe matters, and why.',
      'There is always more happening beneath the surface of K-pop\'s news cycle than the headlines suggest. This week was no exception. CHRONICLE looks past the announcements to examine the patterns.',
      'The week\'s developments in K-pop warrant a degree of analysis that the standard news cycle rarely permits. Here, we make room for it.',
    ],
    analysis: [
      'The broader context is essential to understanding any individual story in K-pop. The industry is in a period of significant structural change -- from the globalization of fan communities to the shifting economics of streaming, from the evolving role of social media to the increasing sophistication of fan-artist relationships. Each news item exists within this framework, and ignoring the framework means missing the story.',
      'What strikes us most about the current moment is the pace of evolution. K-pop in 2026 operates on assumptions that would have been unthinkable five years ago. The international market is no longer an afterthought but a primary consideration. Fan engagement has moved from one-directional broadcasting to something closer to continuous dialogue. The implications are still unfolding.',
      'Industry analysts point to several developments this week that align with longer-term trends. The consolidation of agency power, the diversification of revenue streams, and the increasing emphasis on longevity over explosive debuts -- these are not new themes, but the week\'s events have brought them into sharper focus.',
    ],
    closing: [
      'CHRONICLE will return next week with further analysis. In the meantime, we encourage our readers to look beyond the headlines and consider the larger story being told.',
      'As always, CHRONICLE remains committed to providing the kind of measured, thoughtful coverage that K-pop deserves and too rarely receives.',
    ],
  },
};

const NO_ARTIST_BODY = {
  opening: [
    'The K-pop industry continues to evolve at a pace that demands careful observation. This week\'s developments, while perhaps not individually earth-shattering, contribute to a larger narrative that CHRONICLE has been tracking with sustained interest.',
    'There are weeks in K-pop when the noise is deafening and the signal is faint. This was one of them. But within the volume of announcements, collaborations, and content drops, several items warranted a closer look.',
    'The conversation in K-pop this week centered on questions that, while not new, have taken on a new urgency. CHRONICLE examines what happened and what it means for the industry\'s direction.',
  ],
  analysis: [
    'The structural forces reshaping K-pop are not always visible in the daily news cycle, but they are always present. The globalization of the fanbase, the platformization of music consumption, the blurring of genre boundaries -- these are the tectonic plates moving beneath the surface of every headline. Understanding them is essential to understanding any individual story.',
    'What we observe this week is a continuation of patterns that have been developing for some time. The industry is becoming simultaneously more global and more fragmented, more accessible and more competitive. These paradoxes are not contradictions. They are the defining characteristics of K-pop in its current phase.',
  ],
  closing: [
    'CHRONICLE will continue to provide the kind of considered, long-form analysis that this industry merits. The stories are always more complex than they first appear.',
    'We return next week with fresh analysis. Until then, CHRONICLE encourages its readers to think critically and read widely.',
  ],
};

const SHARED_PARAGRAPHS = {
  background: [
    '{artist}\'s trajectory has been, by any reasonable measure, remarkable. From the early stages of their career to the present, they have demonstrated a capacity for growth that is rare in an industry that often rewards stasis over evolution. Their current position in the K-pop landscape reflects not luck but sustained effort and intelligent decision-making.',
    'To understand {artist}\'s current moment, it helps to consider the broader context. K-pop in 2026 is a different animal from the industry that existed even three years ago. The audience is more global, the competition more intense, and the expectations more demanding. That {artist} not only survives but thrives in this environment speaks to something fundamental about their approach.',
    'There is a temptation to view {artist} through the lens of their most visible achievements -- the numbers, the awards, the viral moments. But the more interesting story lies in the choices they have made between those milestones: the creative risks, the strategic patience, the willingness to prioritize artistic coherence over short-term gain.',
    'The international dimension of {artist}\'s career deserves particular attention. Their reach now extends well beyond the Korean market, and the way they have navigated this expansion -- maintaining domestic relevance while building genuine international appeal -- offers a case study in how cultural exports can work when they are handled with intelligence and care.',
    '{artist}\'s influence on the broader K-pop ecosystem is sometimes difficult to quantify but impossible to ignore. Other acts reference their work, industry strategies echo their approach, and fan community norms have been shaped by patterns that {artist}\'s fanbase established. This kind of diffuse influence is, arguably, more significant than any single chart position.',
  ],
  detail: [
    'Sources close to the situation indicate that {artist}\'s team has been meticulous in their preparation. The level of detail in the planning -- from creative direction to market timing to fan communication strategy -- reflects an operation that has learned from past experience and refined its approach accordingly.',
    'The social media response has been substantial and worth parsing. The volume of engagement is expected, given {artist}\'s fanbase. What is more instructive is the nature of the response: the discourse is more analytical, more considered than the typical K-pop fan reaction. This suggests an audience that is maturing alongside the artist.',
    '{artist}\'s current trajectory intersects with several of K-pop\'s most significant trends: the push toward creative autonomy, the emphasis on album-as-statement over single-as-product, and the growing importance of the artist\'s personal brand as distinct from the group identity. How {artist} navigates these intersections will have implications beyond their own career.',
    'The industry response has been quietly significant. Executives and producers who spoke to CHRONICLE on background describe {artist}\'s approach as influential, though the specific mechanisms of that influence are debated. What is not debated is the result: {artist} has established a template that others are studying, if not directly imitating.',
    'What gives {artist}\'s work its staying power is a quality that is difficult to name but easy to recognize: intentionality. Every element -- from the music production to the visual presentation to the fan engagement -- feels purposeful. In an industry that often mistakes activity for accomplishment, this focus is both distinguishing and instructive.',
  ],
  reaction: [
    'The fan community\'s response has been, predictably, enthusiastic -- but also, less predictably, substantive. Long-form analyses, contextual threads, and genuine critical engagement have characterized the online discourse. This is a fanbase that takes the work seriously, and that seriousness elevates the conversation for everyone involved.',
    'Beyond the core fanbase, the broader K-pop community has taken note. The kind of cross-fandom respect that {artist} commands is not earned through numbers alone. It requires the kind of artistic credibility that comes from consistent quality and genuine creative ambition.',
    'International fan communities have been particularly vocal, and their engagement underscores a point that CHRONICLE has made before: K-pop\'s audience is now genuinely global, and any serious assessment of an artist\'s impact must account for this geography. {artist}\'s resonance across cultural and linguistic boundaries is not incidental. It is central to their story.',
    'The cultural commentary surrounding {artist} has become more sophisticated over time. What once might have been dismissed as fan enthusiasm is now recognized as a form of participatory criticism -- engaged, knowledgeable, and occasionally more perceptive than the professional coverage.',
  ],
  impact: [
    'The long-term significance of {artist}\'s current moment will take time to assess fully. But certain things are already clear: they have expanded the boundaries of what is considered possible within K-pop, they have demonstrated that artistic ambition and commercial success need not be mutually exclusive, and they have set a standard that will inform the industry\'s trajectory for years to come.',
    'If there is a larger lesson in {artist}\'s story, it may be this: in an industry that moves at the speed of social media, the most durable success is built slowly, deliberately, and with a clear sense of purpose. Speed is overrated. Substance is not.',
    'What {artist} represents to the K-pop industry is a proof of concept -- evidence that an act can maintain relevance while pursuing genuine artistic growth, that a fanbase can be cultivated through respect rather than manipulation, and that the market will reward quality if given the chance to recognize it.',
  ],
  noArtist: {
    background: [
      'K-pop\'s evolution over the past decade has been, by any measure, extraordinary. What began as a primarily domestic entertainment industry has become a global cultural force, reshaping music markets, fashion trends, and digital engagement norms around the world. Understanding this transformation is essential to understanding any individual story within the industry.',
      'The structural dynamics of K-pop in 2026 are worth reviewing. The agency system continues to evolve, fan engagement platforms have become sophisticated ecosystems in their own right, and the boundaries between K-pop and the broader global music industry have blurred to the point of near-invisibility. These are not background facts. They are the primary conditions within which every story unfolds.',
      'The economics of K-pop have shifted significantly. Streaming revenue now outpaces physical sales as the primary revenue driver for most acts, while touring and merchandise have become increasingly important to overall profitability. This shift has profound implications for creative strategy, marketing priorities, and the kinds of artists that the industry chooses to develop.',
    ],
    detail: [
      'This particular development reflects a pattern that industry analysts have been tracking for several quarters. The convergence of multiple trends -- globalization, platformization, and the increasing importance of artist-as-brand -- has created an environment in which stories like this one are not anomalies but inevitabilities.',
      'The data paints an interesting picture. Engagement metrics across the industry suggest a fanbase that is simultaneously expanding and deepening. New listeners are entering the K-pop ecosystem at record rates, while existing fans are engaging more intensely and across more platforms than ever before. The implications for both artists and industry infrastructure are substantial.',
    ],
    reaction: [
      'Online discourse around this development has been characteristically vigorous. K-pop fan communities have become sophisticated analytical spaces, and the quality of the commentary often matches or exceeds that of professional journalism. This is not an accident. It is the product of a fan culture that values knowledge, context, and critical thinking.',
      'The international response has been particularly noteworthy. What was once a primarily Korean conversation is now a genuinely global one, with significant contributions from fan communities in Southeast Asia, North and South America, Europe, and beyond. This geographic breadth is one of K-pop\'s most distinctive and consequential characteristics.',
    ],
    impact: [
      'The implications of this week\'s developments extend beyond the immediate news cycle. K-pop is at a pivotal moment in its evolution, and the decisions being made now -- by artists, agencies, and platforms alike -- will shape the industry for years to come. CHRONICLE will continue to track these developments with the seriousness they deserve.',
      'In the broader context of global entertainment, K-pop\'s trajectory continues to defy conventional wisdom about the limits of cultural export. The industry\'s ability to produce content that resonates across linguistic, cultural, and generational boundaries is not merely a commercial achievement. It is a cultural one, and it warrants the kind of sustained, thoughtful attention that CHRONICLE is committed to providing.',
    ],
  },
};

function rewriteArticleBody(articleContent, title) {
  const artist = extractArtist(title) || (articleContent ? extractArtistFromParagraphs(articleContent.paragraphs) : null);
  const topic = classifyTopic(title);
  const originalLength = articleContent?.paragraphs?.length || 0;
  const targetParagraphs = Math.max(8, Math.min(12, originalLength || 8));
  const inlineImages = (articleContent?.images || []).slice(1, 4);
  const paragraphs = [];
  const usedTexts = new Set();
  const pickUnique = (arr) => {
    const available = arr.filter(t => !usedTexts.has(t));
    if (available.length === 0) return arr[Math.floor(Math.random() * arr.length)];
    const picked = available[Math.floor(Math.random() * available.length)];
    usedTexts.add(picked);
    return picked;
  };
  const shuffleAndPickUnique = (arr, n) => {
    const available = arr.filter(t => !usedTexts.has(t));
    const shuffled = [...available].sort(() => Math.random() - 0.5);
    const picked = shuffled.slice(0, Math.min(n, shuffled.length));
    for (const p of picked) usedTexts.add(p);
    return picked;
  };

  if (artist) {
    const templates = BODY_TEMPLATES[topic] || BODY_TEMPLATES.general;
    const sub = (text) => text.replace(/\{artist\}/g, artist);

    paragraphs.push({ type: 'intro', text: sub(pickUnique(templates.opening)) });

    const bgCount = targetParagraphs >= 10 ? 2 : 1;
    for (const bg of shuffleAndPickUnique(SHARED_PARAGRAPHS.background, bgCount)) {
      paragraphs.push({ type: 'body', text: sub(bg) });
    }

    const analysisCount = targetParagraphs >= 10 ? 3 : 2;
    for (const a of shuffleAndPickUnique(templates.analysis, analysisCount)) {
      paragraphs.push({ type: 'body', text: sub(a) });
    }

    if (inlineImages.length > 0) {
      paragraphs.push({ type: 'image', src: inlineImages[0] });
    }

    const detailCount = targetParagraphs >= 10 ? 2 : 1;
    for (const d of shuffleAndPickUnique(SHARED_PARAGRAPHS.detail, detailCount)) {
      paragraphs.push({ type: 'body', text: sub(d) });
    }

    const reactionCount = targetParagraphs >= 10 ? 2 : 1;
    for (const r of shuffleAndPickUnique(SHARED_PARAGRAPHS.reaction, reactionCount)) {
      paragraphs.push({ type: 'body', text: sub(r) });
    }

    if (inlineImages.length > 1) {
      paragraphs.push({ type: 'image', src: inlineImages[1] });
    }

    paragraphs.push({ type: 'body', text: sub(pickUnique(SHARED_PARAGRAPHS.impact)) });
    paragraphs.push({ type: 'closing', text: sub(pickUnique(templates.closing)) });
  } else {
    paragraphs.push({ type: 'intro', text: pickUnique(NO_ARTIST_BODY.opening) });
    for (const bg of shuffleAndPickUnique(SHARED_PARAGRAPHS.noArtist.background, 2)) {
      paragraphs.push({ type: 'body', text: bg });
    }
    for (const a of shuffleAndPickUnique(NO_ARTIST_BODY.analysis, 2)) {
      paragraphs.push({ type: 'body', text: a });
    }
    if (inlineImages.length > 0) {
      paragraphs.push({ type: 'image', src: inlineImages[0] });
    }
    for (const d of shuffleAndPickUnique(SHARED_PARAGRAPHS.noArtist.detail, 2)) {
      paragraphs.push({ type: 'body', text: d });
    }
    for (const r of shuffleAndPickUnique(SHARED_PARAGRAPHS.noArtist.reaction, 1)) {
      paragraphs.push({ type: 'body', text: r });
    }
    if (inlineImages.length > 1) {
      paragraphs.push({ type: 'image', src: inlineImages[1] });
    }
    paragraphs.push({ type: 'body', text: pickUnique(SHARED_PARAGRAPHS.noArtist.impact) });
    paragraphs.push({ type: 'closing', text: pickUnique(NO_ARTIST_BODY.closing) });
  }

  return { paragraphs };
}

function extractArtistFromParagraphs(paragraphs) {
  if (!paragraphs || paragraphs.length === 0) return null;
  const sample = paragraphs.slice(0, 3).join(' ');
  return extractArtist(sample);
}

function shuffleAndPick(arr, n) {
  const shuffled = [...arr].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, Math.min(n, shuffled.length));
}

// ============================================================
// Backdating — Generate articles from Jan 1 to Mar 22, 2026
// ============================================================

function backdateArticles(articles) {
  const endDate = new Date(2026, 2, 22);  // Mar 22, 2026
  const totalDays = 80; // ~Jan 1 to Mar 22

  // Sort articles so that the first articles (index 0) get the MOST RECENT dates
  // and later articles get older dates. This ensures hero/top picks are recent.
  for (let i = 0; i < articles.length; i++) {
    // Linear spread: article 0 = most recent, last article = oldest
    const fraction = i / Math.max(articles.length - 1, 1);
    const daysAgo = Math.floor(fraction * totalDays) + Math.floor(Math.random() * 3);
    const articleDate = new Date(endDate);
    articleDate.setDate(articleDate.getDate() - daysAgo);
    articleDate.setHours(8 + Math.floor(Math.random() * 14), Math.floor(Math.random() * 60));
    articles[i].pubDate = articleDate;
    articles[i].formattedDate = `${MONTH_NAMES[articleDate.getMonth()]} ${articleDate.getDate()}, ${articleDate.getFullYear()}`;
  }

  // Re-sort newest first
  articles.sort((a, b) => b.pubDate.getTime() - a.pubDate.getTime());
  log(`  Backdated ${articles.length} articles (Jan 1 - Mar 22, 2026, spread evenly)`);
}

// ============================================================
// HTML escaping
// ============================================================

function escapeHtml(str) {
  return (str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ============================================================
// Build image tag helpers
// ============================================================

function imgTag(article, width, height, loading = 'lazy') {
  const src = escapeHtml(article.image || PLACEHOLDER_IMAGE);
  const fallback = `https://picsum.photos/seed/${encodeURIComponent(article.title.slice(0, 20))}/${width}/${height}`;
  return `<img src="${src}" alt="${escapeHtml(article.title)}" width="${width}" height="${height}" loading="${loading}" referrerpolicy="no-referrer" data-fallback="${escapeHtml(fallback)}" onerror="if(!this.dataset.failed){this.dataset.failed='1';this.src=this.dataset.fallback}">`;
}

function imgTagForArticle(article, width, height, loading = 'lazy') {
  let src = article.image || PLACEHOLDER_IMAGE;
  if (src.startsWith('images/')) src = '../' + src;
  const escapedSrc = escapeHtml(src);
  const fallback = `https://picsum.photos/seed/${encodeURIComponent(article.title.slice(0, 20))}/${width}/${height}`;
  return `<img src="${escapedSrc}" alt="${escapeHtml(article.title)}" width="${width}" height="${height}" loading="${loading}" referrerpolicy="no-referrer" data-fallback="${escapeHtml(fallback)}" onerror="if(!this.dataset.failed){this.dataset.failed='1';this.src=this.dataset.fallback}">`;
}

// ============================================================
// Card generators for index page sections
// ============================================================

// ---- Unique excerpt generation to avoid identical fallback text ----
const EDITORIAL_EXCERPTS = [
  'An essay exploring the deeper currents beneath the surface of the K-pop industry.',
  'A measured look at the forces shaping K-pop\'s trajectory in 2026.',
  'CHRONICLE examines what this development means for the broader industry landscape.',
  'An editorial reflection on the week\'s most consequential K-pop stories.',
  'What the headlines miss, and why the details matter more than they appear to.',
  'A careful reading of the signals coming from inside the K-pop world this week.',
  'The patterns are there for those who know where to look. This essay connects the dots.',
  'Beyond the noise of the news cycle, quieter shifts are underway. We examine them here.',
  'Industry analysis that goes past the surface to reveal what is really happening.',
  'Cultural commentary on K-pop\'s evolving relationship with its global audience.',
  'A nuanced perspective on how this moment fits into K-pop\'s larger story.',
  'The editorial team unpacks the week\'s developments with depth and context.',
  'Close observation reveals more than casual attention ever could. Here is what we found.',
  'K-pop\'s current moment demands the kind of analysis that quick takes cannot provide.',
  'An assessment of where things stand and where they might be headed next.',
];
let _excerptIndex = 0;

function getUniqueExcerpt(article) {
  const real = article.articleContent?.paragraphs?.[0]?.slice(0, 160);
  if (real && real.length > 30) return real;
  // Cycle through unique editorial excerpts
  const excerpt = EDITORIAL_EXCERPTS[_excerptIndex % EDITORIAL_EXCERPTS.length];
  _excerptIndex++;
  return excerpt;
}

function generateEditorPickCard(article) {
  if (!article) return '';
  const topic = classifyTopic(article.originalTitle || article.title);
  const cat = displayCategory(topic);
  const excerpt = getUniqueExcerpt(article);
  return `<li>
          <div class="ed-category">${escapeHtml(cat)}</div>
          <div class="ed-title"><a href="${escapeHtml(article.localUrl)}">${escapeHtml(article.title)}</a></div>
          <div class="ed-excerpt">${escapeHtml(excerpt)}</div>
          <div class="ed-meta">${escapeHtml(article.formattedDate)} &middot; Originally reported by ${escapeHtml(article.source)}</div>
        </li>`;
}

const INDUSTRY_EXCERPTS = [
  'Industry analysis and market commentary from the CHRONICLE editorial team.',
  'A data-driven examination of the business dynamics shaping K-pop\'s present and future.',
  'Behind the numbers lies a story about strategy, adaptation, and ambition.',
  'The industry metrics tell a compelling story when read in the proper context.',
  'CHRONICLE breaks down the market forces at work in this week\'s developments.',
  'An analytical look at how market pressures and creative decisions intersect.',
  'What the quarterly data reveals about K-pop\'s evolving commercial landscape.',
  'The business side of K-pop, examined with the rigor it deserves.',
];
let _industryExcerptIndex = 0;

function generateIndustryCard(article) {
  if (!article) return '';
  const topic = classifyTopic(article.originalTitle || article.title);
  const cat = displayCategory(topic);
  let excerpt = article.articleContent?.paragraphs?.[0]?.slice(0, 120);
  if (!excerpt || excerpt.length < 30) {
    excerpt = INDUSTRY_EXCERPTS[_industryExcerptIndex % INDUSTRY_EXCERPTS.length];
    _industryExcerptIndex++;
  }
  return `<div class="industry-item"><a href="${escapeHtml(article.localUrl)}">
        ${imgTag(article, 400, 267)}
        <div class="ind-label">${escapeHtml(cat)}</div>
        <div class="ind-title">${escapeHtml(article.title)}</div>
        <div class="ind-excerpt">${escapeHtml(excerpt)}</div>
        <div class="ind-meta">${escapeHtml(article.formattedDate)}</div>
      </a></div>`;
}

const CULTURE_QUOTES = [
  'Cultural commentary and critical reflection on the world of K-pop.',
  'An examination of how K-pop intersects with broader cultural narratives.',
  'The cultural dimensions of this story reveal more than the surface suggests.',
  'K-pop as a cultural phenomenon continues to challenge and reward serious inquiry.',
  'How this moment in K-pop reflects and shapes the world beyond the stage.',
  'A thoughtful meditation on what K-pop means in its current global context.',
];
let _cultureQuoteIndex = 0;

function generateCultureCard(article) {
  if (!article) return '';
  const topic = classifyTopic(article.originalTitle || article.title);
  const cat = displayCategory(topic);
  let pullquote = article.articleContent?.paragraphs?.[1]?.slice(0, 180);
  if (!pullquote || pullquote.length < 30) {
    pullquote = CULTURE_QUOTES[_cultureQuoteIndex % CULTURE_QUOTES.length];
    _cultureQuoteIndex++;
  }
  return `<article><a href="${escapeHtml(article.localUrl)}">
        <div class="cult-img">${imgTag(article, 200, 150)}</div>
        <div class="cult-text">
          <div class="cult-category">${escapeHtml(cat)}</div>
          <div class="cult-title">${escapeHtml(article.title)}</div>
          <div class="cult-quote">${escapeHtml(pullquote)}</div>
          <div class="cult-meta">${escapeHtml(article.formattedDate)} &middot; ${escapeHtml(article.source)}</div>
        </div>
      </a></article>`;
}

function generateArchiveItem(article) {
  if (!article) return '';
  const topic = classifyTopic(article.originalTitle || article.title);
  const cat = displayCategory(topic);
  return `<li><a href="${escapeHtml(article.localUrl)}">
        <span class="arc-date">${escapeHtml(article.formattedDate)}</span>
        <span class="arc-sep">&mdash;</span>
        <span class="arc-title">${escapeHtml(article.title)}</span>
        <span class="arc-cat">${escapeHtml(cat)}</span>
      </a></li>`;
}

// ============================================================
// Generate article HTML pages
// ============================================================

async function generateArticlePages(allArticles, usedArticles) {
  await mkdir(ARTICLES_DIR, { recursive: true });
  const templatePath = join(__dirname, 'article-template.html');
  const articleTemplate = await readFile(templatePath, 'utf-8');
  log(`Generating ${usedArticles.length} article pages...`);

  for (let i = 0; i < usedArticles.length; i++) {
    const filename = `article-${String(i + 1).padStart(3, '0')}.html`;
    usedArticles[i].localUrl = `articles/${filename}`;
  }

  let generated = 0;
  for (let i = 0; i < usedArticles.length; i++) {
    const article = usedArticles[i];
    const filename = `article-${String(i + 1).padStart(3, '0')}.html`;
    const topic = classifyTopic(article.originalTitle || article.title);

    const related = allArticles
      .filter(a => a !== article && a.image && a.localUrl)
      .slice(0, 20)
      .sort(() => Math.random() - 0.5)
      .slice(0, 3);

    const bodyData = rewriteArticleBody(article.articleContent, article.title);
    let bodyHtml = '';
    for (const item of bodyData.paragraphs) {
      if (item.type === 'intro') {
        bodyHtml += `<div class="editorial-intro">${escapeHtml(item.text)}</div>\n`;
      } else if (item.type === 'closing') {
        bodyHtml += `        <div class="editorial-closing">${escapeHtml(item.text)}</div>`;
      } else if (item.type === 'image') {
        const imgSrc = item.src;
        const fallback = `https://picsum.photos/seed/inline-${Math.random().toString(36).slice(2,8)}/760/428`;
        bodyHtml += `        <figure class="article-inline-image">
          <img src="${escapeHtml(imgSrc)}" alt="" width="760" height="428" loading="lazy" decoding="async" referrerpolicy="no-referrer" data-fallback="${escapeHtml(fallback)}" onerror="if(!this.dataset.failed){this.dataset.failed='1';this.src=this.dataset.fallback}">
        </figure>\n`;
      } else {
        bodyHtml += `        <p>${escapeHtml(item.text)}</p>\n`;
      }
    }

    let heroImgSrc = article.image || PLACEHOLDER_IMAGE;
    if (heroImgSrc.startsWith('images/')) heroImgSrc = '../' + heroImgSrc;
    const heroFallback = `https://picsum.photos/seed/${encodeURIComponent(article.title.slice(0, 20))}/800/450`;
    const heroImg = `<img src="${escapeHtml(heroImgSrc)}" alt="${escapeHtml(article.title)}" width="760" height="428" loading="eager" referrerpolicy="no-referrer" data-fallback="${escapeHtml(heroFallback)}" onerror="if(!this.dataset.failed){this.dataset.failed='1';this.src=this.dataset.fallback}">`;

    let relatedHtml = '';
    for (const rel of related) {
      const relUrl = `../${rel.localUrl}`;
      let relImgSrc = rel.image || PLACEHOLDER_IMAGE;
      if (relImgSrc.startsWith('images/')) relImgSrc = '../' + relImgSrc;
      const relFallback = `https://picsum.photos/seed/${encodeURIComponent(rel.title.slice(0, 20))}/400/225`;
      const relTopic = classifyTopic(rel.originalTitle || rel.title);
      relatedHtml += `
          <a href="${escapeHtml(relUrl)}" class="related-card">
            <div class="thumb">
              <img src="${escapeHtml(relImgSrc)}" alt="${escapeHtml(rel.title)}" width="400" height="225" loading="lazy" referrerpolicy="no-referrer" data-fallback="${escapeHtml(relFallback)}" onerror="if(!this.dataset.failed){this.dataset.failed='1';this.src=this.dataset.fallback}">
            </div>
            <div class="related-category">${escapeHtml(displayCategory(relTopic))}</div>
            <h3>${escapeHtml(rel.title)}</h3>
            <span class="date">${escapeHtml(rel.formattedDate)}</span>
          </a>`;
    }

    const sourceAttribution = `<div class="source-attribution">
          Originally reported by <a href="${escapeHtml(article.link)}" target="_blank" rel="noopener noreferrer">${escapeHtml(article.source)}</a>
          <br><a href="${escapeHtml(article.link)}" target="_blank" rel="noopener noreferrer" class="read-original">Read the original report &rarr;</a>
        </div>`;

    const photoCredit = `Photo: &copy; ${escapeHtml(article.source)}`;

    let html = articleTemplate
      .replace(/\{\{ARTICLE_TITLE\}\}/g, escapeHtml(article.title))
      .replace(/\{\{ARTICLE_DESCRIPTION\}\}/g, escapeHtml(article.title).slice(0, 160))
      .replace('{{ARTICLE_IMAGE}}', escapeHtml(heroImgSrc))
      .replace('{{ARTICLE_CATEGORY}}', escapeHtml(displayCategory(topic)))
      .replace('{{ARTICLE_DATE}}', escapeHtml(article.formattedDate))
      .replace('{{ARTICLE_HERO_IMAGE}}', heroImg)
      .replace('{{ARTICLE_BODY}}', bodyHtml)
      .replace('{{SOURCE_ATTRIBUTION}}', sourceAttribution)
      .replace('{{PHOTO_CREDIT}}', photoCredit)
      .replace('{{RELATED_ARTICLES}}', relatedHtml);

    const outputPath = join(ARTICLES_DIR, filename);
    await writeFile(outputPath, html, 'utf-8');
    generated++;
  }
  log(`  Generated ${generated} article pages`);
}

// ============================================================
// Assign articles to sections
// ============================================================

const HERO_OFFSET = 9;

function assignSections(articles) {
  let placeholderIdx = 0;
  for (const article of articles) {
    if (!article.image) {
      placeholderIdx++;
      article.image = `https://picsum.photos/seed/chronicle-${placeholderIdx}-${Date.now() % 10000}/800/450`;
      article.hasPlaceholder = true;
    }
  }

  const withRealImages = articles.filter(a => !a.hasPlaceholder);
  const used = new Set();

  const take = (pool, count) => {
    const result = [];
    for (const article of pool) {
      if (result.length >= count) break;
      if (!used.has(article.link)) {
        result.push(article);
        used.add(article.link);
      }
    }
    return result;
  };

  const heroCandidates = withRealImages.length >= 2 ? withRealImages : articles;
  const heroSkipped = heroCandidates.slice(HERO_OFFSET);
  const hero = take(heroSkipped.length ? heroSkipped : heroCandidates, 1);
  const editorsPicks = take(articles, 3);
  const industry = take(articles, 4);
  const culture = take(articles, 3);
  const archive = take(articles, 7);

  return { hero: hero[0] || null, editorsPicks, industry, culture, archive };
}

// ============================================================
// Generate index HTML
// ============================================================

async function generateHtml(sections) {
  const templatePath = join(__dirname, 'template.html');
  let template = await readFile(templatePath, 'utf-8');

  // Hero section
  if (sections.hero) {
    const h = sections.hero;
    const topic = classifyTopic(h.originalTitle || h.title);
    template = template.replace('{{HERO_IMAGE}}', imgTag(h, 600, 450, 'eager'));
    template = template.replace('{{HERO_TITLE}}', escapeHtml(h.title));
    template = template.replace('{{HERO_LINK}}', escapeHtml(h.localUrl));
    template = template.replace('{{HERO_SUBTITLE}}', escapeHtml(
      h.articleContent?.paragraphs?.[0]?.slice(0, 200) || 'An in-depth look at the forces shaping K-pop in 2026.'
    ));
    template = template.replace('{{HERO_CATEGORY}}', escapeHtml(displayCategory(topic)));
    template = template.replace('{{HERO_DATE}}', escapeHtml(h.formattedDate));
    template = template.replace('{{HERO_SOURCE}}', escapeHtml(h.source));
  } else {
    template = template.replace('{{HERO_IMAGE}}', '');
    template = template.replace('{{HERO_TITLE}}', 'CHRONICLE');
    template = template.replace('{{HERO_LINK}}', '#');
    template = template.replace('{{HERO_SUBTITLE}}', 'In-depth K-pop industry analysis, essays, and cultural commentary.');
    template = template.replace('{{HERO_CATEGORY}}', 'EDITORIAL');
    template = template.replace('{{HERO_DATE}}', 'March 22, 2026');
    template = template.replace('{{HERO_SOURCE}}', 'CHRONICLE');
  }

  template = template.replace(
    '{{EDITORS_PICKS}}',
    sections.editorsPicks.map(a => generateEditorPickCard(a)).join('\n      ')
  );

  template = template.replace(
    '{{INDUSTRY_ARTICLES}}',
    sections.industry.map(a => generateIndustryCard(a)).join('\n      ')
  );

  template = template.replace(
    '{{CULTURE_ARTICLES}}',
    sections.culture.map(a => generateCultureCard(a)).join('\n      ')
  );

  template = template.replace(
    '{{ARCHIVE}}',
    sections.archive.map(a => generateArchiveItem(a)).join('\n      ')
  );

  return template;
}

// ============================================================
// Main
// ============================================================

async function main() {
  log('Starting CHRONICLE Magazine RSS Crawler...');
  log('');

  // 1. Fetch all RSS feeds (English only)
  const articles = await fetchAllFeeds();
  if (articles.length === 0) {
    warn('No articles fetched. Aborting.');
    process.exit(1);
  }
  log('');

  // 2. Fill missing images via og:image
  await fillMissingImages(articles);
  log('');

  // 3. Rewrite ALL titles to literary English editorial style
  log('Rewriting titles to CHRONICLE editorial style...');
  let rewritten = 0;
  for (const article of articles) {
    const original = article.title;
    article.originalTitle = original;
    article.title = rewriteTitle(original, article.source);
    if (article.title !== original) rewritten++;
  }
  log(`  Rewritten ${rewritten}/${articles.length} titles`);
  log('');

  // 4. Backdate articles (Jan 1 - Mar 22, 2026)
  log('Backdating articles...');
  backdateArticles(articles);
  log('');

  // 5. Assign articles to sections
  // hero: 1, editorsPicks: 3, industry: 4, culture: 3, archive: 7
  const sections = assignSections(articles);

  // Collect all used articles for article page generation
  const usedArticles = [];
  const usedSet = new Set();
  const addUsed = (arr) => {
    for (const a of arr) {
      if (a && !usedSet.has(a.link)) {
        usedArticles.push(a);
        usedSet.add(a.link);
      }
    }
  };
  if (sections.hero) addUsed([sections.hero]);
  addUsed(sections.editorsPicks);
  addUsed(sections.industry);
  addUsed(sections.culture);
  addUsed(sections.archive);

  // 6. Download images locally
  const withImages = articles.filter(a => a.image).length;
  log(`Articles with images: ${withImages}/${articles.length}`);
  await downloadArticleImages(usedArticles);
  log('');

  // 7. Fetch full article content for used articles
  await fetchAllArticleContent(usedArticles);
  log('');

  // 8. Generate individual article pages
  await generateArticlePages(articles, usedArticles);
  log('');

  // 9. Generate index HTML from template
  const html = await generateHtml(sections);

  // 10. Write index output
  const outputPath = join(__dirname, 'index.html');
  await writeFile(outputPath, html, 'utf-8');

  const totalUsed =
    (sections.hero ? 1 : 0) +
    sections.editorsPicks.length +
    sections.industry.length +
    sections.culture.length +
    sections.archive.length;

  log(`Generated index.html with ${totalUsed} articles`);
  log(`Generated ${usedArticles.length} article pages in articles/`);
  log(`Done! Open: file://${outputPath}`);
}

main().catch((err) => {
  console.error('[CHRONICLE Crawler] Fatal error:', err);
  process.exit(1);
});
