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
from options_selector import get_selector
from scorer_convergence import get_convergence_scorer
# DISABLED: Stream causing worker timeouts even without monkey patching
# from alpaca_stream_gevent import get_stream
from datetime import datetime, timedelta
import logging
import os
import json
import time

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = Flask(__name__)

# WebSocket stream DISABLED - causing worker timeouts
# Issue: Even without monkey patching, stream init blocks workers
# Solution: Use 2-second polling until we can debug async initialization
alpaca_stream = None

def get_alpaca_stream():
    """Stream disabled - workers timeout during initialization"""
    return None

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
    """Get latest prices for all symbols (REST fallback - stream disabled)"""
    TICKERS = ['NVDA', 'TSLA', 'AMD', 'AAPL', 'AMZN', 'META', 'MSFT', 'GOOGL', 'NFLX', 'AVGO', 'ORCL', 'ADBE']
    
    try:
        alpaca = AlpacaClient()
        quotes = []
        
        for ticker in TICKERS:
            try:
                snapshot = alpaca.get_snapshot(ticker)
                quotes.append(snapshot)
            except Exception as e:
                logger.error(f"Error fetching {ticker}: {e}")
                quotes.append(None)
        
        return jsonify({'quotes': quotes})
    except Exception as e:
        logger.error(f"Error in latest_prices: {e}", exc_info=True)
        return jsonify({'error': str(e)}), 500

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

@app.route('/api/options/<symbol>')
def api_options(symbol):
    """Get options chain data from Alpaca for a specific strike"""
    try:
        # Get query parameters
        strike = request.args.get('strike', type=float)
        option_type = request.args.get('type', 'call').lower()  # 'call' or 'put'
        expiration = request.args.get('expiration', '')  # YYYY-MM-DD format
        
        alpaca = AlpacaClient()
        
        # Get full options chain
        chain_data = alpaca.get_options_chain(symbol.upper())
        
        if 'error' in chain_data:
            return jsonify(chain_data), 403
        
        # If no specific parameters, return summary of nearest ATM options
        if not strike or not expiration:
            # Get current stock price
            quote = alpaca.get_snapshot(symbol.upper())
            current_price = quote.get('c', quote.get('latestTrade', {}).get('p', 0))
            
            # Find nearest strikes and expirations
            summary = {
                'symbol': symbol.upper(),
                'stock_price': current_price,
                'message': 'Provide strike and expiration for specific option data',
                'example': f'/api/options/{symbol}?strike=150&type=call&expiration=2026-03-21'
            }
            return jsonify(summary)
        
        # Find the specific option contract
        # Alpaca options format: {underlying}_{expiration}_{strike}{C/P}
        option_symbol = f"{symbol.upper()}_{expiration.replace('-', '')}_{int(strike * 1000):08d}{'C' if option_type == 'call' else 'P'}"
        
        # Search for the contract in chain data
        options = chain_data.get('snapshots', {})
        
        if option_symbol in options:
            option_data = options[option_symbol]
            
            # Extract relevant pricing info
            latest_quote = option_data.get('latestQuote', {})
            latest_trade = option_data.get('latestTrade', {})
            greeks = option_data.get('greeks', {})
            
            result = {
                'symbol': option_symbol,
                'underlying': symbol.upper(),
                'strike': strike,
                'type': option_type,
                'expiration': expiration,
                'bid': latest_quote.get('bp', 0),
                'ask': latest_quote.get('ap', 0),
                'mid': (latest_quote.get('bp', 0) + latest_quote.get('ap', 0)) / 2 if latest_quote.get('bp') and latest_quote.get('ap') else 0,
                'last': latest_trade.get('p', 0),
                'volume': latest_trade.get('s', 0),
                'bid_size': latest_quote.get('bs', 0),
                'ask_size': latest_quote.get('as', 0),
                'implied_volatility': greeks.get('impliedVolatility', 0),
                'delta': greeks.get('delta', 0),
                'gamma': greeks.get('gamma', 0),
                'theta': greeks.get('theta', 0),
                'vega': greeks.get('vega', 0),
                'open_interest': option_data.get('openInterest', 0)
            }
            
            return jsonify(result)
        else:
            # Contract not found - try to find nearest available
            return jsonify({
                'error': 'Option contract not found',
                'searched_for': option_symbol,
                'available_contracts': len(options),
                'suggestion': 'Try /api/options/nearest endpoint to find closest match'
            }), 404
            
    except Exception as e:
        logger.error(f"Error fetching options for {symbol}: {e}", exc_info=True)
        return jsonify({'error': str(e)}), 500

