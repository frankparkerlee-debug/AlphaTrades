"""
Trade Execution Engine
Handles paper trading (and future real trading via Schwab API)
"""
from datetime import datetime, timedelta
from decimal import Decimal
from models import Trade, Alert, AccountState, get_session
import logging

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

class Trader:
    def __init__(self, config=None, mode='paper'):
        """
        Initialize trader
        
        Args:
            config: ModelConfig object with trading parameters
            mode: 'paper' or 'live'
        """
        self.mode = mode
        self.config = config
        
        if config:
            self.auto_trade_grades = config.auto_trade_grades
            self.position_size_pct = float(config.position_size_pct)
            self.max_positions = config.max_positions
            self.stop_loss_pct = float(config.stop_loss_pct)
            self.target_profit_pct = float(config.target_profit_pct)
            self.max_hold_days = config.max_hold_days
        else:
            # Defaults
            self.auto_trade_grades = ['A+', 'A']
            self.position_size_pct = 0.20
            self.max_positions = 3
            self.stop_loss_pct = -30.0
            self.target_profit_pct = 50.0
            self.max_hold_days = 5
    
    def should_enter_trade(self, alert_grade):
        """Check if grade qualifies for auto-trading"""
        return alert_grade in self.auto_trade_grades
    
    def enter_trade(self, alert, session):
        """
        Enter a new trade based on alert
        
        Args:
            alert: Alert object or dict with alert data
            session: Database session
        
        Returns:
            Trade object or None
        """
        # Check if we have room for more positions
        open_positions = session.query(Trade).filter_by(status='OPEN').count()
        if open_positions >= self.max_positions:
            logger.info(f"Max positions ({self.max_positions}) reached, skipping trade")
            return None
        
        # Get current account state
        account = session.query(AccountState).order_by(AccountState.id.desc()).first()
        if not account:
            logger.error("No account state found")
            return None
        
        # Calculate position size
        position_size = float(account.current_capital) * self.position_size_pct
        
        # Estimate option price (simplified - use 3% of stock price for ATM)
        if hasattr(alert, 'stock_price'):
            stock_price = float(alert.stock_price)
        else:
            stock_price = alert.get('metrics', {}).get('current', 0)
        
        estimated_option_price = stock_price * 0.03
        
        # Calculate quantity (how many contracts we can buy)
        quantity = max(1, int(position_size / (estimated_option_price * 100)))  # Options are per 100 shares
        actual_cost = estimated_option_price * 100 * quantity
        
        # Create trade
        trade = Trade(
            alert_id=alert.id if hasattr(alert, 'id') else None,
            ticker=alert.ticker if hasattr(alert, 'ticker') else alert.get('ticker'),
            direction=alert.direction if hasattr(alert, 'direction') else alert.get('direction'),
            strike=Decimal(str(alert.strike if hasattr(alert, 'strike') else alert.get('strike'))),
            expiration=alert.expiration if hasattr(alert, 'expiration') else alert.get('expiration'),
            entry_time=datetime.now(),
            entry_option_price=Decimal(str(estimated_option_price)),
            entry_stock_price=Decimal(str(stock_price)),
            position_size=Decimal(str(actual_cost)),
            quantity=quantity,
            grade=alert.grade if hasattr(alert, 'grade') else alert.get('grade'),
            status='OPEN',
            trading_mode=self.mode
        )
        
        session.add(trade)
        session.commit()
        
        logger.info(f"✅ ENTERED {trade.ticker} {trade.direction} ${trade.strike} | Grade: {trade.grade} | Cost: ${actual_cost:.2f}")
        
        return trade
    
    def check_exits(self, session):
        """
        Check all open positions for exit conditions
        
        Returns:
            List of exited trades
        """
        open_trades = session.query(Trade).filter_by(status='OPEN').all()
        exited = []
        
        for trade in open_trades:
            exit_reason = self._should_exit(trade)
            if exit_reason:
                exited_trade = self.exit_trade(trade, exit_reason, session)
                if exited_trade:
                    exited.append(exited_trade)
        
        return exited
    
    def _should_exit(self, trade):
        """
        Determine if trade should be exited
        
        Returns:
            Exit reason string or None
        """
        now = datetime.now()
        
        # Calculate hold time
        hold_time = now - trade.entry_time
        hold_days = hold_time.days
        hold_hours = hold_time.total_seconds() / 3600
        
        # Friday close rule (exit after 3pm on Friday)
        if now.weekday() == 4 and now.hour >= 15:
            return 'friday_close'
        
        # Max hold time
        if hold_days >= self.max_hold_days:
            return 'max_hold'
        
        # TODO: Check current P/L against stop loss and target
        # This requires fetching current option price
        # For now, we'll just use time-based exits
        
        # Expiration approaching (exit day before expiration)
        if trade.expiration:
            days_to_exp = (trade.expiration - now.date()).days
            if days_to_exp <= 0:
                return 'expired'
        
        return None
    
    def exit_trade(self, trade, reason, session):
        """
        Exit a trade
        
        Args:
            trade: Trade object
            reason: Exit reason string
            session: Database session
        
        Returns:
            Updated Trade object
        """
        now = datetime.now()
        
        # Estimate exit option price (simplified)
        # In real implementation, fetch from market data
        # For paper trading, simulate based on stock movement
        
        # For now, use a simple simulation:
        # - friday_close or max_hold: +20% gain (conservative)
        # - expired: -50% loss (theta decay)
        if reason == 'expired':
            exit_price = float(trade.entry_option_price) * 0.5
        elif reason in ['friday_close', 'max_hold']:
            exit_price = float(trade.entry_option_price) * 1.2
        else:
            exit_price = float(trade.entry_option_price)
        
        # Calculate P/L
        entry_cost = float(trade.entry_option_price) * 100 * trade.quantity
        exit_value = exit_price * 100 * trade.quantity
        profit_loss = exit_value - entry_cost
        profit_loss_pct = (profit_loss / entry_cost) * 100
        
        # Calculate hold time
        hold_time = now - trade.entry_time
        hold_hours = int(hold_time.total_seconds() / 3600)
        hold_days = hold_time.days
        
        # Update trade
        trade.exit_time = now
        trade.exit_option_price = Decimal(str(exit_price))
        trade.exit_reason = reason
        trade.profit_loss = Decimal(str(profit_loss))
        trade.profit_loss_pct = Decimal(str(profit_loss_pct))
        trade.hold_hours = hold_hours
        trade.hold_days = hold_days
        trade.status = 'CLOSED'
        trade.updated_at = now
        
        session.commit()
        
        pl_emoji = "📈" if profit_loss > 0 else "📉"
        logger.info(f"{pl_emoji} EXITED {trade.ticker} {trade.direction} | Reason: {reason} | P/L: ${profit_loss:.2f} ({profit_loss_pct:.1f}%) | Hold: {hold_days}d {hold_hours}h")
        
        return trade
    
    def get_current_option_price(self, trade):
        """
        Get current market price for an option
        
        TODO: Implement with real option data source
        For now, returns estimated price
        """
        # Placeholder - would query option chain API
        return float(trade.entry_option_price) * 1.1
