# KalshiWeather -- Kalshi Weather Arbitrage Bot

Weather model vs prediction market arbitrage. Buys underpriced temperature
contracts on Kalshi where GFS/ECMWF models indicate higher probability than
the market price reflects.

## Strategy

1. Every 60s, fetch GFS + ECMWF forecasts from Open-Meteo for 20 cities
2. Compare model probability vs Kalshi temperature contract prices
3. Buy YES contracts priced $0.05-0.20 where model says probability is 60%+
4. Sell when market reprices to $0.40+ (15-90 min hold)
5. Temperature laddering: buy 3-4 adjacent temperature buckets per signal

## Setup

```bash
cd KalshiWeather
pip install -r requirements.txt
cp .env.example .env
# Edit .env with your Kalshi API key and private key
```

## Usage

```bash
python main.py --test    # test Open-Meteo + Kalshi data sources
python main.py --scan    # one-shot scan for signals
python main.py           # run the bot
```

## Capital Rules

- Starting capital: $500
- Max 10% per position ($50)
- Max 15 open positions
- Daily loss limit: -15% ($75)
- Max 50 contracts per bucket
