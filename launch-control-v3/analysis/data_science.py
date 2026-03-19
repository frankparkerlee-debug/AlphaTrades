"""
Data science analysis on stored 1-min bar data (lc_v3.bars).
5 analyses: candlestick patterns, VWAP cross, volume before reversals,
RSI divergence, EMA cross exit signals.

Run: python3 analysis/data_science.py
"""

import os
import sys
from collections import defaultdict
from dotenv import load_dotenv
import psycopg2
from psycopg2.extras import RealDictCursor
import numpy as np

load_dotenv(os.path.join(os.path.dirname(__file__), '..', '.env'))

DATABASE_URL = os.environ.get('DATABASE_URL')
if not DATABASE_URL:
    print('ERROR: DATABASE_URL not set in .env')
    sys.exit(1)

conn = psycopg2.connect(DATABASE_URL, sslmode='require')
cur = conn.cursor(cursor_factory=RealDictCursor)

# ── Load all bars into memory, grouped by ticker+day ─────────────────────────

def load_all_bars():
    """Load all regular-session bars, return dict of (ticker, day) -> sorted list of bars."""
    print('Loading bars from DB...')
    cur.execute("""
        SELECT ticker, open, high, low, close, volume,
               DATE(ts AT TIME ZONE 'America/New_York') as day,
               EXTRACT(HOUR FROM ts AT TIME ZONE 'America/New_York')::int * 60 +
               EXTRACT(MINUTE FROM ts AT TIME ZONE 'America/New_York')::int as et_mins
        FROM lc_v3.bars
        WHERE session = 'REGULAR'
        ORDER BY ticker, ts
    """)
    rows = cur.fetchall()
    print(f'  Loaded {len(rows):,} bars')

    by_ticker_day = defaultdict(list)
    tickers = set()
    for r in rows:
        t = r['ticker']
        if t in ('SPY', 'QQQ', 'IWM'):
            continue
        tickers.add(t)
        day = r['day'].isoformat() if hasattr(r['day'], 'isoformat') else str(r['day'])
        by_ticker_day[(t, day)].append({
            'open': float(r['open']), 'high': float(r['high']),
            'low': float(r['low']), 'close': float(r['close']),
            'volume': int(r['volume']), 'et_mins': int(r['et_mins']),
        })

    print(f'  {len(tickers)} tickers, {len(by_ticker_day)} ticker-days\n')
    return by_ticker_day, sorted(tickers)


def time_bucket(et_mins):
    """Return time-of-day bucket label."""
    if et_mins < 660:   # before 11:00
        return '9:30-11am'
    elif et_mins < 780:  # before 1:00pm
        return '11am-1pm'
    else:
        return '1-4pm'


# ═════════════════════════════════════════════════════════════════════════════
# ANALYSIS 1: Candlestick Pattern Continuation Rates
# ═════════════════════════════════════════════════════════════════════════════

