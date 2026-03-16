"""
Data science analysis on stored bar data.
Connects to DATABASE_URL from .env via psycopg2.

Run: python3 analysis/data_science.py
"""

import os
import sys
from dotenv import load_dotenv
import psycopg2
from psycopg2.extras import RealDictCursor

load_dotenv(os.path.join(os.path.dirname(__file__), '..', '.env'))

DATABASE_URL = os.environ.get('DATABASE_URL')
if not DATABASE_URL:
    print('ERROR: DATABASE_URL not set in .env')
    sys.exit(1)

conn = psycopg2.connect(DATABASE_URL, sslmode='require')
cur = conn.cursor(cursor_factory=RealDictCursor)


# ─────────────────────────────────────────────────────────────────────────────
# 1) AUTOCORRELATION — does bar direction predict next bar direction?
# ─────────────────────────────────────────────────────────────────────────────
def autocorrelation():
    print('=' * 70)
    print('1) BAR-TO-BAR AUTOCORRELATION (regular hours)')
    print('=' * 70)

    cur.execute("""
        WITH ordered AS (
            SELECT ticker, ts, open, close,
                   LEAD(open)  OVER w AS next_open,
                   LEAD(close) OVER w AS next_close,
                   EXTRACT(HOUR FROM ts AT TIME ZONE 'America/New_York') AS et_hour,
                   EXTRACT(MINUTE FROM ts AT TIME ZONE 'America/New_York') AS et_min
            FROM lc_v3.bars
            WHERE session = 'REGULAR'
            WINDOW w AS (PARTITION BY ticker, DATE(ts) ORDER BY ts)
        )
        SELECT
            et_hour, et_min,
            CASE WHEN close > open THEN 1 ELSE 0 END AS bullish,
            CASE WHEN next_close > next_open THEN 1 ELSE 0 END AS next_bullish,
            CASE WHEN close > open AND next_close > next_open THEN 1
                 WHEN close <= open AND next_close <= open THEN 1
                 ELSE 0 END AS match
        FROM ordered
        WHERE next_close IS NOT NULL
    """)
    rows = cur.fetchall()

    total = len(rows)
    matches = sum(1 for r in rows if r['match'] == 1)
    print(f'\nOverall: {matches}/{total} = {matches/total*100:.1f}% match rate')

    # Bucket by 30-min window
    buckets = {}
    for r in rows:
        h = int(r['et_hour'])
        m = int(r['et_min'])
        slot = f"{h:02d}:{(m // 30) * 30:02d}"
        if slot not in buckets:
            buckets[slot] = {'total': 0, 'match': 0}
        buckets[slot]['total'] += 1
        buckets[slot]['match'] += r['match']

    print(f'\n{"Window":<10} {"Pairs":>8} {"Match":>8} {"Rate":>8}')
    print('-' * 38)
    for slot in sorted(buckets.keys()):
        b = buckets[slot]
        rate = b['match'] / b['total'] * 100 if b['total'] else 0
        print(f'{slot:<10} {b["total"]:>8,} {b["match"]:>8,} {rate:>7.1f}%')
    print()


# ─────────────────────────────────────────────────────────────────────────────
# 2) VOLUME SPIKE ANALYSIS — bars with volume > 2x baseline
# ─────────────────────────────────────────────────────────────────────────────
def volume_spikes():
    print('=' * 70)
    print('2) VOLUME SPIKE ANALYSIS (>2x window baseline)')
    print('=' * 70)

    # Get baselines into a dict
    cur.execute("SELECT ticker, window_key, avg_volume FROM lc_v3.volume_baselines")
    baselines = {}
    for r in cur.fetchall():
        baselines[(r['ticker'], r['window_key'])] = int(r['avg_volume'])

    # Get all regular-session bars with their window_key and future prices
    cur.execute("""
        WITH bars_with_future AS (
            SELECT b.ticker, b.ts, b.open, b.close, b.volume, b.vwap, b.window_key,
                   -- prices at various horizons (use subquery for exact minute)
                   (SELECT b2.close FROM lc_v3.bars b2
                    WHERE b2.ticker = b.ticker AND b2.ts = b.ts + interval '15 minutes'
                    LIMIT 1) AS price_15m,
                   (SELECT b2.close FROM lc_v3.bars b2
                    WHERE b2.ticker = b.ticker AND b2.ts = b.ts + interval '30 minutes'
                    LIMIT 1) AS price_30m,
                   (SELECT b2.close FROM lc_v3.bars b2
                    WHERE b2.ticker = b.ticker AND b2.ts = b.ts + interval '60 minutes'
                    LIMIT 1) AS price_60m
            FROM lc_v3.bars b
            WHERE b.session = 'REGULAR'
              AND b.volume > 0
        )
        SELECT * FROM bars_with_future
        WHERE price_15m IS NOT NULL
    """)
    rows = cur.fetchall()

    # Filter to volume spikes (> 2x baseline)
    spikes_bull = []
    spikes_bear = []
    for r in rows:
        bl = baselines.get((r['ticker'], r['window_key']), 0)
        if bl <= 0 or r['volume'] <= 2 * bl:
            continue
        entry = {
            'close': float(r['close']),
            'open': float(r['open']),
            'p15': float(r['price_15m']) if r['price_15m'] else None,
            'p30': float(r['price_30m']) if r['price_30m'] else None,
            'p60': float(r['price_60m']) if r['price_60m'] else None,
        }
        if r['close'] > r['open']:
            spikes_bull.append(entry)
        else:
            spikes_bear.append(entry)

    print(f'\nTotal volume spikes: {len(spikes_bull) + len(spikes_bear)}')
    print(f'  Bullish bars: {len(spikes_bull)}')
    print(f'  Bearish bars: {len(spikes_bear)}')

    def analyze_group(label, spikes):
        if not spikes:
            print(f'\n  {label}: no data')
            return
        print(f'\n  {label} ({len(spikes)} bars):')
        print(f'  {"Horizon":<10} {"Avg Chg%":>10} {"Dir Correct":>12} {"Accuracy":>10}')
        print(f'  {"-"*44}')
        for horizon, key in [('15min', 'p15'), ('30min', 'p30'), ('60min', 'p60')]:
            valid = [s for s in spikes if s[key] is not None]
            if not valid:
                continue
            changes = [(s[key] - s['close']) / s['close'] * 100 for s in valid]
            avg_chg = sum(changes) / len(changes)
            if label == 'BULLISH':
                correct = sum(1 for c in changes if c > 0)
            else:
                correct = sum(1 for c in changes if c < 0)
            acc = correct / len(valid) * 100
            print(f'  {horizon:<10} {avg_chg:>+9.3f}% {correct:>5}/{len(valid):<5} {acc:>8.1f}%')

    analyze_group('BULLISH', spikes_bull)
    analyze_group('BEARISH', spikes_bear)
    print()


# ─────────────────────────────────────────────────────────────────────────────
# 3) VWAP DISTANCE — mean reversion probability by distance from VWAP
# ─────────────────────────────────────────────────────────────────────────────
def vwap_distance():
    print('=' * 70)
    print('3) VWAP DISTANCE — MEAN REVERSION PROBABILITY (30min)')
    print('=' * 70)

    cur.execute("""
        SELECT b.ticker, b.ts, b.close, b.vwap,
               (SELECT b2.close FROM lc_v3.bars b2
                WHERE b2.ticker = b.ticker AND b2.ts = b.ts + interval '30 minutes'
                LIMIT 1) AS price_30m
        FROM lc_v3.bars b
        WHERE b.session = 'REGULAR'
          AND b.vwap IS NOT NULL
          AND b.vwap > 0
    """)
    rows = cur.fetchall()

    buckets = {
        '0-0.25%':   {'total': 0, 'reverted': 0},
        '0.25-0.5%': {'total': 0, 'reverted': 0},
        '0.5-1.0%':  {'total': 0, 'reverted': 0},
        '1.0%+':     {'total': 0, 'reverted': 0},
    }

    for r in rows:
        if r['price_30m'] is None:
            continue
        close = float(r['close'])
        vwap = float(r['vwap'])
        future = float(r['price_30m'])

        dist_pct = abs(close - vwap) / vwap * 100

        if dist_pct < 0.25:
            bucket = '0-0.25%'
        elif dist_pct < 0.5:
            bucket = '0.25-0.5%'
        elif dist_pct < 1.0:
            bucket = '0.5-1.0%'
        else:
            bucket = '1.0%+'

        buckets[bucket]['total'] += 1

        # Did price move toward VWAP?
        if close > vwap:
            # Price is above VWAP — reversion means price went down
            if future < close:
                buckets[bucket]['reverted'] += 1
        else:
            # Price is below VWAP — reversion means price went up
            if future > close:
                buckets[bucket]['reverted'] += 1

    print(f'\n{"Distance":<12} {"Bars":>10} {"Reverted":>10} {"Reversion%":>12}')
    print('-' * 46)
    for label in ['0-0.25%', '0.25-0.5%', '0.5-1.0%', '1.0%+']:
        b = buckets[label]
        rate = b['reverted'] / b['total'] * 100 if b['total'] else 0
        print(f'{label:<12} {b["total"]:>10,} {b["reverted"]:>10,} {rate:>11.1f}%')
    print()


# ─────────────────────────────────────────────────────────────────────────────
# 4) SIGNAL vs RAW MOMENTUM — does the signal direction agree with bar momentum?
# ─────────────────────────────────────────────────────────────────────────────
def signal_vs_momentum():
    print('=' * 70)
    print('4) SIGNAL DIRECTION vs RAW BAR MOMENTUM')
    print('=' * 70)

    # Get all signals with their direction and time
    cur.execute("""
        SELECT s.ticker, s.direction, s.created_at,
               -- Find the bar closest to signal time (within 2 min)
               b.ts AS bar_ts, b.open AS bar_open, b.close AS bar_close,
               -- Future prices
               (SELECT b2.close FROM lc_v3.bars b2
                WHERE b2.ticker = s.ticker AND b2.ts BETWEEN b.ts + interval '28 minutes' AND b.ts + interval '32 minutes'
                ORDER BY b2.ts LIMIT 1) AS price_30m,
               (SELECT b2.close FROM lc_v3.bars b2
                WHERE b2.ticker = s.ticker AND b2.ts BETWEEN b.ts + interval '58 minutes' AND b.ts + interval '62 minutes'
                ORDER BY b2.ts LIMIT 1) AS price_60m
        FROM lc_v3.signals s
        JOIN lc_v3.bars b ON b.ticker = s.ticker
            AND b.ts BETWEEN s.created_at - interval '2 minutes' AND s.created_at + interval '2 minutes'
            AND b.session = 'REGULAR'
        ORDER BY s.created_at
    """)
    rows = cur.fetchall()

    total = len(rows)
    if total == 0:
        print('\n  No signal/bar matches found.')
        return

    agree = 0
    disagree_signal_right_30 = 0
    disagree_momentum_right_30 = 0
    disagree_neither_30 = 0
    disagree_signal_right_60 = 0
    disagree_momentum_right_60 = 0
    disagree_neither_60 = 0
    disagree_total = 0
    has_30m = 0
    has_60m = 0

    for r in rows:
        bar_open = float(r['bar_open'])
        bar_close = float(r['bar_close'])
        direction = r['direction']  # 'CALL' or 'PUT'

        # Raw bar momentum direction
        bar_bullish = bar_close > bar_open

        # Signal says CALL (bullish) or PUT (bearish)
        signal_bullish = direction == 'CALL'

        if signal_bullish == bar_bullish:
            agree += 1
            continue

        # They disagree
        disagree_total += 1

        # Check who was right at 30m
        if r['price_30m'] is not None:
            has_30m += 1
            future_30 = float(r['price_30m'])
            price_went_up_30 = future_30 > bar_close

            signal_correct_30 = (signal_bullish and price_went_up_30) or (not signal_bullish and not price_went_up_30)
            momentum_correct_30 = (bar_bullish and price_went_up_30) or (not bar_bullish and not price_went_up_30)

            if signal_correct_30 and not momentum_correct_30:
                disagree_signal_right_30 += 1
            elif momentum_correct_30 and not signal_correct_30:
                disagree_momentum_right_30 += 1
            else:
                disagree_neither_30 += 1  # both right or both wrong (flat)

        # Check who was right at 60m
        if r['price_60m'] is not None:
            has_60m += 1
            future_60 = float(r['price_60m'])
            price_went_up_60 = future_60 > bar_close

            signal_correct_60 = (signal_bullish and price_went_up_60) or (not signal_bullish and not price_went_up_60)
            momentum_correct_60 = (bar_bullish and price_went_up_60) or (not bar_bullish and not price_went_up_60)

            if signal_correct_60 and not momentum_correct_60:
                disagree_signal_right_60 += 1
            elif momentum_correct_60 and not signal_correct_60:
                disagree_momentum_right_60 += 1
            else:
                disagree_neither_60 += 1

    print(f'\n  Total signal/bar pairs: {total}')
    print(f'  Signal agrees with bar momentum: {agree}/{total} = {agree/total*100:.1f}%')
    print(f'  Signal disagrees with bar momentum: {disagree_total}/{total} = {disagree_total/total*100:.1f}%')

    if disagree_total > 0:
        print(f'\n  When they DISAGREE ({disagree_total} cases):')
        if has_30m > 0:
            print(f'\n    At 30 minutes ({has_30m} with data):')
            print(f'      Signal was right:   {disagree_signal_right_30:>5} = {disagree_signal_right_30/has_30m*100:.1f}%')
            print(f'      Momentum was right: {disagree_momentum_right_30:>5} = {disagree_momentum_right_30/has_30m*100:.1f}%')
            print(f'      Neither/flat:       {disagree_neither_30:>5} = {disagree_neither_30/has_30m*100:.1f}%')
        if has_60m > 0:
            print(f'\n    At 60 minutes ({has_60m} with data):')
            print(f'      Signal was right:   {disagree_signal_right_60:>5} = {disagree_signal_right_60/has_60m*100:.1f}%')
            print(f'      Momentum was right: {disagree_momentum_right_60:>5} = {disagree_momentum_right_60/has_60m*100:.1f}%')
            print(f'      Neither/flat:       {disagree_neither_60:>5} = {disagree_neither_60/has_60m*100:.1f}%')
    print()


# ─────────────────────────────────────────────────────────────────────────────
# 5) MOMENTUM CONTINUATION — what conditions push 2-bar momentum above 65%?
# ─────────────────────────────────────────────────────────────────────────────
def momentum_factors():
    print('=' * 70)
    print('5) MOMENTUM CONTINUATION BY FACTOR (2-bar agreement → 3rd bar)')
    print('=' * 70)

    cur.execute("""
        WITH ordered AS (
            SELECT ticker, ts, open, high, low, close, volume, vwap, window_key,
                   LAG(open)  OVER w AS prev_open,
                   LAG(close) OVER w AS prev_close,
                   LEAD(open)  OVER w AS next_open,
                   LEAD(close) OVER w AS next_close,
                   EXTRACT(HOUR FROM ts AT TIME ZONE 'America/New_York') AS et_hour,
                   EXTRACT(MINUTE FROM ts AT TIME ZONE 'America/New_York') AS et_min,
                   -- session open = first bar's open for this ticker+day
                   FIRST_VALUE(open) OVER (PARTITION BY ticker, DATE(ts) ORDER BY ts) AS session_open
            FROM lc_v3.bars
            WHERE session = 'REGULAR'
            WINDOW w AS (PARTITION BY ticker, DATE(ts) ORDER BY ts)
        )
        SELECT *
        FROM ordered
        WHERE prev_close IS NOT NULL
          AND next_close IS NOT NULL
          AND close != open
          AND prev_close != prev_open
    """)
    rows = cur.fetchall()

    # Load baselines
    cur.execute("SELECT ticker, window_key, avg_volume FROM lc_v3.volume_baselines")
    baselines = {}
    for r in cur.fetchall():
        baselines[(r['ticker'], r['window_key'])] = float(r['avg_volume'])

    # Filter to 2-bar momentum agreement
    momentum_rows = []
    for r in rows:
        curr_bull = float(r['close']) > float(r['open'])
        prev_bull = float(r['prev_close']) > float(r['prev_open'])
        if curr_bull != prev_bull:
            continue  # no 2-bar agreement

        next_bull = float(r['next_close']) > float(r['next_open'])
        continued = (curr_bull == next_bull)

        bar_range = float(r['high']) - float(r['low'])
        bar_body = abs(float(r['close']) - float(r['open']))
        body_pct = bar_body / bar_range * 100 if bar_range > 0 else 0

        sess_open = float(r['session_open']) if r['session_open'] else 0
        dist_from_open = abs(float(r['close']) - sess_open) / sess_open * 100 if sess_open > 0 else 0

        vol = int(r['volume']) if r['volume'] else 0
        bl = baselines.get((r['ticker'], r['window_key']), 0)
        if bl > 0:
            rel_vol = vol / bl
        else:
            rel_vol = None

        h = int(r['et_hour'])
        m = int(r['et_min'])
        slot = f"{h:02d}:{(m // 30) * 30:02d}"

        momentum_rows.append({
            'continued': continued,
            'slot': slot,
            'rel_vol': rel_vol,
            'body_pct': body_pct,
            'dist_from_open': dist_from_open,
        })

    total = len(momentum_rows)
    cont = sum(1 for r in momentum_rows if r['continued'])
    print(f'\n  Bars with 2-bar momentum agreement: {total:,}')
    print(f'  Overall 3rd-bar continuation: {cont:,}/{total:,} = {cont/total*100:.1f}%')

    def show_buckets(label, key_fn, bucket_order=None):
        buckets = {}
        for r in momentum_rows:
            k = key_fn(r)
            if k is None:
                continue
            if k not in buckets:
                buckets[k] = {'total': 0, 'cont': 0}
            buckets[k]['total'] += 1
            if r['continued']:
                buckets[k]['cont'] += 1

        keys = bucket_order if bucket_order else sorted(buckets.keys())
        print(f'\n  {label}')
        print(f'  {"Bucket":<20} {"Bars":>10} {"Continue":>10} {"Rate":>8}')
        print(f'  {"-"*50}')
        for k in keys:
            if k not in buckets:
                continue
            b = buckets[k]
            rate = b['cont'] / b['total'] * 100 if b['total'] else 0
            flag = ' <<<' if rate >= 65 else ''
            print(f'  {k:<20} {b["total"]:>10,} {b["cont"]:>10,} {rate:>7.1f}%{flag}')

    # 1) Time window
    show_buckets('BY TIME WINDOW', lambda r: r['slot'])

    # 2) Volume relative to baseline
    def vol_bucket(r):
        rv = r['rel_vol']
        if rv is None:
            return None
        if rv < 1.0:
            return 'Below baseline'
        elif rv < 2.0:
            return '1-2x baseline'
        else:
            return '2x+ baseline'
    show_buckets('BY VOLUME', vol_bucket, ['Below baseline', '1-2x baseline', '2x+ baseline'])

    # 3) Bar body size
    def body_bucket(r):
        bp = r['body_pct']
        if bp < 10:
            return 'Doji (<10%)'
        elif bp < 30:
            return 'Small (10-30%)'
        elif bp < 60:
            return 'Medium (30-60%)'
        else:
            return 'Large (60%+)'
    show_buckets('BY BAR BODY SIZE', body_bucket, ['Doji (<10%)', 'Small (10-30%)', 'Medium (30-60%)', 'Large (60%+)'])

    # 4) Distance from session open
    def dist_bucket(r):
        d = r['dist_from_open']
        if d < 0.5:
            return '<0.5%'
        elif d < 1.0:
            return '0.5-1%'
        elif d < 2.0:
            return '1-2%'
        else:
            return '2%+'
    show_buckets('BY DISTANCE FROM SESSION OPEN', dist_bucket, ['<0.5%', '0.5-1%', '1-2%', '2%+'])

    # Combo: show top combos that cross 65%
    print(f'\n  ── COMBO SCAN (minimum 500 bars, looking for >65%) ──')
    combos = {}
    for r in momentum_rows:
        vb = vol_bucket(r)
        bb = body_bucket(r)
        db = dist_bucket(r)
        if vb is None:
            continue
        key = f'{r["slot"]} | {vb} | {bb} | {db}'
        if key not in combos:
            combos[key] = {'total': 0, 'cont': 0}
        combos[key]['total'] += 1
        if r['continued']:
            combos[key]['cont'] += 1

    winners = []
    for k, v in combos.items():
        if v['total'] >= 500:
            rate = v['cont'] / v['total'] * 100
            if rate >= 65:
                winners.append((k, v['total'], v['cont'], rate))

    winners.sort(key=lambda x: -x[3])
    if winners:
        print(f'  {"Combo":<65} {"Bars":>8} {"Cont":>8} {"Rate":>7}')
        print(f'  {"-"*90}')
        for k, t, c, rate in winners[:20]:
            print(f'  {k:<65} {t:>8,} {c:>8,} {rate:>6.1f}%')
    else:
        print('  No combos with 500+ bars above 65%.')

    # Looser scan: 200+ bars
    print(f'\n  ── COMBO SCAN (minimum 200 bars, looking for >65%) ──')
    winners2 = []
    for k, v in combos.items():
        if v['total'] >= 200:
            rate = v['cont'] / v['total'] * 100
            if rate >= 65:
                winners2.append((k, v['total'], v['cont'], rate))
    winners2.sort(key=lambda x: -x[3])
    if winners2:
        print(f'  {"Combo":<65} {"Bars":>8} {"Cont":>8} {"Rate":>7}')
        print(f'  {"-"*90}')
        for k, t, c, rate in winners2[:20]:
            print(f'  {k:<65} {t:>8,} {c:>8,} {rate:>6.1f}%')
    else:
        print('  No combos with 200+ bars above 65%.')

    print()


