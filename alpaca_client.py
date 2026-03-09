"""
Alpaca API Client for AlphaTrades
Handles real-time stock/options data and paper trading
"""
import os
import requests
from datetime import datetime, timedelta
import json

class AlpacaClient:
    def __init__(self):
        self.api_key = os.getenv('ALPACA_API_KEY', 'PKCF3BAQSFQEWDQRLG45SZIMMQ')
        self.secret_key = os.getenv('ALPACA_SECRET_KEY', 'DFJXX1qz33tPgYxQdVAhhYt4QXmp4zFGHbiaFrCaiQkk')
        self.base_url = os.getenv('ALPACA_BASE_URL', 'https://paper-api.alpaca.markets')
        self.data_url = os.getenv('ALPACA_DATA_URL', 'https://data.alpaca.markets')
        
        self.headers = {
            'APCA-API-KEY-ID': self.api_key,
            'APCA-API-SECRET-KEY': self.secret_key
        }
    
    def get_account(self):
        """Get account information"""
        url = f"{self.base_url}/v2/account"
        response = requests.get(url, headers=self.headers)
        response.raise_for_status()
        return response.json()
    
    def get_quote(self, symbol):
        """Get latest quote for a symbol"""
        url = f"{self.data_url}/v2/stocks/{symbol}/quotes/latest"
        response = requests.get(url, headers=self.headers)
        response.raise_for_status()
        data = response.json()
        
        # Convert to format similar to Finnhub for compatibility
        quote = data.get('quote', {})
        return {
            'symbol': symbol,
            'bid': quote.get('bp', 0),
            'ask': quote.get('ap', 0),
            'bid_size': quote.get('bs', 0),
            'ask_size': quote.get('as', 0),
            'timestamp': quote.get('t', '')
        }
    
    def get_bars(self, symbol, timeframe='1Day', start=None, end=None, limit=100):
        """
        Get historical bars for a symbol
        
        Args:
            symbol: Stock ticker
            timeframe: '1Min', '5Min', '15Min', '1Hour', '1Day'
            start: Start date (YYYY-MM-DD or datetime)
            end: End date (YYYY-MM-DD or datetime)
            limit: Max number of bars (default 100, max 10000)
        """
        url = f"{self.data_url}/v2/stocks/{symbol}/bars"
        
        params = {
            'timeframe': timeframe,
            'limit': limit
        }
        
        if start:
            if isinstance(start, datetime):
                start = start.strftime('%Y-%m-%d')
            params['start'] = start
        
        if end:
            if isinstance(end, datetime):
                end = end.strftime('%Y-%m-%d')
            params['end'] = end
        
        response = requests.get(url, headers=self.headers, params=params)
        response.raise_for_status()
        return response.json()
    
    def get_latest_trade(self, symbol):
        """Get latest trade for a symbol"""
        url = f"{self.data_url}/v2/stocks/{symbol}/trades/latest"
        response = requests.get(url, headers=self.headers)
        response.raise_for_status()
        data = response.json()
        
        trade = data.get('trade', {})
        return {
            'symbol': symbol,
            'price': trade.get('p', 0),
            'size': trade.get('s', 0),
            'timestamp': trade.get('t', ''),
            'exchange': trade.get('x', '')
        }
    
    def get_snapshot(self, symbol):
        """
        Get snapshot (latest quote, trade, bars) for a symbol
        Returns format compatible with our scorer
        """
        url = f"{self.data_url}/v2/stocks/{symbol}/snapshot"
        response = requests.get(url, headers=self.headers)
        response.raise_for_status()
        data = response.json()
        
        # Extract relevant data
        latest_trade = data.get('latestTrade', {})
        latest_quote = data.get('latestQuote', {})
        daily_bar = data.get('dailyBar', {})
        prev_daily_bar = data.get('prevDailyBar', {})
        
        # Convert to format matching our scorer.py expectations
        return {
            'symbol': symbol,
            'c': latest_trade.get('p', 0),  # current price
            'o': daily_bar.get('o', 0),      # open
            'h': daily_bar.get('h', 0),      # high
            'l': daily_bar.get('l', 0),      # low
            'pc': prev_daily_bar.get('c', 0), # previous close
            't': int(datetime.now().timestamp()),  # timestamp
            'v': daily_bar.get('v', 0),      # volume
        }
    
    def get_target_option_contract(self, underlying_symbol, stock_price, direction, dte_preference=1):
        """
        SMART: Fetch ONE specific contract based on algorithm output
        Much faster than fetching entire chain (1000+ contracts)
        
        Args:
            underlying_symbol: Stock ticker
            stock_price: Current stock price
            direction: 'call' or 'put' (from V5 algorithm)
            dte_preference: Days to expiration (1 = tomorrow, default)
        
        Returns:
            Single contract dict or None
        """
        from datetime import date, timedelta
        
        # Calculate ATM strike (round to nearest $5 for stocks > $50, else $1)
        strike_increment = 5 if stock_price > 50 else 1
        target_strike = round(stock_price / strike_increment) * strike_increment
        
        # Calculate target expiration (next trading day + dte_preference)
        # Simple: today + dte_preference days (ignore weekends for now, Alpaca will find nearest)
        target_date = date.today() + timedelta(days=dte_preference)
        
        # Build OCC symbol: AAPL260314C00150000
        # Format: SYMBOL + YYMMDD + [C/P] + STRIKE (8 digits, 3 decimals)
        exp_str = target_date.strftime('%y%m%d')
        opt_type = 'C' if direction.lower() == 'call' else 'P'
        strike_str = f"{int(target_strike * 1000):08d}"
        occ_symbol = f"{underlying_symbol}{exp_str}{opt_type}{strike_str}"
        
        # Fetch JUST THIS ONE CONTRACT
        url = f"{self.data_url}/v1beta1/options/snapshots"
        params = {'symbols': occ_symbol}
        
        try:
            response = requests.get(url, headers=self.headers, params=params, timeout=3)
            
            if response.status_code == 403:
                return {'error': 'Options data requires Alpaca Premium subscription'}
            
            if response.status_code == 404:
                # Contract doesn't exist, try nearby strikes
                for offset in [-strike_increment, strike_increment, -2*strike_increment, 2*strike_increment]:
                    alt_strike = target_strike + offset
                    alt_strike_str = f"{int(alt_strike * 1000):08d}"
                    alt_symbol = f"{underlying_symbol}{exp_str}{opt_type}{alt_strike_str}"
                    params = {'symbols': alt_symbol}
                    response = requests.get(url, headers=self.headers, params=params, timeout=3)
                    if response.status_code == 200:
                        break
            
            if response.status_code != 200:
                return None
            
            data = response.json()
            snapshots = data.get('snapshots', {})
            
            if not snapshots:
                return None
            
            # Return first (and should be only) contract
            contract_symbol = list(snapshots.keys())[0]
            contract_data = snapshots[contract_symbol]
            
            # Format for options_selector compatibility
            return {
                'symbol': contract_symbol,
                'strike': target_strike,
                'expiration': target_date.isoformat(),
                'type': direction.lower(),
                'bid': contract_data.get('latestQuote', {}).get('bp', 0),
                'ask': contract_data.get('latestQuote', {}).get('ap', 0),
                'mid': (contract_data.get('latestQuote', {}).get('bp', 0) + 
                        contract_data.get('latestQuote', {}).get('ap', 0)) / 2,
                'delta': contract_data.get('greeks', {}).get('delta'),
                'iv': contract_data.get('impliedVolatility'),
                'volume': contract_data.get('latestTrade', {}).get('s', 0),
                'open_interest': contract_data.get('openInterest', 0)
            }
            
        except Exception as e:
            # Silently fail, return None (worker will handle)
            return None
    
    def get_options_chain(self, underlying_symbol):
        """
        Get options chain for a symbol (DEPRECATED - use get_target_option_contract instead)
        Note: Requires Alpaca Premium subscription for options data
        """
        url = f"{self.data_url}/v1beta1/options/snapshots/{underlying_symbol}"
        response = requests.get(url, headers=self.headers)
        
        if response.status_code == 403:
            return {'error': 'Options data requires Alpaca Premium subscription'}
        
        response.raise_for_status()
        return response.json()
    
    def place_order(self, symbol, qty, side, type='market', time_in_force='day', **kwargs):
        """
        Place an order (paper trading)
        
        Args:
            symbol: Stock ticker
            qty: Quantity
            side: 'buy' or 'sell'
            type: 'market', 'limit', 'stop', 'stop_limit'
            time_in_force: 'day', 'gtc', 'ioc', 'fok'
            **kwargs: Additional params (limit_price, stop_price, etc.)
        """
        url = f"{self.base_url}/v2/orders"
        
        order_data = {
            'symbol': symbol,
            'qty': qty,
            'side': side,
            'type': type,
            'time_in_force': time_in_force
        }
        
        # Add optional parameters
        if 'limit_price' in kwargs:
            order_data['limit_price'] = kwargs['limit_price']
        if 'stop_price' in kwargs:
            order_data['stop_price'] = kwargs['stop_price']
        
        response = requests.post(url, headers=self.headers, json=order_data)
        response.raise_for_status()
        return response.json()
    
    def get_positions(self):
        """Get all open positions"""
        url = f"{self.base_url}/v2/positions"
        response = requests.get(url, headers=self.headers)
        response.raise_for_status()
        return response.json()
    
    def get_orders(self, status='all', limit=50):
        """Get orders (all, open, closed)"""
        url = f"{self.base_url}/v2/orders"
        params = {'status': status, 'limit': limit}
        response = requests.get(url, headers=self.headers, params=params)
        response.raise_for_status()
        return response.json()


