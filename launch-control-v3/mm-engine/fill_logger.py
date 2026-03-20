"""
Launch Control MM — Fill Logger
Records every fill event with full context for ML training and P&L analysis.
This is the most important module — it builds the dataset that everything else depends on.
"""

import csv
import json
import os
import threading
from datetime import datetime, timezone
from dataclasses import dataclass, asdict
from typing import Optional
from config import LOG_DIR, DATA_DIR


@dataclass
class FillEvent:
    """Complete record of one round-trip fill."""

    # Identity
    fill_id:          str
    symbol:           str
    contract_symbol:  str
    strike:           float
    expiry:           str
    option_type:      str   # "put" or "call"
    dte_at_entry:     int

    # Market state at entry
    underlying_price_entry: float
    bid_at_entry:     float
    ask_at_entry:     float
    raw_spread:       float
    iv_at_entry:      float
    delta_at_entry:   float
    otm_pct:          float

    # Our quote
    our_bid:          float
    our_ask:          float
    capture_target:   float   # raw_spread * capture_pct

    # First fill (open)
    open_side:        str     # "bid_hit" or "ask_lifted"
    open_price:       float
    open_time:        str
    open_contracts:   int

    # Second fill (close) — None if TTL fired
    close_price:      Optional[float]
    close_time:       Optional[str]
    close_reason:     str     # "natural_fill", "ttl_cancel", "kill_switch", "manual"

    # Outcome
    hold_seconds:     float
    gross_capture:    float   # (close - open) * contracts * 100
    fee_open:         float
    fee_close:        float
    slippage:         float   # modeled: delta * underlying_move * contracts * 100
    net_pnl:          float
    win:              bool

    # Tape state at entry (adverse selection signal)
    tape_bid_prints:  int     # prints on bid side in last 60 sec
    tape_ask_prints:  int     # prints on ask side
    tape_confirmed:   bool    # True if >= MIN_PRINTS each side

    # Adverse selection flag (post-hoc)
    adverse_selection: bool   # True if filled on open then price moved against immediately
    underlying_move_during_hold: float  # $ move in underlying during hold


class FillLogger:
    """
    Thread-safe fill logger.
    Writes to CSV for easy analysis and JSON for ML pipeline.
    """

    def __init__(self):
        os.makedirs(LOG_DIR, exist_ok=True)
        os.makedirs(DATA_DIR, exist_ok=True)
        self._lock = threading.Lock()

        date_str = datetime.now(timezone.utc).strftime("%Y%m%d")
        self.csv_path  = os.path.join(LOG_DIR, f"fills_{date_str}.csv")
        self.json_path = os.path.join(DATA_DIR, f"fills_{date_str}.jsonl")

        # P&L tracking
        self._daily_pnl   = 0.0
        self._total_fills = 0
        self._wins        = 0
        self._adverse     = 0

        # Write CSV header if new file
        if not os.path.exists(self.csv_path):
            self._write_csv_header()

    def log(self, fill: FillEvent) -> None:
        """Log a completed round-trip fill. Thread-safe."""
        with self._lock:
            self._daily_pnl   += fill.net_pnl
            self._total_fills += 1
            if fill.win:
                self._wins += 1
            if fill.adverse_selection:
                self._adverse += 1

            # CSV — for spreadsheet analysis
            with open(self.csv_path, "a", newline="") as f:
                writer = csv.DictWriter(f, fieldnames=list(asdict(fill).keys()))
                writer.writerow(asdict(fill))

            # JSONL — for ML pipeline
            with open(self.json_path, "a") as f:
                f.write(json.dumps(asdict(fill)) + "\n")

    def _write_csv_header(self):
        dummy = FillEvent(
            fill_id="", symbol="", contract_symbol="", strike=0, expiry="",
            option_type="", dte_at_entry=0, underlying_price_entry=0,
            bid_at_entry=0, ask_at_entry=0, raw_spread=0, iv_at_entry=0,
            delta_at_entry=0, otm_pct=0, our_bid=0, our_ask=0,
            capture_target=0, open_side="", open_price=0, open_time="",
            open_contracts=0, close_price=None, close_time=None,
            close_reason="", hold_seconds=0, gross_capture=0,
            fee_open=0, fee_close=0, slippage=0, net_pnl=0, win=False,
            tape_bid_prints=0, tape_ask_prints=0, tape_confirmed=False,
            adverse_selection=False, underlying_move_during_hold=0
        )
        with open(self.csv_path, "w", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=list(asdict(dummy).keys()))
            writer.writeheader()

    # ── Daily stats ──────────────────────────────────────────────────────────

    @property
    def daily_pnl(self) -> float:
        return self._daily_pnl

    @property
    def win_rate(self) -> float:
        if self._total_fills == 0:
            return 0.0
        return self._wins / self._total_fills

    @property
    def adverse_rate(self) -> float:
        if self._total_fills == 0:
            return 0.0
        return self._adverse / self._total_fills

    @property
    def total_fills(self) -> int:
        return self._total_fills

    def summary(self) -> dict:
        return {
            "daily_pnl":    round(self._daily_pnl, 2),
            "total_fills":  self._total_fills,
            "wins":         self._wins,
            "win_rate":     round(self.win_rate, 4),
            "adverse_fills": self._adverse,
            "adverse_rate": round(self.adverse_rate, 4),
        }

    def print_summary(self):
        s = self.summary()
        print(f"\n{'='*50}")
        print(f"  Daily P&L:    ${s['daily_pnl']:,.2f}")
        print(f"  Total fills:  {s['total_fills']}")
        print(f"  Win rate:     {s['win_rate']:.1%}")
        print(f"  Adv. sel:     {s['adverse_rate']:.1%}  ← watch this")
        print(f"{'='*50}\n")