# ─────────────────────────────────────────────────────────────────────────────
# 6) GAP PERSISTENCE — does the opening gap predict intraday direction?
# ─────────────────────────────────────────────────────────────────────────────
def gap_persistence():
    print('=' * 70)
    print('6) GAP PERSISTENCE — opening gap vs intraday follow-through')
    print('=' * 70)

    # Get daily open/close per ticker per day, plus prev day close
    cur.execute("""
        WITH daily AS (
            SELECT ticker, DATE(ts) AS day,
                   MIN(ts) AS first_ts,
                   (ARRAY_AGG(open ORDER BY ts))[1] AS day_open,
                   (ARRAY_AGG(close ORDER BY ts DESC))[1] AS day_close
            FROM lc_v3.bars
            WHERE session = 'REGULAR'
            GROUP BY ticker, DATE(ts)
        ),
        with_prev AS (
            SELECT d.*,
                   LAG(day_close) OVER (PARTITION BY ticker ORDER BY day) AS prev_close
            FROM daily d
        )
        SELECT * FROM with_prev WHERE prev_close IS NOT NULL
    """)
    daily_rows = {(r['ticker'], str(r['day'])): r for r in cur.fetchall()}

    # Get intraday checkpoints: price at 30min, 60min after open, and day close
    # We already have day_close. Need price at ~10:00 and ~10:30 ET (30/60 min after 9:30)
    cur.execute("""
        SELECT ticker, DATE(ts) AS day, ts, close,
               EXTRACT(HOUR FROM ts AT TIME ZONE 'America/New_York') AS et_hour,
               EXTRACT(MINUTE FROM ts AT TIME ZONE 'America/New_York') AS et_min
        FROM lc_v3.bars
        WHERE session = 'REGULAR'
        ORDER BY ticker, ts
    """)

    # Index: (ticker, day) -> list of (minutes_since_open, close)
    intraday = {}
    for r in cur.fetchall():
        h = int(r['et_hour'])
        m = int(r['et_min'])
        mins = h * 60 + m - 570  # minutes since 9:30
        key = (r['ticker'], str(r['day']))
        if key not in intraday:
            intraday[key] = {}
        intraday[key][mins] = float(r['close'])

    buckets_order = ['Gap < -2%', 'Gap -1% to -2%', 'Flat (±0.5%)', 'Gap +1% to +2%', 'Gap > +2%']
    horizons = [('30min', 30), ('60min', 60), ('EOD', None)]

    results = {b: {h[0]: {'total': 0, 'continued': 0, 'mag_sum': 0.0} for h in horizons} for b in buckets_order}

    for key, dr in daily_rows.items():
        ticker, day = key
        day_open = float(dr['day_open'])
        prev_close = float(dr['prev_close'])
        if prev_close == 0:
            continue

        gap_pct = (day_open - prev_close) / prev_close * 100

        if gap_pct < -2:
            bucket = 'Gap < -2%'
            gap_dir = -1
        elif gap_pct < -0.5:  # -2 to -0.5 → use -1 to -2 bucket (adjust threshold)
            if gap_pct < -1:
                bucket = 'Gap -1% to -2%'
            else:
                continue  # -0.5 to -1 not in a bucket, skip
            gap_dir = -1
        elif gap_pct <= 0.5:
            bucket = 'Flat (±0.5%)'
            gap_dir = 0
        elif gap_pct <= 1:
            continue  # 0.5 to 1 not in a bucket, skip
        elif gap_pct <= 2:
            bucket = 'Gap +1% to +2%'
            gap_dir = 1
        else:
            bucket = 'Gap > +2%'
            gap_dir = 1

        id_key = (ticker, day)
        if id_key not in intraday:
            continue

        bars = intraday[id_key]

        for label, target_min in horizons:
            if target_min is not None:
                # Find closest bar to target minutes
                price = None
                for offset in range(0, 4):
                    if target_min + offset in bars:
                        price = bars[target_min + offset]
                        break
                    if target_min - offset in bars:
                        price = bars[target_min - offset]
                        break
            else:
                # EOD = last bar
                if bars:
                    price = bars[max(bars.keys())]
                else:
                    price = None

            if price is None or day_open == 0:
                continue

            move_pct = (price - day_open) / day_open * 100

            results[bucket][label]['total'] += 1
            results[bucket][label]['mag_sum'] += move_pct

            if gap_dir == 0:
                continue  # no direction to test for flat gaps

            if (gap_dir > 0 and move_pct > 0) or (gap_dir < 0 and move_pct < 0):
                results[bucket][label]['continued'] += 1

    for bucket in buckets_order:
        print(f'\n  {bucket}')
        print(f'  {"Horizon":<10} {"Days":>8} {"Continued":>10} {"Cont%":>8} {"Avg Move":>10}')
        print(f'  {"-"*48}')
        for label, _ in horizons:
            d = results[bucket][label]
            if d['total'] == 0:
                continue
            rate = d['continued'] / d['total'] * 100 if bucket != 'Flat (±0.5%)' else 0
            avg_mag = d['mag_sum'] / d['total']
            rate_str = f'{rate:.1f}%' if bucket != 'Flat (±0.5%)' else 'n/a'
            print(f'  {label:<10} {d["total"]:>8,} {d["continued"] if bucket != "Flat (±0.5%)" else "":>10} {rate_str:>8} {avg_mag:>+9.3f}%')

    print()


# ─────────────────────────────────────────────────────────────────────────────
# 7) DAY-LEVEL MOMENTUM — does 61% autocorrelation come from trending days?
# ─────────────────────────────────────────────────────────────────────────────
def day_level_momentum():
    print('=' * 70)
    print('7) DAY-LEVEL MOMENTUM — trending vs choppy days')
    print('=' * 70)

    cur.execute("""
        SELECT ticker, DATE(ts) AS day, open, close,
               (ARRAY_AGG(open ORDER BY ts))[1] AS day_open,
               (ARRAY_AGG(close ORDER BY ts DESC))[1] AS day_close,
               COUNT(*) AS bar_count
        FROM lc_v3.bars
        WHERE session = 'REGULAR'
        GROUP BY ticker, DATE(ts), open, close
    """)
    # That groups wrong — need per-bar data within classified days

    # Step 1: classify days
    cur.execute("""
        WITH daily AS (
            SELECT ticker, DATE(ts) AS day,
                   (ARRAY_AGG(open ORDER BY ts))[1] AS day_open,
                   (ARRAY_AGG(close ORDER BY ts DESC))[1] AS day_close
            FROM lc_v3.bars
            WHERE session = 'REGULAR'
            GROUP BY ticker, DATE(ts)
        )
        SELECT ticker, day, day_open, day_close,
               CASE WHEN day_close > day_open * 1.005 THEN 'TREND_UP'
                    WHEN day_close < day_open * 0.995 THEN 'TREND_DOWN'
                    ELSE 'CHOPPY' END AS day_type
        FROM daily
        WHERE day_open > 0
    """)
    day_class = {}
    for r in cur.fetchall():
        day_class[(r['ticker'], str(r['day']))] = r['day_type']

    # Step 2: get all bars, tag with day type, compute bullish %
    cur.execute("""
        SELECT ticker, DATE(ts) AS day, open, close
        FROM lc_v3.bars
        WHERE session = 'REGULAR'
          AND open != close
    """)

    stats = {
        'TREND_UP':   {'total': 0, 'bullish': 0},
        'TREND_DOWN': {'total': 0, 'bullish': 0},
        'CHOPPY':     {'total': 0, 'bullish': 0},
    }

    # Also track bar-to-bar autocorrelation by day type
    # We'll need ordered bars for that — do a second query
    for r in cur.fetchall():
        dt = day_class.get((r['ticker'], str(r['day'])))
        if dt is None:
            continue
        stats[dt]['total'] += 1
        if float(r['close']) > float(r['open']):
            stats[dt]['bullish'] += 1

    print(f'\n  {"Day Type":<15} {"Bars":>10} {"Bullish":>10} {"Bull%":>8}')
    print(f'  {"-"*45}')
    for dt in ['TREND_UP', 'TREND_DOWN', 'CHOPPY']:
        s = stats[dt]
        rate = s['bullish'] / s['total'] * 100 if s['total'] else 0
        print(f'  {dt:<15} {s["total"]:>10,} {s["bullish"]:>10,} {rate:>7.1f}%')

    # Step 3: autocorrelation BY day type
    print(f'\n  Bar-to-bar autocorrelation by day type:')
    cur.execute("""
        WITH ordered AS (
            SELECT ticker, DATE(ts) AS day, open, close,
                   LEAD(open) OVER w AS next_open,
                   LEAD(close) OVER w AS next_close
            FROM lc_v3.bars
            WHERE session = 'REGULAR'
              AND open != close
            WINDOW w AS (PARTITION BY ticker, DATE(ts) ORDER BY ts)
        )
        SELECT ticker, day, open, close, next_open, next_close
        FROM ordered
        WHERE next_close IS NOT NULL AND next_open != next_close
    """)

    auto_stats = {
        'TREND_UP':   {'total': 0, 'match': 0},
        'TREND_DOWN': {'total': 0, 'match': 0},
        'CHOPPY':     {'total': 0, 'match': 0},
    }
    for r in cur.fetchall():
        dt = day_class.get((r['ticker'], str(r['day'])))
        if dt is None:
            continue
        curr_bull = float(r['close']) > float(r['open'])
        next_bull = float(r['next_close']) > float(r['next_open'])
        auto_stats[dt]['total'] += 1
        if curr_bull == next_bull:
            auto_stats[dt]['match'] += 1

    print(f'  {"Day Type":<15} {"Pairs":>10} {"Match":>10} {"AutoCorr%":>10}')
    print(f'  {"-"*47}')
    for dt in ['TREND_UP', 'TREND_DOWN', 'CHOPPY']:
        s = auto_stats[dt]
        rate = s['match'] / s['total'] * 100 if s['total'] else 0
        print(f'  {dt:<15} {s["total"]:>10,} {s["match"]:>10,} {rate:>9.1f}%')

    # Count day types
    type_counts = {}
    for v in day_class.values():
        type_counts[v] = type_counts.get(v, 0) + 1
    print(f'\n  Day counts: {type_counts}')
    print()


# ─────────────────────────────────────────────────────────────────────────────
# 8) MULTI-DAY MOMENTUM — does 3/5/10-day return predict next day?
# ─────────────────────────────────────────────────────────────────────────────
def multi_day_momentum():
    print('=' * 70)
    print('8) MULTI-DAY MOMENTUM — trailing returns vs next-day direction')
    print('=' * 70)

    # Build daily close series per ticker
    cur.execute("""
        SELECT ticker, DATE(ts) AS day,
               (ARRAY_AGG(close ORDER BY ts DESC))[1] AS day_close
        FROM lc_v3.bars
        WHERE session = 'REGULAR'
        GROUP BY ticker, DATE(ts)
        ORDER BY ticker, day
    """)

    by_ticker = {}
    for r in cur.fetchall():
        t = r['ticker']
        if t not in by_ticker:
            by_ticker[t] = []
        by_ticker[t].append({'day': str(r['day']), 'close': float(r['day_close'])})

    lookbacks = [3, 5, 10]
    # For each lookback, bucket trailing return into strong neg (<-3%), neg (-1 to -3%), flat, pos, strong pos (>3%)
    bucket_order = ['Strong neg (<-3%)', 'Neg (-1% to -3%)', 'Flat (±1%)', 'Pos (+1% to +3%)', 'Strong pos (>+3%)']

    for lb in lookbacks:
        buckets = {b: {'total': 0, 'next_up': 0, 'next_mag_sum': 0.0} for b in bucket_order}

        for ticker, days in by_ticker.items():
            for i in range(lb, len(days) - 1):
                prev_close = days[i - lb]['close']
                curr_close = days[i]['close']
                next_close = days[i + 1]['close']
                if prev_close == 0 or curr_close == 0:
                    continue

                trailing_ret = (curr_close - prev_close) / prev_close * 100
                next_ret = (next_close - curr_close) / curr_close * 100

                if trailing_ret < -3:
                    bucket = 'Strong neg (<-3%)'
                elif trailing_ret < -1:
                    bucket = 'Neg (-1% to -3%)'
                elif trailing_ret <= 1:
                    bucket = 'Flat (±1%)'
                elif trailing_ret <= 3:
                    bucket = 'Pos (+1% to +3%)'
                else:
                    bucket = 'Strong pos (>+3%)'

                buckets[bucket]['total'] += 1
                if next_ret > 0:
                    buckets[bucket]['next_up'] += 1
                buckets[bucket]['next_mag_sum'] += next_ret

        print(f'\n  {lb}-Day Trailing Return → Next Day')
        print(f'  {"Bucket":<25} {"Days":>8} {"Next Up":>8} {"Up%":>8} {"Avg Next":>10}')
        print(f'  {"-"*61}')
        for b in bucket_order:
            d = buckets[b]
            if d['total'] == 0:
                continue
            up_rate = d['next_up'] / d['total'] * 100
            avg_next = d['next_mag_sum'] / d['total']
            # For strong moves: does continuation or mean-reversion win?
            print(f'  {b:<25} {d["total"]:>8,} {d["next_up"]:>8,} {up_rate:>7.1f}% {avg_next:>+9.4f}%')

    print()


# ─────────────────────────────────────────────────────────────────────────────
# 9) GAP DOWN REVERSAL DEPTH — hourly recovery profile + first candle filter
# ─────────────────────────────────────────────────────────────────────────────
def gap_down_reversal():
    print('=' * 70)
    print('9) GAP DOWN REVERSAL DEPTH (gap >= -2%)')
    print('=' * 70)

    # Get daily open/prev_close and gap
    cur.execute("""
        WITH daily AS (
            SELECT ticker, DATE(ts) AS day,
                   (ARRAY_AGG(open ORDER BY ts))[1] AS day_open,
                   (ARRAY_AGG(close ORDER BY ts DESC))[1] AS day_close
            FROM lc_v3.bars
            WHERE session = 'REGULAR'
            GROUP BY ticker, DATE(ts)
        ),
        with_prev AS (
            SELECT d.*,
                   LAG(day_close) OVER (PARTITION BY ticker ORDER BY day) AS prev_close
            FROM daily d
        )
        SELECT * FROM with_prev
        WHERE prev_close IS NOT NULL
          AND (day_open - prev_close) / prev_close * 100 < -2
    """)
    gap_days = {(r['ticker'], str(r['day'])): r for r in cur.fetchall()}

    print(f'\n  Total gap-down days (>= -2%): {len(gap_days)}')

    # Get all intraday bars for these days
    cur.execute("""
        SELECT ticker, DATE(ts) AS day, ts, open, close,
               EXTRACT(HOUR FROM ts AT TIME ZONE 'America/New_York') AS et_hour,
               EXTRACT(MINUTE FROM ts AT TIME ZONE 'America/New_York') AS et_min
        FROM lc_v3.bars
        WHERE session = 'REGULAR'
        ORDER BY ticker, ts
    """)

    intraday = {}  # (ticker, day) -> {mins_since_open: {open, close}}
    for r in cur.fetchall():
        key = (r['ticker'], str(r['day']))
        if key not in gap_days:
            continue
        h = int(r['et_hour'])
        m = int(r['et_min'])
        mins = h * 60 + m - 570
        if key not in intraday:
            intraday[key] = {}
        intraday[key][mins] = {'open': float(r['open']), 'close': float(r['close'])}

    # Checkpoints: 10:30 (60min), 11:30 (120min), 1:00pm (210min), close (390min)
    checkpoints = [
        ('10:30 AM',  60),
        ('11:30 AM', 120),
        ('1:00 PM',  210),
        ('Close',    None),
    ]

    # Gap fill = (price - day_open) / (prev_close - day_open)
    # 100% fill means price returned to prev_close
    recovery = {label: {'total': 0, 'fill_sum': 0.0, 'positive_count': 0} for label, _ in checkpoints}

    # First 5-min candle analysis
    green_first = {'total': 0, 'eod_green': 0, 'fill_sum': 0.0}
    red_first   = {'total': 0, 'eod_green': 0, 'fill_sum': 0.0}

    for key, gd in gap_days.items():
        if key not in intraday:
            continue
        bars = intraday[key]
        day_open = float(gd['day_open'])
        prev_close = float(gd['prev_close'])
        gap_size = prev_close - day_open  # positive number (gap was down)
        if gap_size <= 0:
            continue

        # Checkpoints
        for label, target_min in checkpoints:
            if target_min is not None:
                price = None
                for offset in range(0, 4):
                    if target_min + offset in bars:
                        price = bars[target_min + offset]['close']
                        break
                    if target_min - offset in bars:
                        price = bars[target_min - offset]['close']
                        break
            else:
                if bars:
                    price = bars[max(bars.keys())]['close']
                else:
                    price = None

            if price is None:
                continue

            fill_pct = (price - day_open) / gap_size * 100
            recovery[label]['total'] += 1
            recovery[label]['fill_sum'] += fill_pct
            if fill_pct > 0:
                recovery[label]['positive_count'] += 1

        # First 5-min candle: aggregate bars 0-4 minutes
        first_bars = [bars[m] for m in range(0, 5) if m in bars]
        if not first_bars:
            continue
        first_open = first_bars[0]['open']
        first_close = first_bars[-1]['close']
        is_green = first_close > first_open

        # EOD
        if bars:
            eod_price = bars[max(bars.keys())]['close']
            eod_fill = (eod_price - day_open) / gap_size * 100
            eod_green = eod_price > day_open  # closed above open = recovery day
        else:
            continue

        bucket = green_first if is_green else red_first
        bucket['total'] += 1
        bucket['fill_sum'] += eod_fill
        if eod_green:
            bucket['eod_green'] += 1

    print(f'\n  Gap Recovery by Time (% of gap filled):')
    print(f'  {"Checkpoint":<12} {"Days":>8} {"Avg Fill%":>10} {"Recovering":>12}')
    print(f'  {"-"*44}')
    for label, _ in checkpoints:
        d = recovery[label]
        if d['total'] == 0:
            continue
        avg_fill = d['fill_sum'] / d['total']
        pos_rate = d['positive_count'] / d['total'] * 100
        print(f'  {label:<12} {d["total"]:>8,} {avg_fill:>+9.1f}% {pos_rate:>10.1f}%')

    print(f'\n  First 5-Minute Candle Filter:')
    print(f'  {"First Candle":<15} {"Days":>8} {"EOD Green":>10} {"Recovery%":>10} {"Avg Fill%":>10}')
    print(f'  {"-"*55}')
    for label, bucket in [('GREEN', green_first), ('RED', red_first)]:
        if bucket['total'] == 0:
            continue
        rate = bucket['eod_green'] / bucket['total'] * 100
        avg_fill = bucket['fill_sum'] / bucket['total']
        print(f'  {label:<15} {bucket["total"]:>8,} {bucket["eod_green"]:>10,} {rate:>9.1f}% {avg_fill:>+9.1f}%')

    print()


