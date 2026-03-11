import { clamp } from '../utils/math.js';
import { hoursBetween } from '../utils/time.js';
import { query } from '../data/db.js';

// Generic catalyst polarity map
const GENERIC_POLARITY = {
  earnings_beat:       2,
  earnings_miss:      -2,
  analyst_upgrade:     2,
  analyst_downgrade:  -2,
  hyperscaler_capex:   2,
  ai_chip_export_restriction: -2,
  ai_model_release:    1,
  memory_pricing:      1,  // direction-dependent — positive if confirming
  hbm_demand:          2,
  delivery_numbers:    1,  // direction-dependent
  elon_event:          1,  // direction-dependent
  fsd_update:          1,
  ai_accelerator:      2,
  cpu_share_gain:      1,
  iphone_cycle:        1,
  services_growth:     1,
  ad_revenue:          1,
  ai_capex:            1,
  azure_growth:        2,
  openai_news:         1,
  search_revenue:      1,
  cloud_growth:        2,
  fab_capex:           2,
  macro_rate_cut:      1,
  macro_rate_hike:    -1,
  macro_cpi:           0,  // ambiguous
  macro_fomc:          0,  // ambiguous — wait for direction
  regulatory:         -2,
  other:               0,
};

// Cache catalyst map from DB
let catalystMapCache = null;
let catalystMapLoaded = false;

async function getCatalystMap() {
  if (catalystMapLoaded) return catalystMapCache;
  try {
    const res = await query('SELECT * FROM lc_v3.catalyst_map');
    catalystMapCache = res.rows;
    catalystMapLoaded = true;
    return catalystMapCache;
  } catch (err) {
    return [];
  }
}

// Reload cache (call after DB updates)
export function invalidateCatalystCache() {
  catalystMapLoaded = false;
  catalystMapCache = null;
}

/**
 * Classify a news headline against the catalyst map for a specific ticker
 */
export async function classifyCatalyst(headline, ticker) {
  const catalysts = await getCatalystMap();
  const lower = headline.toLowerCase();

  // Check ticker-specific catalysts first (higher priority)
  const tickerCats = catalysts.filter(c => c.ticker === ticker);
  for (const cat of tickerCats.sort((a, b) => b.sensitivity - a.sensitivity)) {
    const keywords = Array.isArray(cat.keywords) ? cat.keywords : JSON.parse(cat.keywords);
    if (keywords.some(kw => lower.includes(kw.toLowerCase()))) {
      return {
        type: cat.catalyst_type,
        sensitivity: parseFloat(cat.sensitivity),
        affectsCluster: cat.affects_cluster,
        decayHours: parseFloat(cat.decay_hours),
      };
    }
  }

  // Check universal catalysts (ticker = '*')
  const universalCats = catalysts.filter(c => c.ticker === '*');
  for (const cat of universalCats) {
    const keywords = Array.isArray(cat.keywords) ? cat.keywords : JSON.parse(cat.keywords);
    if (keywords.some(kw => lower.includes(kw.toLowerCase()))) {
      return {
        type: cat.catalyst_type,
        sensitivity: parseFloat(cat.sensitivity),
        affectsCluster: cat.affects_cluster,
        decayHours: parseFloat(cat.decay_hours),
      };
    }
  }

  // Generic classification fallback
  if (lower.match(/beat|beats|topped|exceeded|raised guidance|record revenue/)) {
    return { type: 'earnings_beat', sensitivity: 1.0, affectsCluster: false, decayHours: 8 };
  }
  if (lower.match(/miss|missed|fell short|lowered guidance|disappointing/)) {
    return { type: 'earnings_miss', sensitivity: 1.0, affectsCluster: false, decayHours: 8 };
  }
  if (lower.match(/upgrade|overweight|outperform|buy rating|price target raised/)) {
    return { type: 'analyst_upgrade', sensitivity: 1.0, affectsCluster: false, decayHours: 6 };
  }
  if (lower.match(/downgrade|underweight|underperform|sell rating|price target cut/)) {
    return { type: 'analyst_downgrade', sensitivity: 1.0, affectsCluster: false, decayHours: 6 };
  }
  if (lower.match(/sec|ftc|doj|antitrust|investigation|fine|lawsuit|regulatory/)) {
    return { type: 'regulatory', sensitivity: 1.2, affectsCluster: false, decayHours: 12 };
  }

  return { type: 'other', sensitivity: 1.0, affectsCluster: false, decayHours: 3 };
}