@app.route('/api/options/optimal/<symbol>')
def api_options_optimal(symbol):
    """Find OPTIMAL option contract for asymmetric 1-2 day returns"""
    try:
        logger.info(f"🎯 Finding optimal option for {symbol} (asymmetric strategy)")
        
        # Get parameters
        option_type = request.args.get('type', 'call').lower()
        
        alpaca = AlpacaClient()
        
        # Get current stock price
        quote = alpaca.get_snapshot(symbol.upper())
        stock_price = quote.get('c', quote.get('latestTrade', {}).get('p', 0))
        
        if not stock_price:
            return jsonify({'error': 'Could not get current stock price'}), 500
        
        logger.info(f"   Current stock price: ${stock_price:.2f}")
        
        # Get full options chain
        chain_data = alpaca.get_options_chain(symbol.upper())
        
        if 'error' in chain_data:
            logger.error(f"   ❌ Alpaca returned error: {chain_data['error']}")
            return jsonify(chain_data), 403
        
        options = chain_data.get('snapshots', {})
        logger.info(f"   Found {len(options)} total options contracts")
        
        if not options:
            logger.warning(f"   No options available for {symbol}")
            return jsonify({'error': 'No options available for this symbol'}), 404
        
        # Use smart selector to find optimal contract
        selector = get_selector()
        best_contract = selector.select_best_contract(options, stock_price, option_type)
        
        if not best_contract:
            return jsonify({
                'error': 'No suitable contracts found for strategy',
                'details': 'Strategy requires: 1-3 DTE, Delta 0.30-0.60, OI>100, Volume>10',
                'total_contracts_available': len(options)
            }), 404
        
        # Return the optimal contract
        result = {
            'symbol': best_contract['symbol'],
            'underlying': symbol.upper(),
            'strike': best_contract['strike'],
            'type': option_type,
            'expiration': best_contract['expiration'].strftime('%Y-%m-%d'),
            'dte': best_contract['dte'],
            'bid': best_contract['bid'],
            'ask': best_contract['ask'],
            'mid': best_contract['mid'],
            'last': best_contract['last'],
            'volume': best_contract['volume'],
            'bid_size': best_contract.get('bid_size', 0),
            'ask_size': best_contract.get('ask_size', 0),
            'implied_volatility': best_contract['iv'],
            'delta': best_contract['delta'],
            'gamma': best_contract['gamma'],
            'theta': best_contract['theta'],
            'vega': best_contract['vega'],
            'open_interest': best_contract['open_interest'],
            'pct_otm': best_contract['pct_otm'],
            'spread_pct': best_contract['spread_pct'],
            'score': best_contract['score'],
            'strategy': 'asymmetric_1_2_day',
            'why_selected': f"Optimal for 50-100% returns: {best_contract['dte']}DTE, Δ={best_contract['delta']:.3f}, {best_contract['pct_otm']:.1f}% OTM"
        }
        
        return jsonify(result)
            
    except Exception as e:
        logger.error(f"Error finding optimal option for {symbol}: {e}", exc_info=True)
        return jsonify({'error': str(e)}), 500

