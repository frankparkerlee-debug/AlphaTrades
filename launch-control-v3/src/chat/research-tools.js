/**
 * Research tools for the chat agent.
 *
 * Gives Claude Sonnet the ability to actively research instead of just
 * narrating a static context dump. The tool-use loop in server.js calls
 * these handlers when Sonnet requests a tool.
 *
 * Tools:
 *   search_news     — Google News RSS search (free, no API key)
 *   query_sentiment — query classified sentiment_events
 *   query_signals   — historical signal lookup (not just today)
 *   query_paper     — paper trade performance
 *   query_ticker    — ticker intelligence (earnings, IV, macro sensitivity)
 *   fetch_article   — fetch + extract text from a URL
 */
import axios from 'axios';
import { parseRSS } from '../sentiment/rss-parser.js';
import { query } from '../data/db.js';

// ── TOOL DEFINITIONS (sent to Sonnet as available tools) ─────────────────────

export const TOOL_DEFINITIONS = [
  {
    name: 'search_news',
    description: 'Search Google News for recent articles on any topic. Use this when the user asks about current events, geopolitical developments, market-moving news, or anything not in your existing context. Returns headlines, links, dates, and snippets.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query (e.g. "Iran Pakistan delegation" or "NVDA earnings guidance")' },
      },
      required: ['query'],
    },
  },
  {
    name: 'query_sentiment',
    description: 'Query the classified sentiment feed from StockTwits, News RSS (Reuters, AP, AFP, Al Jazeera, Bloomberg, FT, Dawn, BBC), Truth Social, and narrative synthesis arcs. Use this to check what social/news sentiment says about a ticker, sector, or geopolitical topic.',
    input_schema: {
      type: 'object',
      properties: {
        ticker: { type: 'string', description: 'Ticker symbol to filter by (e.g. "SPY"). Optional — omit for broad search.' },
        source: { type: 'string', description: 'Filter by source: stocktwits, reuters, ap, afp, aljazeera, bloomberg, ft, dawn, bbc_mideast, truth_social, narrative_synthesis. Optional.' },
        hours_back: { type: 'number', description: 'How many hours back to search. Default 4.' },
        impact: { type: 'string', description: 'Comma-separated impact filter: LOW,MEDIUM,HIGH. Default: MEDIUM,HIGH' },
        limit: { type: 'number', description: 'Max results. Default 20.' },
      },
    },
  },
  {
    name: 'query_signals',
    description: 'Query historical signals from the signal pipeline. Use this to look up past signals for a ticker or strategy beyond just today. Returns grade, direction, strategy, composite score, entry price, PnL if taken.',
    input_schema: {
      type: 'object',
      properties: {
        ticker: { type: 'string', description: 'Ticker symbol. Optional.' },
        strategy: { type: 'string', description: 'Strategy name (e.g. ORB_BREAKOUT, GAP_FILL_REVERSION, MOMENTUM_SCALP). Optional.' },
        days_back: { type: 'number', description: 'How many days back. Default 7.' },
        limit: { type: 'number', description: 'Max results. Default 20.' },
      },
    },
  },
  {
    name: 'query_paper_trades',
    description: 'Query paper trade history and performance. Shows entry/exit prices, PnL, hold time, exit reason, strategy, and outcome. Use this when the user asks about recent trade performance or paper trading results.',
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'Filter by status: OPEN, CLOSED, or ALL. Default ALL.' },
        ticker: { type: 'string', description: 'Ticker symbol. Optional.' },
        days_back: { type: 'number', description: 'How many days back. Default 7.' },
        limit: { type: 'number', description: 'Max results. Default 15.' },
      },
    },
  },
  {
    name: 'query_ticker_intel',
    description: 'Look up intelligence for a specific ticker: earnings date, IV rank, macro sensitivity, analyst targets, beta, insider activity. Use this when the user asks about a specific stock\'s fundamentals or upcoming events.',
    input_schema: {
      type: 'object',
      properties: {
        ticker: { type: 'string', description: 'Ticker symbol (required).' },
      },
      required: ['ticker'],
    },
  },
  {
    name: 'fetch_article',
    description: 'Fetch and extract text content from a URL. Use this when you found a relevant article via search_news and need to read the full text for deeper context. Returns first ~3000 chars of extracted text.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Full URL to fetch.' },
      },
      required: ['url'],
    },
  },
];

// ── TOOL HANDLERS ────────────────────────────────────────────────────────────

async function searchNews({ query: q }) {
  try {
    const encoded = encodeURIComponent(q);
    const url = `https://news.google.com/rss/search?q=${encoded}+when%3A7d&hl=en-US&gl=US&ceid=US:en`;
    const r = await axios.get(url, {
      timeout: 10000,
      headers: { 'User-Agent': 'Mozilla/5.0 (AlphaTradesV3 research agent)' },
      responseType: 'text',
      maxRedirects: 5,
    });
    const items = parseRSS(r.data).slice(0, 15);
    return items.map(item => ({
      title: item.title,
      link: item.link,
      date: item.pubDate ? item.pubDate.toISOString().slice(0, 16) : null,
      snippet: (item.description || '').slice(0, 200),
      source: item.author || 'Google News',
    }));
  } catch (err) {
    return { error: `Search failed: ${err.message}` };
  }
}

