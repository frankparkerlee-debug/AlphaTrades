"""
Diagnostic: run the scanner once and print detailed results.
Run on Render via shell: python mm-engine/diagnose_scanner.py
"""
import os
import sys
import logging

sys.path.insert(0, os.path.dirname(__file__))

logging.basicConfig(
    level=logging.INFO,
    format="%(message)s",
    handlers=[logging.StreamHandler(sys.stdout)]
)
logger = logging.getLogger("diag")

from dotenv import load_dotenv
load_dotenv()

from config import (
    ALPACA_API_KEY, ALPACA_API_SECRET, UNIVERSE,
    TARGET_DTE_MIN, TARGET_DTE_MAX, OTM_PCT_MIN, OTM_PCT_MAX,
    MIN_SPREAD_WIDTH, MIN_DAILY_VOLUME,
)

print("=" * 60)
print("MM ENGINE SCANNER DIAGNOSTIC")
print("=" * 60)
print(f"API key:  {ALPACA_API_KEY[:8]}..." if ALPACA_API_KEY else "API key:  MISSING")
print(f"Secret:   {'SET' if ALPACA_API_SECRET else 'MISSING'}")
print(f"Universe: {UNIVERSE}")
print(f"DTE:      {TARGET_DTE_MIN}-{TARGET_DTE_MAX}")
print(f"OTM:      {OTM_PCT_MIN*100:.0f}%-{OTM_PCT_MAX*100:.0f}%")
print(f"Min spread: ${MIN_SPREAD_WIDTH}")
print(f"Min volume: {MIN_DAILY_VOLUME}")
print("=" * 60)

if not ALPACA_API_KEY or not ALPACA_API_SECRET:
    print("ERROR: API keys not set. Exiting.")
    sys.exit(1)

from alpaca.data.historical.option import OptionHistoricalDataClient
from alpaca.data.requests import OptionChainRequest
from alpaca.data.historical.stock import StockHistoricalDataClient
from alpaca.data.requests import StockLatestQuoteRequest
from datetime import date, timedelta

option_client = OptionHistoricalDataClient(
    api_key=ALPACA_API_KEY, secret_key=ALPACA_API_SECRET
)
stock_client = StockHistoricalDataClient(
    api_key=ALPACA_API_KEY, secret_key=ALPACA_API_SECRET
)

today = date.today()
expiry_min = today + timedelta(days=TARGET_DTE_MIN)
expiry_max = today + timedelta(days=TARGET_DTE_MAX)

total_contracts = 0
total_viable = 0

for symbol in UNIVERSE:
    print(f"\n{'─'*50}")
    print(f"SCANNING: {symbol}")
    print(f"{'─'*50}")

    # Get underlying price
    try:
        req = StockLatestQuoteRequest(symbol_or_symbols=symbol)
        quote = stock_client.get_stock_latest_quote(req)
        if symbol not in quote:
            print(f"  NO QUOTE for {symbol}")
            continue
        q = quote[symbol]
        price = (float(q.bid_price) + float(q.ask_price)) / 2
        print(f"  Underlying: ${price:.2f} (bid=${q.bid_price} ask=${q.ask_price})")
    except Exception as e:
        print(f"  QUOTE ERROR: {e}")
        continue

    print(f"  Expiry range: {expiry_min} - {expiry_max}")

    all_chain = {}
    for opt_type in ["put", "call"]:
        if opt_type == "put":
            s_min = price * (1 - OTM_PCT_MAX)
            s_max = price * (1 - OTM_PCT_MIN)
        else:
            s_min = price * (1 + OTM_PCT_MIN)
            s_max = price * (1 + OTM_PCT_MAX)

        print(f"  {opt_type.upper()} strike range: ${s_min:.2f} - ${s_max:.2f}")

        try:
            request = OptionChainRequest(
                underlying_symbol=symbol,
                type=opt_type,
                strike_price_gte=str(round(s_min, 2)),
                strike_price_lte=str(round(s_max, 2)),
                expiration_date_gte=expiry_min.strftime("%Y-%m-%d"),
                expiration_date_lte=expiry_max.strftime("%Y-%m-%d"),
            )
            chain = option_client.get_option_chain(request)
            if chain:
                print(f"  {opt_type.upper()}: {len(chain)} contracts")
                all_chain.update(chain)
            else:
                print(f"  {opt_type.upper()}: empty chain")
        except Exception as e:
            print(f"  {opt_type.upper()} CHAIN ERROR: {e}")

    if not all_chain:
        print(f"  NO CONTRACTS in any chain")
        continue

    print(f"  Total contracts: {len(all_chain)}")

    for contract_sym, snapshot in all_chain.items():
        total_contracts += 1
        bid = float(snapshot.latest_quote.bid_price or 0) if snapshot.latest_quote else 0
        ask = float(snapshot.latest_quote.ask_price or 0) if snapshot.latest_quote else 0
        spread = ask - bid if ask > bid else 0
        oi = int(snapshot.open_interest or 0) if snapshot.open_interest else 0
        vol = int(snapshot.daily_bar.volume or 0) if snapshot.daily_bar else 0
        iv = float(snapshot.implied_volatility or 0) if snapshot.implied_volatility else 0

        status = "OK"
        reject_reason = ""

        if bid <= 0 or ask <= 0 or ask <= bid:
            status = "REJECT"
            reject_reason = f"bad quote bid=${bid} ask=${ask}"
        elif spread < MIN_SPREAD_WIDTH:
            status = "REJECT"
            reject_reason = f"spread ${spread:.3f} < ${MIN_SPREAD_WIDTH}"
        elif oi < 50:
            status = "REJECT"
            reject_reason = f"OI={oi} < 50"
        elif 0 < vol < MIN_DAILY_VOLUME and oi < 200:
            status = "REJECT"
            reject_reason = f"vol={vol} OI={oi} too low"
        else:
            status = "VIABLE"
            total_viable += 1

        marker = ">>>" if status == "VIABLE" else "   "
        print(
            f"  {marker} {contract_sym}: "
            f"bid=${bid:.2f} ask=${ask:.2f} spread=${spread:.3f} "
            f"OI={oi} vol={vol} IV={iv:.2f} "
            f"— {status} {reject_reason}"
        )

print(f"\n{'='*60}")
print(f"SUMMARY: {total_contracts} contracts scanned, {total_viable} viable")
print(f"{'='*60}")
