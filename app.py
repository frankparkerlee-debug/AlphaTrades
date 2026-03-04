"""
Flask Web Service - API and Dashboard
"""
from flask import Flask, jsonify, request, render_template_string
from models import Alert, Trade, DailyPerformance, ModelConfig, AccountState, get_session
from datetime import datetime, timedelta
import logging

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = Flask(__name__)

# Simple HTML dashboard template
DASHBOARD_HTML = """
<!DOCTYPE html>
<html>
<head>
    <title>AlphaTrades Dashboard</title>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            padding: 20px;
        }
        .container {
            max-width: 1400px;
            margin: 0 auto;
            background: white;
            border-radius: 12px;
            padding: 30px;
            box-shadow: 0 10px 40px rgba(0,0,0,0.2);
        }
        h1 { color: #2a5298; margin-bottom: 10px; }
        h2 { color: #2a5298; margin-top: 30px; margin-bottom: 15px; border-bottom: 2px solid #e9ecef; padding-bottom: 10px; }
        .stats {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 20px;
            margin-bottom: 30px;
        }
        .stat-card {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 20px;
            border-radius: 10px;
            text-align: center;
        }
        .stat-value { font-size: 32px; font-weight: bold; margin: 10px 0; }
        .stat-label { font-size: 14px; opacity: 0.9; }
        table {
            width: 100%;
            border-collapse: collapse;
            margin-top: 15px;
        }
        th {
            background: #f8f9fa;
            padding: 12px;
            text-align: left;
            font-weight: 600;
            border-bottom: 2px solid #dee2e6;
        }
        td {
            padding: 12px;
            border-bottom: 1px solid #e9ecef;
        }
        tr:hover { background: #f8f9fa; }
        .grade-A { background: #28a745; color: white; padding: 4px 8px; border-radius: 4px; font-weight: bold; }
        .grade-B { background: #ffc107; color: #856404; padding: 4px 8px; border-radius: 4px; font-weight: bold; }
        .grade-C { background: #fd7e14; color: white; padding: 4px 8px; border-radius: 4px; font-weight: bold; }
        .positive { color: #28a745; font-weight: bold; }
        .negative { color: #dc3545; font-weight: bold; }
        .status-open { background: #d1ecf1; color: #0c5460; padding: 4px 8px; border-radius: 4px; font-size: 12px; }
        .status-closed { background: #d4edda; color: #155724; padding: 4px 8px; border-radius: 4px; font-size: 12px; }
        .refresh { text-align: center; margin-top: 20px; color: #6c757d; font-size: 14px; }
    </style>
</head>
<body>
    <div class="container">
        <h1>📊 AlphaTrades Dashboard</h1>
        <p style="color: #6c757d; margin-bottom: 30px;">Automated Options Trading System - {{ mode|upper }} MODE</p>
        
        <div class="stats">
            <div class="stat-card">
                <div class="stat-label">Account Value</div>
                <div class="stat-value">${{ account.total_value|round(2) }}</div>
                <div class="stat-label">Capital: ${{ account.current_capital|round(2) }}</div>
            </div>
            <div class="stat-card">
                <div class="stat-label">Total P/L</div>
                <div class="stat-value" style="color: {{ 'lime' if account.cumulative_pl >= 0 else 'red' }}">${{ account.cumulative_pl|round(2) }}</div>
                <div class="stat-label">{{ account.total_trades }} trades</div>
            </div>
            <div class="stat-card">
                <div class="stat-label">Win Rate</div>
                <div class="stat-value">{{ win_rate|round(1) }}%</div>
                <div class="stat-label">{{ account.winning_trades }}W / {{ account.losing_trades }}L</div>
            </div>
            <div class="stat-card">
                <div class="stat-label">Open Positions</div>
                <div class="stat-value">{{ open_positions }}</div>
                <div class="stat-label">Active trades</div>
            </div>
        </div>
        
        <h2>🚨 Recent Alerts (Last 24h)</h2>
        <table>
            <tr>
                <th>Time</th>
                <th>Ticker</th>
                <th>Grade</th>
                <th>Score</th>
                <th>Move %</th>
                <th>Range %</th>
                <th>Direction</th>
                <th>Strike</th>
            </tr>
            {% for alert in alerts %}
            <tr>
                <td>{{ alert.timestamp.strftime('%H:%M:%S') }}</td>
                <td><strong>{{ alert.ticker }}</strong></td>
                <td><span class="grade-{{ alert.grade[0] }}">{{ alert.grade }}</span></td>
                <td>{{ alert.score }}/55</td>
                <td>{{ alert.move_pct|round(2) }}%</td>
                <td>{{ alert.range_pct|round(2) }}%</td>
                <td>{{ alert.direction }}</td>
                <td>${{ alert.strike|round(2) }}</td>
            </tr>
            {% endfor %}
        </table>
        
        <h2>💼 Open Positions</h2>
        <table>
            <tr>
                <th>Entry</th>
                <th>Ticker</th>
                <th>Direction</th>
                <th>Strike</th>
                <th>Grade</th>
                <th>Entry $</th>
                <th>Hold Time</th>
                <th>Status</th>
            </tr>
            {% for trade in open_trades %}
            <tr>
                <td>{{ trade.entry_time.strftime('%m/%d %H:%M') }}</td>
                <td><strong>{{ trade.ticker }}</strong></td>
                <td>{{ trade.direction }}</td>
                <td>${{ trade.strike|round(2) }}</td>
                <td><span class="grade-{{ trade.grade[0] }}">{{ trade.grade }}</span></td>
                <td>${{ trade.entry_option_price|round(2) }}</td>
                <td>{{ hold_time(trade.entry_time) }}</td>
                <td><span class="status-{{ trade.status.lower() }}">{{ trade.status }}</span></td>
            </tr>
            {% endfor %}
        </table>
        
        <h2>📊 Closed Trades (Last 20)</h2>
        <table>
            <tr>
                <th>Date</th>
                <th>Ticker</th>
                <th>Direction</th>
                <th>Grade</th>
                <th>Entry</th>
                <th>Exit</th>
                <th>P/L</th>
                <th>P/L %</th>
                <th>Hold</th>
                <th>Exit Reason</th>
            </tr>
            {% for trade in closed_trades %}
            <tr>
                <td>{{ trade.entry_time.strftime('%m/%d') }}</td>
                <td><strong>{{ trade.ticker }}</strong></td>
                <td>{{ trade.direction }}</td>
                <td><span class="grade-{{ trade.grade[0] }}">{{ trade.grade }}</span></td>
                <td>${{ trade.entry_option_price|round(2) }}</td>
                <td>${{ trade.exit_option_price|round(2) }}</td>
                <td class="{{ 'positive' if trade.profit_loss >= 0 else 'negative' }}">${{ trade.profit_loss|round(2) }}</td>
                <td class="{{ 'positive' if trade.profit_loss_pct >= 0 else 'negative' }}">{{ trade.profit_loss_pct|round(1) }}%</td>
                <td>{{ trade.hold_days }}d</td>
                <td>{{ trade.exit_reason }}</td>
            </tr>
            {% endfor %}
        </table>
        
        <div class="refresh">
            Auto-refreshes every 30 seconds
        </div>
    </div>
    
    <script>
        setTimeout(() => location.reload(), 30000);  // Refresh every 30s
    </script>
</body>
</html>
"""

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
def dashboard():
    """Main dashboard"""
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
        
        # Get recent alerts (last 24 hours)
        yesterday = datetime.now() - timedelta(days=1)
        alerts = session.query(Alert).filter(
            Alert.timestamp >= yesterday
        ).order_by(Alert.timestamp.desc()).limit(50).all()
        
        # Get open positions
        open_trades = session.query(Trade).filter_by(status='OPEN').order_by(Trade.entry_time.desc()).all()
        
        # Get closed trades
        closed_trades = session.query(Trade).filter_by(status='CLOSED').order_by(Trade.exit_time.desc()).limit(20).all()
        
        return render_template_string(
            DASHBOARD_HTML,
            account=account,
            win_rate=win_rate,
            open_positions=len(open_trades),
            alerts=alerts,
            open_trades=open_trades,
            closed_trades=closed_trades,
            hold_time=hold_time,
            mode='paper'  # TODO: Get from config
        )
    except Exception as e:
        logger.error(f"Error rendering dashboard: {e}")
        return f"Error: {e}", 500
    finally:
        session.close()

@app.route('/api/alerts')
def api_alerts():
    """Get recent alerts"""
    session = get_session()
    try:
        limit = request.args.get('limit', 50, type=int)
        alerts = session.query(Alert).order_by(Alert.timestamp.desc()).limit(limit).all()
        return jsonify([alert.to_dict() for alert in alerts])
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
        return jsonify([trade.to_dict() for trade in trades])
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

@app.route('/health')
def health():
    """Health check endpoint"""
    return jsonify({'status': 'ok', 'timestamp': datetime.now().isoformat()})

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=10000)