async function querySentiment({ ticker, source, hours_back, impact, limit }) {
  const hoursBack = hours_back || 4;
  const impactList = (impact || 'MEDIUM,HIGH').split(',').map(s => s.trim());
  const maxRows = Math.min(limit || 20, 50);
  const since = new Date(Date.now() - hoursBack * 60 * 60 * 1000);

  const wheres = [`raw_ts >= $1`];
  const params = [since];

  if (ticker) {
    params.push(ticker.toUpperCase());
    wheres.push(`(tickers @> to_jsonb(ARRAY[$${params.length}::text]) OR tickers ? $${params.length})`);
  }
  if (source) {
    params.push(source);
    wheres.push(`source = $${params.length}`);
  }
  if (impactList.length) {
    params.push(impactList);
    wheres.push(`market_impact = ANY($${params.length}::text[])`);
  }
  params.push(maxRows);

  const r = await query(`
    SELECT source, author, title, text, raw_ts, direction, confidence,
           market_impact, sentiment, tickers, rationale
    FROM lc_v3.sentiment_events
    WHERE ${wheres.join(' AND ')}
    ORDER BY raw_ts DESC
    LIMIT $${params.length}
  `, params);

  return r.rows.map(e => ({
    source: e.source,
    author: e.author,
    title: (e.title || '').slice(0, 120),
    text: (e.text || '').slice(0, 200),
    time: e.raw_ts?.toISOString?.().slice(0, 16),
    direction: e.direction,
    confidence: e.confidence ? +Number(e.confidence).toFixed(2) : null,
    impact: e.market_impact,
    sentiment: e.sentiment ? +Number(e.sentiment) : null,
    tickers: e.tickers,
    rationale: (e.rationale || '').slice(0, 200),
  }));
}

async function querySignals({ ticker, strategy, days_back, limit }) {
  const daysBack = days_back || 7;
  const maxRows = Math.min(limit || 20, 50);

  const wheres = [`s.created_at >= NOW() - ($1 || ' days')::interval`];
  const params = [String(daysBack)];

  if (ticker) {
    params.push(ticker.toUpperCase());
    wheres.push(`s.ticker = $${params.length}`);
  }
  if (strategy) {
    params.push(strategy.toUpperCase());
    wheres.push(`s.strategy = $${params.length}`);
  }
  params.push(maxRows);

  const r = await query(`
    SELECT s.signal_id, s.ticker, s.direction, s.grade, s.status, s.strategy,
           s.composite_raw, s.price_at_signal, s.spy_change_pct, s.relative_volume,
           s.confluence_score, s.created_at, s.human_taken, s.human_pnl_pct,
           s.news_headline
    FROM lc_v3.signals s
    WHERE ${wheres.join(' AND ')}
    ORDER BY s.created_at DESC
    LIMIT $${params.length}
  `, params);

  return r.rows.map(s => ({
    id: s.signal_id,
    ticker: s.ticker,
    direction: s.direction,
    grade: s.grade,
    strategy: s.strategy,
    composite: Number(s.composite_raw) || 0,
    price: Number(s.price_at_signal) || null,
    status: s.status,
    taken: !!s.human_taken,
    pnl_pct: s.human_pnl_pct != null ? +Number(s.human_pnl_pct).toFixed(2) : null,
    time: s.created_at?.toISOString?.().slice(0, 16),
    news: (s.news_headline || '').slice(0, 100),
  }));
}

async function queryPaperTrades({ status, ticker, days_back, limit }) {
  const daysBack = days_back || 7;
  const maxRows = Math.min(limit || 15, 50);

  const wheres = [`entry_time >= NOW() - ($1 || ' days')::interval`];
  const params = [String(daysBack)];

  if (status && status !== 'ALL') {
    params.push(status.toUpperCase());
    wheres.push(`status = $${params.length}`);
  }
  if (ticker) {
    params.push(ticker.toUpperCase());
    wheres.push(`ticker = $${params.length}`);
  }
  params.push(maxRows);

  const r = await query(`
    SELECT paper_id, ticker, direction, strategy, status,
           entry_time, entry_contract_symbol, entry_contract_mid,
           exit_time, exit_reason, final_pnl_pct, final_pnl_dollars, outcome,
           unrealized_pnl_pct, peak_pnl_pct
    FROM lc_v3.paper_trades
    WHERE ${wheres.join(' AND ')}
    ORDER BY entry_time DESC
    LIMIT $${params.length}
  `, params);

  return r.rows.map(t => ({
    id: t.paper_id,
    ticker: t.ticker,
    direction: t.direction,
    strategy: t.strategy,
    status: t.status,
    entry_time: t.entry_time?.toISOString?.().slice(0, 16),
    contract: t.entry_contract_symbol,
    entry_mid: Number(t.entry_contract_mid) || null,
    exit_time: t.exit_time?.toISOString?.().slice(0, 16),
    exit_reason: t.exit_reason,
    pnl_pct: t.final_pnl_pct != null ? +Number(t.final_pnl_pct).toFixed(2) : null,
    pnl_dollars: t.final_pnl_dollars != null ? +Number(t.final_pnl_dollars).toFixed(2) : null,
    outcome: t.outcome,
    unrealized_pct: t.unrealized_pnl_pct != null ? +Number(t.unrealized_pnl_pct).toFixed(2) : null,
    peak_pct: t.peak_pnl_pct != null ? +Number(t.peak_pnl_pct).toFixed(2) : null,
  }));
}

