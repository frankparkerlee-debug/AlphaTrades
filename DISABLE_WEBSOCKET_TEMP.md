# Temporary: Disable WebSocket Streaming

## Issue
Workers keep getting SIGKILL even on Standard tier (2GB RAM). The asyncio/websockets library might be conflicting with gevent workers.

## Temporary Solution
Disable real-time WebSocket streaming and use REST API polling (every 2-3 seconds) until we debug the WebSocket issue.

## To Disable WebSocket:

Edit `app.py`:
```python
# Comment out stream initialization
# alpaca_stream = None
# def get_alpaca_stream():
#     return None

# Update /api/stream/prices to return error immediately
@app.route('/api/stream/prices')
def stream_prices():
    def generate():
        yield f"data: {json.dumps({'error': 'WebSocket temporarily disabled'})}\n\n"
    return Response(generate(), mimetype='text/event-stream')
```

Edit `stock_cards.html`:
```javascript
// Fall back to polling instead of SSE
setInterval(() => {
    updateStockCards();
}, 2000);  // Poll every 2 seconds
```

This will make the system stable while we debug the WebSocket/gevent compatibility issue.

## Root Cause Options
1. **asyncio + gevent conflict** - websockets library uses asyncio which might conflict with gevent monkey-patching
2. **Thread issues** - WebSocket runs in separate thread, might be causing problems
3. **Memory leak** - Stream might accumulate data faster than it's consumed

## Better Long-term Solution
Switch to a gevent-compatible WebSocket library like `gevent-websocket` instead of `websockets`.
