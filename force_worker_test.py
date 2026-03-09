#!/usr/bin/env python3
"""
Force test worker on Render - run this in shell to see what breaks
"""
import sys
print("🔍 FORCE WORKER TEST", flush=True)
print("="*70, flush=True)

print("\n1️⃣ Importing worker module...", flush=True)
try:
    import worker
    print("   ✅ Worker module imported", flush=True)
except Exception as e:
    print(f"   ❌ Import failed: {e}", flush=True)
    import traceback
    traceback.print_exc()
    sys.exit(1)

print("\n2️⃣ Checking worker configuration...", flush=True)
print(f"   Tickers: {worker.TICKERS}", flush=True)
print(f"   Update interval: {worker.UPDATE_INTERVAL}s", flush=True)
print(f"   Alpaca key: {worker.ALPACA_API_KEY[:10] if worker.ALPACA_API_KEY else 'NOT SET'}...", flush=True)

print("\n3️⃣ Creating SignalWorker instance...", flush=True)
try:
    w = worker.SignalWorker()
    print("   ✅ Worker instance created", flush=True)
except Exception as e:
    print(f"   ❌ Failed to create worker: {e}", flush=True)
    import traceback
    traceback.print_exc()
    sys.exit(1)

print("\n4️⃣ Running ONE update cycle manually...", flush=True)
try:
    w.update_all_signals()
    print("   ✅ Update cycle completed", flush=True)
except Exception as e:
    print(f"   ❌ Update cycle failed: {e}", flush=True)
    import traceback
    traceback.print_exc()
    sys.exit(1)

print("\n5️⃣ Checking database...", flush=True)
from models import get_session, Signal
session = get_session()
count = session.query(Signal).count()
print(f"   📊 Total signals: {count}", flush=True)
session.close()

print("\n✅ WORKER TEST COMPLETE", flush=True)
print("="*70, flush=True)
print("\nIf you see 15 signals above, the worker code WORKS.", flush=True)
print("If worker.py won't start normally, check Render's startCommand.", flush=True)
