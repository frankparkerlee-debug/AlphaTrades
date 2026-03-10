"""
Alert System - Real-time monitoring and notifications
Webhooks and trade recommendations for distress signals
"""

import json
import requests
from typing import Dict, List, Optional
from datetime import datetime, timedelta
from dataclasses import dataclass
import smtplib
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart


@dataclass
class TradeRecommendation:
    """Trade recommendation for distressed company"""
    ticker: str
    action: str  # "BUY_PUT"
    strike: Optional[float]
    expiry: str
    entry_price: Optional[float]
    confidence: str  # "HIGH", "MEDIUM", "LOW"
    distress_score: int
    reasoning: str
    timestamp: datetime


class AlertManager:
    """
    Manages alerts and notifications for distress signals
    """
    
    def __init__(self, 
                 webhook_url: Optional[str] = None,
                 email_config: Optional[Dict] = None,
                 slack_webhook: Optional[str] = None,
                 discord_webhook: Optional[str] = None):
        """
        Initialize alert manager
        
        Args:
            webhook_url: Generic webhook URL
            email_config: Email configuration dict
            slack_webhook: Slack webhook URL
            discord_webhook: Discord webhook URL
        """
        self.webhook_url = webhook_url
        self.email_config = email_config
        self.slack_webhook = slack_webhook
        self.discord_webhook = discord_webhook
        
        self.alert_history: List[Dict] = []
    
    def send_alert(self, 
                  ticker: str,
                  score: int,
                  signals: List[Dict],
                  recommendation: Optional[TradeRecommendation] = None):
        """
        Send alert through all configured channels
        
        Args:
            ticker: Stock ticker
            score: Distress score
            signals: List of triggered signals
            recommendation: Trade recommendation
        """
        alert_data = {
            'timestamp': datetime.now().isoformat(),
            'ticker': ticker,
            'score': score,
            'signals': signals,
            'recommendation': recommendation.__dict__ if recommendation else None
        }
        
        # Store in history
        self.alert_history.append(alert_data)
        
        # Send through various channels
        success = False
        
        if self.webhook_url:
            success = self._send_webhook(alert_data) or success
        
        if self.slack_webhook:
            success = self._send_slack(alert_data) or success
        
        if self.discord_webhook:
            success = self._send_discord(alert_data) or success
        
        if self.email_config:
            success = self._send_email(alert_data) or success
        
        return success
    
    def _send_webhook(self, alert_data: Dict) -> bool:
        """Send to generic webhook"""
        try:
            response = requests.post(
                self.webhook_url,
                json=alert_data,
                timeout=10
            )
            response.raise_for_status()
            print(f"✅ Alert sent to webhook")
            return True
        except Exception as e:
            print(f"❌ Webhook error: {e}")
            return False
    
    def _send_slack(self, alert_data: Dict) -> bool:
        """Send formatted alert to Slack"""
        try:
            ticker = alert_data['ticker']
            score = alert_data['score']
            signals = alert_data['signals']
            
            # Format message
            blocks = [
                {
                    "type": "header",
                    "text": {
                        "type": "plain_text",
                        "text": f"🚨 DISTRESS ALERT: {ticker}"
                    }
                },
                {
                    "type": "section",
                    "fields": [
                        {"type": "mrkdwn", "text": f"*Score:*\n{score}/100"},
                        {"type": "mrkdwn", "text": f"*Signals:*\n{len(signals)}"}
                    ]
                }
            ]
            
            # Add signal details
            signal_text = "\n".join([
                f"• {s['type']}: +{s['weight']} pts - {s['details']}"
                for s in signals
            ])
            
            blocks.append({
                "type": "section",
                "text": {"type": "mrkdwn", "text": f"*Triggered Signals:*\n{signal_text}"}
            })
            
            # Add recommendation if present
            if alert_data.get('recommendation'):
                rec = alert_data['recommendation']
                blocks.append({
                    "type": "section",
                    "text": {
                        "type": "mrkdwn",
                        "text": f"*Trade Rec:* {rec['action']} {rec['strike']} PUT @ {rec['expiry']}"
                    }
                })
            
            payload = {"blocks": blocks}
            
            response = requests.post(
                self.slack_webhook,
                json=payload,
                timeout=10
            )
            response.raise_for_status()
            print(f"✅ Alert sent to Slack")
            return True
        
        except Exception as e:
            print(f"❌ Slack error: {e}")
            return False
    
    def _send_discord(self, alert_data: Dict) -> bool:
        """Send formatted alert to Discord"""
        try:
            ticker = alert_data['ticker']
            score = alert_data['score']
            signals = alert_data['signals']
            
            # Create rich embed
            embed = {
                "title": f"🚨 DISTRESS ALERT: {ticker}",
                "color": 15158332,  # Red
                "fields": [
                    {"name": "Score", "value": f"{score}/100", "inline": True},
                    {"name": "Signals", "value": str(len(signals)), "inline": True}
                ],
                "timestamp": alert_data['timestamp']
            }
            
            # Add signal details
            signal_text = "\n".join([
                f"• {s['type']}: +{s['weight']} pts"
                for s in signals
            ])
            embed["fields"].append({"name": "Triggered Signals", "value": signal_text})
            
            # Add recommendation
            if alert_data.get('recommendation'):
                rec = alert_data['recommendation']
                embed["fields"].append({
                    "name": "Trade Recommendation",
                    "value": f"{rec['action']} {rec['strike']} PUT @ {rec['expiry']}"
                })
            
            payload = {"embeds": [embed]}
            
            response = requests.post(
                self.discord_webhook,
                json=payload,
                timeout=10
            )
            response.raise_for_status()
            print(f"✅ Alert sent to Discord")
            return True
        
        except Exception as e:
            print(f"❌ Discord error: {e}")
            return False
    
    def _send_email(self, alert_data: Dict) -> bool:
        """Send email alert"""
        try:
            ticker = alert_data['ticker']
            score = alert_data['score']
            signals = alert_data['signals']
            
            # Create email
            msg = MIMEMultipart('alternative')
            msg['Subject'] = f"🚨 Distress Alert: {ticker} (Score: {score})"
            msg['From'] = self.email_config.get('from_email')
            msg['To'] = self.email_config.get('to_email')
            
            # Plain text version
            text = f"""
DISTRESS ALERT: {ticker}

Score: {score}/100
Signals Triggered: {len(signals)}

Triggered Signals:
"""
            for signal in signals:
                text += f"\n• {signal['type']}: +{signal['weight']} pts - {signal['details']}"
            
            if alert_data.get('recommendation'):
                rec = alert_data['recommendation']
                text += f"\n\nTrade Recommendation:\n{rec['action']} {rec['strike']} PUT @ {rec['expiry']}"
                text += f"\nConfidence: {rec['confidence']}"
                text += f"\nReasoning: {rec['reasoning']}"
            
            # HTML version
            html = f"""
<html>
<body>
<h2 style="color: red;">🚨 DISTRESS ALERT: {ticker}</h2>
<p><strong>Score:</strong> {score}/100</p>
<p><strong>Signals Triggered:</strong> {len(signals)}</p>

<h3>Triggered Signals:</h3>
<ul>
"""
            for signal in signals:
                html += f"<li>{signal['type']}: +{signal['weight']} pts - {signal['details']}</li>"
            
            html += "</ul>"
            
            if alert_data.get('recommendation'):
                rec = alert_data['recommendation']
                html += f"""
<h3>Trade Recommendation:</h3>
<p>{rec['action']} {rec['strike']} PUT @ {rec['expiry']}</p>
<p><strong>Confidence:</strong> {rec['confidence']}</p>
<p><strong>Reasoning:</strong> {rec['reasoning']}</p>
"""
            
            html += "</body></html>"
            
            # Attach parts
            part1 = MIMEText(text, 'plain')
            part2 = MIMEText(html, 'html')
            msg.attach(part1)
            msg.attach(part2)
            
            # Send email
            with smtplib.SMTP(
                self.email_config.get('smtp_server'),
                self.email_config.get('smtp_port', 587)
            ) as server:
                server.starttls()
                server.login(
                    self.email_config.get('username'),
                    self.email_config.get('password')
                )
                server.send_message(msg)
            
            print(f"✅ Alert sent via email")
            return True
        
        except Exception as e:
            print(f"❌ Email error: {e}")
            return False


