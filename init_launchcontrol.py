"""
Initialize Launch Control v2.0 Database
Creates tables and seeds initial data
"""

import os
import sys
import psycopg2
from psycopg2.extensions import ISOLATION_LEVEL_AUTOCOMMIT


def init_database():
    """Initialize database with Launch Control v2.0 schema"""
    
    db_url = os.getenv('DATABASE_URL')
    if not db_url:
        print("❌ DATABASE_URL environment variable not set")
        sys.exit(1)
    
    print("🚀 Initializing Launch Control v2.0 Database")
    print("=" * 60)
    
    try:
        # Connect to database
        conn = psycopg2.connect(db_url)
        conn.set_isolation_level(ISOLATION_LEVEL_AUTOCOMMIT)
        cur = conn.cursor()
        
        # Read and execute schema
        print("📄 Reading schema file...")
        with open('schema_launchcontrol.sql', 'r') as f:
            schema = f.read()
        
        print("📊 Creating tables...")
        cur.execute(schema)
        
        # Verify tables were created
        print("\n✅ Verifying tables...")
        cur.execute("""
            SELECT table_name 
            FROM information_schema.tables 
            WHERE table_schema = 'public' 
            AND table_name LIKE '%launchcontrol%' OR table_name = 'equity_profiles'
            ORDER BY table_name
        """)
        
        tables = cur.fetchall()
        print(f"\n📋 Created {len(tables)} tables:")
        for table in tables:
            print(f"  ✓ {table[0]}")
        
        # Check equity profiles seeded
        cur.execute("SELECT COUNT(*) FROM equity_profiles")
        profile_count = cur.fetchone()[0]
        print(f"\n📈 Seeded {profile_count} equity profiles")
        
        # Check account initialized
        cur.execute("SELECT current_capital FROM launchcontrol_account ORDER BY id DESC LIMIT 1")
        account = cur.fetchone()
        if account:
            print(f"💰 Account initialized: ${account[0]:.2f}")
        
        cur.close()
        conn.close()
        
        print("\n" + "=" * 60)
        print("✅ Launch Control v2.0 database initialized successfully!")
        print("=" * 60)
        
        print("\n📋 NEXT STEPS:")
        print("1. Run equity profile update:")
        print("   python update_equity_profiles.py")
        print("\n2. Test the scorer:")
        print("   python test_launchcontrol_scorer.py")
        print("\n3. Run the dashboard:")
        print("   flask run")
        
    except Exception as e:
        print(f"\n❌ Error initializing database: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)


if __name__ == '__main__':
    init_database()
