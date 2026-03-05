"""
Flask Web Service - API and Dashboard
Three-page architecture:
1. Stock Cards - Live monitoring with call/put grades
2. Trader Simulation - Paper trading performance
3. Options Feed - Historical alerts with filters
"""
from flask import Flask, jsonify, request, render_template, Response, stream_with_context
from models import Alert, Trade, DailyPerformance, ModelConfig, AccountState, get_session
from alpaca_client import AlpacaClient
from alpaca_stream_gevent import get_stream
from datetime import datetime, timedelta
import logging
import os
import json
import time

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = Flask(__name__)

# WebSocket stream using gevent (no asyncio conflicts)
alpaca_stream = None

def get_alpaca_stream():
    """Lazy-load the Alpaca stream using gevent-compatible WebSocket"""
    global alpaca_stream
    if alpaca_stream is None:
        try:
            logger.info("🔄 Initializing Alpaca WebSocket stream (gevent)...")
            alpaca_stream = get_stream()
            logger.info("✅ Alpaca WebSocket stream initialized (gevent)")
        except Exception as e:
            logger.error(f"❌ Failed to initialize stream: {e}", exc_info=True)
            return None
    return alpaca_stream

# Alpaca API credentials
ALPACA_API_KEY = os.getenv('ALPACA_API_KEY', '')
ALPACA_SECRET_KEY = os.getenv('ALPACA_SECRET_KEY', '')
ALPACA_DATA_URL = os.getenv('ALPACA_DATA_URL', 'https://data.alpaca.markets')

def hold_time(entry_time):
    """Calculate hold time from entry"""
    if not entry_time:
        return ""
    delta = datetime.now() - entry_time
    days = delta.days
    hours = delta.seconds // 3600
    if days > 0:
        return f"{days}d {hours}h"
    return f"{hours}h"

@app.route('/')
def stock_cards():
    """Stock Cards Page - Live monitoring"""
    return render_template(
        'stock_cards.html',
        alpaca_key=ALPACA_API_KEY,
        alpaca_secret=ALPACA_SECRET_KEY,
        alpaca_data_url=ALPACA_DATA_URL
    )

@app.route('/trader')
def trader_simulation():
    """Trader Simulation Page - Performance dashboard"""
    session = get_session()
    
    try:
        # Get account state
        account = session.query(AccountState).order_by(AccountState.id.desc()).first()
        if not account:
            account = AccountState()
        
        # Calculate win rate
        if account.total_trades > 0:
            win_rate = (account.winning_trades / account.total_trades) * 100
        else:
            win_rate = 0
        
        # Get open positions
        open_trades = session.query(Trade).filter_by(status='OPEN').order_by(Trade.entry_time.desc()).all()
        
        # Get closed trades
        closed_trades = session.query(Trade).filter_by(status='CLOSED').order_by(Trade.exit_time.desc()).limit(50).all()
        
        # Performance stats
        best_trade = session.query(Trade).filter_by(status='CLOSED').order_by(Trade.profit_loss.desc()).first()
        worst_trade = session.query(Trade).filter_by(status='CLOSED').order_by(Trade.profit_loss.asc()).first()
        
        # Average hold time
        closed_with_days = [t for t in closed_trades if t.hold_days is not None]
        avg_hold_days = sum(t.hold_days for t in closed_with_days) / len(closed_with_days) if closed_with_days else 0
        
        # Average P/L per trade
        avg_pl_per_trade = account.cumulative_pl / account.total_trades if account.total_trades > 0 else 0
        
        # Grade statistics
        grade_stats = {}
        for grade in ['A+', 'A', 'A-', 'B+', 'B', 'B-']:
            grade_trades = [t for t in closed_trades if t.grade == grade]
            if grade_trades:
                wins = len([t for t in grade_trades if t.profit_loss >= 0])
                grade_stats[grade] = {
                    'count': len(grade_trades),
                    'win_rate': (wins / len(grade_trades)) * 100,
                    'total_pl': sum(t.profit_loss for t in grade_trades),
                    'avg_pl': sum(t.profit_loss for t in grade_trades) / len(grade_trades),
                    'best': max(t.profit_loss for t in grade_trades),
                    'worst': min(t.profit_loss for t in grade_trades)
                }
        
        return render_template(
            'trader_simulation.html',
            account=account,
            win_rate=win_rate,
            open_positions=len(open_trades),
            open_trades=open_trades,
            closed_trades=closed_trades,
            best_trade=best_trade,
            worst_trade=worst_trade,
            avg_hold_days=avg_hold_days,
            avg_pl_per_trade=avg_pl_per_trade,
            grade_stats=grade_stats,
            hold_time=hold_time,
            mode='paper'
        )
    except Exception as e:
        logger.error(f"Error rendering trader page: {e}")
        return f"Error: {e}", 500
    finally:
        session.close()