# ─────────────────────────────────────────────────────────────────────────────
# 10) RALLY EXHAUSTION — 3-day return buckets + 20-day high filter
# ─────────────────────────────────────────────────────────────────────────────
def rally_exhaustion():
    print('=' * 70)
    print('10) RALLY EXHAUSTION — 3-day return magnitude + 20-day high filter')
    print('=' * 70)

    # Build daily OHLC series per ticker
    cur.execute("""
        SELECT ticker, DATE(ts) AS day,
               (ARRAY_AGG(open ORDER BY ts))[1] AS day_open,
               MAX(high) AS day_high,
               MIN(low) AS day_low,
               (ARRAY_AGG(close ORDER BY ts DESC))[1] AS day_close
        FROM lc_v3.bars
        WHERE session = 'REGULAR'
        GROUP BY ticker, DATE(ts)
        ORDER BY ticker, day
    """)

    by_ticker = {}
    for r in cur.fetchall():
        t = r['ticker']
        if t not in by_ticker:
            by_ticker[t] = []
        by_ticker[t].append({
            'day': str(r['day']),
            'open': float(r['day_open']),
            'high': float(r['day_high']),
            'low': float(r['day_low']),
            'close': float(r['day_close']),
        })

    import math

    bucket_order = ['+1% to +2%', '+2% to +3%', '+3% to +5%', '+5%+']

    # Basic 3-day return buckets
    buckets = {b: {'total': 0, 'next_down': 0, 'next_ret_sum': 0.0, 'next_rets': []}
               for b in bucket_order}

    # With 20-day high filter
    buckets_at_high = {b: {'total': 0, 'next_down': 0, 'next_ret_sum': 0.0, 'next_rets': []}
                       for b in bucket_order}
    buckets_not_high = {b: {'total': 0, 'next_down': 0, 'next_ret_sum': 0.0, 'next_rets': []}
                        for b in bucket_order}

    for ticker, days in by_ticker.items():
        for i in range(20, len(days) - 1):
            if i < 3:
                continue
            prev3_close = days[i - 3]['close']
            curr_close = days[i]['close']
            next_close = days[i + 1]['close']
            if prev3_close == 0 or curr_close == 0:
                continue

            ret_3d = (curr_close - prev3_close) / prev3_close * 100
            next_ret = (next_close - curr_close) / curr_close * 100

            # Only look at positive 3-day returns
            if ret_3d <= 1:
                continue

            if ret_3d <= 2:
                bucket = '+1% to +2%'
            elif ret_3d <= 3:
                bucket = '+2% to +3%'
            elif ret_3d <= 5:
                bucket = '+3% to +5%'
            else:
                bucket = '+5%+'

            buckets[bucket]['total'] += 1
            if next_ret < 0:
                buckets[bucket]['next_down'] += 1
            buckets[bucket]['next_ret_sum'] += next_ret
            buckets[bucket]['next_rets'].append(next_ret)

            # 20-day high check
            high_20d = max(d['high'] for d in days[i-19:i+1])
            at_high = curr_close >= high_20d * 0.99  # within 1% of 20-day high

            target = buckets_at_high if at_high else buckets_not_high
            target[bucket]['total'] += 1
            if next_ret < 0:
                target[bucket]['next_down'] += 1
            target[bucket]['next_ret_sum'] += next_ret
            target[bucket]['next_rets'].append(next_ret)

    print(f'\n  3-Day Rally → Next Day (all):')
    print(f'  {"Bucket":<15} {"Days":>8} {"Next Down":>10} {"Down%":>8} {"Avg Next":>10} {"t-stat":>8}')
    print(f'  {"-"*61}')
    for b in bucket_order:
        d = buckets[b]
        if d['total'] == 0:
            continue
        down_rate = d['next_down'] / d['total'] * 100
        avg_next = d['next_ret_sum'] / d['total']
        # t-stat: is avg_next significantly different from 0?
        rets = d['next_rets']
        n = len(rets)
        if n > 1:
            mean = sum(rets) / n
            var = sum((r - mean)**2 for r in rets) / (n - 1)
            se = math.sqrt(var / n) if var > 0 else 0.001
            t_stat = mean / se
        else:
            t_stat = 0
        sig = '*' if abs(t_stat) > 1.96 else ''
        print(f'  {b:<15} {d["total"]:>8,} {d["next_down"]:>10,} {down_rate:>7.1f}% {avg_next:>+9.4f}% {t_stat:>7.2f}{sig}')

    print(f'\n  With 20-Day High Filter (within 1% of 20d high):')
    print(f'  {"Bucket":<15} {"Days":>8} {"Next Down":>10} {"Down%":>8} {"Avg Next":>10} {"t-stat":>8}')
    print(f'  {"-"*61}')
    for b in bucket_order:
        d = buckets_at_high[b]
        if d['total'] == 0:
            continue
        down_rate = d['next_down'] / d['total'] * 100
        avg_next = d['next_ret_sum'] / d['total']
        rets = d['next_rets']
        n = len(rets)
        if n > 1:
            mean = sum(rets) / n
            var = sum((r - mean)**2 for r in rets) / (n - 1)
            se = math.sqrt(var / n) if var > 0 else 0.001
            t_stat = mean / se
        else:
            t_stat = 0
        sig = '*' if abs(t_stat) > 1.96 else ''
        print(f'  {b:<15} {d["total"]:>8,} {d["next_down"]:>10,} {down_rate:>7.1f}% {avg_next:>+9.4f}% {t_stat:>7.2f}{sig}')

    print(f'\n  NOT at 20-Day High:')
    print(f'  {"Bucket":<15} {"Days":>8} {"Next Down":>10} {"Down%":>8} {"Avg Next":>10} {"t-stat":>8}')
    print(f'  {"-"*61}')
    for b in bucket_order:
        d = buckets_not_high[b]
        if d['total'] == 0:
            continue
        down_rate = d['next_down'] / d['total'] * 100
        avg_next = d['next_ret_sum'] / d['total']
        rets = d['next_rets']
        n = len(rets)
        if n > 1:
            mean = sum(rets) / n
            var = sum((r - mean)**2 for r in rets) / (n - 1)
            se = math.sqrt(var / n) if var > 0 else 0.001
            t_stat = mean / se
        else:
            t_stat = 0
        sig = '*' if abs(t_stat) > 1.96 else ''
        print(f'  {b:<15} {d["total"]:>8,} {d["next_down"]:>10,} {down_rate:>7.1f}% {avg_next:>+9.4f}% {t_stat:>7.2f}{sig}')

    print()


# ─────────────────────────────────────────────────────────────────────────────
# 11) RALLY EXHAUSTION (6mo daily from Alpaca) — large-sample test
# ─────────────────────────────────────────────────────────────────────────────
def rally_exhaustion_alpaca():
    import math
    import requests
    import json
    from datetime import datetime

    print('=' * 70)
    print('11) RALLY EXHAUSTION — 6 months daily bars from Alpaca')
    print('=' * 70)

    API_KEY    = os.environ.get('ALPACA_API_KEY')
    API_SECRET = os.environ.get('ALPACA_SECRET_KEY')
    if not API_KEY or not API_SECRET:
        print('  ERROR: ALPACA_API_KEY / ALPACA_SECRET_KEY not set')
        return

    # Get tickers
    cur.execute('SELECT ticker FROM lc_v3.equity_profiles ORDER BY ticker')
    tickers = [r['ticker'] for r in cur.fetchall()]
    print(f'  Tickers: {len(tickers)}')

    headers = {
        'APCA-API-KEY-ID': API_KEY,
        'APCA-API-SECRET-KEY': API_SECRET,
    }

    # Fetch daily bars in batches (API supports multi-symbol, max ~50 at a time)
    all_bars = {}  # ticker -> [{'day': ..., 'o': ..., 'h': ..., 'c': ...}, ...]
    batch_size = 40

    for batch_start in range(0, len(tickers), batch_size):
        batch = tickers[batch_start:batch_start + batch_size]
        symbols = ','.join(batch)
        print(f'  Fetching batch {batch_start // batch_size + 1}: {len(batch)} tickers...')

        page_token = None
        while True:
            params = {
                'symbols': symbols,
                'timeframe': '1Day',
                'start': '2025-09-01',
                'end': datetime.now().strftime('%Y-%m-%d'),
                'limit': 10000,
                'feed': 'sip',
                'adjustment': 'split',
            }
            if page_token:
                params['page_token'] = page_token

            resp = requests.get(
                'https://data.alpaca.markets/v2/stocks/bars',
                headers=headers,
                params=params,
            )
            if resp.status_code != 200:
                print(f'  ERROR: {resp.status_code} — {resp.text[:200]}')
                return

            data = resp.json()

            for ticker, bars in data.get('bars', {}).items():
                if ticker not in all_bars:
                    all_bars[ticker] = []
                for b in bars:
                    all_bars[ticker].append({
                        'day': b['t'][:10],
                        'o': b['o'],
                        'h': b['h'],
                        'l': b['l'],
                        'c': b['c'],
                        'v': b['v'],
                    })

            page_token = data.get('next_page_token')
            if not page_token:
                break

    # Sort each ticker's bars by date
    for t in all_bars:
        all_bars[t].sort(key=lambda x: x['day'])

    total_bars = sum(len(v) for v in all_bars.values())
    print(f'  Total daily bars fetched: {total_bars:,} across {len(all_bars)} tickers')

    # Date range
    all_days = set()
    for bars in all_bars.values():
        for b in bars:
            all_days.add(b['day'])
    sorted_days = sorted(all_days)
    if sorted_days:
        print(f'  Date range: {sorted_days[0]} → {sorted_days[-1]} ({len(sorted_days)} trading days)')

    # ── 3-Day Rally Exhaustion ──
    bucket_order_3d = ['+1% to +2%', '+2% to +3%', '+3% to +5%', '+5% to +8%', '+8%+']
    buckets_3d = {b: {'total': 0, 'next_down': 0, 'rets': []} for b in bucket_order_3d}

    # ── 10-Day Rally Exhaustion ──
    bucket_order_10d = ['+3% to +5%', '+5% to +8%', '+8% to +12%', '+12%+']
    buckets_10d = {b: {'total': 0, 'next_down': 0, 'rets': []} for b in bucket_order_10d}

    # ── 20-day high filter for 3-day ──
    buckets_3d_high = {b: {'total': 0, 'next_down': 0, 'rets': []} for b in bucket_order_3d}
    buckets_3d_nothigh = {b: {'total': 0, 'next_down': 0, 'rets': []} for b in bucket_order_3d}

    for ticker, days in all_bars.items():
        for i in range(20, len(days) - 1):
            curr = days[i]
            next_day = days[i + 1]
            if curr['c'] == 0:
                continue
            next_ret = (next_day['c'] - curr['c']) / curr['c'] * 100

            # 3-day return
            if i >= 3:
                prev3 = days[i - 3]
                if prev3['c'] > 0:
                    ret_3d = (curr['c'] - prev3['c']) / prev3['c'] * 100

                    if ret_3d > 1:
                        if ret_3d <= 2:
                            b3 = '+1% to +2%'
                        elif ret_3d <= 3:
                            b3 = '+2% to +3%'
                        elif ret_3d <= 5:
                            b3 = '+3% to +5%'
                        elif ret_3d <= 8:
                            b3 = '+5% to +8%'
                        else:
                            b3 = '+8%+'

                        buckets_3d[b3]['total'] += 1
                        if next_ret < 0:
                            buckets_3d[b3]['next_down'] += 1
                        buckets_3d[b3]['rets'].append(next_ret)

                        # 20-day high check
                        high_20d = max(d['h'] for d in days[i-19:i+1])
                        at_high = curr['c'] >= high_20d * 0.99
                        target = buckets_3d_high if at_high else buckets_3d_nothigh
                        target[b3]['total'] += 1
                        if next_ret < 0:
                            target[b3]['next_down'] += 1
                        target[b3]['rets'].append(next_ret)

            # 10-day return
            if i >= 10:
                prev10 = days[i - 10]
                if prev10['c'] > 0:
                    ret_10d = (curr['c'] - prev10['c']) / prev10['c'] * 100

                    if ret_10d > 3:
                        if ret_10d <= 5:
                            b10 = '+3% to +5%'
                        elif ret_10d <= 8:
                            b10 = '+5% to +8%'
                        elif ret_10d <= 12:
                            b10 = '+8% to +12%'
                        else:
                            b10 = '+12%+'

                        buckets_10d[b10]['total'] += 1
                        if next_ret < 0:
                            buckets_10d[b10]['next_down'] += 1
                        buckets_10d[b10]['rets'].append(next_ret)

    def print_table(label, buckets, bucket_order):
        print(f'\n  {label}')
        print(f'  {"Bucket":<15} {"Days":>8} {"Next Down":>10} {"Down%":>8} {"Avg Next":>10} {"t-stat":>8}')
        print(f'  {"-"*61}')
        for b in bucket_order:
            d = buckets[b]
            if d['total'] == 0:
                continue
            down_rate = d['next_down'] / d['total'] * 100
            avg_next = sum(d['rets']) / d['total']
            n = len(d['rets'])
            if n > 1:
                mean = sum(d['rets']) / n
                var = sum((r - mean)**2 for r in d['rets']) / (n - 1)
                se = math.sqrt(var / n) if var > 0 else 0.001
                t_stat = mean / se
            else:
                t_stat = 0
            sig = ' **' if abs(t_stat) > 2.58 else ' *' if abs(t_stat) > 1.96 else ''
            print(f'  {b:<15} {d["total"]:>8,} {d["next_down"]:>10,} {down_rate:>7.1f}% {avg_next:>+9.4f}% {t_stat:>7.2f}{sig}')

    print_table('3-Day Rally → Next Day (all):', buckets_3d, bucket_order_3d)
    print_table('3-Day Rally + At 20-Day High:', buckets_3d_high, bucket_order_3d)
    print_table('3-Day Rally + NOT at 20-Day High:', buckets_3d_nothigh, bucket_order_3d)
    print_table('10-Day Rally → Next Day:', buckets_10d, bucket_order_10d)

    print()


# ─────────────────────────────────────────────────────────────────────────────
# 12) SYMPATHY CASCADE VALIDATION — leader/follower same-day + next-day
# ─────────────────────────────────────────────────────────────────────────────
def sympathy_cascade():
    print('=' * 70)
    print('12) SYMPATHY CASCADE — leader move >2% → follower response')
    print('=' * 70)

    pairs = [
        ('NVDA', 'AMD'), ('NVDA', 'AMAT'), ('NVDA', 'MU'),
        ('META', 'SNAP'), ('MSFT', 'CRM'), ('GOOGL', 'META'),
    ]

    # Build daily returns per ticker: {ticker: {day: {open, close, ret%}}}
    cur.execute("""
        SELECT ticker, DATE(ts) AS day,
               (ARRAY_AGG(open ORDER BY ts))[1] AS day_open,
               (ARRAY_AGG(close ORDER BY ts DESC))[1] AS day_close
        FROM lc_v3.bars
        WHERE session = 'REGULAR'
        GROUP BY ticker, DATE(ts)
        ORDER BY ticker, day
    """)

    daily = {}  # ticker -> [{day, open, close, ret}]
    daily_idx = {}  # ticker -> {day: {open, close, ret}}
    for r in cur.fetchall():
        t = r['ticker']
        o = float(r['day_open'])
        c = float(r['day_close'])
        d = str(r['day'])
        entry = {'day': d, 'open': o, 'close': c, 'ret': (c - o) / o * 100 if o > 0 else 0}
        if t not in daily:
            daily[t] = []
            daily_idx[t] = {}
        daily[t].append(entry)
        daily_idx[t][d] = entry

    # For each ticker, build sorted day list for next-day lookup
    daily_days = {}
    for t in daily:
        daily[t].sort(key=lambda x: x['day'])
        daily_days[t] = [d['day'] for d in daily[t]]

    print(f'\n  {"Pair":<15} {"Leader>2%":>10} {"Foll Same":>10} {"Same%":>8} {"Foll Next":>10} {"Next%":>8} {"Avg Mag":>8}')
    print(f'  {"-"*72}')

    for leader, follower in pairs:
        if leader not in daily_idx or follower not in daily_idx:
            print(f'  {leader}-{follower:<10} — missing data (ticker not in DB)')
            continue

        leader_big_days = []
        for entry in daily[leader]:
            if abs(entry['ret']) >= 2:
                leader_big_days.append(entry)

        if not leader_big_days:
            print(f'  {leader}-{follower:<10} — no leader moves >2%')
            continue

        same_dir_count = 0
        next_dir_count = 0
        next_dir_total = 0
        mag_ratios = []

        for ld in leader_big_days:
            day = ld['day']
            leader_dir = 1 if ld['ret'] > 0 else -1

            # Same day
            fd = daily_idx[follower].get(day)
            if fd is None:
                continue

            follower_dir = 1 if fd['ret'] > 0 else -1
            if leader_dir == follower_dir:
                same_dir_count += 1

            if ld['ret'] != 0:
                mag_ratios.append(abs(fd['ret']) / abs(ld['ret']))

            # Next day
            f_days = daily_days[follower]
            if day in f_days:
                idx = f_days.index(day)
                if idx + 1 < len(f_days):
                    next_day = f_days[idx + 1]
                    nd = daily_idx[follower].get(next_day)
                    if nd:
                        next_dir_total += 1
                        next_follower_dir = 1 if nd['ret'] > 0 else -1
                        if leader_dir == next_follower_dir:
                            next_dir_count += 1

        total = len(leader_big_days)
        # Count only days where follower had data
        same_total = sum(1 for ld in leader_big_days if daily_idx[follower].get(ld['day']))
        same_pct = same_dir_count / same_total * 100 if same_total else 0
        next_pct = next_dir_count / next_dir_total * 100 if next_dir_total else 0
        avg_mag = sum(mag_ratios) / len(mag_ratios) * 100 if mag_ratios else 0

        pair_label = f'{leader}-{follower}'
        print(f'  {pair_label:<15} {same_total:>10} {same_dir_count:>10} {same_pct:>7.1f}% {next_dir_count:>5}/{next_dir_total:<4} {next_pct:>7.1f}% {avg_mag:>7.1f}%')

    # Detailed breakdown by direction for top pairs
    print(f'\n  Detailed: NVDA >+2% days vs NVDA <-2% days')
    for leader, follower in [('NVDA', 'AMD'), ('NVDA', 'MU')]:
        if leader not in daily_idx or follower not in daily_idx:
            continue
        for dir_label, dir_filter in [('UP (>+2%)', lambda r: r > 2), ('DOWN (<-2%)', lambda r: r < -2)]:
            big_days = [e for e in daily[leader] if dir_filter(e['ret'])]
            if not big_days:
                continue
            same = 0
            total = 0
            f_rets = []
            for ld in big_days:
                fd = daily_idx[follower].get(ld['day'])
                if fd is None:
                    continue
                total += 1
                leader_dir = 1 if ld['ret'] > 0 else -1
                follower_dir = 1 if fd['ret'] > 0 else -1
                if leader_dir == follower_dir:
                    same += 1
                f_rets.append(fd['ret'])
            avg_f = sum(f_rets) / len(f_rets) if f_rets else 0
            pct = same / total * 100 if total else 0
            print(f'    {leader} {dir_label} → {follower}: {same}/{total} same dir ({pct:.1f}%), avg follower ret: {avg_f:+.2f}%')

    print()