def test_connection():
    """Test Alpaca connection and print account info"""
    client = AlpacaClient()
    
    print("Testing Alpaca Paper Trading Connection...")
    print("-" * 50)
    
    try:
        # Test 1: Account info
        account = client.get_account()
        print(f"✅ Account connected: {account['account_number']}")
        print(f"   Buying Power: ${float(account['buying_power']):,.2f}")
        print(f"   Cash: ${float(account['cash']):,.2f}")
        print(f"   Portfolio Value: ${float(account['portfolio_value']):,.2f}")
        print()
        
        # Test 2: Get quote
        print("Testing stock quote (AAPL)...")
        quote = client.get_snapshot('AAPL')
        print(f"✅ AAPL Quote:")
        print(f"   Current: ${quote['c']:.2f}")
        print(f"   Open: ${quote['o']:.2f}")
        print(f"   High: ${quote['h']:.2f}")
        print(f"   Low: ${quote['l']:.2f}")
        print(f"   Prev Close: ${quote['pc']:.2f}")
        print()
        
        # Test 3: Historical data
        print("Testing historical data (NVDA, last 5 days)...")
        bars = client.get_bars('NVDA', timeframe='1Day', limit=5)
        if 'bars' in bars:
            print(f"✅ Retrieved {len(bars['bars'])} bars")
            print(f"   Latest close: ${bars['bars'][-1]['c']:.2f}")
        print()
        
        print("✅ All tests passed! Alpaca integration ready.")
        return True
        
    except Exception as e:
        print(f"❌ Error: {e}")
        return False


if __name__ == '__main__':
    test_connection()