def analysis_1_candlestick_patterns(by_ticker_day):
    print('=' * 78)
    print('1) CANDLESTICK PATTERN CONTINUATION RATES')
    print('=' * 78)

    # Pattern detectors: return (detected, direction) where direction is 1=bullish, -1=bearish
    def detect_doji(bar, prev):
        rng = bar['high'] - bar['low']
        if rng == 0:
            return False, 0
        body = abs(bar['close'] - bar['open'])
        if body < rng * 0.10:
            return True, 0  # neutral
        return False, 0

    def detect_hammer(bar, prev):
        body = abs(bar['close'] - bar['open'])
        if body == 0:
            return False, 0
        lower_wick = min(bar['open'], bar['close']) - bar['low']
        if lower_wick > 2 * body:
            return True, 1  # bullish
        return False, 0

    def detect_shooting_star(bar, prev):
        body = abs(bar['close'] - bar['open'])
        if body == 0:
            return False, 0
        upper_wick = bar['high'] - max(bar['open'], bar['close'])
        if upper_wick > 2 * body:
            return True, -1  # bearish
        return False, 0

    def detect_bullish_engulfing(bar, prev):
        if prev is None:
            return False, 0
        if prev['close'] >= prev['open']:
            return False, 0  # prev must be red
        if bar['close'] <= bar['open']:
            return False, 0  # current must be green
        if bar['close'] > prev['open'] and bar['open'] < prev['close']:
            return True, 1
        return False, 0

    def detect_bearish_engulfing(bar, prev):
        if prev is None:
            return False, 0
        if prev['close'] <= prev['open']:
            return False, 0  # prev must be green
        if bar['close'] >= bar['open']:
            return False, 0  # current must be red
        if bar['close'] < prev['open'] and bar['open'] > prev['close']:
            return True, -1
        return False, 0

    def detect_inside_bar(bar, prev):
        if prev is None:
            return False, 0
        if bar['high'] < prev['high'] and bar['low'] > prev['low']:
            return True, 0  # neutral — continuation of prior
        return False, 0

    def detect_marubozu(bar, prev):
        rng = bar['high'] - bar['low']
        if rng == 0:
            return False, 0
        body = abs(bar['close'] - bar['open'])
        if body > rng * 0.90:
            direction = 1 if bar['close'] > bar['open'] else -1
            return True, direction
        return False, 0

    patterns = {
        'DOJI': detect_doji,
        'HAMMER': detect_hammer,
        'SHOOTING_STAR': detect_shooting_star,
        'BULLISH_ENGULF': detect_bullish_engulfing,
        'BEARISH_ENGULF': detect_bearish_engulfing,
        'INSIDE_BAR': detect_inside_bar,
        'MARUBOZU': detect_marubozu,
    }

    # Stats: pattern -> time_bucket -> {count, continuations, magnitudes}
    stats = {p: {b: {'count': 0, 'cont': 0, 'mags': []} for b in ['9:30-11am', '11am-1pm', '1-4pm', 'ALL']}
             for p in patterns}

    for (ticker, day), bars in by_ticker_day.items():
        if len(bars) < 3:
            continue
        for i in range(1, len(bars) - 1):
            bar = bars[i]
            prev = bars[i - 1]
            nxt = bars[i + 1]
            bucket = time_bucket(bar['et_mins'])

            next_move = nxt['close'] - nxt['open']

            for pname, detector in patterns.items():
                detected, direction = detector(bar, prev)
                if not detected:
                    continue

                # For neutral patterns (doji, inside bar), continuation = same direction as the bar itself
                if direction == 0:
                    bar_dir = 1 if bar['close'] >= bar['open'] else -1
                    continued = (next_move * bar_dir > 0)
                else:
                    continued = (next_move * direction > 0)

                mag = abs(next_move) / bar['close'] * 100 if bar['close'] > 0 else 0

                for bk in [bucket, 'ALL']:
                    stats[pname][bk]['count'] += 1
                    if continued:
                        stats[pname][bk]['cont'] += 1
                    stats[pname][bk]['mags'].append(mag)

    # Print results
    for pname in patterns:
        s = stats[pname]
        all_s = s['ALL']
        if all_s['count'] == 0:
            continue
        rate = all_s['cont'] / all_s['count'] * 100
        avg_mag = np.mean(all_s['mags']) if all_s['mags'] else 0
        print(f'\n  {pname}')
        print(f'  {"Bucket":<14} {"Count":>10} {"Cont Rate":>12} {"Avg Mag%":>10}')
        print(f'  {"-"*48}')
        for bk in ['9:30-11am', '11am-1pm', '1-4pm', 'ALL']:
            d = s[bk]
            if d['count'] == 0:
                continue
            r = d['cont'] / d['count'] * 100
            m = np.mean(d['mags']) if d['mags'] else 0
            label = bk if bk != 'ALL' else '** ALL **'
            print(f'  {label:<14} {d["count"]:>10,} {r:>11.1f}% {m:>9.4f}%')

    print()


# ═════════════════════════════════════════════════════════════════════════════
# ANALYSIS 2: VWAP Cross as Exit Signal
# ═════════════════════════════════════════════════════════════════════════════