@app.route('/feed')
def options_feed():
    """Options Feed Page - Historical alerts with filters"""
    session = get_session()
    
    try:
        # Get filter parameters
        ticker = request.args.get('ticker', '').upper()
        grade = request.args.get('grade', '')
        direction = request.args.get('direction', '')
        start_date = request.args.get('start_date', '')
        end_date = request.args.get('end_date', '')
        page = request.args.get('page', 1, type=int)
        per_page = 50
        
        # Build query
        query = session.query(Alert)
        
        if ticker:
            query = query.filter(Alert.ticker.like(f'%{ticker}%'))
        
        if grade:
            query = query.filter_by(grade=grade)
        
        if direction:
            query = query.filter_by(direction=direction)
        
        if start_date:
            start_dt = datetime.strptime(start_date, '%Y-%m-%d')
            query = query.filter(Alert.timestamp >= start_dt)
        
        if end_date:
            end_dt = datetime.strptime(end_date, '%Y-%m-%d') + timedelta(days=1)
            query = query.filter(Alert.timestamp < end_dt)
        
        # Get total count for pagination
        total_alerts = query.count()
        total_pages = (total_alerts + per_page - 1) // per_page
        
        # Get paginated results
        alerts = query.order_by(Alert.timestamp.desc()).limit(per_page).offset((page - 1) * per_page).all()
        
        # Quick stats
        today_start = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
        today_alerts = session.query(Alert).filter(Alert.timestamp >= today_start).count()
        
        a_grade_count = session.query(Alert).filter(
            Alert.grade.in_(['A+', 'A', 'A-'])
        ).count()
        
        b_grade_count = session.query(Alert).filter(
            Alert.grade.in_(['B+', 'B', 'B-'])
        ).count()
        
        return render_template(
            'options_feed.html',
            alerts=alerts,
            total_alerts=total_alerts,
            today_alerts=today_alerts,
            a_grade_count=a_grade_count,
            b_grade_count=b_grade_count,
            page=page,
            total_pages=total_pages,
            filters={
                'ticker': ticker,
                'grade': grade,
                'direction': direction,
                'start_date': start_date,
                'end_date': end_date
            }
        )
    except Exception as e:
        logger.error(f"Error rendering feed page: {e}")
        return f"Error: {e}", 500
    finally:
        session.close()

# Real-Time Streaming Endpoint (Server-Sent Events)
@app.route('/api/stream/prices')
def stream_prices():
    """Server-Sent Events endpoint for real-time price updates"""
    def generate():
        """Generator function for SSE"""
        # Try to get stream, but don't fail if it's not available
        try:
            stream = get_alpaca_stream()
        except Exception as e:
            logger.error(f"Stream initialization failed in endpoint: {e}")
            stream = None
        
        if not stream:
            # Fallback: Send error and close connection
            yield f"data: {json.dumps({'error': 'Stream not available - using REST API fallback'})}\n\n"
            return
        
        # Send initial connection confirmation
        yield f"data: {json.dumps({'type': 'connected', 'timestamp': datetime.now().isoformat()})}\n\n"
        
        # Stream price updates
        while True:
            try:
                # Get next update from stream (blocks for max 1 second)
                update = stream.get_price_update(timeout=1)
                
                if update:
                    # Send update as SSE event
                    yield f"data: {json.dumps(update)}\n\n"
                else:
                    # Send heartbeat to keep connection alive
                    yield f": heartbeat\n\n"
                
            except GeneratorExit:
                # Client disconnected
                logger.info("Client disconnected from price stream")
                break
            except Exception as e:
                logger.error(f"Error in price stream: {e}")
                yield f"data: {json.dumps({'error': str(e)})}\n\n"
                break
    
    return Response(
        stream_with_context(generate()),
        mimetype='text/event-stream',
        headers={
            'Cache-Control': 'no-cache',
            'X-Accel-Buffering': 'no',  # Disable nginx buffering
            'Connection': 'keep-alive'
        }
    )

@app.route('/api/stream/latest')
def latest_prices():
    """Get latest cached prices for all symbols"""
    stream = get_alpaca_stream()
    if not stream:
        return jsonify({'error': 'Stream not initialized'}), 503
    
    prices = {}
    for symbol in stream.stock_symbols:
        price_data = stream.get_latest_price(symbol)
        if price_data:
            prices[symbol] = price_data
    
    return jsonify(prices)

