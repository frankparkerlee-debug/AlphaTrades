import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function seed() {
  const client = await pool.connect();
  try {
    console.log('Starting seed...');
    await client.query('BEGIN');

    // ── CLUSTER DEFINITIONS ────────────────────────────
    const clusters = [
      { name: 'AI Infrastructure',       leader: 'NVDA', desc: 'NVDA leads AI chip moves. AMD, MRVL, ARM follow. AVGO follows on hyperscaler capex.',     min: 20, max: 75 },
      { name: 'Memory Cycle',             leader: 'MU',   desc: 'MU leads memory cycle. Moves on DRAM/NAND pricing, HBM demand.',                          min: 25, max: 70 },
      { name: 'Hyperscaler Capex',        leader: 'MSFT', desc: 'MSFT Azure capex signals benefit NVDA, AVGO, ANET. AMZN and GOOGL co-lead.',              min: 15, max: 50 },
      { name: 'Consumer Platform',        leader: 'AAPL', desc: 'AAPL leads consumer tech. MSFT, GOOGL, META follow on broad sentiment days.',             min: 30, max: 90 },
      { name: 'High Beta Momentum',       leader: 'TSLA', desc: 'TSLA idiosyncratic leader. PLTR, APP, SMCI follow on risk-on days only.',                 min: 20, max: 60 },
      { name: 'Semiconductor Equipment',  leader: 'AMAT', desc: 'AMAT leads equipment cycle. LRCX, KLAC, ONTO follow on capex cycle news.',               min: 25, max: 70 },
      { name: 'Software Cloud',           leader: 'NOW',  desc: 'NOW leads enterprise software. CRM, ORCL, WDAY, ADBE follow on SaaS sentiment.',         min: 40, max: 100 },
    ];

    const clusterIds = {};
    for (const c of clusters) {
      const res = await client.query(`
        INSERT INTO lc_v3.cluster_definitions
          (cluster_name, leader_ticker, description, avg_lag_min_min, avg_lag_max_min)
        VALUES ($1,$2,$3,$4,$5)
        ON CONFLICT DO NOTHING
        RETURNING cluster_id
      `, [c.name, c.leader, c.desc, c.min, c.max]);
      if (res.rows.length > 0) {
        clusterIds[c.leader] = res.rows[0].cluster_id;
        console.log(`  ✓ Cluster: ${c.name} (id=${res.rows[0].cluster_id})`);
      }
    }

    // Fetch all cluster IDs (handles re-runs)
    const allClusters = await client.query(`SELECT cluster_id, leader_ticker FROM lc_v3.cluster_definitions`);
    allClusters.rows.forEach(r => { clusterIds[r.leader_ticker] = r.cluster_id; });

    // ── CLUSTER FOLLOWERS ──────────────────────────────
    const followers = [
      { leader: 'NVDA', ticker: 'AMD',  corr: 0.82, lag: 30, rate: 0.78 },
      { leader: 'NVDA', ticker: 'MRVL', corr: 0.74, lag: 35, rate: 0.71 },
      { leader: 'NVDA', ticker: 'ARM',  corr: 0.71, lag: 40, rate: 0.65 },
      { leader: 'NVDA', ticker: 'AVGO', corr: 0.68, lag: 45, rate: 0.62 },
      { leader: 'NVDA', ticker: 'SMCI', corr: 0.65, lag: 50, rate: 0.58 },
      { leader: 'MU',   ticker: 'WDC',  corr: 0.71, lag: 35, rate: 0.68 },
      { leader: 'MU',   ticker: 'STX',  corr: 0.65, lag: 40, rate: 0.61 },
      { leader: 'MU',   ticker: 'MRVL', corr: 0.60, lag: 45, rate: 0.55 },
      { leader: 'MSFT', ticker: 'NVDA', corr: 0.78, lag: 20, rate: 0.74 },
      { leader: 'MSFT', ticker: 'AVGO', corr: 0.70, lag: 25, rate: 0.68 },
      { leader: 'MSFT', ticker: 'ANET', corr: 0.65, lag: 30, rate: 0.61 },
      { leader: 'MSFT', ticker: 'AMZN', corr: 0.60, lag: 20, rate: 0.58 },
      { leader: 'MSFT', ticker: 'GOOGL',corr: 0.58, lag: 20, rate: 0.55 },
      { leader: 'AAPL', ticker: 'MSFT', corr: 0.72, lag: 35, rate: 0.65 },
      { leader: 'AAPL', ticker: 'GOOGL',corr: 0.68, lag: 40, rate: 0.61 },
      { leader: 'AAPL', ticker: 'META', corr: 0.61, lag: 45, rate: 0.55 },
      { leader: 'TSLA', ticker: 'PLTR', corr: 0.58, lag: 25, rate: 0.52 },
      { leader: 'TSLA', ticker: 'APP',  corr: 0.54, lag: 30, rate: 0.48 },
      { leader: 'TSLA', ticker: 'SMCI', corr: 0.51, lag: 35, rate: 0.45 },
      { leader: 'AMAT', ticker: 'LRCX', corr: 0.82, lag: 30, rate: 0.78 },
      { leader: 'AMAT', ticker: 'KLAC', corr: 0.79, lag: 30, rate: 0.75 },
      { leader: 'AMAT', ticker: 'ONTO', corr: 0.65, lag: 40, rate: 0.60 },
      { leader: 'NOW',  ticker: 'CRM',  corr: 0.72, lag: 45, rate: 0.65 },
      { leader: 'NOW',  ticker: 'ORCL', corr: 0.65, lag: 50, rate: 0.58 },
      { leader: 'NOW',  ticker: 'WDAY', corr: 0.68, lag: 45, rate: 0.62 },
      { leader: 'NOW',  ticker: 'ADBE', corr: 0.70, lag: 45, rate: 0.64 },
    ];

    for (const f of followers) {
      const cid = clusterIds[f.leader];
      if (!cid) continue;
      await client.query(`
        INSERT INTO lc_v3.cluster_followers
          (cluster_id, follower_ticker, avg_correlation, typical_lag_min, follow_rate)
        VALUES ($1,$2,$3,$4,$5)
        ON CONFLICT (cluster_id, follower_ticker) DO NOTHING
      `, [cid, f.ticker, f.corr, f.lag, f.rate]);
    }
    console.log(`  ✓ ${followers.length} cluster followers seeded`);

    // ── CATALYST MAP ───────────────────────────────────
    const catalysts = [
      // NVDA
      { ticker:'NVDA', type:'hyperscaler_capex',       kw:['capex','data center spend','gpu demand','blackwell','hopper','infrastructure spend'],      sens:2.1, decay:8.0,  cluster:true  },
      { ticker:'NVDA', type:'ai_chip_export_restriction',kw:['chip export','china ban','export control','commerce department','BIS rule','entity list'], sens:2.4, decay:24.0, cluster:false },
      { ticker:'NVDA', type:'ai_model_release',         kw:['gpt','claude','gemini','llm release','foundation model','ai model','training compute'],    sens:1.6, decay:4.0,  cluster:true  },
      { ticker:'NVDA', type:'earnings_beat',            kw:['beats','beat estimates','raised guidance','EPS beat','record revenue'],                    sens:1.8, decay:8.0,  cluster:true  },
      // MU
      { ticker:'MU',   type:'memory_pricing',           kw:['dram price','nand price','memory contract','spot price','memory pricing','dram contract'], sens:2.2, decay:12.0, cluster:true  },
      { ticker:'MU',   type:'hbm_demand',               kw:['hbm','high bandwidth memory','hbm3','ai memory','bandwidth demand','memory bandwidth'],   sens:2.0, decay:8.0,  cluster:true  },
      { ticker:'MU',   type:'earnings_beat',            kw:['beats','beat estimates','raised guidance','EPS beat'],                                     sens:1.9, decay:8.0,  cluster:true  },
      // TSLA
      { ticker:'TSLA', type:'delivery_numbers',         kw:['deliveries','production','q1 deliveries','q2 deliveries','model y','cybertruck','delivery miss','delivery beat'], sens:2.1, decay:6.0, cluster:false },
      { ticker:'TSLA', type:'elon_event',               kw:['elon','musk','doge','twitter','x.com','tesla ceo','elon musk'],                           sens:1.8, decay:3.0,  cluster:false },
      { ticker:'TSLA', type:'fsd_update',               kw:['fsd','full self driving','autonomy','robotaxi','dojo','autopilot'],                        sens:1.6, decay:5.0,  cluster:false },
      // AMD
      { ticker:'AMD',  type:'ai_accelerator',           kw:['mi300','mi350','instinct','ai accelerator','data center gpu','hyperscaler deal'],          sens:1.9, decay:6.0,  cluster:true  },
      { ticker:'AMD',  type:'cpu_share_gain',           kw:['epyc','server cpu','cpu share','intel loss','ryzen','cpu market'],                         sens:1.5, decay:8.0,  cluster:false },
      // AAPL
      { ticker:'AAPL', type:'iphone_cycle',             kw:['iphone','supply chain','foxconn','tsmc yield','iphone 17','upgrade cycle'],                sens:1.7, decay:8.0,  cluster:true  },
      { ticker:'AAPL', type:'services_growth',          kw:['app store','services revenue','apple intelligence','apple tv','subscription'],             sens:1.5, decay:6.0,  cluster:false },
      // META
      { ticker:'META', type:'ad_revenue',               kw:['ad revenue','cpm','advertiser','reels','engagement','instagram','facebook ads'],           sens:1.9, decay:6.0,  cluster:false },
      { ticker:'META', type:'ai_capex',                 kw:['meta ai','llama','ai investment','data center','capex guidance'],                          sens:1.7, decay:8.0,  cluster:true  },
      // MSFT
      { ticker:'MSFT', type:'azure_growth',             kw:['azure','cloud growth','copilot','ai revenue','office 365','commercial cloud'],             sens:1.8, decay:8.0,  cluster:true  },
      { ticker:'MSFT', type:'openai_news',              kw:['openai','chatgpt','gpt-5','microsoft openai','copilot update'],                            sens:1.6, decay:4.0,  cluster:true  },
      // GOOGL
      { ticker:'GOOGL',type:'search_revenue',           kw:['search revenue','google search','ad revenue','youtube','search market'],                   sens:1.7, decay:6.0,  cluster:false },
      { ticker:'GOOGL',type:'cloud_growth',             kw:['google cloud','gcp','cloud revenue','gemini','vertex ai'],                                 sens:1.8, decay:8.0,  cluster:true  },
      // AMAT
      { ticker:'AMAT', type:'fab_capex',                kw:['wafer start','fab equipment','capex cycle','semiconductor equipment','tsmc capex','intel fab'], sens:1.7, decay:12.0, cluster:true },
      // Universal
      { ticker:'*',    type:'macro_rate_cut',           kw:['rate cut','fed cut','lower rates','dovish','rate reduction'],                              sens:1.2, decay:6.0,  cluster:false },
      { ticker:'*',    type:'macro_rate_hike',          kw:['rate hike','rate increase','hawkish','tighten','higher for longer'],                       sens:1.3, decay:6.0,  cluster:false },
      { ticker:'*',    type:'macro_cpi',                kw:['cpi','inflation report','consumer price','core inflation'],                                sens:1.4, decay:4.0,  cluster:false },
      { ticker:'*',    type:'macro_fomc',               kw:['fomc','federal reserve','powell','fed decision','monetary policy'],                        sens:1.5, decay:6.0,  cluster:false },
    ];

    for (const c of catalysts) {
      await client.query(`
        INSERT INTO lc_v3.catalyst_map
          (ticker, catalyst_type, keywords, sensitivity, decay_hours, affects_cluster)
        VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT (ticker, catalyst_type) DO UPDATE SET
          keywords=EXCLUDED.keywords, sensitivity=EXCLUDED.sensitivity,
          decay_hours=EXCLUDED.decay_hours, affects_cluster=EXCLUDED.affects_cluster
      `, [c.ticker, c.type, JSON.stringify(c.kw), c.sens, c.decay, c.cluster]);
    }
    console.log(`  ✓ ${catalysts.length} catalyst entries seeded`);

    // ── EQUITY PROFILES — Initial static values ────────
    const profiles = [
      // ticker, name, exchange, exch_etf, sector_etf, role, chop, persist, h_cap, h_exp, h_mem, h_hbm, h_earn, h_upg, fade, liq, cluster_leader
      ['NVDA','NVIDIA Corp',          'NASDAQ','QQQ','SMH','LEADER',  22,0.82,2.1,2.4,1.0,1.4,1.8,0.95,0.42,0.98,'NVDA'],
      ['AMD', 'Advanced Micro Devices','NASDAQ','QQQ','SMH','FOLLOWER',20,0.76,1.6,1.8,1.0,1.2,1.5,1.10,0.38,0.95,'NVDA'],
      ['MU',  'Micron Technology',    'NASDAQ','QQQ','SMH','LEADER',  18,0.74,1.2,1.4,2.2,2.0,1.9,1.20,0.35,0.92,'MU'],
      ['AVGO','Broadcom',             'NASDAQ','QQQ','SMH','FOLLOWER',16,0.78,1.8,1.5,1.0,1.6,1.6,1.00,0.32,0.94,'NVDA'],
      ['MRVL','Marvell Technology',   'NASDAQ','QQQ','SMH','FOLLOWER',16,0.72,1.5,1.3,1.4,1.7,1.5,1.15,0.38,0.88,'NVDA'],
      ['ARM', 'Arm Holdings',         'NASDAQ','QQQ','SMH','FOLLOWER',18,0.70,1.7,1.6,1.0,1.3,1.6,1.10,0.40,0.85,'NVDA'],
      ['AAPL','Apple',                'NASDAQ','QQQ','XLK','LEADER',  14,0.85,1.3,0.8,1.0,1.0,1.2,0.92,0.28,0.99,'AAPL'],
      ['MSFT','Microsoft',            'NASDAQ','QQQ','XLK','LEADER',  14,0.87,1.8,0.9,1.0,1.0,1.1,0.75,0.25,0.99,'MSFT'],
      ['GOOGL','Alphabet',            'NASDAQ','QQQ','XLK','FOLLOWER',15,0.81,1.5,0.9,1.0,1.0,1.2,0.88,0.31,0.97,'AAPL'],
      ['META','Meta Platforms',       'NASDAQ','QQQ','XLK','FOLLOWER',16,0.79,1.3,0.8,1.0,1.0,1.5,1.28,0.35,0.96,'AAPL'],
      ['AMZN','Amazon',               'NASDAQ','QQQ','XLY','STANDALONE',17,0.78,1.6,0.9,1.0,1.0,1.3,1.05,0.40,0.98,'MSFT'],
      ['TSLA','Tesla',                'NASDAQ','QQQ','XLY','LEADER',  28,0.61,0.8,0.7,1.0,1.0,1.6,0.60,0.68,0.97,'TSLA'],
      ['NFLX','Netflix',              'NASDAQ','QQQ','XLC','STANDALONE',18,0.67,0.7,0.6,1.0,1.0,1.9,1.53,0.61,0.93,null],
      ['INTC','Intel',                'NASDAQ','QQQ','SMH','STANDALONE',16,0.58,1.2,1.4,1.3,1.1,1.4,1.12,0.52,0.90,null],
      ['QCOM','Qualcomm',             'NASDAQ','QQQ','SMH','STANDALONE',15,0.65,1.3,1.4,1.0,1.2,1.5,1.10,0.45,0.89,null],
      ['AMAT','Applied Materials',    'NASDAQ','QQQ','SMH','LEADER',  16,0.72,1.7,1.3,1.2,1.0,1.5,1.05,0.38,0.88,'AMAT'],
      ['LRCX','Lam Research',         'NASDAQ','QQQ','SMH','FOLLOWER',16,0.70,1.6,1.2,1.2,1.0,1.4,1.05,0.40,0.87,'AMAT'],
      ['ADBE','Adobe',                'NASDAQ','QQQ','XLK','FOLLOWER',16,0.71,1.2,0.8,1.0,1.0,1.6,1.10,0.42,0.91,'NOW'],
      ['CRM', 'Salesforce',           'NYSE', 'QQQ','XLK','FOLLOWER',18,0.68,1.2,0.8,1.0,1.0,1.5,1.10,0.44,0.90,'NOW'],
      ['NOW', 'ServiceNow',           'NYSE', 'QQQ','XLK','LEADER',  17,0.74,1.3,0.8,1.0,1.0,1.7,1.15,0.40,0.89,'NOW'],
    ];

    for (const p of profiles) {
      const [ticker, name, exchange, exch_etf, sector_etf, role, chop, persist,
             hcap, hexp, hmem, hhbm, hearn, hupg, fade, liq, clusterLeader] = p;
      const clusterId = clusterLeader ? clusterIds[clusterLeader] : null;

      await client.query(`
        INSERT INTO lc_v3.equity_profiles (
          ticker, company_name, exchange, exchange_etf, sector_etf,
          cluster_id, cluster_role, opening_chop_minutes, momentum_persistence,
          sens_hyperscaler_capex, sens_export_restriction, sens_memory_pricing,
          sens_hbm_demand, sens_earnings_beat, sens_analyst_upgrade,
          news_fade_rate, options_liquidity_score
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
        ON CONFLICT (ticker) DO UPDATE SET
          company_name=EXCLUDED.company_name, exchange=EXCLUDED.exchange,
          exchange_etf=EXCLUDED.exchange_etf, sector_etf=EXCLUDED.sector_etf,
          cluster_id=EXCLUDED.cluster_id, cluster_role=EXCLUDED.cluster_role,
          opening_chop_minutes=EXCLUDED.opening_chop_minutes,
          momentum_persistence=EXCLUDED.momentum_persistence,
          sens_hyperscaler_capex=EXCLUDED.sens_hyperscaler_capex,
          sens_export_restriction=EXCLUDED.sens_export_restriction,
          sens_memory_pricing=EXCLUDED.sens_memory_pricing,
          news_fade_rate=EXCLUDED.news_fade_rate,
          options_liquidity_score=EXCLUDED.options_liquidity_score
      `, [ticker, name, exchange, exch_etf, sector_etf,
          clusterId, role, chop, persist,
          hcap, hexp, hmem, hhbm, hearn, hupg, fade, liq]);
    }
    console.log(`  ✓ ${profiles.length} equity profiles seeded`);

    await client.query('COMMIT');
    console.log('\n✅ Seed complete');
    console.log('Next: run npm run update-profiles to seed volume baselines and ATR from Alpaca');

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Seed failed:', err.message);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

seed().catch(err => {
  console.error(err);
  process.exit(1);
});
