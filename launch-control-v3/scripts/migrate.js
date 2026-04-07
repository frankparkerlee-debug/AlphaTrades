import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function migrate() {
  const client = await pool.connect();
  try {
    console.log('Starting migration...');
    await client.query('BEGIN');

    // ── SCHEMA ─────────────────────────────────────────
    await client.query(`CREATE SCHEMA IF NOT EXISTS lc_v3`);
    console.log('✓ Schema lc_v3 ready');

    // ── CLUSTER DEFINITIONS ────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS lc_v3.cluster_definitions (
        cluster_id        SERIAL PRIMARY KEY,
        cluster_name      VARCHAR(50) NOT NULL,
        leader_ticker     VARCHAR(10) NOT NULL,
        description       TEXT,
        avg_lag_min_min   INTEGER DEFAULT 15,
        avg_lag_max_min   INTEGER DEFAULT 60,
        active            BOOLEAN DEFAULT TRUE,
        created_at        TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    console.log('✓ cluster_definitions');

    // ── CLUSTER FOLLOWERS ──────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS lc_v3.cluster_followers (
        id                SERIAL PRIMARY KEY,
        cluster_id        INTEGER REFERENCES lc_v3.cluster_definitions(cluster_id),
        follower_ticker   VARCHAR(10) NOT NULL,
        avg_correlation   DECIMAL(4,3),
        typical_lag_min   INTEGER,
        follow_rate       DECIMAL(4,3),
        UNIQUE(cluster_id, follower_ticker)
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_v3_cf_cluster ON lc_v3.cluster_followers(cluster_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_v3_cf_ticker ON lc_v3.cluster_followers(follower_ticker)`);
    console.log('✓ cluster_followers');

    // ── CATALYST MAP ───────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS lc_v3.catalyst_map (
        id                SERIAL PRIMARY KEY,
        ticker            VARCHAR(10) NOT NULL,
        catalyst_type     VARCHAR(50) NOT NULL,
        keywords          JSONB NOT NULL,
        sensitivity       DECIMAL(4,3) NOT NULL,
        decay_hours       DECIMAL(4,1) NOT NULL,
        affects_cluster   BOOLEAN DEFAULT FALSE,
        notes             TEXT,
        UNIQUE(ticker, catalyst_type)
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_v3_cm_ticker ON lc_v3.catalyst_map(ticker)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_v3_cm_type ON lc_v3.catalyst_map(catalyst_type)`);
    console.log('✓ catalyst_map');

    // ── EQUITY PROFILES ────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS lc_v3.equity_profiles (
        ticker                    VARCHAR(10) PRIMARY KEY,
        company_name              VARCHAR(100),
        exchange                  VARCHAR(10),
        exchange_etf              VARCHAR(10),
        sector_etf                VARCHAR(10),
        cluster_id                INTEGER REFERENCES lc_v3.cluster_definitions(cluster_id),
        cluster_role              VARCHAR(10),

        atr_20d                   DECIMAL(6,4),
        atr_5d                    DECIMAL(6,4),
        avg_daily_range_pct       DECIMAL(6,4),

        avg_vol_by_window         JSONB NOT NULL DEFAULT '{}',
        vol_to_move_correlation   DECIMAL(4,3),
        panic_vol_threshold       DECIMAL(5,2),

        beta_qqq                  DECIMAL(4,3),
        beta_spy                  DECIMAL(4,3),
        sector_etf_correlation    DECIMAL(4,3),
        exchange_etf_correlation  DECIMAL(4,3),
        alignment_followthru_rate DECIMAL(4,3),

        opening_chop_minutes      INTEGER DEFAULT 15,
        best_windows              JSONB DEFAULT '[]',
        worst_windows             JSONB DEFAULT '[]',
        post_fomc_quality         DECIMAL(4,3) DEFAULT 0.75,
        post_cpi_quality          DECIMAL(4,3) DEFAULT 0.75,

        momentum_persistence      DECIMAL(4,3) DEFAULT 0.70,
        mean_reversion_speed      DECIMAL(4,3) DEFAULT 0.50,
        options_liquidity_score   DECIMAL(4,3) DEFAULT 0.70,

        sens_earnings_beat        DECIMAL(4,3) DEFAULT 1.0,
        sens_earnings_miss        DECIMAL(4,3) DEFAULT 1.0,
        sens_analyst_upgrade      DECIMAL(4,3) DEFAULT 1.0,
        sens_analyst_downgrade    DECIMAL(4,3) DEFAULT 1.0,
        sens_hyperscaler_capex    DECIMAL(4,3) DEFAULT 1.0,
        sens_export_restriction   DECIMAL(4,3) DEFAULT 1.0,
        sens_memory_pricing       DECIMAL(4,3) DEFAULT 1.0,
        sens_product_launch       DECIMAL(4,3) DEFAULT 1.0,
        sens_macro_bullish        DECIMAL(4,3) DEFAULT 1.0,
        sens_macro_bearish        DECIMAL(4,3) DEFAULT 1.0,
        sens_regulatory           DECIMAL(4,3) DEFAULT 1.0,
        sens_executive_departure  DECIMAL(4,3) DEFAULT 1.0,
        news_fade_rate            DECIMAL(4,3) DEFAULT 0.40,

        last_updated              TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_v3_ep_cluster ON lc_v3.equity_profiles(cluster_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_v3_ep_exchange ON lc_v3.equity_profiles(exchange)`);
    console.log('✓ equity_profiles');

    // ── SIGNALS ────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS lc_v3.signals (
        signal_id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        created_at              TIMESTAMPTZ DEFAULT NOW(),
        expires_at              TIMESTAMPTZ,
        status                  VARCHAR(16) DEFAULT 'ACTIVE',

        ticker                  VARCHAR(10) NOT NULL,
        direction               VARCHAR(4) NOT NULL,
        signal_tier             VARCHAR(12) DEFAULT 'primary',

        composite_raw           INTEGER NOT NULL CHECK (composite_raw >= 0),
        grade                   VARCHAR(3) NOT NULL,
        grade_capped            BOOLEAN DEFAULT FALSE,
        cap_reason              VARCHAR(64),
        post_announcement_bonus INTEGER DEFAULT 0,

        score_timing            INTEGER,
        score_price_action      INTEGER,
        score_volume            INTEGER,
        score_news              INTEGER,
        score_market            INTEGER,

        price_at_signal         DECIMAL(10,2),
        vwap_at_signal          DECIMAL(10,2),
        atr_multiple            DECIMAL(5,3),
        relative_volume         DECIMAL(5,2),
        spy_change_pct          DECIMAL(6,4),
        qqq_change_pct          DECIMAL(6,4),
        sector_change_pct       DECIMAL(6,4),
        exchange_etf_change_pct DECIMAL(6,4),
        vix_at_signal           DECIMAL(5,2),

        news_headline           TEXT,
        news_catalyst_type      VARCHAR(50),
        news_polarity           INTEGER,
        news_age_minutes        INTEGER,
        news_stack_count        INTEGER DEFAULT 1,
        news_stack_bonus        DECIMAL(5,2) DEFAULT 0,

        cluster_id              INTEGER REFERENCES lc_v3.cluster_definitions(cluster_id),
        cluster_context         VARCHAR(12),
        leader_ticker           VARCHAR(10),
        leader_move_pct         DECIMAL(6,4),
        propagation_lag_min     INTEGER,
        confluence_score        INTEGER DEFAULT 0,

        flags                   JSONB DEFAULT '[]',
        conflict_detected       BOOLEAN DEFAULT FALSE,

        position_size_pct       DECIMAL(4,3),
        position_size_dollars   DECIMAL(10,2),

        human_taken             BOOLEAN,
        human_skip_reason       TEXT,
        human_entry_price       DECIMAL(10,2),
        human_exit_price        DECIMAL(10,2),
        human_pnl_pct           DECIMAL(7,4),
        human_notes             TEXT,

        strategy                VARCHAR(50)
      )
    `);
    // Backfill: ADD COLUMN IF NOT EXISTS for DBs created before strategy column was added
    await client.query(`ALTER TABLE lc_v3.signals ADD COLUMN IF NOT EXISTS strategy VARCHAR(50)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_v3_sig_ticker ON lc_v3.signals(ticker)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_v3_sig_created ON lc_v3.signals(created_at DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_v3_sig_grade ON lc_v3.signals(grade)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_v3_sig_status ON lc_v3.signals(status)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_v3_sig_cluster ON lc_v3.signals(cluster_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_v3_sig_tier ON lc_v3.signals(signal_tier)`);
    console.log('✓ signals');

    // ── PROPAGATION EVENTS ─────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS lc_v3.propagation_events (
        event_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        created_at        TIMESTAMPTZ DEFAULT NOW(),
        cluster_id        INTEGER REFERENCES lc_v3.cluster_definitions(cluster_id),
        leader_ticker     VARCHAR(10) NOT NULL,
        leader_signal_id  UUID REFERENCES lc_v3.signals(signal_id),
        leader_move_pct   DECIMAL(6,4),
        leader_grade      VARCHAR(3),
        leader_direction  VARCHAR(4),
        window_open_at    TIMESTAMPTZ NOT NULL,
        window_close_at   TIMESTAMPTZ NOT NULL,
        status            VARCHAR(12) DEFAULT 'OPEN',
        followers_alerted JSONB DEFAULT '[]',
        followers_taken   JSONB DEFAULT '[]'
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_v3_pe_cluster ON lc_v3.propagation_events(cluster_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_v3_pe_status ON lc_v3.propagation_events(status)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_v3_pe_created ON lc_v3.propagation_events(created_at DESC)`);
    console.log('✓ propagation_events');

    // ── DAILY SUMMARY ──────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS lc_v3.daily_summary (
        date                DATE PRIMARY KEY,
        total_signals       INTEGER DEFAULT 0,
        primary_signals     INTEGER DEFAULT 0,
        propagation_signals INTEGER DEFAULT 0,
        base_layer_signals  INTEGER DEFAULT 0,
        confluence_signals  INTEGER DEFAULT 0,
        signals_taken       INTEGER DEFAULT 0,
        signals_skipped     INTEGER DEFAULT 0,
        wins                INTEGER DEFAULT 0,
        losses              INTEGER DEFAULT 0,
        gross_pnl_pct       DECIMAL(8,4),
        net_pnl_pct         DECIMAL(8,4),
        account_start       DECIMAL(12,2),
        account_end         DECIMAL(12,2),
        top_signal_ticker   VARCHAR(10),
        top_signal_grade    VARCHAR(3),
        market_regime       VARCHAR(20),
        notes               TEXT,
        created_at          TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    console.log('✓ daily_summary');

    // ── PREMARKET BRIEFING ─────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS lc_v3.premarket_briefing (
        date              DATE PRIMARY KEY,
        flagged_tickers   JSONB DEFAULT '[]',
        macro_events      JSONB DEFAULT '[]',
        market_bias       VARCHAR(10),
        notes             TEXT,
        created_at        TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    console.log('✓ premarket_briefing');

    await client.query('COMMIT');
    console.log('\n✅ Migration complete — all lc_v3 tables created');

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Migration failed:', err.message);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch(err => {
  console.error(err);
  process.exit(1);
});