def analysis_2_vwap_cross(by_ticker_day):
    print('=' * 78)
    print('2) VWAP CROSS AS EXIT SIGNAL')
    print('=' * 78)

    cross_below_stats = {'small': [], 'medium': [], 'large': [], 'ALL': []}  # magnitude buckets
    cross_above_stats = {'small': [], 'medium': [], 'large': [], 'ALL': []}

    for (ticker, day), bars in by_ticker_day.items():
        if len(bars) < 20:
            continue

        # Compute running VWAP
        cum_vol = 0
        cum_tp_vol = 0
        vwaps = []
        for b in bars:
            tp = (b['high'] + b['low'] + b['close']) / 3
            cum_vol += b['volume']
            cum_tp_vol += tp * b['volume']
            vwaps.append(cum_tp_vol / cum_vol if cum_vol > 0 else b['close'])

        # Track above/below VWAP streak
        above_streak = 0
        below_streak = 0

        for i in range(1, len(bars)):
            price = bars[i]['close']
            vwap = vwaps[i]
            prev_price = bars[i - 1]['close']
            prev_vwap = vwaps[i - 1]

            if prev_price > prev_vwap:
                above_streak += 1
                below_streak = 0
            elif prev_price < prev_vwap:
                below_streak += 1
                above_streak = 0

            # Cross BELOW VWAP after being above for 5+ bars
            if price < vwap and prev_price >= prev_vwap and above_streak >= 5:
                cross_mag = (vwap - price) / vwap * 100
                # Look at next 10 bars
                forward = bars[i + 1: i + 11]
                if len(forward) < 5:
                    continue
                # Did price continue declining or reclaim VWAP?
                min_price = min(b['close'] for b in forward)
                reclaimed = any(b['close'] > vwaps[min(i + 1 + j, len(vwaps) - 1)] for j, b in enumerate(forward))
                max_decline = (price - min_price) / price * 100
                continued_decline = min_price < price

                result = {
                    'cross_mag': cross_mag,
                    'continued_decline': continued_decline,
                    'reclaimed': reclaimed,
                    'max_decline_pct': max_decline,
                    'above_streak': above_streak,
                }

                if cross_mag < 0.05:
                    cross_below_stats['small'].append(result)
                elif cross_mag < 0.15:
                    cross_below_stats['medium'].append(result)
                else:
                    cross_below_stats['large'].append(result)
                cross_below_stats['ALL'].append(result)

            # Cross ABOVE VWAP after being below for 5+ bars
            if price > vwap and prev_price <= prev_vwap and below_streak >= 5:
                cross_mag = (price - vwap) / vwap * 100
                forward = bars[i + 1: i + 11]
                if len(forward) < 5:
                    continue
                max_price = max(b['close'] for b in forward)
                reclaimed = any(b['close'] < vwaps[min(i + 1 + j, len(vwaps) - 1)] for j, b in enumerate(forward))
                max_gain = (max_price - price) / price * 100
                continued_gain = max_price > price

                result = {
                    'cross_mag': cross_mag,
                    'continued_gain': continued_gain,
                    'reclaimed': reclaimed,
                    'max_gain_pct': max_gain,
                    'below_streak': below_streak,
                }

                if cross_mag < 0.05:
                    cross_above_stats['small'].append(result)
                elif cross_mag < 0.15:
                    cross_above_stats['medium'].append(result)
                else:
                    cross_above_stats['large'].append(result)
                cross_above_stats['ALL'].append(result)

    # Print cross BELOW results
    print(f'\n  CROSS BELOW VWAP (was above 5+ bars, then crosses below)')
    print(f'  {"Magnitude":<14} {"Count":>8} {"Cont Decline":>14} {"Reclaimed":>12} {"Avg MaxDecl%":>14}')
    print(f'  {"-"*64}')
    for bk in ['small (<0.05%)', 'medium (0.05-0.15%)', 'large (>0.15%)', '** ALL **']:
        key = bk.split()[0].replace('**', '').strip()
        if key == 'ALL':
            data = cross_below_stats['ALL']
        elif 'small' in bk:
            data = cross_below_stats['small']
        elif 'medium' in bk:
            data = cross_below_stats['medium']
        else:
            data = cross_below_stats['large']
        if not data:
            continue
        cont_rate = sum(1 for d in data if d['continued_decline']) / len(data) * 100
        recl_rate = sum(1 for d in data if d['reclaimed']) / len(data) * 100
        avg_decl = np.mean([d['max_decline_pct'] for d in data])
        print(f'  {bk:<24} {len(data):>8,} {cont_rate:>13.1f}% {recl_rate:>11.1f}% {avg_decl:>13.4f}%')

    # Print cross ABOVE results
    print(f'\n  CROSS ABOVE VWAP (was below 5+ bars, then crosses above)')
    print(f'  {"Magnitude":<14} {"Count":>8} {"Cont Gain":>14} {"Reclaimed":>12} {"Avg MaxGain%":>14}')
    print(f'  {"-"*64}')
    for bk in ['small (<0.05%)', 'medium (0.05-0.15%)', 'large (>0.15%)', '** ALL **']:
        key = bk.split()[0].replace('**', '').strip()
        if key == 'ALL':
            data = cross_above_stats['ALL']
        elif 'small' in bk:
            data = cross_above_stats['small']
        elif 'medium' in bk:
            data = cross_above_stats['medium']
        else:
            data = cross_above_stats['large']
        if not data:
            continue
        cont_rate = sum(1 for d in data if d['continued_gain']) / len(data) * 100
        recl_rate = sum(1 for d in data if d['reclaimed']) / len(data) * 100
        avg_gain = np.mean([d['max_gain_pct'] for d in data])
        print(f'  {bk:<24} {len(data):>8,} {cont_rate:>13.1f}% {recl_rate:>11.1f}% {avg_gain:>13.4f}%')

    print()


