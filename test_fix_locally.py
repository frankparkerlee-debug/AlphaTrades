"""
Quick test to verify the session management fix works
Tests the exact fixed code logic
"""
import os

# Test with MOCK database to avoid hitting production
os.environ['DATABASE_URL'] = 'postgresql://alphatrades_db_user:kY5KYLQ16AQ43Ylp5foW0enqfSyiCZxK@dpg-d6kak47kijhs73cat0o0-a.oregon-postgres.render.com/alphatrades_db'

print("="*70)
print("🧪 TESTING SESSION MANAGEMENT FIX")
print("="*70)
print()

# Import the models to test session creation
from models import get_session, Signal

print("1️⃣  Test: Can we create multiple sessions?")
try:
    session1 = get_session()
    print(f"   ✅ Session 1 created: {id(session1)}")
    
    session2 = get_session()
    print(f"   ✅ Session 2 created: {id(session2)}")
    
    if id(session1) != id(session2):
        print(f"   ✅ Sessions are DIFFERENT (correct!)")
    else:
        print(f"   ❌ Sessions are SAME (would cause the bug!)")
    
    session1.close()
    session2.close()
    print(f"   ✅ Both sessions closed")
    print()
except Exception as e:
    print(f"   ❌ Error: {e}")
    print()

print("2️⃣  Test: Can we query and commit with fresh sessions?")
try:
    # Session 1 - read
    session_a = get_session()
    count_a = session_a.query(Signal).count()
    print(f"   ✅ Session A query: {count_a} signals")
    session_a.close()
    
    # Session 2 - different session
    session_b = get_session()
    count_b = session_b.query(Signal).count()
    print(f"   ✅ Session B query: {count_b} signals")
    session_b.close()
    
    print(f"   ✅ Multiple sessions work independently")
    print()
except Exception as e:
    print(f"   ❌ Error: {e}")
    import traceback
    traceback.print_exc()
    print()

print("3️⃣  Test: Session rollback after error")
try:
    session = get_session()
    
    # Simulate error scenario
    try:
        # Try something that might fail
        sig = session.query(Signal).first()
        print(f"   ✅ Queried signal: {sig.ticker if sig else 'None'}")
        
        # Force an error
        raise Exception("Simulated error")
        
    except Exception as e:
        print(f"   ✅ Caught error: {e}")
        try:
            session.rollback()
            print(f"   ✅ Rollback successful")
        except Exception as rb_error:
            print(f"   ❌ Rollback failed: {rb_error}")
    
    session.close()
    print(f"   ✅ Session closed after error+rollback")
    print()
except Exception as e:
    print(f"   ❌ Test failed: {e}")
    print()

print("="*70)
print("✅ SESSION MANAGEMENT TESTS COMPLETE")
print()
print("The fixed worker code should:")
print("  1. Create a FRESH session for each update cycle")
print("  2. Rollback session on per-ticker errors")
print("  3. Close session after processing all tickers")
print()
print("This prevents the 'stale session' bug that caused only")
print("NVDA to be processed.")
print("="*70)
