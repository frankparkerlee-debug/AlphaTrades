import sys
print("1. Starting script...", flush=True)

import os
print("2. Importing os...", flush=True)

os.environ['DATABASE_URL'] = os.getenv('DATABASE_URL', 'postgresql://alphatrades_db_user:kY5KYLQ16AQ43Ylp5foW0enqfSyiCZxK@dpg-d6kak47kijhs73cat0o0-a.oregon-postgres.render.com/alphatrades_db')
print("3. Set DATABASE_URL", flush=True)

from models import get_session
print("4. Imported models", flush=True)

session = get_session()
print("5. Got database session", flush=True)

from sqlalchemy import func, text
result = session.execute(text("SELECT COUNT(*) FROM minute_bars")).scalar()
print(f"6. Minute bars in DB: {result:,}", flush=True)

print("✅ All checks passed!", flush=True)