# ═════════════════════════════════════════════════════════════════════════════
# ANALYSIS 3: Volume Pattern Before Reversals
# ═════════════════════════════════════════════════════════════════════════════

def analysis_3_volume_before_reversals(by_ticker_day):
    print('=' * 78)
    print('3) VOLUME PATTERN BEFORE REVERSALS')
    print('=' * 78)

    # A reversal = price drops >1% from local high within 10 bars
    bearish_reversals = []  # volume patterns before bearish reversals
    bullish_reversals = []  # volume patterns before bullish reversals (price rises >1% from local low)

    for (ticker, day), bars in by_ticker_day.items():
        if len(bars) < 20:
            continue

        prices = [b['close'] for b in bars]
        volumes = [b['volume'] for b in bars]

        for i in range(10, len(bars) - 10):
            # Check if bars[i] is a local high (highest close in window of 10 before)
            window_before = prices[i - 10:i + 1]
            if prices[i] != max(window_before):
                continue

            # Check if price drops >1% within next 10 bars
            min_after = min(prices[i + 1:i + 11])
            drop_pct = (prices[i] - min_after) / prices[i] * 100
            if drop_pct < 1.0:
                continue

            # Record volume pattern in 5 bars before the peak
            if i < 5:
                continue
            vol_pattern = volumes[i - 5:i + 1]  # bars -5 through 0
            avg_vol = np.mean(vol_pattern) if np.mean(vol_pattern) > 0 else 1
            vol_ratios = [v / avg_vol for v in vol_pattern]

            # Is volume expanding or contracting?
            expanding = all(vol_pattern[j + 1] >= vol_pattern[j] for j in range(len(vol_pattern) - 1))
            contracting = all(vol_pattern[j + 1] <= vol_pattern[j] for j in range(len(vol_pattern) - 1))
            # Linear trend
            x = np.arange(6)
            slope = np.polyfit(x, vol_pattern, 1)[0] if len(vol_pattern) == 6 else 0

            bearish_reversals.append({
                'drop_pct': drop_pct,
                'vol_pattern': vol_pattern,
                'vol_ratios': vol_ratios,
                'expanding': expanding,
                'contracting': contracting,
                'vol_slope': slope,
                'vol_ratio_last_to_avg': vol_pattern[-1] / avg_vol if avg_vol > 0 else 1,
            })

        # Bullish reversals: local low then rises >1%
        for i in range(10, len(bars) - 10):
            window_before = prices[i - 10:i + 1]
            if prices[i] != min(window_before):
                continue
            max_after = max(prices[i + 1:i + 11])
            rise_pct = (max_after - prices[i]) / prices[i] * 100
            if rise_pct < 1.0:
                continue
            if i < 5:
                continue
            vol_pattern = volumes[i - 5:i + 1]
            avg_vol = np.mean(vol_pattern) if np.mean(vol_pattern) > 0 else 1
            vol_ratios = [v / avg_vol for v in vol_pattern]
            expanding = all(vol_pattern[j + 1] >= vol_pattern[j] for j in range(len(vol_pattern) - 1))
            contracting = all(vol_pattern[j + 1] <= vol_pattern[j] for j in range(len(vol_pattern) - 1))
            x = np.arange(6)
            slope = np.polyfit(x, vol_pattern, 1)[0] if len(vol_pattern) == 6 else 0
            bullish_reversals.append({
                'rise_pct': rise_pct,
                'vol_pattern': vol_pattern,
                'vol_ratios': vol_ratios,
                'expanding': expanding,
                'contracting': contracting,
                'vol_slope': slope,
                'vol_ratio_last_to_avg': vol_pattern[-1] / avg_vol if avg_vol > 0 else 1,
            })

    def print_reversal_stats(label, reversals, move_key):
        print(f'\n  {label}: {len(reversals):,} events')
        if not reversals:
            return

        exp_count = sum(1 for r in reversals if r['expanding'])
        con_count = sum(1 for r in reversals if r['contracting'])
        print(f'  Strictly expanding volume: {exp_count:,} ({exp_count/len(reversals)*100:.1f}%)')
        print(f'  Strictly contracting volume: {con_count:,} ({con_count/len(reversals)*100:.1f}%)')
        print(f'  Neither: {len(reversals) - exp_count - con_count:,} ({(len(reversals) - exp_count - con_count)/len(reversals)*100:.1f}%)')

        avg_slope = np.mean([r['vol_slope'] for r in reversals])
        print(f'  Avg volume slope (bars -5 to 0): {avg_slope:,.0f} shares/bar')

        # Average volume ratio by position
        print(f'\n  Avg volume ratio by bar position (normalized to mean of window):')
        print(f'  {"Bar":<8}', end='')
        for pos in range(-5, 1):
            print(f'  {"bar " + str(pos):>10}', end='')
        print()
        print(f'  {"Ratio":<8}', end='')
        for pos_idx in range(6):
            avg_ratio = np.mean([r['vol_ratios'][pos_idx] for r in reversals])
            print(f'  {avg_ratio:>10.3f}', end='')
        print()

        avg_move = np.mean([r[move_key] for r in reversals])
        print(f'\n  Avg {move_key}: {avg_move:.2f}%')

        # Volume at peak vs average
        avg_peak_ratio = np.mean([r['vol_ratio_last_to_avg'] for r in reversals])
        print(f'  Avg volume at peak bar / window avg: {avg_peak_ratio:.3f}x')

        # Bucket by volume trend
        high_vol = [r for r in reversals if r['vol_ratio_last_to_avg'] > 1.5]
        low_vol = [r for r in reversals if r['vol_ratio_last_to_avg'] < 0.7]
        if high_vol:
            avg_m = np.mean([r[move_key] for r in high_vol])
            print(f'  High volume at peak (>1.5x): {len(high_vol):,} events, avg {move_key}={avg_m:.2f}%')
        if low_vol:
            avg_m = np.mean([r[move_key] for r in low_vol])
            print(f'  Low volume at peak (<0.7x): {len(low_vol):,} events, avg {move_key}={avg_m:.2f}%')

    print_reversal_stats('BEARISH REVERSALS (>1% drop from local high)', bearish_reversals, 'drop_pct')
    print_reversal_stats('BULLISH REVERSALS (>1% rise from local low)', bullish_reversals, 'rise_pct')
    print()