# ─────────────────────────────────────────────────────────────────────────────
# 13) GAP DOWN BY DEPTH — does gap size matter for recovery?
# ─────────────────────────────────────────────────────────────────────────────
def gap_down_by_depth():
    print('=' * 70)
    print('13) GAP DOWN BY DEPTH — gap size vs first candle vs recovery')
    print('=' * 70)

    # Daily open/prev_close
    cur.execute("""
        WITH daily AS (
            SELECT ticker, DATE(ts) AS day,
                   (ARRAY_AGG(open ORDER BY ts))[1] AS day_open,
                   (ARRAY_AGG(close ORDER BY ts DESC))[1] AS day_close
            FROM lc_v3.bars
            WHERE session = 'REGULAR'
            GROUP BY ticker, DATE(ts)
        ),
        with_prev AS (
            SELECT d.*,
                   LAG(day_close) OVER (PARTITION BY ticker ORDER BY day) AS prev_close
            FROM daily d
        )
        SELECT * FROM with_prev
        WHERE prev_close IS NOT NULL
          AND (day_open - prev_close) / prev_close * 100 < -2
    """)
    gap_days = {(r['ticker'], str(r['day'])): r for r in cur.fetchall()}

    # Get intraday bars for gap days
    cur.execute("""
        SELECT ticker, DATE(ts) AS day, ts, open, close,
               EXTRACT(HOUR FROM ts AT TIME ZONE 'America/New_York') AS et_hour,
               EXTRACT(MINUTE FROM ts AT TIME ZONE 'America/New_York') AS et_min
        FROM lc_v3.bars
        WHERE session = 'REGULAR'
        ORDER BY ticker, ts
    """)

    intraday = {}
    for r in cur.fetchall():
        key = (r['ticker'], str(r['day']))
        if key not in gap_days:
            continue
        h = int(r['et_hour'])
        m = int(r['et_min'])
        mins = h * 60 + m - 570
        if key not in intraday:
            intraday[key] = {}
        intraday[key][mins] = {'open': float(r['open']), 'close': float(r['close'])}

    depth_buckets = ['2-3% gap', '3-5% gap', '5%+ gap']
    results = {b: {
        'total': 0,
        'green_first': 0,
        'green_first_eod_green': 0,
        'green_first_fill_sum': 0.0,
        'red_first': 0,
        'red_first_eod_green': 0,
        'red_first_fill_sum': 0.0,
    } for b in depth_buckets}

    for key, gd in gap_days.items():
        if key not in intraday:
            continue
        bars = intraday[key]
        day_open = float(gd['day_open'])
        prev_close = float(gd['prev_close'])
        gap_pct = abs((day_open - prev_close) / prev_close * 100)
        gap_size = prev_close - day_open  # positive

        if gap_size <= 0:
            continue

        if gap_pct < 3:
            bucket = '2-3% gap'
        elif gap_pct < 5:
            bucket = '3-5% gap'
        else:
            bucket = '5%+ gap'

        results[bucket]['total'] += 1

        # First 5-min candle
        first_bars = [bars[m] for m in range(0, 5) if m in bars]
        if not first_bars:
            continue
        first_open = first_bars[0]['open']
        first_close = first_bars[-1]['close']
        is_green = first_close > first_open

        # EOD
        if not bars:
            continue
        eod_price = bars[max(bars.keys())]['close']
        eod_green = eod_price > day_open
        eod_fill = (eod_price - day_open) / gap_size * 100

        if is_green:
            results[bucket]['green_first'] += 1
            results[bucket]['green_first_fill_sum'] += eod_fill
            if eod_green:
                results[bucket]['green_first_eod_green'] += 1
        else:
            results[bucket]['red_first'] += 1
            results[bucket]['red_first_fill_sum'] += eod_fill
            if eod_green:
                results[bucket]['red_first_eod_green'] += 1

    print(f'\n  {"Depth":<12} {"Days":>6} {"Grn1st":>8} {"Grn1st%":>8} {"GrnEOD":>8} {"Recovery%":>10} {"AvgFill":>10} | {"Red1st":>8} {"RedEOD":>8} {"RedRecov%":>10} {"RedFill":>10}')
    print(f'  {"-"*115}')
    for b in depth_buckets:
        d = results[b]
        if d['total'] == 0:
            continue
        grn = d['green_first']
        grn_eod = d['green_first_eod_green']
        grn_pct = grn / d['total'] * 100 if d['total'] else 0
        grn_recov = grn_eod / grn * 100 if grn else 0
        grn_fill = d['green_first_fill_sum'] / grn if grn else 0

        red = d['red_first']
        red_eod = d['red_first_eod_green']
        red_recov = red_eod / red * 100 if red else 0
        red_fill = d['red_first_fill_sum'] / red if red else 0

        print(f'  {b:<12} {d["total"]:>6} {grn:>8} {grn_pct:>7.1f}% {grn_eod:>8} {grn_recov:>9.1f}% {grn_fill:>+9.1f}% | {red:>8} {red_eod:>8} {red_recov:>9.1f}% {red_fill:>+9.1f}%')

    # Summary
    print(f'\n  Summary — Green First Candle Recovery Rate by Gap Depth:')
    print(f'  {"Depth":<12} {"Sample":>8} {"EOD Green":>10} {"Win Rate":>10} {"Avg Fill":>10}')
    print(f'  {"-"*52}')
    for b in depth_buckets:
        d = results[b]
        grn = d['green_first']
        if grn == 0:
            continue
        grn_eod = d['green_first_eod_green']
        grn_recov = grn_eod / grn * 100
        grn_fill = d['green_first_fill_sum'] / grn
        print(f'  {b:<12} {grn:>8} {grn_eod:>10} {grn_recov:>9.1f}% {grn_fill:>+9.1f}%')

    print()


# ─────────────────────────────────────────────────────────────────────────────
# 14) OVERNIGHT HOLD — close-to-open return by day of week, direction, gap
# ─────────────────────────────────────────────────────────────────────────────
def overnight_hold():
    print('=' * 70)
    print('14) OVERNIGHT HOLD — close-to-next-open return')
    print('=' * 70)

    cur.execute("""
        WITH daily AS (
            SELECT ticker, DATE(ts) AS day,
                   (ARRAY_AGG(open ORDER BY ts))[1] AS day_open,
                   (ARRAY_AGG(close ORDER BY ts DESC))[1] AS day_close
            FROM lc_v3.bars
            WHERE session = 'REGULAR'
            GROUP BY ticker, DATE(ts)
            ORDER BY ticker, day
        ),
        with_neighbors AS (
            SELECT d.*,
                   LAG(day_close) OVER w AS prev_close,
                   LEAD(day_open) OVER w AS next_open,
                   EXTRACT(DOW FROM d.day) AS dow
            FROM daily d
            WINDOW w AS (PARTITION BY ticker ORDER BY day)
        )
        SELECT * FROM with_neighbors
        WHERE next_open IS NOT NULL AND prev_close IS NOT NULL
    """)
    rows = cur.fetchall()

    dow_names = {1: 'Mon', 2: 'Tue', 3: 'Wed', 4: 'Thu', 5: 'Fri'}

    # By day of week
    by_dow = {}
    for d in dow_names:
        by_dow[d] = {'total': 0, 'positive': 0, 'ret_sum': 0.0}

    # By today's direction
    by_dir = {'Up day': {'total': 0, 'positive': 0, 'ret_sum': 0.0},
              'Down day': {'total': 0, 'positive': 0, 'ret_sum': 0.0}}

    # Gap down that recovered
    by_gap_recov = {'Gap-down recovered': {'total': 0, 'positive': 0, 'ret_sum': 0.0},
                    'Gap-down NOT recovered': {'total': 0, 'positive': 0, 'ret_sum': 0.0},
                    'No gap down': {'total': 0, 'positive': 0, 'ret_sum': 0.0}}

    for r in rows:
        day_close = float(r['day_close'])
        next_open = float(r['next_open'])
        day_open = float(r['day_open'])
        prev_close = float(r['prev_close'])
        dow = int(r['dow'])

        if day_close == 0:
            continue

        overnight_ret = (next_open - day_close) / day_close * 100

        # DOW
        if dow in by_dow:
            by_dow[dow]['total'] += 1
            if overnight_ret > 0:
                by_dow[dow]['positive'] += 1
            by_dow[dow]['ret_sum'] += overnight_ret

        # Direction
        if day_close > day_open:
            bucket = 'Up day'
        else:
            bucket = 'Down day'
        by_dir[bucket]['total'] += 1
        if overnight_ret > 0:
            by_dir[bucket]['positive'] += 1
        by_dir[bucket]['ret_sum'] += overnight_ret

        # Gap-down recovery
        gap_down = day_open < prev_close * 0.99  # opened >1% below prev close
        recovered = day_close > day_open  # closed above open
        if gap_down and recovered:
            gk = 'Gap-down recovered'
        elif gap_down and not recovered:
            gk = 'Gap-down NOT recovered'
        else:
            gk = 'No gap down'
        by_gap_recov[gk]['total'] += 1
        if overnight_ret > 0:
            by_gap_recov[gk]['positive'] += 1
        by_gap_recov[gk]['ret_sum'] += overnight_ret

    def show(label, data, key_order):
        print(f'\n  {label}')
        print(f'  {"Bucket":<25} {"Days":>8} {"Positive":>10} {"Pos%":>8} {"Avg Ret":>10}')
        print(f'  {"-"*63}')
        for k in key_order:
            d = data[k] if isinstance(k, str) else data[k]
            lbl = k if isinstance(k, str) else dow_names[k]
            if d['total'] == 0:
                continue
            pos_pct = d['positive'] / d['total'] * 100
            avg = d['ret_sum'] / d['total']
            print(f'  {lbl:<25} {d["total"]:>8,} {d["positive"]:>10,} {pos_pct:>7.1f}% {avg:>+9.4f}%')

    show('BY DAY OF WEEK', by_dow, [1, 2, 3, 4, 5])
    show('BY TODAY\'S DIRECTION', by_dir, ['Up day', 'Down day'])
    show('BY GAP-DOWN RECOVERY', by_gap_recov, ['Gap-down recovered', 'Gap-down NOT recovered', 'No gap down'])

    print()


# ─────────────────────────────────────────────────────────────────────────────
# 15) PUT EDGE — 3%+ intraday drop → next-day behavior
# ─────────────────────────────────────────────────────────────────────────────
def put_edge():
    print('=' * 70)
    print('15) PUT EDGE — 3%+ intraday drop → next day')
    print('=' * 70)

    cur.execute("""
        WITH daily AS (
            SELECT ticker, DATE(ts) AS day,
                   (ARRAY_AGG(open ORDER BY ts))[1] AS day_open,
                   (ARRAY_AGG(close ORDER BY ts DESC))[1] AS day_close,
                   SUM(volume) AS day_vol
            FROM lc_v3.bars
            WHERE session = 'REGULAR'
            GROUP BY ticker, DATE(ts)
            ORDER BY ticker, day
        ),
        with_next AS (
            SELECT d.*,
                   LEAD(day_open) OVER w AS next_open,
                   LEAD(day_close) OVER w AS next_close,
                   -- avg volume over prior 20 days
                   AVG(day_vol) OVER (PARTITION BY ticker ORDER BY day ROWS BETWEEN 20 PRECEDING AND 1 PRECEDING) AS avg_vol_20
            FROM daily d
            WINDOW w AS (PARTITION BY ticker ORDER BY day)
        )
        SELECT * FROM with_next
        WHERE next_close IS NOT NULL
          AND day_open > 0
          AND (day_close - day_open) / day_open * 100 < -3
    """)
    rows = cur.fetchall()

    total = len(rows)
    print(f'\n  Days with 3%+ intraday drop: {total}')

    # All drops
    all_bucket = {'total': 0, 'next_down': 0, 'next_rets': []}
    high_vol = {'total': 0, 'next_down': 0, 'next_rets': []}
    low_vol = {'total': 0, 'next_down': 0, 'next_rets': []}

    # By drop magnitude
    drop_buckets = {'3-5% drop': {'total': 0, 'next_down': 0, 'next_rets': []},
                    '5-8% drop': {'total': 0, 'next_down': 0, 'next_rets': []},
                    '8%+ drop': {'total': 0, 'next_down': 0, 'next_rets': []}}

    for r in rows:
        day_open = float(r['day_open'])
        day_close = float(r['day_close'])
        next_open = float(r['next_open'])
        next_close = float(r['next_close'])
        day_vol = int(r['day_vol']) if r['day_vol'] else 0
        avg_vol = float(r['avg_vol_20']) if r['avg_vol_20'] else 0

        drop_pct = abs((day_close - day_open) / day_open * 100)
        next_ret = (next_close - next_open) / next_open * 100 if next_open > 0 else 0

        all_bucket['total'] += 1
        if next_ret < 0:
            all_bucket['next_down'] += 1
        all_bucket['next_rets'].append(next_ret)

        # Volume filter
        above_avg = avg_vol > 0 and day_vol > avg_vol * 1.5
        target = high_vol if above_avg else low_vol
        target['total'] += 1
        if next_ret < 0:
            target['next_down'] += 1
        target['next_rets'].append(next_ret)

        # Drop magnitude
        if drop_pct < 5:
            dk = '3-5% drop'
        elif drop_pct < 8:
            dk = '5-8% drop'
        else:
            dk = '8%+ drop'
        drop_buckets[dk]['total'] += 1
        if next_ret < 0:
            drop_buckets[dk]['next_down'] += 1
        drop_buckets[dk]['next_rets'].append(next_ret)

    def show_bucket(label, d):
        if d['total'] == 0:
            return
        down_rate = d['next_down'] / d['total'] * 100
        avg = sum(d['next_rets']) / d['total']
        print(f'  {label:<25} {d["total"]:>8} {d["next_down"]:>10} {down_rate:>9.1f}% {avg:>+9.3f}%')

    print(f'\n  {"Bucket":<25} {"Days":>8} {"Next Down":>10} {"Down%":>10} {"Avg Next":>10}')
    print(f'  {"-"*65}')
    show_bucket('ALL 3%+ drops', all_bucket)
    show_bucket('  High volume (>1.5x avg)', high_vol)
    show_bucket('  Normal volume', low_vol)
    print()
    for dk in ['3-5% drop', '5-8% drop', '8%+ drop']:
        show_bucket(dk, drop_buckets[dk])

    print()


# ─────────────────────────────────────────────────────────────────────────────
# 16) EXTENDED DOWN MOVE — consecutive 3%+ drops → what happens next
# ─────────────────────────────────────────────────────────────────────────────
def extended_down():
    print('=' * 70)
    print('16) EXTENDED DOWN — consecutive 3%+ daily drops')
    print('=' * 70)

    cur.execute("""
        WITH daily AS (
            SELECT ticker, DATE(ts) AS day,
                   (ARRAY_AGG(open ORDER BY ts))[1] AS day_open,
                   (ARRAY_AGG(close ORDER BY ts DESC))[1] AS day_close
            FROM lc_v3.bars
            WHERE session = 'REGULAR'
            GROUP BY ticker, DATE(ts)
            ORDER BY ticker, day
        )
        SELECT ticker, day, day_open, day_close,
               (day_close - day_open) / NULLIF(day_open, 0) * 100 AS day_ret
        FROM daily
        WHERE day_open > 0
        ORDER BY ticker, day
    """)

    by_ticker = {}
    for r in cur.fetchall():
        t = r['ticker']
        if t not in by_ticker:
            by_ticker[t] = []
        by_ticker[t].append({
            'day': str(r['day']),
            'open': float(r['day_open']),
            'close': float(r['day_close']),
            'ret': float(r['day_ret']) if r['day_ret'] else 0,
        })

    # Find consecutive 3%+ down days
    consec_2 = {'total': 0, 'next_down': 0, 'next_bounce': 0, 'next_rets': []}
    consec_3 = {'total': 0, 'next_down': 0, 'next_bounce': 0, 'next_rets': []}

    # Also track: 2 consecutive down days (any magnitude > 1%)
    consec_2_mild = {'total': 0, 'next_down': 0, 'next_rets': []}
    consec_3_mild = {'total': 0, 'next_down': 0, 'next_rets': []}

    for ticker, days in by_ticker.items():
        for i in range(2, len(days) - 1):
            # 2 consecutive 3%+ drops
            if days[i]['ret'] < -3 and days[i-1]['ret'] < -3:
                next_day = days[i + 1]
                next_ret = (next_day['close'] - next_day['open']) / next_day['open'] * 100 if next_day['open'] > 0 else 0
                consec_2['total'] += 1
                if next_ret < 0:
                    consec_2['next_down'] += 1
                if next_ret > 1:
                    consec_2['next_bounce'] += 1
                consec_2['next_rets'].append(next_ret)

            # 2 consecutive 1%+ drops (milder)
            if days[i]['ret'] < -1 and days[i-1]['ret'] < -1:
                next_day = days[i + 1]
                next_ret = (next_day['close'] - next_day['open']) / next_day['open'] * 100 if next_day['open'] > 0 else 0
                consec_2_mild['total'] += 1
                if next_ret < 0:
                    consec_2_mild['next_down'] += 1
                consec_2_mild['next_rets'].append(next_ret)

            # 3 consecutive
            if i >= 3:
                if days[i]['ret'] < -3 and days[i-1]['ret'] < -3 and days[i-2]['ret'] < -3:
                    if i + 1 < len(days):
                        next_day = days[i + 1]
                        next_ret = (next_day['close'] - next_day['open']) / next_day['open'] * 100 if next_day['open'] > 0 else 0
                        consec_3['total'] += 1
                        if next_ret < 0:
                            consec_3['next_down'] += 1
                        if next_ret > 1:
                            consec_3['next_bounce'] += 1
                        consec_3['next_rets'].append(next_ret)

                if days[i]['ret'] < -1 and days[i-1]['ret'] < -1 and days[i-2]['ret'] < -1:
                    if i + 1 < len(days):
                        next_day = days[i + 1]
                        next_ret = (next_day['close'] - next_day['open']) / next_day['open'] * 100 if next_day['open'] > 0 else 0
                        consec_3_mild['total'] += 1
                        if next_ret < 0:
                            consec_3_mild['next_down'] += 1
                        consec_3_mild['next_rets'].append(next_ret)

    def show(label, d):
        if d['total'] == 0:
            print(f'  {label:<40} — no occurrences')
            return
        down_rate = d['next_down'] / d['total'] * 100
        avg = sum(d['next_rets']) / d['total']
        bounce = d.get('next_bounce', 0)
        bounce_str = f'{bounce}/{d["total"]} ({bounce/d["total"]*100:.0f}%)' if 'next_bounce' in d else ''
        print(f'  {label:<40} {d["total"]:>6} days | next down: {d["next_down"]:>4} ({down_rate:.1f}%) | avg next: {avg:>+.3f}% | bounce>1%: {bounce_str}')

    print()
    show('2 consecutive days down 3%+', consec_2)
    show('3 consecutive days down 3%+', consec_3)
    print()
    show('2 consecutive days down 1%+ (milder)', consec_2_mild)
    show('3 consecutive days down 1%+ (milder)', consec_3_mild)

    print()