class TradeRecommendationEngine:
    """
    Generates trade recommendations for distressed companies
    """
    
    @staticmethod
    def calculate_strike_and_expiry(ticker: str,
                                    current_price: float,
                                    distress_score: int,
                                    days_until_earnings: Optional[int] = None) -> TradeRecommendation:
        """
        Calculate recommended PUT strike and expiry
        
        Logic:
        - High distress (80+): ATM or slightly ITM, short expiry
        - Medium distress (60-79): OTM, medium expiry
        - Strike: 5-15% OTM depending on score
        - Expiry: Based on earnings date or 2-4 weeks
        """
        
        # Determine confidence level
        if distress_score >= 80:
            confidence = "HIGH"
            otm_percent = 0.05  # 5% OTM (nearly ATM)
            expiry_days = 7  # 1 week
        elif distress_score >= 70:
            confidence = "MEDIUM"
            otm_percent = 0.08  # 8% OTM
            expiry_days = 14  # 2 weeks
        else:  # 60-69
            confidence = "MEDIUM"
            otm_percent = 0.12  # 12% OTM
            expiry_days = 21  # 3 weeks
        
        # Adjust for earnings
        if days_until_earnings and days_until_earnings <= 7:
            # Align expiry to just after earnings
            expiry_days = days_until_earnings + 2
            confidence = "HIGH" if distress_score >= 70 else "MEDIUM"
        
        # Calculate strike
        strike = round(current_price * (1 - otm_percent), 2)
        
        # Calculate expiry date
        expiry_date = datetime.now() + timedelta(days=expiry_days)
        
        # Format expiry (find next Friday for options expiry)
        days_until_friday = (4 - expiry_date.weekday()) % 7
        if days_until_friday == 0 and expiry_date.hour > 16:
            days_until_friday = 7  # Next week if after market close
        
        expiry_date = expiry_date + timedelta(days=days_until_friday)
        expiry_str = expiry_date.strftime('%Y-%m-%d')
        
        # Generate reasoning
        reasoning = f"Score {distress_score}/100 suggests {confidence.lower()} probability of decline. "
        
        if days_until_earnings and days_until_earnings <= 7:
            reasoning += f"Earnings in {days_until_earnings} days - high risk period. "
        
        reasoning += f"Targeting {int(otm_percent*100)}% downside with {expiry_days}-day horizon."
        
        return TradeRecommendation(
            ticker=ticker,
            action="BUY_PUT",
            strike=strike,
            expiry=expiry_str,
            entry_price=None,  # Would need options pricing API
            confidence=confidence,
            distress_score=distress_score,
            reasoning=reasoning,
            timestamp=datetime.now()
        )