async function queryTickerIntel({ ticker }) {
  const tk = ticker.toUpperCase();
  const results = {};

  // Ticker intelligence
  const intel = await query(`
    SELECT * FROM lc_v3.ticker_intelligence WHERE ticker = $1
  `, [tk]).catch(() => ({ rows: [] }));
  if (intel.rows[0]) {
    const i = intel.rows[0];
    results.earnings_date = i.earnings_date;
    results.earnings_days_away = i.earnings_days_away;
    results.earnings_avg_move_pct = i.earnings_avg_move_pct ? +Number(i.earnings_avg_move_pct).toFixed(2) : null;
    results.earnings_beat_rate = i.earnings_beat_rate ? +Number(i.earnings_beat_rate).toFixed(2) : null;
    results.iv_rank_30d = i.iv_rank_30d ? +Number(i.iv_rank_30d).toFixed(2) : null;
    results.analyst_target = i.analyst_price_target ? +Number(i.analyst_price_target).toFixed(2) : null;
    results.beta = i.beta_30d ? +Number(i.beta_30d).toFixed(2) : null;
    results.insider_signal = i.insider_signal;
    results.short_interest_pct = i.short_interest_pct ? +Number(i.short_interest_pct).toFixed(2) : null;
  } else {
    results.note = 'No ticker intelligence record found for ' + tk;
  }

  // Macro sensitivity
  const macro = await query(`
    SELECT event_type, avg_move_pct, avg_move_direction
    FROM lc_v3.macro_sensitivity WHERE ticker = $1
  `, [tk]).catch(() => ({ rows: [] }));
  if (macro.rows.length) {
    results.macro_sensitivity = macro.rows.map(m => ({
      event: m.event_type,
      avg_move: m.avg_move_pct ? +Number(m.avg_move_pct).toFixed(3) : null,
      direction: m.avg_move_direction,
    }));
  }

  // Recent IV
  const iv = await query(`
    SELECT iv_atm, iv_rank, put_call_skew, captured_at
    FROM lc_v3.iv_history WHERE ticker = $1
    ORDER BY captured_at DESC LIMIT 1
  `, [tk]).catch(() => ({ rows: [] }));
  if (iv.rows[0]) {
    results.latest_iv = {
      iv_atm: iv.rows[0].iv_atm ? +Number(iv.rows[0].iv_atm).toFixed(4) : null,
      iv_rank: iv.rows[0].iv_rank ? +Number(iv.rows[0].iv_rank).toFixed(2) : null,
      skew: iv.rows[0].put_call_skew ? +Number(iv.rows[0].put_call_skew).toFixed(3) : null,
      as_of: iv.rows[0].captured_at?.toISOString?.().slice(0, 16),
    };
  }

  return results;
}

async function fetchArticle({ url }) {
  try {
    const r = await axios.get(url, {
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (AlphaTradesV3 research agent)',
        'Accept': 'text/html,application/xhtml+xml,*/*',
      },
      responseType: 'text',
      maxRedirects: 5,
    });
    // Strip HTML tags, collapse whitespace, extract readable text
    let text = (r.data || '')
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<nav[\s\S]*?<\/nav>/gi, '')
      .replace(/<header[\s\S]*?<\/header>/gi, '')
      .replace(/<footer[\s\S]*?<\/footer>/gi, '')
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return { url, text: text.slice(0, 3000), length: text.length };
  } catch (err) {
    return { url, error: `Fetch failed: ${err.message}` };
  }
}

// ── DISPATCHER ───────────────────────────────────────────────────────────────

const HANDLERS = {
  search_news: searchNews,
  query_sentiment: querySentiment,
  query_signals: querySignals,
  query_paper_trades: queryPaperTrades,
  query_ticker_intel: queryTickerIntel,
  fetch_article: fetchArticle,
};

/**
 * Execute a tool by name with the given input.
 * Returns the JSON-serializable result.
 */
export async function executeTool(name, input) {
  const handler = HANDLERS[name];
  if (!handler) return { error: `Unknown tool: ${name}` };
  try {
    return await handler(input || {});
  } catch (err) {
    return { error: `Tool ${name} failed: ${err.message}` };
  }
}