# ─────────────────────────────────────────────────────────────────────────────
# 17) PRE-MARKET GAP PREDICTION — after-hours move vs no move
# ─────────────────────────────────────────────────────────────────────────────
def premarket_gap():
    print('=' * 70)
    print('17) PRE-MARKET GAP PREDICTION — after-hours move impact')
    print('=' * 70)

    cur.execute("""
        WITH daily AS (
            SELECT ticker, DATE(ts) AS day,
                   (ARRAY_AGG(open ORDER BY ts))[1] AS day_open,
                   (ARRAY_AGG(close ORDER BY ts DESC))[1] AS day_close
            FROM lc_v3.bars
            WHERE session = 'REGULAR'
            GROUP BY ticker, DATE(ts)
            ORDER BY ticker, day
        ),
        with_neighbors AS (
            SELECT d.*,
                   LAG(day_close) OVER w AS prev_close
            FROM daily d
            WINDOW w AS (PARTITION BY ticker ORDER BY day)
        )
        SELECT * FROM with_neighbors WHERE prev_close IS NOT NULL
    """)
    rows = cur.fetchall()

    # Gap = (open - prev_close) / prev_close = after-hours move proxy
    buckets = {
        'Gap down >1%':   {'total': 0, 'intraday_up': 0, 'ret_sum': 0.0},
        'No AH move (±1%)': {'total': 0, 'intraday_up': 0, 'ret_sum': 0.0},
        'Gap up >1%':     {'total': 0, 'intraday_up': 0, 'ret_sum': 0.0},
    }
    # Finer buckets
    fine = {
        'Gap down >3%': {'total': 0, 'intraday_up': 0, 'ret_sum': 0.0},
        'Gap down 2-3%': {'total': 0, 'intraday_up': 0, 'ret_sum': 0.0},
        'Gap down 1-2%': {'total': 0, 'intraday_up': 0, 'ret_sum': 0.0},
        'Flat (±0.5%)':  {'total': 0, 'intraday_up': 0, 'ret_sum': 0.0},
        'Gap up 1-2%':   {'total': 0, 'intraday_up': 0, 'ret_sum': 0.0},
        'Gap up 2-3%':   {'total': 0, 'intraday_up': 0, 'ret_sum': 0.0},
        'Gap up >3%':    {'total': 0, 'intraday_up': 0, 'ret_sum': 0.0},
    }

    for r in rows:
        prev_close = float(r['prev_close'])
        day_open = float(r['day_open'])
        day_close = float(r['day_close'])
        if prev_close == 0 or day_open == 0:
            continue

        gap_pct = (day_open - prev_close) / prev_close * 100
        intraday_ret = (day_close - day_open) / day_open * 100
        intraday_up = day_close > day_open

        # Coarse buckets
        if gap_pct < -1:
            bk = 'Gap down >1%'
        elif gap_pct > 1:
            bk = 'Gap up >1%'
        else:
            bk = 'No AH move (±1%)'
        buckets[bk]['total'] += 1
        if intraday_up:
            buckets[bk]['intraday_up'] += 1
        buckets[bk]['ret_sum'] += intraday_ret

        # Fine buckets
        if gap_pct < -3:
            fk = 'Gap down >3%'
        elif gap_pct < -2:
            fk = 'Gap down 2-3%'
        elif gap_pct < -1:
            fk = 'Gap down 1-2%'
        elif gap_pct <= 0.5 and gap_pct >= -0.5:
            fk = 'Flat (±0.5%)'
        elif gap_pct > 3:
            fk = 'Gap up >3%'
        elif gap_pct > 2:
            fk = 'Gap up 2-3%'
        elif gap_pct > 1:
            fk = 'Gap up 1-2%'
        else:
            continue  # 0.5-1% gap, skip
        fine[fk]['total'] += 1
        if intraday_up:
            fine[fk]['intraday_up'] += 1
        fine[fk]['ret_sum'] += intraday_ret

    print(f'\n  Coarse Buckets:')
    print(f'  {"Bucket":<25} {"Days":>8} {"Intraday Up":>12} {"Up%":>8} {"Avg Intraday":>13}')
    print(f'  {"-"*68}')
    for bk in ['Gap down >1%', 'No AH move (±1%)', 'Gap up >1%']:
        d = buckets[bk]
        if d['total'] == 0:
            continue
        up_pct = d['intraday_up'] / d['total'] * 100
        avg = d['ret_sum'] / d['total']
        print(f'  {bk:<25} {d["total"]:>8,} {d["intraday_up"]:>12,} {up_pct:>7.1f}% {avg:>+12.3f}%')

    print(f'\n  Fine Buckets:')
    print(f'  {"Bucket":<25} {"Days":>8} {"Intraday Up":>12} {"Up%":>8} {"Avg Intraday":>13}')
    print(f'  {"-"*68}')
    for fk in ['Gap down >3%', 'Gap down 2-3%', 'Gap down 1-2%', 'Flat (±0.5%)',
                'Gap up 1-2%', 'Gap up 2-3%', 'Gap up >3%']:
        d = fine[fk]
        if d['total'] == 0:
            continue
        up_pct = d['intraday_up'] / d['total'] * 100
        avg = d['ret_sum'] / d['total']
        print(f'  {fk:<25} {d["total"]:>8,} {d["intraday_up"]:>12,} {up_pct:>7.1f}% {avg:>+12.3f}%')

    print()


