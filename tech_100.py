"""
Top 100 Tech Stocks by Market Cap
Used for Overnight Gap Momentum scanner
"""

TECH_100 = [
    # Mega Tech (10)
    'AAPL', 'MSFT', 'NVDA', 'GOOGL', 'AMZN', 'META', 'TSLA', 'AVGO', 'ORCL', 'ADBE',
    
    # Large Tech & Semiconductors (20)
    'AMD', 'CRM', 'INTC', 'QCOM', 'CSCO', 'IBM', 'NOW', 'INTU', 'AMAT', 'MU',
    'LRCX', 'ADI', 'KLAC', 'SNPS', 'CDNS', 'MRVL', 'NXPI', 'MCHP', 'ON', 'TXN',
    
    # Software & Cloud (20)
    'PLTR', 'SNOW', 'DDOG', 'NET', 'CRWD', 'ZS', 'PANW', 'FTNT', 'WDAY', 'TEAM',
    'HUBS', 'DOCN', 'MDB', 'SHOP', 'SQ', 'SPOT', 'UBER', 'LYFT', 'DASH', 'ABNB',
    
    # AI & Data (15)
    'AI', 'PATH', 'SOUN', 'BBAI', 'SMCI', 'DELL', 'HPE', 'HPQ', 'NTAP', 'STX',
    'WDC', 'PSTG', 'SPLK', 'ESTC', 'ZI',
    
    # Communications & Internet (15)
    'NFLX', 'DIS', 'CMCSA', 'TMUS', 'VZ', 'T', 'CHTR', 'RBLX', 'PINS', 'SNAP',
    'TWLO', 'ZM', 'DOCU', 'OKTA', 'BOX',
    
    # Hardware & Electronics (10)
    'AAOI', 'AEHR', 'ASML', 'TSM', 'AEIS', 'LITE', 'CIEN', 'JNPR', 'FFIV', 'AKAM',
    
    # Emerging Tech & Fintech (10)
    'COIN', 'HOOD', 'PYPL', 'AFFIRM', 'SOFI', 'NU', 'UPST', 'AFRM', 'LC', 'ROKU'
]

def get_tech_100():
    """Return list of top 100 tech stocks"""
    return TECH_100

def is_tech_stock(symbol):
    """Check if symbol is in tech 100"""
    return symbol.upper() in TECH_100