# ═════════════════════════════════════════════════════════════════════════════
# ANALYSIS 4: RSI Divergence on 1-Minute Bars
# ═════════════════════════════════════════════════════════════════════════════

def analysis_4_rsi_divergence(by_ticker_day):
    print('=' * 78)
    print('4) RSI DIVERGENCE ON 1-MINUTE BARS')
    print('=' * 78)

    def compute_rsi(prices, period=14):
        """Compute RSI series from price array."""
        if len(prices) < period + 1:
            return []
        rsi = [None] * period
        gains = []
        losses = []
        for i in range(1, len(prices)):
            diff = prices[i] - prices[i - 1]
            gains.append(max(diff, 0))
            losses.append(max(-diff, 0))

        avg_gain = np.mean(gains[:period])
        avg_loss = np.mean(losses[:period])

        for i in range(period, len(prices)):
            if i > period:
                avg_gain = (avg_gain * (period - 1) + gains[i - 1]) / period
                avg_loss = (avg_loss * (period - 1) + losses[i - 1]) / period
            if avg_loss == 0:
                rsi.append(100.0)
            else:
                rs = avg_gain / avg_loss
                rsi.append(100.0 - 100.0 / (1.0 + rs))
        return rsi

    bearish_divs = []  # price new high, RSI lower high
    bullish_divs = []  # price new low, RSI higher low

    for (ticker, day), bars in by_ticker_day.items():
        if len(bars) < 40:
            continue

        prices = [b['close'] for b in bars]
        rsi = compute_rsi(prices, 14)

        if len(rsi) != len(prices):
            continue

        # Find swing highs and lows (local extremes over 5-bar window)
        swing_highs = []
        swing_lows = []
        for i in range(5, len(prices) - 5):
            if rsi[i] is None:
                continue
            # Swing high: highest in 5 bars each side
            if prices[i] == max(prices[i - 5:i + 6]):
                swing_highs.append(i)
            if prices[i] == min(prices[i - 5:i + 6]):
                swing_lows.append(i)

        # Bearish divergence: consecutive swing highs where price higher but RSI lower
        for j in range(1, len(swing_highs)):
            i1 = swing_highs[j - 1]
            i2 = swing_highs[j]
            if i2 - i1 < 10 or i2 - i1 > 60:
                continue
            if rsi[i1] is None or rsi[i2] is None:
                continue
            if prices[i2] > prices[i1] and rsi[i2] < rsi[i1] - 2:  # RSI at least 2 pts lower
                # Check for reversal within 10 bars
                forward = prices[i2 + 1:i2 + 11]
                if len(forward) < 5:
                    continue
                min_fwd = min(forward)
                drop_pct = (prices[i2] - min_fwd) / prices[i2] * 100
                reversed_ = drop_pct > 0.2  # at least 0.2% decline
                bearish_divs.append({
                    'rsi_diff': rsi[i1] - rsi[i2],
                    'price_diff_pct': (prices[i2] - prices[i1]) / prices[i1] * 100,
                    'reversed': reversed_,
                    'drop_pct': drop_pct,
                    'bars_apart': i2 - i1,
                })

        # Bullish divergence: consecutive swing lows where price lower but RSI higher
        for j in range(1, len(swing_lows)):
            i1 = swing_lows[j - 1]
            i2 = swing_lows[j]
            if i2 - i1 < 10 or i2 - i1 > 60:
                continue
            if rsi[i1] is None or rsi[i2] is None:
                continue
            if prices[i2] < prices[i1] and rsi[i2] > rsi[i1] + 2:
                forward = prices[i2 + 1:i2 + 11]
                if len(forward) < 5:
                    continue
                max_fwd = max(forward)
                rise_pct = (max_fwd - prices[i2]) / prices[i2] * 100
                reversed_ = rise_pct > 0.2
                bullish_divs.append({
                    'rsi_diff': rsi[i2] - rsi[i1],
                    'price_diff_pct': (prices[i1] - prices[i2]) / prices[i1] * 100,
                    'reversed': reversed_,
                    'rise_pct': rise_pct,
                    'bars_apart': i2 - i1,
                })

    def print_div_stats(label, divs, move_key):
        print(f'\n  {label}: {len(divs):,} events')
        if not divs:
            return
        rev_count = sum(1 for d in divs if d['reversed'])
        fp_count = len(divs) - rev_count
        print(f'  Reversal within 10 bars (>{0.2}%): {rev_count:,} ({rev_count/len(divs)*100:.1f}%)')
        print(f'  False positives: {fp_count:,} ({fp_count/len(divs)*100:.1f}%)')
        avg_move = np.mean([d[move_key] for d in divs])
        avg_move_reversed = np.mean([d[move_key] for d in divs if d['reversed']]) if rev_count else 0
        print(f'  Avg {move_key} (all): {avg_move:.3f}%')
        print(f'  Avg {move_key} (reversed only): {avg_move_reversed:.3f}%')
        avg_rsi_diff = np.mean([d['rsi_diff'] for d in divs])
        print(f'  Avg RSI divergence magnitude: {avg_rsi_diff:.1f} pts')
        avg_bars = np.mean([d['bars_apart'] for d in divs])
        print(f'  Avg bars between swing points: {avg_bars:.1f}')

        # Break by RSI divergence magnitude
        small = [d for d in divs if d['rsi_diff'] < 5]
        medium = [d for d in divs if 5 <= d['rsi_diff'] < 10]
        large = [d for d in divs if d['rsi_diff'] >= 10]
        print(f'\n  By RSI divergence magnitude:')
        print(f'  {"Bucket":<20} {"Count":>8} {"Rev Rate":>10} {"Avg Move%":>10}')
        print(f'  {"-"*50}')
        for lbl, subset in [('< 5 pts', small), ('5-10 pts', medium), ('> 10 pts', large)]:
            if not subset:
                continue
            rr = sum(1 for d in subset if d['reversed']) / len(subset) * 100
            am = np.mean([d[move_key] for d in subset])
            print(f'  {lbl:<20} {len(subset):>8,} {rr:>9.1f}% {am:>9.3f}%')

    print_div_stats('BEARISH DIVERGENCE (price new high, RSI lower high)', bearish_divs, 'drop_pct')
    print_div_stats('BULLISH DIVERGENCE (price new low, RSI higher low)', bullish_divs, 'rise_pct')
    print()