# ─────────────────────────────────────────────────────────────────────────────
# 18) IV EXPANSION PRE-EARNINGS — daily return volatility into earnings
# ─────────────────────────────────────────────────────────────────────────────
def iv_expansion_earnings():
    import math
    import json

    print('=' * 70)
    print('18) IV EXPANSION PRE-EARNINGS — daily volatility ramp')
    print('=' * 70)

    # Get historical earnings from ticker_intelligence
    cur.execute("""
        SELECT ticker, historical_earnings
        FROM lc_v3.ticker_intelligence
        WHERE historical_earnings IS NOT NULL
    """)
    intel_rows = cur.fetchall()
    print(f'\n  Tickers with historical earnings: {len(intel_rows)}')

    if not intel_rows:
        print('  No historical earnings data found.')
        return

    # Parse all earnings events
    all_events = []  # [{ticker, date}, ...]
    for r in intel_rows:
        ticker = r['ticker']
        hist = r['historical_earnings']
        if isinstance(hist, str):
            hist = json.loads(hist)
        for q in hist:
            if q.get('date'):
                all_events.append({'ticker': ticker, 'date': q['date']})
    print(f'  Total earnings events: {len(all_events)}')

    # Fetch 6 months of daily bars from Alpaca (lc_v3.bars only has ~20 days)
    import requests
    from datetime import datetime

    API_KEY    = os.environ.get('ALPACA_API_KEY')
    API_SECRET = os.environ.get('ALPACA_SECRET_KEY')

    # Get all tickers
    cur.execute('SELECT ticker FROM lc_v3.equity_profiles ORDER BY ticker')
    tickers = [r['ticker'] for r in cur.fetchall()]

    daily_by_ticker = {}

    # Try local Alpaca keys first, fall back to Render proxy
    fetch_success = False
    if API_KEY and API_SECRET:
        print(f'  Fetching 6mo daily bars from Alpaca for {len(tickers)} tickers...')
        headers = {'APCA-API-KEY-ID': API_KEY, 'APCA-API-SECRET-KEY': API_SECRET}
        batch_size = 40

        for batch_start in range(0, len(tickers), batch_size):
            batch = tickers[batch_start:batch_start + batch_size]
            page_token = None
            while True:
                params = {
                    'symbols': ','.join(batch), 'timeframe': '1Day',
                    'start': '2025-09-01', 'end': datetime.now().strftime('%Y-%m-%d'),
                    'limit': 10000, 'feed': 'sip', 'adjustment': 'split',
                }
                if page_token:
                    params['page_token'] = page_token
                try:
                    resp = requests.get('https://data.alpaca.markets/v2/stocks/bars',
                                        headers=headers, params=params, timeout=30)
                    if resp.status_code == 401:
                        print(f'  Alpaca 401 — keys expired, trying Render proxy...')
                        daily_by_ticker = {}
                        break
                    if resp.status_code != 200:
                        print(f'  Alpaca error {resp.status_code}')
                        break
                    data = resp.json()
                    for ticker, bars in data.get('bars', {}).items():
                        if ticker not in daily_by_ticker:
                            daily_by_ticker[ticker] = []
                        for b in bars:
                            daily_by_ticker[ticker].append({
                                'day': b['t'][:10], 'open': b['o'], 'close': b['c'],
                            })
                    page_token = data.get('next_page_token')
                    if not page_token:
                        break
                except Exception as e:
                    print(f'  Alpaca fetch error: {e}')
                    break
            else:
                continue
            break

        if daily_by_ticker:
            for t in daily_by_ticker:
                daily_by_ticker[t].sort(key=lambda x: x['day'])
            total = sum(len(v) for v in daily_by_ticker.values())
            print(f'  Fetched {total:,} daily bars for {len(daily_by_ticker)} tickers')
            fetch_success = True

    # Render proxy fallback: fetch from /api/analysis/rally-exhaustion which already fetches daily bars
    # Actually, let's just query the raw Alpaca via Render
    if not fetch_success and not daily_by_ticker:
        print(f'  Fetching daily bars via Render proxy...')
        try:
            resp = requests.get('https://alphatradesv3-1.onrender.com/api/analysis/rally-exhaustion', timeout=120)
            if resp.status_code == 200:
                # This endpoint returns analysis, not raw bars — we need raw bars
                # Fall back to DB
                print(f'  Render proxy doesn\'t return raw bars — using DB')
            else:
                print(f'  Render proxy error {resp.status_code}')
        except Exception as e:
            print(f'  Render proxy error: {e}')

    if not daily_by_ticker:
        print('  No Alpaca keys — falling back to lc_v3.bars (limited range)')
        cur.execute("""
            SELECT ticker, DATE(ts) AS day,
                   (ARRAY_AGG(open ORDER BY ts))[1] AS day_open,
                   (ARRAY_AGG(close ORDER BY ts DESC))[1] AS day_close
            FROM lc_v3.bars
            WHERE session = 'REGULAR'
            GROUP BY ticker, DATE(ts)
            ORDER BY ticker, day
        """)
        for r in cur.fetchall():
            t = r['ticker']
            if t not in daily_by_ticker:
                daily_by_ticker[t] = []
            daily_by_ticker[t].append({
                'day': str(r['day']),
                'open': float(r['day_open']),
                'close': float(r['day_close']),
            })

    # Build day index per ticker for fast lookup
    day_index = {}  # ticker -> {day_str: index}
    for t, days in daily_by_ticker.items():
        day_index[t] = {d['day']: i for i, d in enumerate(days)}

    windows = [10, 7, 5, 3, 1]
    vol_by_window = {w: [] for w in windows}
    baseline_vols = []
    er_day_moves = []  # absolute move on earnings day

    matched = 0

    for ev in all_events:
        ticker = ev['ticker']
        edate = ev['date']

        days = daily_by_ticker.get(ticker, [])
        idx = day_index.get(ticker, {})

        if len(days) < 15:
            continue

        # Find earnings date or nearest trading day at or after
        ei = idx.get(edate)
        if ei is None:
            # Find nearest trading day after earnings date
            candidates = [(d_str, i) for d_str, i in idx.items() if d_str >= edate]
            if not candidates:
                # Try nearest before
                candidates = [(d_str, i) for d_str, i in idx.items() if d_str <= edate]
                if not candidates:
                    continue
                candidates.sort(reverse=True)
            else:
                candidates.sort()
            edate, ei = candidates[0]

        if ei < 12:
            continue

        close_list = [d['close'] for d in days]

        # Earnings day move: open-to-close on earnings day
        er_open = days[ei]['open']
        er_close = days[ei]['close']
        if er_open > 0:
            er_move = abs((er_close - er_open) / er_open * 100)
            er_day_moves.append(er_move)

        # Compute daily return volatility at each window before earnings
        for w in windows:
            end = ei  # day before earnings day (compute vol of days leading up)
            start = end - w
            if start < 1:
                continue
            rets = []
            for j in range(start, end):
                if close_list[j - 1] > 0:
                    rets.append((close_list[j] - close_list[j - 1]) / close_list[j - 1] * 100)
            if len(rets) >= 2:
                mean = sum(rets) / len(rets)
                var = sum((r - mean) ** 2 for r in rets) / (len(rets) - 1)
                daily_vol = math.sqrt(var)
                annual_vol = daily_vol * math.sqrt(252)
                vol_by_window[w].append(annual_vol)

        # Baseline: 20-day vol ending 15 days before earnings
        baseline_end = ei - 15
        baseline_start = baseline_end - 20
        if baseline_start >= 1 and baseline_end > baseline_start:
            brets = []
            for j in range(baseline_start, baseline_end):
                if close_list[j - 1] > 0:
                    brets.append((close_list[j] - close_list[j - 1]) / close_list[j - 1] * 100)
            if len(brets) >= 5:
                mean = sum(brets) / len(brets)
                var = sum((r - mean) ** 2 for r in brets) / (len(brets) - 1)
                baseline_vols.append(math.sqrt(var) * math.sqrt(252))

        matched += 1

    print(f'  Earnings events matched to bars: {matched}')

    baseline_avg = sum(baseline_vols) / len(baseline_vols) if baseline_vols else 0

    print(f'\n  Baseline annualized vol (20d, >15d before ER): {baseline_avg:.1f}%')
    print(f'  ({len(baseline_vols)} baseline samples)')
    print(f'\n  {"Window":<20} {"Samples":>10} {"Ann. Vol":>10} {"vs Base":>10}')
    print(f'  {"-"*52}')
    for w in windows:
        vols = vol_by_window[w]
        if not vols:
            print(f'  {w}d before ER       {0:>10} {"—":>10} {"—":>10}')
            continue
        avg = sum(vols) / len(vols)
        ratio = avg / baseline_avg * 100 if baseline_avg > 0 else 0
        print(f'  {w}d before ER       {len(vols):>10} {avg:>9.1f}% {ratio:>8.0f}%')

    # Earnings day move
    if er_day_moves:
        avg_move = sum(er_day_moves) / len(er_day_moves)
        median_move = sorted(er_day_moves)[len(er_day_moves) // 2]
        big_moves = sum(1 for m in er_day_moves if m > 5)
        print(f'\n  Earnings Day Move (open → close):')
        print(f'    Events: {len(er_day_moves)}')
        print(f'    Avg absolute move: {avg_move:.2f}%')
        print(f'    Median absolute move: {median_move:.2f}%')
        print(f'    Moves >5%: {big_moves} ({big_moves/len(er_day_moves)*100:.1f}%)')

    print()


# ─────────────────────────────────────────────────────────────────────────────
# 19) VIX REGIME IMPACT — signal quality by VIX level
# ─────────────────────────────────────────────────────────────────────────────
def vix_regime():
    print('=' * 70)
    print('19) VIX REGIME — signal quality by VIX level')
    print('=' * 70)

    # Get signals with VIX and direction
    cur.execute("""
        SELECT s.signal_id, s.ticker, s.direction, s.created_at,
               s.composite_raw, s.vix_at_signal, s.price_at_signal
        FROM lc_v3.signals s
        WHERE s.vix_at_signal IS NOT NULL
          AND s.price_at_signal IS NOT NULL
          AND s.price_at_signal > 0
    """)
    signals = cur.fetchall()

    print(f'\n  Total signals with VIX data: {len(signals)}')

    if not signals:
        print('  No signals with VIX data found.')
        return

    vix_buckets = {
        'VIX < 15':    {'total': 0, 'correct': 0, 'comp_sum': 0, 'checked': 0},
        'VIX 15-20':   {'total': 0, 'correct': 0, 'comp_sum': 0, 'checked': 0},
        'VIX > 20':    {'total': 0, 'correct': 0, 'comp_sum': 0, 'checked': 0},
    }

    for sig in signals:
        vix = float(sig['vix_at_signal'])
        comp = int(sig['composite_raw']) if sig['composite_raw'] else 0

        if vix < 15:
            bk = 'VIX < 15'
        elif vix <= 20:
            bk = 'VIX 15-20'
        else:
            bk = 'VIX > 20'

        vix_buckets[bk]['total'] += 1
        vix_buckets[bk]['comp_sum'] += comp

        # Check directional accuracy at 1 hour
        ticker = sig['ticker']
        signal_time = sig['created_at']
        direction = sig['direction']
        entry_price = float(sig['price_at_signal'])

        # Find price 1 hour later from bars
        cur.execute("""
            SELECT close FROM lc_v3.bars
            WHERE ticker = %s
              AND ts BETWEEN %s + interval '55 minutes' AND %s + interval '65 minutes'
              AND session = 'REGULAR'
            ORDER BY ts LIMIT 1
        """, (ticker, signal_time, signal_time))
        future = cur.fetchone()

        if future:
            future_price = float(future['close'])
            vix_buckets[bk]['checked'] += 1
            if direction == 'CALL' and future_price > entry_price:
                vix_buckets[bk]['correct'] += 1
            elif direction == 'PUT' and future_price < entry_price:
                vix_buckets[bk]['correct'] += 1

    print(f'\n  {"VIX Bucket":<15} {"Signals":>10} {"Avg Comp":>10} {"Checked":>10} {"Correct":>10} {"Accuracy":>10}')
    print(f'  {"-"*67}')
    for bk in ['VIX < 15', 'VIX 15-20', 'VIX > 20']:
        d = vix_buckets[bk]
        if d['total'] == 0:
            continue
        avg_comp = d['comp_sum'] / d['total']
        if d['checked'] > 0:
            acc = d['correct'] / d['checked'] * 100
            print(f'  {bk:<15} {d["total"]:>10} {avg_comp:>9.1f} {d["checked"]:>10} {d["correct"]:>10} {acc:>9.1f}%')
        else:
            print(f'  {bk:<15} {d["total"]:>10} {avg_comp:>9.1f} {d["checked"]:>10} {"—":>10} {"—":>10}')

    print()


# ─────────────────────────────────────────────────────────────────────────────
# 20) FUNDAMENTAL DETERIORATION — declining revenue + upcoming earnings
# ─────────────────────────────────────────────────────────────────────────────
def fundamental_deterioration():
    print('=' * 70)
    print('20) FUNDAMENTAL DETERIORATION — revenue decline + upcoming earnings')
    print('=' * 70)

    # Get all fundamentals ordered by ticker then period descending
    cur.execute("""
        SELECT f.ticker, f.period, f.revenue, f.gross_profit, f.gross_margin,
               f.free_cash_flow
        FROM lc_v3.fundamentals f
        ORDER BY f.ticker, f.reported_at DESC
    """)
    rows = cur.fetchall()

    # Group by ticker
    by_ticker = {}
    for r in rows:
        t = r['ticker']
        if t not in by_ticker:
            by_ticker[t] = []
        by_ticker[t].append(r)

    # Get earnings intelligence (all tickers, not just those with earnings_date)
    cur.execute("""
        SELECT ticker, earnings_date, iv_rank_30d
        FROM lc_v3.ticker_intelligence
    """)
    intel = {r['ticker']: r for r in cur.fetchall()}

    from datetime import datetime, date
    today = date.today()
    results = []

    for ticker, quarters in by_ticker.items():
        if len(quarters) < 4:
            continue

        # Last 4 quarters (already sorted desc by reported_at)
        last4 = quarters[:4]

        # Count declining revenue quarters in last 3 transitions
        # last4[0] is most recent, last4[3] is oldest
        rev_declines = 0
        for i in range(3):
            newer = last4[i]['revenue']
            older = last4[i + 1]['revenue']
            if newer is not None and older is not None and newer < older:
                rev_declines += 1

        if rev_declines < 2:
            continue

        # Earnings info (optional — show all candidates regardless)
        ti = intel.get(ticker)
        days_to = None
        iv_rank = None
        if ti:
            edate = ti.get('earnings_date')
            if edate:
                if isinstance(edate, str):
                    edate = datetime.strptime(edate, '%Y-%m-%d').date()
                d = (edate - today).days
                if d >= 0 and d <= 60:
                    days_to = d
            if ti.get('iv_rank_30d') is not None:
                iv_rank = float(ti['iv_rank_30d'])

        # Gross margin trend
        gm_vals = [float(q['gross_margin']) for q in last4 if q['gross_margin'] is not None]
        latest_gm = gm_vals[0] if gm_vals else None
        gm_declines = 0
        for i in range(min(3, len(gm_vals) - 1)):
            if gm_vals[i] < gm_vals[i + 1]:
                gm_declines += 1

        # FCF status
        latest_fcf = last4[0]['free_cash_flow']
        fcf_negative = latest_fcf is not None and float(latest_fcf) < 0

        results.append({
            'ticker': ticker,
            'rev_decline_quarters': rev_declines,
            'latest_gm': latest_gm,
            'gm_declining': gm_declines >= 2,
            'fcf_negative': fcf_negative,
            'days_to_earnings': days_to,
            'iv_rank': iv_rank,
        })

    # Sort: most declines first, then nearest earnings
    results.sort(key=lambda x: (-x['rev_decline_quarters'], x['days_to_earnings'] if x['days_to_earnings'] is not None else 9999))

    print(f"\n*** KYNDRYL CANDIDATE LIST — 2+ quarters declining revenue ***")
    print(f"{'TICKER':<8} {'REV↓ Q':>7} {'GROSS M':>8} {'FCF':>8} {'DAYS':>6} {'IV RANK':>8}")
    print('-' * 50)

    if not results:
        print('(none found)')
    else:
        for r in results:
            gm_str = f"{r['latest_gm']*100:.1f}%" if r['latest_gm'] is not None else '—'
            gm_str += '↓' if r['gm_declining'] else ''
            fcf_str = 'NEG' if r['fcf_negative'] else 'OK'
            iv_str = f"{r['iv_rank']:.0f}%" if r['iv_rank'] is not None else '—'
            days_str = str(r['days_to_earnings']) if r['days_to_earnings'] is not None else '—'
            print(f"{r['ticker']:<8} {r['rev_decline_quarters']:>5}/3  {gm_str:>8} {fcf_str:>8} {days_str:>6} {iv_str:>8}")

    # Highlight near-earnings candidates
    near = [r for r in results if r['days_to_earnings'] is not None]
    if near:
        print(f"\n  >> {len(near)} with earnings within 60 days (actionable)")

    print(f"\nTotal: {len(results)} tickers flagged")


# ─────────────────────────────────────────────────────────────────────────────
# 21) FULL UNIVERSE DETERIORATION — revenue decline across both universes
# ─────────────────────────────────────────────────────────────────────────────
def full_universe_deterioration():
    from datetime import datetime, date
    print('=' * 80)
    print('21) FULL UNIVERSE DETERIORATION — declining revenue (equity_profiles + conviction)')
    print('=' * 80)

    # All fundamentals
    cur.execute("""
        SELECT ticker, period, revenue, gross_margin, free_cash_flow, reported_at
        FROM lc_v3.fundamentals
        ORDER BY ticker, reported_at DESC
    """)
    rows = cur.fetchall()

    by_ticker = {}
    for r in rows:
        t = r['ticker']
        if t not in by_ticker:
            by_ticker[t] = []
        by_ticker[t].append(r)

    # Earnings intelligence
    cur.execute("SELECT ticker, earnings_date, iv_rank_30d FROM lc_v3.ticker_intelligence")
    intel = {r['ticker']: r for r in cur.fetchall()}

    # Universe membership
    cur.execute("SELECT ticker FROM lc_v3.equity_profiles")
    core_set = set(r['ticker'] for r in cur.fetchall())
    cur.execute("SELECT ticker FROM lc_v3.conviction_universe")
    conv_set = set(r['ticker'] for r in cur.fetchall())

    today = date.today()
    results = []

    for ticker, quarters in by_ticker.items():
        if len(quarters) < 4:
            continue
        last4 = quarters[:4]

        # Count declining revenue in last 3 transitions
        rev_declines = 0
        for i in range(3):
            newer = last4[i]['revenue']
            older = last4[i + 1]['revenue']
            if newer is not None and older is not None and float(newer) < float(older):
                rev_declines += 1

        if rev_declines < 2:
            continue

        # Gross margin
        latest_gm = float(last4[0]['gross_margin']) if last4[0]['gross_margin'] is not None else None

        # FCF
        latest_fcf = last4[0]['free_cash_flow']
        fcf_negative = latest_fcf is not None and float(latest_fcf) < 0

        # Earnings + IV
        ti = intel.get(ticker)
        days_to = None
        iv_rank = None
        if ti:
            edate = ti.get('earnings_date')
            if edate:
                if isinstance(edate, str):
                    edate = datetime.strptime(edate, '%Y-%m-%d').date()
                d = (edate - today).days
                if 0 <= d <= 90:
                    days_to = d
            if ti.get('iv_rank_30d') is not None:
                iv_rank = float(ti['iv_rank_30d'])

        # Universe
        if ticker in core_set:
            universe = 'CORE'
        elif ticker in conv_set:
            universe = 'CONV'
        else:
            universe = '?'

        results.append({
            'ticker': ticker,
            'rev_declines': rev_declines,
            'latest_gm': latest_gm,
            'fcf_negative': fcf_negative,
            'days_to': days_to,
            'iv_rank': iv_rank,
            'universe': universe,
        })

    results.sort(key=lambda x: (-x['rev_declines'], x['days_to'] if x['days_to'] is not None else 9999))

    print(f"\n{'TICKER':<8} {'REV↓':>5} {'GROSS M':>8} {'FCF':>5} {'DAYS':>6} {'IV':>6} {'UNIV':>6}")
    print('-' * 48)

    if not results:
        print('(none found)')
    else:
        for r in results:
            gm_str = f"{r['latest_gm']*100:.1f}%" if r['latest_gm'] is not None else '—'
            fcf_str = 'NEG' if r['fcf_negative'] else 'OK'
            days_str = str(r['days_to']) if r['days_to'] is not None else '—'
            iv_str = f"{r['iv_rank']:.0f}%" if r['iv_rank'] is not None else '—'
            print(f"{r['ticker']:<8} {r['rev_declines']:>3}/3  {gm_str:>8} {fcf_str:>5} {days_str:>6} {iv_str:>6} {r['universe']:>6}")

    core_cnt = sum(1 for r in results if r['universe'] == 'CORE')
    conv_cnt = sum(1 for r in results if r['universe'] == 'CONV')
    near_cnt = sum(1 for r in results if r['days_to'] is not None)
    print(f"\nTotal: {len(results)} flagged ({core_cnt} core, {conv_cnt} conviction)")
    print(f"  >> {near_cnt} with earnings within 90 days")


# ─────────────────────────────────────────────────────────────────────────────
# 22) GAP UP REVERSAL — gap 2-3% above prev close, red first candle → put signal
# ─────────────────────────────────────────────────────────────────────────────
def gap_up_reversal():
    print('=' * 70)
    print('22) GAP UP REVERSAL — 2-3% gap, red first candle, EOD follow-through')
    print('=' * 70)

    # Build daily OHLC + first bar OHLC from 1-min bars
    # prev_close = previous day's last regular bar close
    # day_open = first regular bar open (9:30 ET)
    # first_bar_close = first regular bar close
    # day_close = last regular bar close
    cur.execute("""
        WITH daily AS (
            SELECT ticker,
                   DATE(ts AT TIME ZONE 'America/New_York') AS day,
                   MIN(ts) AS first_ts,
                   MAX(ts) AS last_ts
            FROM lc_v3.bars
            WHERE session = 'REGULAR'
            GROUP BY ticker, DATE(ts AT TIME ZONE 'America/New_York')
            HAVING COUNT(*) >= 10
        ),
        daily_ohlc AS (
            SELECT d.ticker, d.day,
                   first_bar.open  AS day_open,
                   first_bar.close AS first_bar_close,
                   first_bar.open  AS first_bar_open,
                   last_bar.close  AS day_close,
                   last_bar.high   AS day_high,
                   LAG(last_bar.close) OVER (PARTITION BY d.ticker ORDER BY d.day) AS prev_close
            FROM daily d
            JOIN lc_v3.bars first_bar ON first_bar.ticker = d.ticker AND first_bar.ts = d.first_ts
            JOIN lc_v3.bars last_bar  ON last_bar.ticker  = d.ticker AND last_bar.ts  = d.last_ts
        )
        SELECT * FROM daily_ohlc
        WHERE prev_close IS NOT NULL
        ORDER BY ticker, day
    """)
    rows = cur.fetchall()
    print(f'\n  Total ticker-days with prev close: {len(rows)}')

    # Filter for 2-3% gap ups
    gap_days = []
    for r in rows:
        prev = float(r['prev_close'])
        day_open = float(r['day_open'])
        if prev <= 0:
            continue
        gap_pct = (day_open - prev) / prev
        if 0.02 <= gap_pct <= 0.03:
            gap_days.append({
                'ticker': r['ticker'],
                'day': r['day'],
                'prev_close': prev,
                'day_open': day_open,
                'first_bar_open': float(r['first_bar_open']),
                'first_bar_close': float(r['first_bar_close']),
                'day_close': float(r['day_close']),
                'gap_pct': gap_pct,
            })

    print(f'  Days with 2-3% gap up: {len(gap_days)}')
    if not gap_days:
        print('  (no gap-up days found in data)')
        return

    # Classify first candle
    red_first = [d for d in gap_days if d['first_bar_close'] < d['first_bar_open']]
    green_first = [d for d in gap_days if d['first_bar_close'] >= d['first_bar_open']]

    print(f'  Red first candle:   {len(red_first)} ({len(red_first)/len(gap_days)*100:.1f}%)')
    print(f'  Green first candle: {len(green_first)} ({len(green_first)/len(gap_days)*100:.1f}%)')

    # For red-first-candle days: did stock close below the open? (put wins)
    if red_first:
        put_wins = sum(1 for d in red_first if d['day_close'] < d['day_open'])
        put_wr = put_wins / len(red_first) * 100

        # Average magnitude of the drop (open - close) / open
        drops = [(d['day_open'] - d['day_close']) / d['day_open'] * 100 for d in red_first if d['day_close'] < d['day_open']]
        avg_drop = sum(drops) / len(drops) if drops else 0

        # Losses when it recovers
        recoveries = [(d['day_close'] - d['day_open']) / d['day_open'] * 100 for d in red_first if d['day_close'] >= d['day_open']]
        avg_recovery = sum(recoveries) / len(recoveries) if recoveries else 0

        print(f'\n  RED FIRST CANDLE → PUT RESULTS:')
        print(f'    Sample:      {len(red_first)} days')
        print(f'    Put win rate: {put_wr:.1f}% ({put_wins}/{len(red_first)})')
        print(f'    Avg drop when winning: {avg_drop:.2f}%')
        print(f'    Avg recovery when losing: {avg_recovery:.2f}%')

        # By gap size bucket
        print(f'\n    By gap size:')
        for lo, hi, label in [(0.02, 0.025, '2.0-2.5%'), (0.025, 0.03, '2.5-3.0%')]:
            bucket = [d for d in red_first if lo <= d['gap_pct'] < hi]
            if bucket:
                bw = sum(1 for d in bucket if d['day_close'] < d['day_open'])
                print(f'      {label}: {len(bucket)} days, put WR {bw/len(bucket)*100:.1f}%')

    # Green first candle comparison
    if green_first:
        gf_put_wins = sum(1 for d in green_first if d['day_close'] < d['day_open'])
        gf_wr = gf_put_wins / len(green_first) * 100
        print(f'\n  GREEN FIRST CANDLE → PUT RESULTS (comparison):')
        print(f'    Sample:      {len(green_first)} days')
        print(f'    Put win rate: {gf_wr:.1f}% ({gf_put_wins}/{len(green_first)})')

    # Show individual examples (most recent 10)
    red_first.sort(key=lambda d: d['day'], reverse=True)
    print(f'\n  Recent examples (red first candle):')
    print(f"  {'DATE':<12} {'TICKER':<8} {'GAP%':>6} {'OPEN':>8} {'1st BAR':>8} {'CLOSE':>8} {'RESULT':>8}")
    print(f"  {'-'*62}")
    for d in red_first[:15]:
        result = 'PUT WIN' if d['day_close'] < d['day_open'] else 'LOSS'
        move = (d['day_open'] - d['day_close']) / d['day_open'] * 100
        print(f"  {str(d['day']):<12} {d['ticker']:<8} {d['gap_pct']*100:>5.1f}% {d['day_open']:>8.2f} {d['first_bar_close']:>8.2f} {d['day_close']:>8.2f} {result:>8}")


# ─────────────────────────────────────────────────────────────────────────────
# 23) RELATIVE STRENGTH CONTINUATION — ticker moves >1% while MKT <0.3%
# ─────────────────────────────────────────────────────────────────────────────
def relative_strength_continuation():
    print('=' * 70)
    print('23) RELATIVE STRENGTH CONTINUATION — divergent movers vs SPY')
    print('=' * 70)

    # No SPY in bars — compute market proxy as median ticker change per day
    cur.execute("""
        WITH daily AS (
            SELECT ticker,
                   DATE(ts AT TIME ZONE 'America/New_York') AS day,
                   (ARRAY_AGG(open ORDER BY ts))[1] AS day_open,
                   (ARRAY_AGG(close ORDER BY ts DESC))[1] AS day_close
            FROM lc_v3.bars
            WHERE session = 'REGULAR'
            GROUP BY ticker, DATE(ts AT TIME ZONE 'America/New_York')
            HAVING COUNT(*) >= 10
        )
        SELECT day, AVG((day_close - day_open) / NULLIF(day_open, 0)) AS mkt_change,
               COUNT(*) AS ticker_count
        FROM daily
        WHERE day_open > 0
        GROUP BY day
        HAVING COUNT(*) >= 20
        ORDER BY day
    """)
    mkt_rows = cur.fetchall()
    spy_by_day = {r['day']: {
        'change': float(r['mkt_change']),
        'count': int(r['ticker_count']),
    } for r in mkt_rows}
    print(f'\n  Market proxy days (avg of all tickers): {len(spy_by_day)}')

    # Get all tickers' daily open/close + 2hr mark close
    # 2hr after open = 11:30 ET
    cur.execute("""
        WITH daily AS (
            SELECT ticker,
                   DATE(ts AT TIME ZONE 'America/New_York') AS day,
                   (ARRAY_AGG(open ORDER BY ts))[1] AS day_open,
                   (ARRAY_AGG(close ORDER BY ts DESC))[1] AS day_close
            FROM lc_v3.bars
            WHERE session = 'REGULAR' AND ticker != 'SPY'
            GROUP BY ticker, DATE(ts AT TIME ZONE 'America/New_York')
            HAVING COUNT(*) >= 10
        )
        SELECT * FROM daily ORDER BY ticker, day
    """)
    ticker_rows = cur.fetchall()
    print(f'  Ticker-days (excl SPY): {len(ticker_rows)}')

    # Also fetch the bar closest to 11:30 ET (2hr after open) for each ticker-day
    cur.execute("""
        SELECT DISTINCT ON (ticker, DATE(ts AT TIME ZONE 'America/New_York'))
            ticker,
            DATE(ts AT TIME ZONE 'America/New_York') AS day,
            close AS two_hr_close
        FROM lc_v3.bars
        WHERE session = 'REGULAR'
          AND ticker != 'SPY'
          AND EXTRACT(HOUR FROM ts AT TIME ZONE 'America/New_York') = 11
          AND EXTRACT(MINUTE FROM ts AT TIME ZONE 'America/New_York') BETWEEN 25 AND 34
        ORDER BY ticker, DATE(ts AT TIME ZONE 'America/New_York'),
                 ABS(EXTRACT(MINUTE FROM ts AT TIME ZONE 'America/New_York') - 30)
    """)
    two_hr_rows = cur.fetchall()
    two_hr_map = {}
    for r in two_hr_rows:
        two_hr_map[(r['ticker'], r['day'])] = float(r['two_hr_close'])
    print(f'  Ticker-days with 2hr mark: {len(two_hr_map)}')

    # Find divergent days: ticker >1% move, MKT <0.3%
    bullish_divergent = []  # ticker up >1%, MKT flat
    bearish_divergent = []  # ticker down >1%, MKT flat

    for r in ticker_rows:
        day = r['day']
        if day not in spy_by_day:
            continue
        mkt = spy_by_day[day]
        if abs(mkt['change']) >= 0.003:
            continue  # market moved too much, skip

        day_open = float(r['day_open'])
        day_close = float(r['day_close'])
        if day_open <= 0:
            continue
        ticker_change = (day_close - day_open) / day_open

        two_hr = two_hr_map.get((r['ticker'], day))
        two_hr_change = (two_hr - day_open) / day_open if two_hr else None

        entry = {
            'ticker': r['ticker'],
            'day': day,
            'day_open': day_open,
            'day_close': day_close,
            'ticker_change': ticker_change,
            'spy_change': mkt['change'],
            'two_hr_close': two_hr,
            'two_hr_change': two_hr_change,
        }

        if ticker_change > 0.01:
            bullish_divergent.append(entry)
        elif ticker_change < -0.01:
            bearish_divergent.append(entry)

    print(f'\n  Bullish divergent days (ticker >+1%, MKT <0.3%): {len(bullish_divergent)}')
    print(f'  Bearish divergent days (ticker <-1%, MKT <0.3%): {len(bearish_divergent)}')

    # ── BULLISH DIVERGENCE ANALYSIS ──
    if bullish_divergent:
        # Next-day continuation: did ticker stay up or extend?
        # We measure at 2hr mark and EOD
        with_2hr = [d for d in bullish_divergent if d['two_hr_change'] is not None]

        # At 2hr mark: was ticker already positive?
        two_hr_pos = sum(1 for d in with_2hr if d['two_hr_change'] > 0)
        avg_2hr = sum(d['two_hr_change'] for d in with_2hr) / len(with_2hr) * 100 if with_2hr else 0

        # EOD: positive?
        eod_pos = sum(1 for d in bullish_divergent if d['ticker_change'] > 0)
        avg_eod = sum(d['ticker_change'] for d in bullish_divergent) / len(bullish_divergent) * 100

        print(f'\n  BULLISH DIVERGENCE (ticker up, MKT flat):')
        print(f'    Total days:             {len(bullish_divergent)}')
        print(f'    At 2hr: positive         {two_hr_pos}/{len(with_2hr)} ({two_hr_pos/len(with_2hr)*100:.1f}%)' if with_2hr else '    At 2hr: no data')
        print(f'    At 2hr: avg move         {avg_2hr:+.2f}%' if with_2hr else '')
        print(f'    At EOD: positive         {eod_pos}/{len(bullish_divergent)} ({eod_pos/len(bullish_divergent)*100:.1f}%)')
        print(f'    At EOD: avg move         {avg_eod:+.2f}%')

        # By magnitude bucket
        print(f'\n    By intraday magnitude:')
        for lo, hi, label in [(0.01, 0.02, '1-2%'), (0.02, 0.03, '2-3%'), (0.03, 1.0, '3%+')]:
            bucket = [d for d in bullish_divergent if lo <= d['ticker_change'] < hi]
            if bucket:
                bw = sum(d['ticker_change'] for d in bucket) / len(bucket) * 100
                print(f'      {label}: {len(bucket)} days, avg EOD move {bw:+.2f}%')

    # ── BEARISH DIVERGENCE ANALYSIS ──
    if bearish_divergent:
        with_2hr = [d for d in bearish_divergent if d['two_hr_change'] is not None]

        two_hr_neg = sum(1 for d in with_2hr if d['two_hr_change'] < 0)
        avg_2hr = sum(d['two_hr_change'] for d in with_2hr) / len(with_2hr) * 100 if with_2hr else 0

        eod_neg = sum(1 for d in bearish_divergent if d['ticker_change'] < 0)
        avg_eod = sum(d['ticker_change'] for d in bearish_divergent) / len(bearish_divergent) * 100

        print(f'\n  BEARISH DIVERGENCE (ticker down, MKT flat):')
        print(f'    Total days:             {len(bearish_divergent)}')
        print(f'    At 2hr: negative         {two_hr_neg}/{len(with_2hr)} ({two_hr_neg/len(with_2hr)*100:.1f}%)' if with_2hr else '    At 2hr: no data')
        print(f'    At 2hr: avg move         {avg_2hr:+.2f}%' if with_2hr else '')
        print(f'    At EOD: negative         {eod_neg}/{len(bearish_divergent)} ({eod_neg/len(bearish_divergent)*100:.1f}%)')
        print(f'    At EOD: avg move         {avg_eod:+.2f}%')

        # These are the green-day put candidates
        print(f'\n    PUT OPPORTUNITY (bearish divergence on flat SPY):')
        put_wins = sum(1 for d in bearish_divergent if d['day_close'] < d['day_open'])
        avg_drop = sum(abs(d['ticker_change']) for d in bearish_divergent if d['day_close'] < d['day_open']) / max(1, put_wins) * 100
        print(f'      Put win rate: {put_wins/len(bearish_divergent)*100:.1f}%')
        print(f'      Avg drop magnitude: {avg_drop:.2f}%')

        print(f'\n    By intraday magnitude:')
        for lo, hi, label in [(0.01, 0.02, '1-2%'), (0.02, 0.03, '2-3%'), (0.03, 1.0, '3%+')]:
            bucket = [d for d in bearish_divergent if lo <= abs(d['ticker_change']) < hi]
            if bucket:
                bw = sum(abs(d['ticker_change']) for d in bucket) / len(bucket) * 100
                print(f'      {label}: {len(bucket)} days, avg magnitude {bw:.2f}%')

    # Recent examples (bearish — green day candidates)
    bearish_divergent.sort(key=lambda d: d['day'], reverse=True)
    if bearish_divergent:
        print(f'\n  Recent bearish divergence examples:')
        print(f"  {'DATE':<12} {'TICKER':<8} {'TKR CHG':>8} {'MKT CHG':>8} {'2HR':>8} {'EOD':>8}")
        print(f"  {'-'*58}")
        for d in bearish_divergent[:15]:
            two_hr_str = f"{d['two_hr_change']*100:+.1f}%" if d['two_hr_change'] is not None else '—'
            print(f"  {str(d['day']):<12} {d['ticker']:<8} {d['ticker_change']*100:>+7.1f}% {d['spy_change']*100:>+7.2f}% {two_hr_str:>8} {d['ticker_change']*100:>+7.1f}%")


# ─────────────────────────────────────────────────────────────────────────────
# 24) RELATIVE STRENGTH VALIDATION — deep dive on analysis 23
# ─────────────────────────────────────────────────────────────────────────────
def relative_strength_validation():
    import statistics

    print('=' * 70)
    print('24) RELATIVE STRENGTH VALIDATION — artifact check')
    print('=' * 70)

    # ── CRITICAL NOTE ────────────────────────────────────────────────────────
    # Analysis 23 used EOD open→close to DEFINE the divergence AND measure
    # the outcome. That's circular — 100% win rate is guaranteed by
    # construction. The real test: if at an INTRADAY checkpoint the ticker
    # is diverging from market, does it CONTINUE into EOD?
    #
    # New approach:
    #   Signal = at 11:30 ET (2hr), ticker is down >1% from open while
    #            market avg is flat (<0.3%)
    #   Outcome = did ticker close below the 11:30 ET price? (continuation)
    # ─────────────────────────────────────────────────────────────────────────

    print('\n  NOTE: Analysis 23 had a circular definition (EOD change used')
    print('  as both signal and outcome). This analysis fixes that by using')
    print('  the 2hr mark (11:30 ET) as the signal point and measuring')
    print('  continuation from 2hr → EOD.\n')

    # Market proxy: avg ticker change at 2hr mark AND at EOD per day
    cur.execute("""
        WITH daily AS (
            SELECT ticker,
                   DATE(ts AT TIME ZONE 'America/New_York') AS day,
                   (ARRAY_AGG(open ORDER BY ts))[1] AS day_open,
                   (ARRAY_AGG(close ORDER BY ts DESC))[1] AS day_close
            FROM lc_v3.bars
            WHERE session = 'REGULAR'
            GROUP BY ticker, DATE(ts AT TIME ZONE 'America/New_York')
            HAVING COUNT(*) >= 10
        )
        SELECT day,
               AVG((day_close - day_open) / NULLIF(day_open, 0)) AS mkt_eod_change,
               COUNT(*) AS ticker_count
        FROM daily
        WHERE day_open > 0
        GROUP BY day
        HAVING COUNT(*) >= 20
        ORDER BY day
    """)
    mkt_rows = cur.fetchall()
    mkt_by_day = {r['day']: {
        'eod_change': float(r['mkt_eod_change']),
        'count': int(r['ticker_count']),
    } for r in mkt_rows}

    # Market avg at 2hr mark
    cur.execute("""
        WITH bars_2hr AS (
            SELECT DISTINCT ON (ticker, DATE(ts AT TIME ZONE 'America/New_York'))
                ticker,
                DATE(ts AT TIME ZONE 'America/New_York') AS day,
                close AS two_hr_close
            FROM lc_v3.bars
            WHERE session = 'REGULAR'
              AND EXTRACT(HOUR FROM ts AT TIME ZONE 'America/New_York') = 11
              AND EXTRACT(MINUTE FROM ts AT TIME ZONE 'America/New_York') BETWEEN 25 AND 34
            ORDER BY ticker, DATE(ts AT TIME ZONE 'America/New_York'),
                     ABS(EXTRACT(MINUTE FROM ts AT TIME ZONE 'America/New_York') - 30)
        ),
        day_opens AS (
            SELECT ticker,
                   DATE(ts AT TIME ZONE 'America/New_York') AS day,
                   (ARRAY_AGG(open ORDER BY ts))[1] AS day_open
            FROM lc_v3.bars
            WHERE session = 'REGULAR'
            GROUP BY ticker, DATE(ts AT TIME ZONE 'America/New_York')
        )
        SELECT b.day,
               AVG((b.two_hr_close - d.day_open) / NULLIF(d.day_open, 0)) AS mkt_2hr_change,
               COUNT(*) AS cnt
        FROM bars_2hr b
        JOIN day_opens d ON d.ticker = b.ticker AND d.day = b.day
        WHERE d.day_open > 0
        GROUP BY b.day
        HAVING COUNT(*) >= 20
        ORDER BY b.day
    """)
    mkt_2hr_rows = cur.fetchall()
    for r in mkt_2hr_rows:
        if r['day'] in mkt_by_day:
            mkt_by_day[r['day']]['two_hr_change'] = float(r['mkt_2hr_change'])

    print(f'  Trading days with market proxy: {len(mkt_by_day)}')

    # Per-ticker: open, 2hr close, EOD close
    cur.execute("""
        WITH day_opens AS (
            SELECT ticker,
                   DATE(ts AT TIME ZONE 'America/New_York') AS day,
                   (ARRAY_AGG(open ORDER BY ts))[1] AS day_open,
                   (ARRAY_AGG(close ORDER BY ts DESC))[1] AS day_close
            FROM lc_v3.bars
            WHERE session = 'REGULAR'
            GROUP BY ticker, DATE(ts AT TIME ZONE 'America/New_York')
            HAVING COUNT(*) >= 10
        ),
        bars_2hr AS (
            SELECT DISTINCT ON (ticker, DATE(ts AT TIME ZONE 'America/New_York'))
                ticker,
                DATE(ts AT TIME ZONE 'America/New_York') AS day,
                close AS two_hr_close
            FROM lc_v3.bars
            WHERE session = 'REGULAR'
              AND EXTRACT(HOUR FROM ts AT TIME ZONE 'America/New_York') = 11
              AND EXTRACT(MINUTE FROM ts AT TIME ZONE 'America/New_York') BETWEEN 25 AND 34
            ORDER BY ticker, DATE(ts AT TIME ZONE 'America/New_York'),
                     ABS(EXTRACT(MINUTE FROM ts AT TIME ZONE 'America/New_York') - 30)
        )
        SELECT d.ticker, d.day, d.day_open, d.day_close, b.two_hr_close
        FROM day_opens d
        JOIN bars_2hr b ON b.ticker = d.ticker AND b.day = d.day
        WHERE d.day_open > 0
        ORDER BY d.ticker, d.day
    """)
    ticker_rows = cur.fetchall()
    print(f'  Ticker-days with 2hr data: {len(ticker_rows)}')

    # ── SIGNAL: at 2hr, ticker down >1% from open, market 2hr change <0.3% ──
    bearish_signals = []
    bullish_signals = []

    for r in ticker_rows:
        day = r['day']
        if day not in mkt_by_day or 'two_hr_change' not in mkt_by_day[day]:
            continue
        mkt = mkt_by_day[day]
        if abs(mkt['two_hr_change']) >= 0.003:
            continue  # market not flat at 2hr

        day_open = float(r['day_open'])
        two_hr = float(r['two_hr_close'])
        day_close = float(r['day_close'])
        change_at_2hr = (two_hr - day_open) / day_open
        eod_change = (day_close - day_open) / day_open
        continuation = (day_close - two_hr) / two_hr  # 2hr → EOD

        entry = {
            'ticker': r['ticker'],
            'day': day,
            'day_open': day_open,
            'two_hr': two_hr,
            'day_close': day_close,
            'change_at_2hr': change_at_2hr,
            'eod_change': eod_change,
            'continuation': continuation,
            'mkt_2hr': mkt['two_hr_change'],
            'mkt_eod': mkt['eod_change'],
        }

        if change_at_2hr < -0.01:
            bearish_signals.append(entry)
        elif change_at_2hr > 0.01:
            bullish_signals.append(entry)

    # ══════════════════════════════════════════════════════════════════════════
    # BEARISH DIVERGENCE VALIDATION
    # ══════════════════════════════════════════════════════════════════════════
    print(f'\n  {"="*60}')
    print(f'  BEARISH: ticker down >1% at 2hr, market flat (<0.3%)')
    print(f'  {"="*60}')
    print(f'  Sample size: {len(bearish_signals)}')

    if bearish_signals:
        # Distribution of 2hr → EOD continuation
        conts = [d['continuation'] * 100 for d in bearish_signals]
        eods = [d['eod_change'] * 100 for d in bearish_signals]
        mkt_vals = [d['mkt_2hr'] * 100 for d in bearish_signals]
        mkt_eods = [d['mkt_eod'] * 100 for d in bearish_signals]

        conts.sort()
        eods.sort()

        def pctl(arr, p):
            k = (len(arr) - 1) * p / 100
            f = int(k)
            c = f + 1 if f + 1 < len(arr) else f
            return arr[f] + (k - f) * (arr[c] - arr[f])

        print(f'\n  Market confirmation (avg market change on these days):')
        print(f'    Avg MKT at 2hr:   {sum(mkt_vals)/len(mkt_vals):+.3f}%')
        print(f'    Avg MKT at EOD:   {sum(mkt_eods)/len(mkt_eods):+.3f}%')
        print(f'    Max MKT at 2hr:   {max(mkt_vals):+.3f}%')
        print(f'    Min MKT at 2hr:   {min(mkt_vals):+.3f}%')

        print(f'\n  EOD return distribution (open → close):')
        print(f'    Worst:    {eods[0]:+.2f}%')
        print(f'    P25:      {pctl(eods, 25):+.2f}%')
        print(f'    Median:   {pctl(eods, 50):+.2f}%')
        print(f'    P75:      {pctl(eods, 75):+.2f}%')
        print(f'    Best:     {eods[-1]:+.2f}%')
        print(f'    Mean:     {sum(eods)/len(eods):+.2f}%')
        print(f'    Std dev:  {statistics.stdev(eods):.2f}%')

        print(f'\n  CONTINUATION (2hr → EOD) — THE REAL TEST:')
        cont_neg = sum(1 for c in conts if c < 0)
        print(f'    Continued lower:   {cont_neg}/{len(conts)} ({cont_neg/len(conts)*100:.1f}%)')
        print(f'    Worst:    {conts[0]:+.2f}%')
        print(f'    P25:      {pctl(conts, 25):+.2f}%')
        print(f'    Median:   {pctl(conts, 50):+.2f}%')
        print(f'    P75:      {pctl(conts, 75):+.2f}%')
        print(f'    Best:     {conts[-1]:+.2f}%')
        print(f'    Mean:     {sum(conts)/len(conts):+.2f}%')

        # By how far down at 2hr
        print(f'\n  By signal strength (how far down at 2hr):')
        for lo, hi, label in [(-0.02, -0.01, '1-2% down'), (-0.03, -0.02, '2-3% down'), (-1.0, -0.03, '3%+ down')]:
            bucket = [d for d in bearish_signals if lo <= d['change_at_2hr'] < hi]
            if bucket:
                bc = [d['continuation'] * 100 for d in bucket]
                bc.sort()
                cont_pct = sum(1 for c in bc if c < 0) / len(bc) * 100
                print(f'      {label}: {len(bucket)} days, continued lower {cont_pct:.0f}%, median cont {pctl(bc, 50):+.2f}%')

        # By unique date — how many distinct days?
        unique_days = set(d['day'] for d in bearish_signals)
        unique_tickers = set(d['ticker'] for d in bearish_signals)
        print(f'\n  Concentration check:')
        print(f'    Unique days:    {len(unique_days)}')
        print(f'    Unique tickers: {len(unique_tickers)}')
        print(f'    Avg signals/day: {len(bearish_signals)/len(unique_days):.1f}')

        # Signals per day distribution
        from collections import Counter
        day_counts = Counter(d['day'] for d in bearish_signals)
        print(f'    Day with most:   {max(day_counts.values())} signals on {max(day_counts, key=day_counts.get)}')
        print(f'    Days with 1 sig: {sum(1 for v in day_counts.values() if v == 1)}')
        print(f'    Days with 5+:    {sum(1 for v in day_counts.values() if v >= 5)}')

        # Top tickers by frequency
        ticker_counts = Counter(d['ticker'] for d in bearish_signals)
        print(f'\n  Most frequent tickers:')
        for tkr, cnt in ticker_counts.most_common(10):
            subset = [d for d in bearish_signals if d['ticker'] == tkr]
            avg_cont = sum(d['continuation'] for d in subset) / len(subset) * 100
            print(f'    {tkr:<8} {cnt} days, avg continuation {avg_cont:+.2f}%')

        # Recent examples
        bearish_signals.sort(key=lambda d: d['day'], reverse=True)
        print(f'\n  Recent bearish signals:')
        print(f"  {'DATE':<12} {'TICKER':<8} {'AT 2HR':>8} {'EOD':>8} {'CONT':>8} {'MKT 2HR':>8}")
        print(f"  {'-'*58}")
        for d in bearish_signals[:20]:
            result = 'v' if d['continuation'] < 0 else '^'
            print(f"  {str(d['day']):<12} {d['ticker']:<8} {d['change_at_2hr']*100:>+7.1f}% {d['eod_change']*100:>+7.1f}% {d['continuation']*100:>+7.2f}% {d['mkt_2hr']*100:>+7.2f}% {result}")

    # ══════════════════════════════════════════════════════════════════════════
    # BULLISH DIVERGENCE VALIDATION
    # ══════════════════════════════════════════════════════════════════════════
    print(f'\n  {"="*60}')
    print(f'  BULLISH: ticker up >1% at 2hr, market flat (<0.3%)')
    print(f'  {"="*60}')
    print(f'  Sample size: {len(bullish_signals)}')

    if bullish_signals:
        conts = [d['continuation'] * 100 for d in bullish_signals]
        eods = [d['eod_change'] * 100 for d in bullish_signals]
        mkt_vals = [d['mkt_2hr'] * 100 for d in bullish_signals]
        mkt_eods = [d['mkt_eod'] * 100 for d in bullish_signals]

        conts.sort()
        eods.sort()

        def pctl(arr, p):
            k = (len(arr) - 1) * p / 100
            f = int(k)
            c = f + 1 if f + 1 < len(arr) else f
            return arr[f] + (k - f) * (arr[c] - arr[f])

        print(f'\n  Market confirmation:')
        print(f'    Avg MKT at 2hr:   {sum(mkt_vals)/len(mkt_vals):+.3f}%')
        print(f'    Avg MKT at EOD:   {sum(mkt_eods)/len(mkt_eods):+.3f}%')

        print(f'\n  EOD return distribution (open → close):')
        print(f'    Worst:    {eods[0]:+.2f}%')
        print(f'    P25:      {pctl(eods, 25):+.2f}%')
        print(f'    Median:   {pctl(eods, 50):+.2f}%')
        print(f'    P75:      {pctl(eods, 75):+.2f}%')
        print(f'    Best:     {eods[-1]:+.2f}%')
        print(f'    Mean:     {sum(eods)/len(eods):+.2f}%')

        print(f'\n  CONTINUATION (2hr → EOD):')
        cont_pos = sum(1 for c in conts if c > 0)
        print(f'    Continued higher:  {cont_pos}/{len(conts)} ({cont_pos/len(conts)*100:.1f}%)')
        print(f'    Worst:    {conts[0]:+.2f}%')
        print(f'    P25:      {pctl(conts, 25):+.2f}%')
        print(f'    Median:   {pctl(conts, 50):+.2f}%')
        print(f'    P75:      {pctl(conts, 75):+.2f}%')
        print(f'    Best:     {conts[-1]:+.2f}%')
        print(f'    Mean:     {sum(conts)/len(conts):+.2f}%')

        # By signal strength
        print(f'\n  By signal strength (how far up at 2hr):')
        for lo, hi, label in [(0.01, 0.02, '1-2% up'), (0.02, 0.03, '2-3% up'), (0.03, 1.0, '3%+ up')]:
            bucket = [d for d in bullish_signals if lo <= d['change_at_2hr'] < hi]
            if bucket:
                bc = [d['continuation'] * 100 for d in bucket]
                bc.sort()
                cont_pct = sum(1 for c in bc if c > 0) / len(bc) * 100
                print(f'      {label}: {len(bucket)} days, continued higher {cont_pct:.0f}%, median cont {pctl(bc, 50):+.2f}%')

        # Concentration
        unique_days = set(d['day'] for d in bullish_signals)
        unique_tickers = set(d['ticker'] for d in bullish_signals)
        print(f'\n  Concentration check:')
        print(f'    Unique days:    {len(unique_days)}')
        print(f'    Unique tickers: {len(unique_tickers)}')
        print(f'    Avg signals/day: {len(bullish_signals)/len(unique_days):.1f}')

        from collections import Counter
        day_counts = Counter(d['day'] for d in bullish_signals)
        print(f'    Day with most:   {max(day_counts.values())} signals on {max(day_counts, key=day_counts.get)}')


# ─────────────────────────────────────────────────────────────────────────────
# SHARED: build market proxy + per-ticker daily data for green-day analyses
# ─────────────────────────────────────────────────────────────────────────────
def _build_green_day_data():
    """Returns (green_days dict, ticker_daily list, ticker_1hr dict, ticker_2hr dict)"""
    import statistics

    # Market proxy: avg ticker open→close per day
    cur.execute("""
        WITH daily AS (
            SELECT ticker,
                   DATE(ts AT TIME ZONE 'America/New_York') AS day,
                   (ARRAY_AGG(open ORDER BY ts))[1] AS day_open,
                   (ARRAY_AGG(close ORDER BY ts DESC))[1] AS day_close
            FROM lc_v3.bars
            WHERE session = 'REGULAR'
            GROUP BY ticker, DATE(ts AT TIME ZONE 'America/New_York')
            HAVING COUNT(*) >= 10
        )
        SELECT day,
               AVG((day_close - day_open) / NULLIF(day_open, 0)) AS mkt_change,
               COUNT(*) AS ticker_count
        FROM daily WHERE day_open > 0
        GROUP BY day HAVING COUNT(*) >= 20
        ORDER BY day
    """)
    mkt_rows = cur.fetchall()
    green_days = {}
    for r in mkt_rows:
        chg = float(r['mkt_change'])
        if chg > 0.005:
            green_days[r['day']] = chg
    print(f'  Market proxy days: {len(mkt_rows)}, green days (>+0.5%): {len(green_days)}')
    if green_days:
        for d, c in sorted(green_days.items()):
            print(f'    {d}  MKT: {c*100:+.2f}%')

    # Per-ticker daily: open (first bar), close (last bar), prev_close, first bar OHLC
    cur.execute("""
        WITH daily AS (
            SELECT ticker,
                   DATE(ts AT TIME ZONE 'America/New_York') AS day,
                   MIN(ts) AS first_ts,
                   MAX(ts) AS last_ts
            FROM lc_v3.bars
            WHERE session = 'REGULAR'
            GROUP BY ticker, DATE(ts AT TIME ZONE 'America/New_York')
            HAVING COUNT(*) >= 10
        ),
        daily_ohlc AS (
            SELECT d.ticker, d.day,
                   fb.open  AS day_open,
                   fb.close AS first_bar_close,
                   fb.open  AS first_bar_open,
                   fb.high  AS first_bar_high,
                   fb.low   AS first_bar_low,
                   lb.close AS day_close,
                   lb.high  AS day_high,
                   lb.low   AS day_low,
                   LAG(lb.close) OVER (PARTITION BY d.ticker ORDER BY d.day) AS prev_close
            FROM daily d
            JOIN lc_v3.bars fb ON fb.ticker = d.ticker AND fb.ts = d.first_ts
            JOIN lc_v3.bars lb ON lb.ticker = d.ticker AND lb.ts = d.last_ts
        )
        SELECT * FROM daily_ohlc WHERE prev_close IS NOT NULL ORDER BY ticker, day
    """)
    ticker_daily = cur.fetchall()

    # 1hr mark (10:30 ET)
    cur.execute("""
        SELECT DISTINCT ON (ticker, DATE(ts AT TIME ZONE 'America/New_York'))
            ticker,
            DATE(ts AT TIME ZONE 'America/New_York') AS day,
            close AS one_hr_close
        FROM lc_v3.bars
        WHERE session = 'REGULAR'
          AND EXTRACT(HOUR FROM ts AT TIME ZONE 'America/New_York') = 10
          AND EXTRACT(MINUTE FROM ts AT TIME ZONE 'America/New_York') BETWEEN 25 AND 34
        ORDER BY ticker, DATE(ts AT TIME ZONE 'America/New_York'),
                 ABS(EXTRACT(MINUTE FROM ts AT TIME ZONE 'America/New_York') - 30)
    """)
    ticker_1hr = {(r['ticker'], r['day']): float(r['one_hr_close']) for r in cur.fetchall()}

    # 2hr mark (11:30 ET)
    cur.execute("""
        SELECT DISTINCT ON (ticker, DATE(ts AT TIME ZONE 'America/New_York'))
            ticker,
            DATE(ts AT TIME ZONE 'America/New_York') AS day,
            close AS two_hr_close
        FROM lc_v3.bars
        WHERE session = 'REGULAR'
          AND EXTRACT(HOUR FROM ts AT TIME ZONE 'America/New_York') = 11
          AND EXTRACT(MINUTE FROM ts AT TIME ZONE 'America/New_York') BETWEEN 25 AND 34
        ORDER BY ticker, DATE(ts AT TIME ZONE 'America/New_York'),
                 ABS(EXTRACT(MINUTE FROM ts AT TIME ZONE 'America/New_York') - 30)
    """)
    ticker_2hr = {(r['ticker'], r['day']): float(r['two_hr_close']) for r in cur.fetchall()}

    return green_days, ticker_daily, ticker_1hr, ticker_2hr


def pctl(arr, p):
    """Percentile from sorted array"""
    if not arr:
        return 0
    k = (len(arr) - 1) * p / 100
    f = int(k)
    c = f + 1 if f + 1 < len(arr) else f
    return arr[f] + (k - f) * (arr[c] - arr[f])


# ─────────────────────────────────────────────────────────────────────────────
# 25) GREEN DAY GAP UPS — ticker gaps up 2-3% on a green market day
# ─────────────────────────────────────────────────────────────────────────────
def green_day_gap_ups():
    import statistics

    print('=' * 70)
    print('25) GREEN DAY GAP UPS — individual stock gap 2-3% on MKT up >0.5%')
    print('=' * 70)

    green_days, ticker_daily, ticker_1hr, ticker_2hr = _build_green_day_data()

    if not green_days:
        print('  No green days found in data.')
        return

    # Filter: ticker gapped up 2-3% from prev close AND day is green
    gap_ups = []
    for r in ticker_daily:
        day = r['day']
        if day not in green_days:
            continue
        prev = float(r['prev_close'])
        day_open = float(r['day_open'])
        if prev <= 0:
            continue
        gap_pct = (day_open - prev) / prev
        if not (0.02 <= gap_pct <= 0.03):
            continue

        first_bar_open = float(r['first_bar_open'])
        first_bar_close = float(r['first_bar_close'])
        day_close = float(r['day_close'])
        one_hr = ticker_1hr.get((r['ticker'], day))
        two_hr = ticker_2hr.get((r['ticker'], day))

        gap_ups.append({
            'ticker': r['ticker'],
            'day': day,
            'prev_close': prev,
            'day_open': day_open,
            'first_bar_open': first_bar_open,
            'first_bar_close': first_bar_close,
            'day_close': day_close,
            'gap_pct': gap_pct,
            'first_candle_red': first_bar_close < first_bar_open,
            'eod_change': (day_close - day_open) / day_open,
            'one_hr': one_hr,
            'two_hr': two_hr,
            'one_hr_change': (one_hr - day_open) / day_open if one_hr else None,
            'two_hr_change': (two_hr - day_open) / day_open if two_hr else None,
            'mkt_change': green_days[day],
        })

    print(f'\n  Ticker-days with 2-3% gap up on green days: {len(gap_ups)}')
    if not gap_ups:
        print('  (none found)')
        return

    red_first = [d for d in gap_ups if d['first_candle_red']]
    green_first = [d for d in gap_ups if not d['first_candle_red']]

    print(f'  Red first candle:   {len(red_first)} ({len(red_first)/len(gap_ups)*100:.1f}%)')
    print(f'  Green first candle: {len(green_first)} ({len(green_first)/len(gap_ups)*100:.1f}%)')

    # ── RED FIRST CANDLE → PUT SIGNAL ──
    if red_first:
        put_wins = sum(1 for d in red_first if d['day_close'] < d['day_open'])
        eods = sorted([d['eod_change'] * 100 for d in red_first])

        print(f'\n  RED FIRST CANDLE → PUT:')
        print(f'    Sample:       {len(red_first)}')
        print(f'    Put win rate: {put_wins/len(red_first)*100:.1f}% ({put_wins}/{len(red_first)})')
        print(f'    EOD return distribution:')
        print(f'      Worst:  {eods[0]:+.2f}%  |  P25: {pctl(eods,25):+.2f}%  |  Median: {pctl(eods,50):+.2f}%')
        print(f'      P75: {pctl(eods,75):+.2f}%  |  Best: {eods[-1]:+.2f}%  |  Mean: {sum(eods)/len(eods):+.2f}%')

        # 1hr and 2hr checkpoints
        with_1hr = [d for d in red_first if d['one_hr_change'] is not None]
        if with_1hr:
            down_1hr = sum(1 for d in with_1hr if d['one_hr_change'] < 0)
            avg_1hr = sum(d['one_hr_change'] for d in with_1hr) / len(with_1hr) * 100
            print(f'    At 1hr: {down_1hr}/{len(with_1hr)} still negative, avg {avg_1hr:+.2f}%')

        print(f'\n    Examples:')
        print(f"    {'DATE':<12} {'TICKER':<8} {'GAP':>6} {'1stBAR':>8} {'1HR':>8} {'EOD':>8} {'MKT':>8}")
        print(f"    {'-'*62}")
        for d in sorted(red_first, key=lambda x: x['day'], reverse=True)[:15]:
            fb = 'RED'
            o1 = f"{d['one_hr_change']*100:+.1f}%" if d['one_hr_change'] is not None else '—'
            result = 'PUT WIN' if d['day_close'] < d['day_open'] else 'LOSS'
            print(f"    {str(d['day']):<12} {d['ticker']:<8} {d['gap_pct']*100:>5.1f}% {fb:>8} {o1:>8} {d['eod_change']*100:>+7.1f}% {d['mkt_change']*100:>+7.1f}%")

    # ── GREEN FIRST CANDLE → CALL SIGNAL ──
    if green_first:
        call_wins = sum(1 for d in green_first if d['day_close'] > d['day_open'])
        eods = sorted([d['eod_change'] * 100 for d in green_first])

        print(f'\n  GREEN FIRST CANDLE → CALL:')
        print(f'    Sample:        {len(green_first)}')
        print(f'    Call win rate:  {call_wins/len(green_first)*100:.1f}% ({call_wins}/{len(green_first)})')
        print(f'    EOD return distribution:')
        print(f'      Worst:  {eods[0]:+.2f}%  |  P25: {pctl(eods,25):+.2f}%  |  Median: {pctl(eods,50):+.2f}%')
        print(f'      P75: {pctl(eods,75):+.2f}%  |  Best: {eods[-1]:+.2f}%  |  Mean: {sum(eods)/len(eods):+.2f}%')

        print(f'\n    Examples:')
        print(f"    {'DATE':<12} {'TICKER':<8} {'GAP':>6} {'1stBAR':>8} {'1HR':>8} {'EOD':>8} {'MKT':>8}")
        print(f"    {'-'*62}")
        for d in sorted(green_first, key=lambda x: x['day'], reverse=True)[:15]:
            o1 = f"{d['one_hr_change']*100:+.1f}%" if d['one_hr_change'] is not None else '—'
            print(f"    {str(d['day']):<12} {d['ticker']:<8} {d['gap_pct']*100:>5.1f}% {'GREEN':>8} {o1:>8} {d['eod_change']*100:>+7.1f}% {d['mkt_change']*100:>+7.1f}%")


# ─────────────────────────────────────────────────────────────────────────────
# 26) PRE-MARKET MOVERS ON GREEN DAYS — open >2% above prev close
# ─────────────────────────────────────────────────────────────────────────────
def green_day_premarket_movers():
    import statistics

    print('=' * 70)
    print('26) PRE-MARKET MOVERS — open >2% above prev close on green days')
    print('=' * 70)

    green_days, ticker_daily, ticker_1hr, ticker_2hr = _build_green_day_data()

    if not green_days:
        print('  No green days found.')
        return

    # Any ticker that opened >2% above prev close on a green day
    movers = []
    for r in ticker_daily:
        day = r['day']
        if day not in green_days:
            continue
        prev = float(r['prev_close'])
        day_open = float(r['day_open'])
        day_close = float(r['day_close'])
        if prev <= 0:
            continue
        premarket_gap = (day_open - prev) / prev
        if premarket_gap <= 0.02:
            continue

        one_hr = ticker_1hr.get((r['ticker'], day))
        two_hr = ticker_2hr.get((r['ticker'], day))

        movers.append({
            'ticker': r['ticker'],
            'day': day,
            'prev_close': prev,
            'day_open': day_open,
            'day_close': day_close,
            'premarket_gap': premarket_gap,
            'eod_change': (day_close - day_open) / day_open,
            'one_hr': one_hr,
            'one_hr_change': (one_hr - day_open) / day_open if one_hr else None,
            'two_hr': two_hr,
            'two_hr_change': (two_hr - day_open) / day_open if two_hr else None,
            'mkt_change': green_days[day],
        })

    print(f'\n  Tickers up >2% pre-market on green days: {len(movers)}')
    if not movers:
        print('  (none found)')
        return

    # Does pre-market strength continue or fade?
    eods = sorted([d['eod_change'] * 100 for d in movers])
    faded = sum(1 for d in movers if d['eod_change'] < 0)  # opened up, closed below open
    continued = sum(1 for d in movers if d['eod_change'] > 0)

    print(f'\n  INTRADAY OUTCOME (from open):')
    print(f'    Continued up (close > open): {continued}/{len(movers)} ({continued/len(movers)*100:.1f}%)')
    print(f'    Faded (close < open):        {faded}/{len(movers)} ({faded/len(movers)*100:.1f}%)')
    print(f'    EOD distribution:')
    print(f'      Worst:  {eods[0]:+.2f}%  |  P25: {pctl(eods,25):+.2f}%  |  Median: {pctl(eods,50):+.2f}%')
    print(f'      P75: {pctl(eods,75):+.2f}%  |  Best: {eods[-1]:+.2f}%  |  Mean: {sum(eods)/len(eods):+.2f}%')

    # First hour
    with_1hr = [d for d in movers if d['one_hr_change'] is not None]
    if with_1hr:
        hrs = sorted([d['one_hr_change'] * 100 for d in with_1hr])
        up_1hr = sum(1 for d in with_1hr if d['one_hr_change'] > 0)
        print(f'\n  FIRST HOUR (from open):')
        print(f'    Still up:  {up_1hr}/{len(with_1hr)} ({up_1hr/len(with_1hr)*100:.1f}%)')
        print(f'    Median: {pctl(hrs,50):+.2f}%  |  Mean: {sum(hrs)/len(hrs):+.2f}%')

    # By gap size
    print(f'\n  By pre-market gap size:')
    for lo, hi, label in [(0.02, 0.03, '2-3%'), (0.03, 0.05, '3-5%'), (0.05, 1.0, '5%+')]:
        bucket = [d for d in movers if lo <= d['premarket_gap'] < hi]
        if bucket:
            bfaded = sum(1 for d in bucket if d['eod_change'] < 0)
            bavg = sum(d['eod_change'] for d in bucket) / len(bucket) * 100
            print(f'    {label}: {len(bucket)} days, faded {bfaded/len(bucket)*100:.0f}%, avg EOD {bavg:+.2f}%')

    # Concentration
    unique_days = sorted(set(d['day'] for d in movers))
    print(f'\n  Concentration: {len(movers)} signals across {len(unique_days)} days')

    # Examples
    movers.sort(key=lambda x: x['day'], reverse=True)
    print(f'\n  Recent examples:')
    print(f"  {'DATE':<12} {'TICKER':<8} {'GAP':>6} {'1HR':>8} {'EOD':>8} {'MKT':>8} {'RESULT':>8}")
    print(f"  {'-'*62}")
    for d in movers[:20]:
        o1 = f"{d['one_hr_change']*100:+.1f}%" if d['one_hr_change'] is not None else '—'
        result = 'CONT' if d['eod_change'] > 0 else 'FADE'
        print(f"  {str(d['day']):<12} {d['ticker']:<8} {d['premarket_gap']*100:>5.1f}% {o1:>8} {d['eod_change']*100:>+7.1f}% {d['mkt_change']*100:>+7.1f}% {result:>8}")


# ─────────────────────────────────────────────────────────────────────────────
# 27) SECTOR ROTATION — red-at-open on a green day: bounce or put?
# ─────────────────────────────────────────────────────────────────────────────
def green_day_sector_rotation():
    import statistics

    print('=' * 70)
    print('27) SECTOR ROTATION — ticker DOWN >1% at open on a GREEN day')
    print('=' * 70)

    green_days, ticker_daily, ticker_1hr, ticker_2hr = _build_green_day_data()

    if not green_days:
        print('  No green days found.')
        return

    # Ticker gapped DOWN >1% from prev close on a green day
    red_opens = []
    for r in ticker_daily:
        day = r['day']
        if day not in green_days:
            continue
        prev = float(r['prev_close'])
        day_open = float(r['day_open'])
        day_close = float(r['day_close'])
        if prev <= 0:
            continue
        gap_pct = (day_open - prev) / prev
        if gap_pct >= -0.01:
            continue  # not down enough

        one_hr = ticker_1hr.get((r['ticker'], day))
        two_hr = ticker_2hr.get((r['ticker'], day))

        red_opens.append({
            'ticker': r['ticker'],
            'day': day,
            'prev_close': prev,
            'day_open': day_open,
            'day_close': day_close,
            'gap_pct': gap_pct,
            'eod_change': (day_close - day_open) / day_open,
            'eod_vs_prev': (day_close - prev) / prev,
            'one_hr': one_hr,
            'one_hr_change': (one_hr - day_open) / day_open if one_hr else None,
            'two_hr': two_hr,
            'two_hr_change': (two_hr - day_open) / day_open if two_hr else None,
            'mkt_change': green_days[day],
        })

    print(f'\n  Tickers down >1% at open on green days: {len(red_opens)}')
    if not red_opens:
        print('  (none found)')
        return

    # Key question: did they bounce or keep falling?
    bounced = sum(1 for d in red_opens if d['eod_change'] > 0)  # close > open = intraday recovery
    kept_falling = sum(1 for d in red_opens if d['eod_change'] < 0)

    eods = sorted([d['eod_change'] * 100 for d in red_opens])

    print(f'\n  INTRADAY OUTCOME (from open):')
    print(f'    Bounced (close > open):    {bounced}/{len(red_opens)} ({bounced/len(red_opens)*100:.1f}%)')
    print(f'    Kept falling (close < open): {kept_falling}/{len(red_opens)} ({kept_falling/len(red_opens)*100:.1f}%)')
    print(f'\n    EOD return from open:')
    print(f'      Worst:  {eods[0]:+.2f}%  |  P25: {pctl(eods,25):+.2f}%  |  Median: {pctl(eods,50):+.2f}%')
    print(f'      P75: {pctl(eods,75):+.2f}%  |  Best: {eods[-1]:+.2f}%  |  Mean: {sum(eods)/len(eods):+.2f}%')

    # Put win = close < open (continued falling from already-red open)
    print(f'\n    PUT signal: {kept_falling/len(red_opens)*100:.1f}% win rate')
    print(f'    CALL signal (bounce): {bounced/len(red_opens)*100:.1f}% win rate')

    # First hour
    with_1hr = [d for d in red_opens if d['one_hr_change'] is not None]
    if with_1hr:
        hrs = sorted([d['one_hr_change'] * 100 for d in with_1hr])
        up_1hr = sum(1 for d in with_1hr if d['one_hr_change'] > 0)
        down_1hr = sum(1 for d in with_1hr if d['one_hr_change'] < 0)
        print(f'\n  FIRST HOUR from open:')
        print(f'    Recovered (up): {up_1hr}/{len(with_1hr)} ({up_1hr/len(with_1hr)*100:.1f}%)')
        print(f'    Fell more:      {down_1hr}/{len(with_1hr)} ({down_1hr/len(with_1hr)*100:.1f}%)')
        print(f'    Median: {pctl(hrs,50):+.2f}%  |  Mean: {sum(hrs)/len(hrs):+.2f}%')

    # 2hr mark
    with_2hr = [d for d in red_opens if d['two_hr_change'] is not None]
    if with_2hr:
        hrs = sorted([d['two_hr_change'] * 100 for d in with_2hr])
        up_2hr = sum(1 for d in with_2hr if d['two_hr_change'] > 0)
        print(f'\n  AT 2HR from open:')
        print(f'    Recovered (up): {up_2hr}/{len(with_2hr)} ({up_2hr/len(with_2hr)*100:.1f}%)')
        print(f'    Median: {pctl(hrs,50):+.2f}%  |  Mean: {sum(hrs)/len(hrs):+.2f}%')

    # By gap severity
    print(f'\n  By gap-down severity:')
    for lo, hi, label in [(-0.02, -0.01, '1-2% down'), (-0.03, -0.02, '2-3% down'), (-1.0, -0.03, '3%+ down')]:
        bucket = [d for d in red_opens if lo <= d['gap_pct'] < hi]
        if bucket:
            bbounced = sum(1 for d in bucket if d['eod_change'] > 0)
            bavg = sum(d['eod_change'] for d in bucket) / len(bucket) * 100
            print(f'    {label}: {len(bucket)} days, bounced {bbounced/len(bucket)*100:.0f}%, avg EOD from open {bavg:+.2f}%')

    # Did any close ABOVE prev close (full recovery)?
    full_recovery = sum(1 for d in red_opens if d['day_close'] > d['prev_close'])
    print(f'\n  Full recovery (close > prev close): {full_recovery}/{len(red_opens)} ({full_recovery/len(red_opens)*100:.1f}%)')

    # Concentration
    unique_days = sorted(set(d['day'] for d in red_opens))
    unique_tickers = set(d['ticker'] for d in red_opens)
    print(f'\n  Concentration: {len(red_opens)} signals across {len(unique_days)} days, {len(unique_tickers)} tickers')

    # Examples
    red_opens.sort(key=lambda x: x['day'], reverse=True)
    print(f'\n  Recent examples:')
    print(f"  {'DATE':<12} {'TICKER':<8} {'GAP':>7} {'1HR':>8} {'2HR':>8} {'EOD':>8} {'MKT':>8} {'RESULT':>8}")
    print(f"  {'-'*72}")
    for d in red_opens[:20]:
        o1 = f"{d['one_hr_change']*100:+.1f}%" if d['one_hr_change'] is not None else '—'
        o2 = f"{d['two_hr_change']*100:+.1f}%" if d['two_hr_change'] is not None else '—'
        result = 'BOUNCE' if d['eod_change'] > 0 else 'PUT WIN'
        print(f"  {str(d['day']):<12} {d['ticker']:<8} {d['gap_pct']*100:>+6.1f}% {o1:>8} {o2:>8} {d['eod_change']*100:>+7.1f}% {d['mkt_change']*100:>+7.1f}% {result:>8}")


# ─────────────────────────────────────────────────────────────────────────────
if __name__ == '__main__':
    try:
        green_day_gap_ups()
        print('\n')
        green_day_premarket_movers()
        print('\n')
        green_day_sector_rotation()
    finally:
        cur.close()
        conn.close()