# Convenience function
def create_and_send_alert(ticker: str,
                         score: int,
                         signals: List[Dict],
                         current_price: Optional[float] = None,
                         days_until_earnings: Optional[int] = None,
                         alert_manager: Optional[AlertManager] = None) -> bool:
    """
    Create trade recommendation and send alert
    
    Args:
        ticker: Stock ticker
        score: Distress score
        signals: Triggered signals
        current_price: Current stock price
        days_until_earnings: Days until earnings
        alert_manager: AlertManager instance
    
    Returns:
        True if alert sent successfully
    """
    # Generate recommendation if we have price data
    recommendation = None
    if current_price:
        recommendation = TradeRecommendationEngine.calculate_strike_and_expiry(
            ticker=ticker,
            current_price=current_price,
            distress_score=score,
            days_until_earnings=days_until_earnings
        )
    
    # Send alert if manager provided
    if alert_manager:
        return alert_manager.send_alert(ticker, score, signals, recommendation)
    
    # Otherwise just print
    print(f"\n{'='*60}")
    print(f"🚨 ALERT: {ticker}")
    print(f"{'='*60}")
    print(f"Distress Score: {score}/100")
    print(f"Signals: {len(signals)}")
    
    if recommendation:
        print(f"\n💰 TRADE RECOMMENDATION:")
        print(f"  Action: {recommendation.action}")
        print(f"  Strike: ${recommendation.strike}")
        print(f"  Expiry: {recommendation.expiry}")
        print(f"  Confidence: {recommendation.confidence}")
        print(f"  Reasoning: {recommendation.reasoning}")
    
    return True


# Demo / Test
if __name__ == "__main__":
    print("Testing Alert System...")
    
    # Sample alert data
    test_signals = [
        {'type': 'executive_departure', 'weight': 30, 'details': 'CFO resigned'},
        {'type': 'insider_selling_spike', 'weight': 25, 'details': '6 Form 4s in 30 days'},
        {'type': 'negative_news', 'weight': 20, 'details': 'Avg sentiment: -0.6'},
    ]
    
    # Test 1: Generate trade recommendation
    print("\n📊 Test 1: Trade Recommendation")
    print("-" * 60)
    
    rec = TradeRecommendationEngine.calculate_strike_and_expiry(
        ticker='TEST',
        current_price=100.0,
        distress_score=75,
        days_until_earnings=4
    )
    
    print(f"Ticker: {rec.ticker}")
    print(f"Action: {rec.action}")
    print(f"Strike: ${rec.strike}")
    print(f"Expiry: {rec.expiry}")
    print(f"Confidence: {rec.confidence}")
    print(f"Reasoning: {rec.reasoning}")
    
    # Test 2: Alert without webhook (just console)
    print("\n\n📊 Test 2: Console Alert")
    print("-" * 60)
    
    create_and_send_alert(
        ticker='TEST',
        score=75,
        signals=test_signals,
        current_price=100.0,
        days_until_earnings=4
    )
    
    print("\n✅ Alert system test complete!")
    print("\n💡 To enable webhooks, initialize with:")
    print('   alert_manager = AlertManager(slack_webhook="YOUR_WEBHOOK_URL")')