# API Endpoints (for stock cards live data)
@app.route('/api/alerts')
def api_alerts():
    """Get recent alerts"""
    session = get_session()
    try:
        limit = request.args.get('limit', 100, type=int)
        alerts = session.query(Alert).order_by(Alert.timestamp.desc()).limit(limit).all()
        return jsonify([{
            'timestamp': alert.timestamp.isoformat(),
            'ticker': alert.ticker,
            'direction': alert.direction,
            'grade': alert.grade,
            'score': alert.score,
            'strike': float(alert.strike),
            'target_option_price': float(alert.target_option_price),
            'move_pct': float(alert.move_pct),
            'range_pct': float(alert.range_pct),
            'days_to_expiry': alert.days_to_expiry
        } for alert in alerts])
    finally:
        session.close()

@app.route('/api/trades')
def api_trades():
    """Get trades"""
    session = get_session()
    try:
        status = request.args.get('status', 'all')
        limit = request.args.get('limit', 100, type=int)
        
        query = session.query(Trade)
        if status != 'all':
            query = query.filter_by(status=status.upper())
        
        trades = query.order_by(Trade.entry_time.desc()).limit(limit).all()
        return jsonify([{
            'id': trade.id,
            'ticker': trade.ticker,
            'direction': trade.direction,
            'grade': trade.grade,
            'entry_time': trade.entry_time.isoformat(),
            'exit_time': trade.exit_time.isoformat() if trade.exit_time else None,
            'strike': float(trade.strike),
            'entry_option_price': float(trade.entry_option_price),
            'exit_option_price': float(trade.exit_option_price) if trade.exit_option_price else None,
            'profit_loss': float(trade.profit_loss) if trade.profit_loss else None,
            'profit_loss_pct': float(trade.profit_loss_pct) if trade.profit_loss_pct else None,
            'status': trade.status,
            'exit_reason': trade.exit_reason
        } for trade in trades])
    finally:
        session.close()

@app.route('/api/performance')
def api_performance():
    """Get performance metrics"""
    session = get_session()
    try:
        days = request.args.get('days', 30, type=int)
        start_date = datetime.now().date() - timedelta(days=days)
        
        perf = session.query(DailyPerformance).filter(
            DailyPerformance.date >= start_date
        ).order_by(DailyPerformance.date.desc()).all()
        
        return jsonify([{
            'date': p.date.isoformat(),
            'trades_opened': p.trades_opened,
            'trades_closed': p.trades_closed,
            'win_rate': float(p.win_rate) if p.win_rate else 0,
            'total_pl': float(p.total_profit_loss) if p.total_profit_loss else 0
        } for p in perf])
    finally:
        session.close()

@app.route('/api/trader_snapshot')
def api_trader_snapshot():
    """Get current trader snapshot for real-time updates"""
    session = get_session()
    try:
        # Get account state
        account = session.query(AccountState).order_by(AccountState.id.desc()).first()
        if not account:
            return jsonify({'error': 'No account data'}), 404
        
        # Calculate win rate
        if account.total_trades > 0:
            win_rate = (account.winning_trades / account.total_trades) * 100
        else:
            win_rate = 0
        
        # Get open positions count
        open_positions = session.query(Trade).filter_by(status='OPEN').count()
        
        return jsonify({
            'account': {
                'total_value': float(account.total_value),
                'current_capital': float(account.current_capital),
                'cumulative_pl': float(account.cumulative_pl),
                'total_trades': account.total_trades,
                'winning_trades': account.winning_trades,
                'losing_trades': account.losing_trades
            },
            'win_rate': win_rate,
            'open_positions': open_positions,
            'timestamp': datetime.now().isoformat()
        })
    finally:
        session.close()

@app.route('/api/config')
def api_config():
    """Get current configuration"""
    session = get_session()
    try:
        config = session.query(ModelConfig).filter_by(is_active=True).first()
        if not config:
            return jsonify({'error': 'No active config'}), 404
        
        return jsonify({
            'thresholds': {
                'A+': config.threshold_a_plus,
                'A': config.threshold_a,
                'A-': config.threshold_a_minus,
                'B+': config.threshold_b_plus,
                'B': config.threshold_b,
                'B-': config.threshold_b_minus
            },
            'auto_trade_grades': config.auto_trade_grades,
            'position_size_pct': float(config.position_size_pct),
            'max_positions': config.max_positions
        })
    finally:
        session.close()

@app.route('/api/quote/<symbol>')
def api_quote(symbol):
    """Get real-time quote from Alpaca"""
    try:
        alpaca = AlpacaClient()
        quote = alpaca.get_snapshot(symbol.upper())
        return jsonify(quote)
    except Exception as e:
        logger.error(f"Error fetching quote for {symbol}: {e}")
        return jsonify({'error': str(e)}), 500

@app.route('/health')
def health():
    """Health check endpoint"""
    return jsonify({'status': 'ok', 'timestamp': datetime.now().isoformat()})

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=10000)
