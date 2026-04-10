/**
 * Minimal RSS 2.0 / Atom parser.
 *
 * Deliberately dependency-free. RSS is simple enough that a focused regex
 * parser handles all the real-world feeds we ingest (Reuters via Google News,
 * AP via Google News, AFP direct, Al Jazeera direct, FT, Bloomberg,
 * Truth Social via trumpstruth.org). If a feed adds structural complexity
 * beyond what's handled here, swap in rss-parser as a dependency.
 *
 * Returns normalized items:
 *   { id, title, link, pubDate (Date), description, author, guid, source }
 */

function decodeEntities(s) {
  if (!s) return '';
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function stripHtml(s) {
  return decodeEntities(s || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

function extractTag(block, tag) {
  // Non-greedy, case-insensitive, handles CDATA
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i');
  const m = block.match(re);
  return m ? decodeEntities(m[1]).trim() : '';
}

function extractAttr(block, tag, attr) {
  const re = new RegExp(`<${tag}[^>]*\\s${attr}="([^"]+)"[^>]*/?>`, 'i');
  const m = block.match(re);
  return m ? decodeEntities(m[1]) : '';
}

function parseDate(s) {
  if (!s) return null;
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return d;
  return null;
}

/**
 * Parse RSS 2.0 or Atom XML into an array of normalized items.
 * @param {string} xml
 * @returns {Array<{id:string,title:string,link:string,pubDate:Date|null,description:string,author:string}>}
 */
export function parseRSS(xml) {
  if (!xml || typeof xml !== 'string') return [];
  const items = [];

  // RSS 2.0: <item>...</item>
  const rssMatches = xml.match(/<item\b[\s\S]*?<\/item>/gi) || [];
  for (const block of rssMatches) {
    const title = stripHtml(extractTag(block, 'title'));
    const link = stripHtml(extractTag(block, 'link'));
    const pubDateRaw = extractTag(block, 'pubDate') || extractTag(block, 'dc:date');
    const description = stripHtml(extractTag(block, 'description') || extractTag(block, 'content:encoded'));
    const author = stripHtml(extractTag(block, 'author') || extractTag(block, 'dc:creator'));
    const guid = stripHtml(extractTag(block, 'guid')) || link;
    if (!title && !description) continue;
    items.push({
      id: guid || link || title,
      title,
      link,
      pubDate: parseDate(pubDateRaw),
      description,
      author,
    });
  }

  // Atom: <entry>...</entry> (if we didn't already get items from RSS)
  if (items.length === 0) {
    const atomMatches = xml.match(/<entry\b[\s\S]*?<\/entry>/gi) || [];
    for (const block of atomMatches) {
      const title = stripHtml(extractTag(block, 'title'));
      const link = extractAttr(block, 'link', 'href') || stripHtml(extractTag(block, 'id'));
      const pubDateRaw = extractTag(block, 'published') || extractTag(block, 'updated');
      const description = stripHtml(extractTag(block, 'summary') || extractTag(block, 'content'));
      const author = stripHtml(extractTag(block, 'name'));
      const guid = stripHtml(extractTag(block, 'id')) || link;
      if (!title && !description) continue;
      items.push({
        id: guid || link || title,
        title,
        link,
        pubDate: parseDate(pubDateRaw),
        description,
        author,
      });
    }
  }

  return items;
}
