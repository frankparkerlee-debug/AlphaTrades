"""
Real-time WebSocket streaming from Alpaca
Pushes live stock prices to connected clients
"""
import os
import json
import asyncio
import websockets
import logging
from datetime import datetime
from threading import Thread
from queue import Queue
import time

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

class AlpacaStream:
    """WebSocket streaming client for Alpaca real-time data"""
    
    def __init__(self, api_key, secret_key, feed='iex'):
        self.api_key = api_key
        self.secret_key = secret_key
        self.feed = feed  # 'iex' or 'sip' (sip = all exchanges, requires premium)
        self.ws_url = f"wss://stream.data.alpaca.markets/v2/{feed}"
        
        # Stock tickers to monitor
        self.stock_symbols = [
            'NVDA', 'TSLA', 'AMD', 'AAPL', 'AMZN', 
            'META', 'MSFT', 'GOOGL', 'NFLX', 'AVGO', 
            'ORCL', 'ADBE', 'SPY'
        ]
        
        # Message queues for different consumers
        self.price_queue = Queue(maxsize=1000)  # For frontend updates
        self.scoring_queue = Queue(maxsize=1000)  # For worker scoring
        
        # Latest prices cache (thread-safe)
        self.latest_prices = {}
        
        # Connection state
        self.is_connected = False
        self.ws = None
        
    async def _authenticate(self, websocket):
        """Authenticate WebSocket connection"""
        auth_message = {
            "action": "auth",
            "key": self.api_key,
            "secret": self.secret_key
        }
        await websocket.send(json.dumps(auth_message))
        
        # Wait for auth response
        response = await websocket.recv()
        data = json.loads(response)
        
        # Check for success message (Alpaca sends 'connected' on initial auth)
        if data[0].get('T') == 'success':
            msg = data[0].get('msg', '')
            if msg in ['authenticated', 'connected']:
                logger.info(f"✅ WebSocket authenticated successfully ({msg})")
                return True
        
        logger.error(f"❌ Authentication failed: {data}")
        return False
    
    async def _subscribe(self, websocket):
        """Subscribe to stock trade updates"""
        subscribe_message = {
            "action": "subscribe",
            "trades": self.stock_symbols,
            "quotes": self.stock_symbols,  # Also get bid/ask
            "bars": self.stock_symbols  # 1-minute bars
        }
        await websocket.send(json.dumps(subscribe_message))
        logger.info(f"📡 Subscribed to {len(self.stock_symbols)} symbols")
    
    async def _handle_message(self, message):
        """Process incoming WebSocket message"""
        try:
            data = json.loads(message)
            
            for item in data:
                msg_type = item.get('T')
                
                # Trade update (last price)
                if msg_type == 't':
                    symbol = item.get('S')
                    price = item.get('p')
                    timestamp = item.get('t')
                    
                    update = {
                        'type': 'trade',
                        'symbol': symbol,
                        'price': price,
                        'timestamp': timestamp,
                        'volume': item.get('s', 0)
                    }
                    
                    # Update cache
                    if symbol not in self.latest_prices:
                        self.latest_prices[symbol] = {}
                    self.latest_prices[symbol]['last'] = price
                    self.latest_prices[symbol]['timestamp'] = timestamp
                    
                    # Push to queues (non-blocking)
                    try:
                        self.price_queue.put_nowait(update)
                        self.scoring_queue.put_nowait(update)
                    except:
                        pass  # Queue full, skip
                
                # Quote update (bid/ask)
                elif msg_type == 'q':
                    symbol = item.get('S')
                    bid = item.get('bp')
                    ask = item.get('ap')
                    
                    update = {
                        'type': 'quote',
                        'symbol': symbol,
                        'bid': bid,
                        'ask': ask,
                        'bid_size': item.get('bs', 0),
                        'ask_size': item.get('as', 0)
                    }
                    
                    # Update cache
                    if symbol not in self.latest_prices:
                        self.latest_prices[symbol] = {}
                    self.latest_prices[symbol]['bid'] = bid
                    self.latest_prices[symbol]['ask'] = ask
                    
                    try:
                        self.price_queue.put_nowait(update)
                    except:
                        pass
                
                # Bar update (OHLCV)
                elif msg_type == 'b':
                    symbol = item.get('S')
                    
                    update = {
                        'type': 'bar',
                        'symbol': symbol,
                        'open': item.get('o'),
                        'high': item.get('h'),
                        'low': item.get('l'),
                        'close': item.get('c'),
                        'volume': item.get('v'),
                        'timestamp': item.get('t')
                    }
                    
                    # Update cache with bar data
                    if symbol not in self.latest_prices:
                        self.latest_prices[symbol] = {}
                    self.latest_prices[symbol].update({
                        'open': item.get('o'),
                        'high': item.get('h'),
                        'low': item.get('l'),
                        'close': item.get('c')
                    })
                    
                    try:
                        self.scoring_queue.put_nowait(update)
                    except:
                        pass
                
                # Subscription confirmation
                elif msg_type == 'subscription':
                    logger.info(f"📊 Subscription confirmed: {item}")
        
        except Exception as e:
            logger.error(f"Error handling message: {e}")
    
    async def _run(self):
        """Main WebSocket connection loop"""
        while True:
            try:
                async with websockets.connect(self.ws_url) as websocket:
                    self.ws = websocket
                    self.is_connected = True
                    
                    # Authenticate
                    if not await self._authenticate(websocket):
                        logger.error("Authentication failed, retrying in 5s...")
                        await asyncio.sleep(5)
                        continue
                    
                    # Subscribe to symbols
                    await self._subscribe(websocket)
                    
                    # Listen for messages
                    logger.info("🎧 Listening for real-time updates...")
                    async for message in websocket:
                        await self._handle_message(message)
            
            except websockets.exceptions.ConnectionClosed:
                logger.warning("⚠️ WebSocket connection closed, reconnecting...")
                self.is_connected = False
                await asyncio.sleep(2)
            
            except Exception as e:
                logger.error(f"WebSocket error: {e}")
                self.is_connected = False
                await asyncio.sleep(5)
    
    def start(self):
        """Start WebSocket connection in background thread"""
        def run_loop():
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            loop.run_until_complete(self._run())
        
        thread = Thread(target=run_loop, daemon=True)
        thread.start()
        logger.info("🚀 Alpaca WebSocket stream started")
    
    def get_latest_price(self, symbol):
        """Get latest cached price for symbol"""
        return self.latest_prices.get(symbol, {})
    
    def get_price_update(self, timeout=1):
        """Get next price update from queue (blocking)"""
        try:
            return self.price_queue.get(timeout=timeout)
        except:
            return None
    
    def get_scoring_update(self, timeout=1):
        """Get next update for scoring (blocking)"""
        try:
            return self.scoring_queue.get(timeout=timeout)
        except:
            return None

# Global stream instance
_stream_instance = None

def get_stream():
    """Get or create global stream instance"""
    global _stream_instance
    
    if _stream_instance is None:
        api_key = os.getenv('ALPACA_API_KEY')
        secret_key = os.getenv('ALPACA_SECRET_KEY')
        
        if not api_key or not secret_key:
            raise ValueError("Alpaca API credentials not configured")
        
        _stream_instance = AlpacaStream(api_key, secret_key, feed='iex')
        _stream_instance.start()
        
        # Give it a moment to connect
        time.sleep(2)
    
    return _stream_instance

if __name__ == '__main__':
    # Test the stream
    stream = get_stream()
    
    print("Listening for updates (Ctrl+C to stop)...")
    while True:
        update = stream.get_price_update(timeout=5)
        if update:
            print(f"📈 {update['symbol']}: ${update.get('price', 'N/A')}")
