"""
Real-time WebSocket streaming from Alpaca using gevent (no asyncio conflicts)
Pushes live stock prices to connected clients
"""
import os
import json
import logging
from datetime import datetime
from queue import Queue
import time
import ssl
import socket
from gevent import spawn, sleep
from websocket import create_connection, WebSocketConnectionClosedException

# NOTE: No monkey patching - causes recursion errors when imported
# gevent greenlets work fine without patching stdlib in this isolated module

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

class AlpacaStreamGevent:
    """WebSocket streaming client using gevent (no asyncio conflicts)"""
    
    def __init__(self, api_key, secret_key, feed='iex'):
        self.api_key = api_key
        self.secret_key = secret_key
        self.feed = feed  # 'iex' or 'sip'
        self.ws_url = f"wss://stream.data.alpaca.markets/v2/{feed}"
        
        # Stock tickers to monitor
        self.stock_symbols = [
            'NVDA', 'TSLA', 'AMD', 'AAPL', 'AMZN', 
            'META', 'MSFT', 'GOOGL', 'NFLX', 'AVGO', 
            'ORCL', 'ADBE', 'SPY'
        ]
        
        # Message queues (smaller size to prevent memory buildup)
        self.price_queue = Queue(maxsize=100)
        self.scoring_queue = Queue(maxsize=100)
        
        # Latest prices cache
        self.latest_prices = {}
        
        # Connection state
        self.is_connected = False
        self.ws = None
        self.running = False
        
    def _authenticate(self):
        """Authenticate WebSocket connection"""
        try:
            auth_message = {
                "action": "auth",
                "key": self.api_key,
                "secret": self.secret_key
            }
            self.ws.send(json.dumps(auth_message))
            
            # Wait for auth response
            response = self.ws.recv()
            data = json.loads(response)
            
            # Check for success (accepts both 'authenticated' and 'connected')
            if data[0].get('T') == 'success':
                msg = data[0].get('msg', '')
                if msg in ['authenticated', 'connected']:
                    logger.info(f"✅ WebSocket authenticated successfully ({msg})")
                    return True
            
            logger.error(f"❌ Authentication failed: {data}")
            return False
            
        except Exception as e:
            logger.error(f"Authentication error: {e}")
            return False
    
    def _subscribe(self):
        """Subscribe to stock trade updates"""
        try:
            subscribe_message = {
                "action": "subscribe",
                "trades": self.stock_symbols,
                "quotes": self.stock_symbols,
                "bars": self.stock_symbols
            }
            self.ws.send(json.dumps(subscribe_message))
            logger.info(f"📡 Subscribed to {len(self.stock_symbols)} symbols")
            return True
        except Exception as e:
            logger.error(f"Subscribe error: {e}")
            return False
    
    def _handle_message(self, message):
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
    
    def _run_loop(self):
        """Main WebSocket connection loop (runs in greenlet)"""
        while self.running:
            try:
                # Create WebSocket connection
                logger.info(f"Connecting to {self.ws_url}...")
                self.ws = create_connection(
                    self.ws_url,
                    sslopt={"cert_reqs": ssl.CERT_NONE},
                    timeout=10
                )
                self.is_connected = True
                
                # Authenticate
                if not self._authenticate():
                    logger.error("Authentication failed, retrying in 5s...")
                    sleep(5)
                    continue
                
                # Subscribe to symbols
                if not self._subscribe():
                    logger.error("Subscription failed, retrying in 5s...")
                    sleep(5)
                    continue
                
                # Listen for messages
                logger.info("🎧 Listening for real-time updates...")
                while self.running:
                    try:
                        message = self.ws.recv()
                        if message:
                            self._handle_message(message)
                    except WebSocketConnectionClosedException:
                        logger.warning("⚠️ WebSocket connection closed")
                        break
                    except Exception as e:
                        logger.error(f"Error receiving message: {e}")
                        break
            
            except Exception as e:
                logger.error(f"WebSocket error: {e}")
                self.is_connected = False
                
            finally:
                if self.ws:
                    try:
                        self.ws.close()
                    except:
                        pass
                self.is_connected = False
            
            # Reconnect after delay
            if self.running:
                logger.info("Reconnecting in 2 seconds...")
                sleep(2)
    
    def start(self):
        """Start WebSocket connection in background greenlet"""
        self.running = True
        spawn(self._run_loop)
        logger.info("🚀 Alpaca WebSocket stream started (gevent)")
        
        # Give it a moment to connect
        sleep(2)
    
    def stop(self):
        """Stop WebSocket connection"""
        self.running = False
        if self.ws:
            try:
                self.ws.close()
            except:
                pass
        logger.info("🛑 Alpaca WebSocket stream stopped")
    
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
        
        _stream_instance = AlpacaStreamGevent(api_key, secret_key, feed='iex')
        _stream_instance.start()
        
        # Give it a moment to connect
        sleep(2)
    
    return _stream_instance

if __name__ == '__main__':
    # Test the stream
    stream = get_stream()
    
    print("Listening for updates (Ctrl+C to stop)...")
    try:
        while True:
            update = stream.get_price_update(timeout=5)
            if update:
                print(f"📈 {update['symbol']}: ${update.get('price', 'N/A')}")
    except KeyboardInterrupt:
        stream.stop()
        print("\nStopped")