@app.route('/api/options/debug/<symbol>')
def api_options_debug(symbol):
    """Debug endpoint - show raw Alpaca options chain response"""
    try:
        alpaca = AlpacaClient()
        chain_data = alpaca.get_options_chain(symbol.upper())
        
        # Return raw response with summary
        summary = {
            'raw_response_keys': list(chain_data.keys()),
            'snapshots_count': len(chain_data.get('snapshots', {})),
            'first_5_symbols': list(chain_data.get('snapshots', {}).keys())[:5],
            'full_response': chain_data
        }
        
        return jsonify(summary)
    except Exception as e:
        logger.error(f"Debug endpoint error: {e}", exc_info=True)
        return jsonify({'error': str(e), 'traceback': str(e)}), 500

@app.route('/api/signal/<symbol>')
def api_signal(symbol):
    """Get convergence signal - cached if available, calculated on-demand otherwise"""
    from models import Signal, get_session
    
    session = get_session()
    try:
        # Try to read from signals cache first (FAST - < 50ms)
        signal = session.query(Signal).filter_by(ticker=symbol.upper()).first()
        
        if signal:
            # Check if data is stale (> 5 minutes)
            age_seconds = (datetime.utcnow() - signal.updated_at).total_seconds()
            if age_seconds > 300:
                logger.warning(f"Signal for {symbol} is stale ({age_seconds:.0f}s old)")
            
            # Return cached data
            result = {
                'ticker': signal.ticker,
                'stock_price': float(signal.price) if signal.price else None,
                'convergence': signal.convergence_json,
                'option': signal.option_json,
                'recommendation': _generate_recommendation(signal.convergence_json, signal.option_json),
                'cached_at': signal.updated_at.isoformat() if signal.updated_at else None,
                'age_seconds': age_seconds,
                'source': 'cache'
            }
            return jsonify(result)
        
        # Fallback: Calculate on-demand if not cached (worker hasn't run yet)
        logger.info(f"Signal not cached for {symbol}, calculating on-demand...")
        
        alpaca = AlpacaClient()
        quote = alpaca.get_snapshot(symbol.upper())
        stock_price = quote.get('c', 0)
        
        if not stock_price:
            return jsonify({'error': 'Could not get stock price'}), 500
        
        # Get SPY for market context
        spy_quote = alpaca.get_snapshot('SPY')
        spy_current = spy_quote.get('c', 0)
        spy_prev = spy_quote.get('pc', spy_current)
        market_data = {
            'is_up': spy_current >= spy_prev,
            'change_pct': ((spy_current - spy_prev) / spy_prev * 100) if spy_prev else 0
        }
        
        # Run convergence scoring
        scorer = get_convergence_scorer(ALPACA_API_KEY, ALPACA_SECRET_KEY)
        convergence_result = scorer.score_ticker(symbol.upper(), quote, market_data)
        
        # Get optimal option
        momentum_move = convergence_result['signals']['momentum']['metrics'].get('move_from_open', 0)
        option_type = 'call' if momentum_move >= 0 else 'put'
        chain_data = alpaca.get_options_chain(symbol.upper())
        
        optimal_option = None
        if 'error' not in chain_data and chain_data.get('snapshots'):
            selector = get_selector()
            optimal_option = selector.select_best_contract(
                chain_data.get('snapshots', {}),
                stock_price,
                option_type
            )
        
        result = {
            'ticker': symbol.upper(),
            'stock_price': stock_price,
            'convergence': convergence_result,
            'option': optimal_option,
            'recommendation': _generate_recommendation(convergence_result, optimal_option),
            'source': 'calculated'
        }
        
        return jsonify(result)
        
    except Exception as e:
        logger.error(f"Error fetching signal for {symbol}: {e}", exc_info=True)
        return jsonify({'error': str(e)}), 500
    finally:
        session.close()

