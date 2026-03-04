# Database Connection URLs

## Internal URL (Use for Render Services)
**Recommended for production deployment:**
```
postgresql://alphatrades_db_user:kY5KYLQ16AQ43Ylp5foW0enqfSyiCZxK@dpg-d6kak47kijhs73cat0o0-a/alphatrades_db
```

**Benefits:**
- ✅ Faster (no external network hop)
- ✅ More secure (stays within Render network)
- ✅ No bandwidth charges

**Use in:**
- Web service environment variables
- Worker service environment variables

## External URL (Use for Local Development)
**For testing from your Mac:**
```
postgresql://alphatrades_db_user:kY5KYLQ16AQ43Ylp5foW0enqfSyiCZxK@dpg-d6kak47kijhs73cat0o0-a.oregon-postgres.render.com/alphatrades_db
```

**Use when:**
- Running locally (your Mac)
- Testing connections
- Manual database queries

## Environment Variable Setup

### For Render Services (Web + Worker):
```bash
DATABASE_URL=postgresql://alphatrades_db_user:kY5KYLQ16AQ43Ylp5foW0enqfSyiCZxK@dpg-d6kak47kijhs73cat0o0-a/alphatrades_db
```

### For Local Testing:
```bash
export DATABASE_URL=postgresql://alphatrades_db_user:kY5KYLQ16AQ43Ylp5foW0enqfSyiCZxK@dpg-d6kak47kijhs73cat0o0-a.oregon-postgres.render.com/alphatrades_db
```

## Quick Test

**Test from your Mac:**
```bash
cd /tmp/AlphaTrades
export DATABASE_URL="postgresql://alphatrades_db_user:kY5KYLQ16AQ43Ylp5foW0enqfSyiCZxK@dpg-d6kak47kijhs73cat0o0-a.oregon-postgres.render.com/alphatrades_db"
python3 test_connection.py
```

Should show:
```
✅ Database connected
✅ Active config: default_strategy_1
✅ Account initialized: $600.0
```

---

**Note:** Never commit these URLs to git! They contain credentials.
