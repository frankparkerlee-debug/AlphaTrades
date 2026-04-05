"""
Terminal dashboard for live P&L and position monitoring.
Uses Rich library for formatted terminal output.
"""

import os
import logging
from datetime import datetime

from config.settings import CITIES

log = logging.getLogger("dashboard")

try:
    from rich.console import Console
    from rich.table import Table
    from rich.panel import Panel
    from rich.layout import Layout
    from rich.text import Text
    HAS_RICH = True
except ImportError:
    HAS_RICH = False


def clear_screen():
    os.system("cls" if os.name == "nt" else "clear")


def render_dashboard(executor, signals=None):
    """Render terminal dashboard showing positions, P&L, and signals."""
    if HAS_RICH:
        _render_rich(executor, signals)
    else:
        _render_plain(executor, signals)


def _render_rich(executor, signals):
    console = Console()
    clear_screen()

    stats = executor.get_stats()

    # Header
    mode = "PAPER" if os.getenv("TRADING_MODE", "paper") == "paper" else "LIVE"
    header = Text(f"  KalshiWeather | Kalshi Weather Arb | {mode} | {datetime.now().strftime('%H:%M:%S')}", style="bold white on blue")
    console.print(header)
    console.print()

    # Stats panel
    pnl_color = "green" if stats["daily_pnl"] >= 0 else "red"
    stats_text = (
        f"Capital: ${stats['capital']:.2f}  |  "
        f"Deployed: ${stats['deployed']:.2f}  |  "
        f"Available: ${stats['available']:.2f}  |  "
        f"Daily P&L: [{pnl_color}]${stats['daily_pnl']:+.2f}[/{pnl_color}]  |  "
        f"Trades: {stats['total_trades']}  |  "
        f"WR: {stats['win_rate']:.0%}"
    )
    if stats["halted"]:
        stats_text += "  |  [bold red]HALTED[/bold red]"
    console.print(Panel(stats_text, title="Portfolio"))

    # Open positions table
    pos_table = Table(title="Open Positions", show_lines=False)
    pos_table.add_column("Ticker", style="cyan")
    pos_table.add_column("City")
    pos_table.add_column("Date")
    pos_table.add_column("Threshold")
    pos_table.add_column("Qty", justify="right")
    pos_table.add_column("Entry", justify="right")
    pos_table.add_column("Current", justify="right")
    pos_table.add_column("P&L", justify="right")
    pos_table.add_column("Hold", justify="right")

    for pos in executor.open_positions:
        prices = executor.kalshi.get_best_prices(pos.ticker)
        current = prices["yes_bid"] if prices else 0
        pnl = (current - pos.entry_price) * pos.contracts
        pnl_str = f"${pnl:+.2f}"
        pnl_style = "green" if pnl >= 0 else "red"
        city_name = CITIES.get(pos.city_code, {}).get("name", pos.city_code)

        pos_table.add_row(
            pos.ticker,
            city_name,
            pos.date,
            f">{pos.threshold}F",
            str(pos.contracts),
            f"${pos.entry_price:.2f}",
            f"${current:.2f}",
            f"[{pnl_style}]{pnl_str}[/{pnl_style}]",
            f"{pos.hold_minutes:.0f}m",
        )

    console.print(pos_table)

    # Recent signals
    if signals:
        sig_table = Table(title="Latest Signals", show_lines=False)
        sig_table.add_column("City")
        sig_table.add_column("Date")
        sig_table.add_column("Threshold")
        sig_table.add_column("Model Prob", justify="right")
        sig_table.add_column("Mkt Price", justify="right")
        sig_table.add_column("Edge", justify="right")
        sig_table.add_column("Forecast", justify="right")

        for sig in signals[:10]:
            city_name = CITIES.get(sig.city_code, {}).get("name", sig.city_code)
            sig_table.add_row(
                city_name,
                sig.date,
                f">{sig.threshold}F",
                f"{sig.model_prob:.0%}",
                f"${sig.market_price:.2f}",
                f"{sig.edge:+.2f}",
                f"{sig.forecast_mean:.0f}F +/-{sig.model_spread:.0f}",
            )

        console.print(sig_table)

    # Closed trades summary
    if executor.closed_positions:
        recent = executor.closed_positions[-5:]
        closed_table = Table(title="Recent Closed", show_lines=False)
        closed_table.add_column("Ticker", style="dim")
        closed_table.add_column("Entry", justify="right")
        closed_table.add_column("Exit", justify="right")
        closed_table.add_column("P&L", justify="right")
        closed_table.add_column("Hold", justify="right")

        for pos in recent:
            pnl_style = "green" if pos.pnl >= 0 else "red"
            closed_table.add_row(
                pos.ticker,
                f"${pos.entry_price:.2f}",
                f"${pos.exit_price:.2f}",
                f"[{pnl_style}]${pos.pnl:+.2f}[/{pnl_style}]",
                f"{pos.hold_minutes:.0f}m",
            )

        console.print(closed_table)


def _render_plain(executor, signals):
    """Fallback plain-text dashboard."""
    clear_screen()
    stats = executor.get_stats()

    print("=" * 70)
    print(f"  KalshiWeather | Kalshi Weather Arb | {datetime.now().strftime('%H:%M:%S')}")
    print("=" * 70)
    print(f"  Capital: ${stats['capital']:.2f}  Deployed: ${stats['deployed']:.2f}  "
          f"P&L: ${stats['daily_pnl']:+.2f}  WR: {stats['win_rate']:.0%}")
    print("-" * 70)

    print(f"\n  Open Positions ({len(executor.open_positions)}):")
    for pos in executor.open_positions:
        print(f"    {pos.ticker}  {pos.contracts}x @ ${pos.entry_price:.2f}  "
              f"held {pos.hold_minutes:.0f}m")

    if signals:
        print(f"\n  Signals ({len(signals)}):")
        for sig in signals[:5]:
            print(f"    {sig}")

    print()