@app.route('/api/signals/all')
def api_signals_all():
    """Get all cached signals (for dashboard grid) - ONE REQUEST"""
    from models import Signal, get_session
    
    session = get_session()
    try:
        signals = session.query(Signal).all()
        
        return jsonify({
            'signals': [s.to_dict() for s in signals],
            'count': len(signals),
            'timestamp': datetime.utcnow().isoformat()
        })
        
    except Exception as e:
        logger.error(f"Error fetching all signals: {e}", exc_info=True)
        return jsonify({'error': str(e)}), 500
    finally:
        session.close()

def _generate_recommendation(convergence, option):
    """Generate trading recommendation based on convergence + options"""
    score = convergence['total_score']
    grade = convergence['grade']
    convergence_count = convergence['convergence_count']
    confidence = convergence['confidence']
    
    if not option:
        return {
            'action': 'NO TRADE',
            'reason': 'No suitable options contract available',
            'confidence': 'N/A'
        }
    
    if score >= 85 and convergence_count >= 4:
        action = 'STRONG BUY'
        reason = f"{convergence_count} signals converged. Grade {grade}. High probability setup."
    elif score >= 75 and convergence_count >= 3:
        action = 'BUY'
        reason = f"{convergence_count} signals converged. Grade {grade}. Good setup."
    elif score >= 65:
        action = 'CONSIDER'
        reason = f"Grade {grade}. Moderate setup. Watch for more convergence."
    else:
        action = 'PASS'
        reason = f"Grade {grade}. Insufficient convergence. Wait for better setup."
    
    return {
        'action': action,
        'reason': reason,
        'confidence': confidence,
        'entry': option.get('mid'),
        'stop': round(option.get('mid', 0) * 0.70, 2),
        'target': round(option.get('mid', 0) * 1.50, 2),
        'risk_reward': '1:1.67'
    }

@app.route('/v5')
def v5_dashboard():
    """V5 Dashboard - 100-Point Momentum Confirmation Strategy"""
    return render_template('v5_dashboard.html')

@app.route('/api/v5/score/<symbol>')
def api_v5_score(symbol):
    """Get V5 score for a ticker"""
    try:
        from scorer_v5 import get_v5_scorer
        
        # Get current quote
        alpaca = AlpacaClient()
        snapshot = alpaca.get_snapshot(symbol.upper())
        
        if not snapshot:
            return jsonify({'error': 'No data available'}), 404
        
        # Get 20-day average volume (from bars)
        bars = alpaca.get_bars(symbol.upper(), timeframe='1Day', limit=20)
        if bars and len(bars) > 0:
            avg_volume = sum(bar['v'] for bar in bars) / len(bars)
        else:
            avg_volume = snapshot.get('v', 0)
        
        # Build quote_data for scorer
        quote_data = {
            'open': snapshot.get('o', 0),
            'high': snapshot.get('h', 0),
            'low': snapshot.get('l', 0),
            'current': snapshot.get('c', 0),
            'volume': snapshot.get('v', 0),
            'avg_volume': avg_volume
        }
        
        # Get SPY for market alignment (optional)
        market_data = None
        try:
            spy_snapshot = alpaca.get_snapshot('SPY')
            if spy_snapshot:
                spy_direction = 'UP' if spy_snapshot.get('c', 0) > spy_snapshot.get('o', 0) else 'DOWN'
                market_data = {'spy_direction': spy_direction}
        except:
            pass
        
        # Calculate V5 score
        scorer = get_v5_scorer()
        result = scorer.score_ticker(symbol.upper(), quote_data, market_data)
        
        return jsonify(result)
        
    except Exception as e:
        logger.error(f"Error scoring {symbol}: {str(e)}")
        return jsonify({'error': str(e)}), 500

@app.route('/favicon.ico')
def favicon():
    """Return simple favicon to prevent 404"""
    return '', 204  # No Content

@app.route('/health')
def health():
    """Health check endpoint"""
    return jsonify({'status': 'ok', 'timestamp': datetime.now().isoformat()})

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=10000)