# ═════════════════════════════════════════════════════════════════════════════
# ANALYSIS 5: EMA Cross Exit Signal
# ═════════════════════════════════════════════════════════════════════════════

def analysis_5_ema_cross(by_ticker_day):
    print('=' * 78)
    print('5) EMA CROSS EXIT SIGNAL (9/21 EMA)')
    print('=' * 78)

    def compute_ema(prices, period):
        """Compute EMA series."""
        if len(prices) < period:
            return [None] * len(prices)
        multiplier = 2.0 / (period + 1)
        ema = [None] * (period - 1)
        ema.append(np.mean(prices[:period]))
        for i in range(period, len(prices)):
            ema.append(prices[i] * multiplier + ema[-1] * (1 - multiplier))
        return ema

    bearish_crosses = []
    bullish_crosses = []

    for (ticker, day), bars in by_ticker_day.items():
        if len(bars) < 40:
            continue

        prices = [b['close'] for b in bars]
        ema9 = compute_ema(prices, 9)
        ema21 = compute_ema(prices, 21)

        # Track how long price has been above/below both EMAs
        above_both_streak = 0
        below_both_streak = 0

        for i in range(21, len(bars)):
            if ema9[i] is None or ema21[i] is None or ema9[i - 1] is None or ema21[i - 1] is None:
                continue

            price = prices[i]
            prev_price = prices[i - 1]

            # Update streaks
            if prev_price > ema9[i - 1] and prev_price > ema21[i - 1]:
                above_both_streak += 1
                below_both_streak = 0
            elif prev_price < ema9[i - 1] and prev_price < ema21[i - 1]:
                below_both_streak += 1
                above_both_streak = 0
            else:
                above_both_streak = 0
                below_both_streak = 0

            # Bearish cross: 9 EMA crosses below 21 EMA after price above both for 10+ bars
            if ema9[i] < ema21[i] and ema9[i - 1] >= ema21[i - 1] and above_both_streak >= 10:
                forward = prices[i + 1:i + 31]  # look ahead 30 bars
                if len(forward) < 10:
                    continue
                min_fwd = min(forward)
                min_idx = forward.index(min_fwd)
                decline_pct = (prices[i] - min_fwd) / prices[i] * 100
                continued = decline_pct > 0.2
                bearish_crosses.append({
                    'decline_pct': decline_pct,
                    'continued': continued,
                    'time_to_max_adverse': min_idx + 1,
                    'above_streak': above_both_streak,
                    'et_mins': bars[i]['et_mins'],
                })

            # Bullish cross: 9 EMA crosses above 21 EMA after price below both for 10+ bars
            if ema9[i] > ema21[i] and ema9[i - 1] <= ema21[i - 1] and below_both_streak >= 10:
                forward = prices[i + 1:i + 31]
                if len(forward) < 10:
                    continue
                max_fwd = max(forward)
                max_idx = forward.index(max_fwd)
                gain_pct = (max_fwd - prices[i]) / prices[i] * 100
                continued = gain_pct > 0.2
                bullish_crosses.append({
                    'gain_pct': gain_pct,
                    'continued': continued,
                    'time_to_max_favorable': max_idx + 1,
                    'below_streak': below_both_streak,
                    'et_mins': bars[i]['et_mins'],
                })

    def print_cross_stats(label, crosses, move_key, time_key):
        print(f'\n  {label}: {len(crosses):,} events')
        if not crosses:
            return
        cont_count = sum(1 for c in crosses if c['continued'])
        print(f'  Continued (>0.2% move): {cont_count:,} ({cont_count/len(crosses)*100:.1f}%)')
        avg_move = np.mean([c[move_key] for c in crosses])
        med_move = np.median([c[move_key] for c in crosses])
        print(f'  Avg {move_key}: {avg_move:.3f}%')
        print(f'  Median {move_key}: {med_move:.3f}%')
        avg_time = np.mean([c[time_key] for c in crosses])
        print(f'  Avg {time_key}: {avg_time:.1f} bars')

        # By time of day
        print(f'\n  By time of day:')
        print(f'  {"Bucket":<14} {"Count":>8} {"Cont Rate":>12} {"Avg Move%":>10} {"Avg Time":>10}')
        print(f'  {"-"*56}')
        for bk_name in ['9:30-11am', '11am-1pm', '1-4pm']:
            subset = [c for c in crosses if time_bucket(c['et_mins']) == bk_name]
            if not subset:
                continue
            cr = sum(1 for c in subset if c['continued']) / len(subset) * 100
            am = np.mean([c[move_key] for c in subset])
            at = np.mean([c[time_key] for c in subset])
            print(f'  {bk_name:<14} {len(subset):>8,} {cr:>11.1f}% {am:>9.3f}% {at:>9.1f}')

        # By prior streak length
        print(f'\n  By prior streak length:')
        print(f'  {"Streak":<14} {"Count":>8} {"Cont Rate":>12} {"Avg Move%":>10}')
        print(f'  {"-"*46}')
        streak_key = 'above_streak' if 'above_streak' in crosses[0] else 'below_streak'
        for lo, hi, lbl in [(10, 15, '10-14 bars'), (15, 25, '15-24 bars'), (25, 999, '25+ bars')]:
            subset = [c for c in crosses if lo <= c[streak_key] < hi]
            if not subset:
                continue
            cr = sum(1 for c in subset if c['continued']) / len(subset) * 100
            am = np.mean([c[move_key] for c in subset])
            print(f'  {lbl:<14} {len(subset):>8,} {cr:>11.1f}% {am:>9.3f}%')

    print_cross_stats(
        'BEARISH EMA CROSS (9 crosses below 21, price was above both 10+ bars)',
        bearish_crosses, 'decline_pct', 'time_to_max_adverse')
    print_cross_stats(
        'BULLISH EMA CROSS (9 crosses above 21, price was below both 10+ bars)',
        bullish_crosses, 'gain_pct', 'time_to_max_favorable')
    print()


# ═════════════════════════════════════════════════════════════════════════════
# MAIN
# ═════════════════════════════════════════════════════════════════════════════

def main():
    print('=' * 78)
    print('  LAUNCH CONTROL v3 — BAR DATA ANALYSIS (5 analyses)')
    print('=' * 78)
    print()

    by_ticker_day, tickers = load_all_bars()

    analysis_1_candlestick_patterns(by_ticker_day)
    analysis_2_vwap_cross(by_ticker_day)
    analysis_3_volume_before_reversals(by_ticker_day)
    analysis_4_rsi_divergence(by_ticker_day)
    analysis_5_ema_cross(by_ticker_day)

    print('=' * 78)
    print('  ALL ANALYSES COMPLETE')
    print('=' * 78)

    conn.close()


if __name__ == '__main__':
    main()