/**
 * Score a single news event for a given direction
 */
function scoreSingleEvent(event, direction, profile) {
  const { catalyst, polarity, timestamp, profile: p } = event;
  const ageHours = hoursBetween(new Date(timestamp), new Date());

  // Direction-adjusted polarity
  const dirPolarity = direction === 'CALL' ? polarity : -polarity;

  // Base score by direction polarity
  let base = 0;
  if (dirPolarity >= 2)       base = 15;
  else if (dirPolarity === 1) base = 9;
  else if (dirPolarity === 0) base = 4;
  else if (dirPolarity === -1) base = 0;
  else                         base = -8; // dirPolarity <= -2

  // Recency decay
  const isStrong = Math.abs(polarity) >= 2;
  let decay;
  if (isStrong) {
    decay = ageHours <= 2 ? 1.0 : ageHours <= 6 ? 0.75 : 0.50;
  } else {
    decay = ageHours <= 0.5 ? 1.0 : ageHours <= 1 ? 0.85 :
            ageHours <= 2   ? 0.65 : 0.40;
  }

  // Catalyst-specific sensitivity
  const sensitivity = catalyst?.sensitivity || 1.0;

  // Fade rate adjustment for old news
  const fadeRate = profile?.news_fade_rate || 0.40;
  let fadeMult = 1.0;
  if (ageHours > 1 && fadeRate > 0.60) {
    fadeMult = Math.max(0.4, 1 - ((fadeRate - 0.60) * ageHours * 0.1));
  }

  return base * sensitivity * decay * fadeMult;
}

/**
 * News/Sentiment pillar — max 20 pts (15 single event + 5 stack bonus)
 * Handles multi-event stacking with diminishing returns
 */
export function computeNewsScore(params) {
  const {
    direction,
    newsEvents,   // array of { headline, catalyst, polarity, timestamp }
    profile,      // equity_profile row
  } = params;

  const flags = [];
  let cap = null;

  // No news — slight positive (no headwind)
  if (!newsEvents || newsEvents.length === 0) {
    return { score: 4, cap: null, flags: [], stackCount: 0, stackBonus: 0, headline: null };
  }

  // Separate confirming and opposing
  const confirming = newsEvents.filter(e => {
    const dp = direction === 'CALL' ? e.polarity : -e.polarity;
    return dp >= 1;
  });
  const opposing = newsEvents.filter(e => {
    const dp = direction === 'CALL' ? e.polarity : -e.polarity;
    return dp <= -1;
  });

  // Score primary event
  const primary = confirming.length > 0
    ? confirming.reduce((best, e) => Math.abs(e.polarity) > Math.abs(best.polarity) ? e : best)
    : newsEvents.reduce((best, e) => Math.abs(e.polarity) > Math.abs(best.polarity) ? e : best);

  const baseScore = scoreSingleEvent(primary, direction, profile);

  // Stack bonus — confirming events, diminishing returns
  let stackBonus = 0;
  const extras = confirming.filter(e => e !== primary);
  for (const extra of extras) {
    const sameType = extra.catalyst?.type === primary.catalyst?.type;
    const typeDecay = sameType ? 0.25 : 0.50;
    const marginal = scoreSingleEvent(extra, direction, profile);
    stackBonus = Math.min(stackBonus + marginal * typeDecay, 5); // hard cap +5
  }

  // Opposing penalty
  let opposingPenalty = 0;
  for (const opp of opposing) {
    const oppScore = scoreSingleEvent(opp, direction, profile);
    opposingPenalty += oppScore * 0.75;
    const dp = direction === 'CALL' ? opp.polarity : -opp.polarity;
    if (dp <= -2) {
      flags.push('NEWS_CONFLICT_CRITICAL');
      cap = 'B-';
    } else {
      flags.push('NEWS_HEADWIND');
    }
  }

  const rawScore = baseScore + stackBonus + opposingPenalty;
  const score = clamp(Math.round(rawScore), -8, 20);

  return {
    score,
    cap,
    flags,
    stackCount: newsEvents.length,
    stackBonus: parseFloat(stackBonus.toFixed(2)),
    headline: primary.headline,
    catalystType: primary.catalyst?.type || 'other',
    polarity: primary.polarity,
    ageMinutes: Math.round(hoursBetween(new Date(primary.timestamp), new Date()) * 60),
    affectsCluster: primary.catalyst?.affectsCluster || false,
  };
}
