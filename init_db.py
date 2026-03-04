"""
Database Initialization Script
Run once to create all tables and insert default data
"""
import os
import sys
from sqlalchemy import text
from models import Base, get_db_engine
import logging

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

def init_database():
    """Initialize database with schema"""
    try:
        # Get engine
        engine = get_db_engine()
        logger.info("✅ Database connection established")
        
        # Create all tables
        Base.metadata.create_all(engine)
        logger.info("✅ All tables created")
        
        # Run additional SQL from schema.sql for constraints, indexes, and default data
        schema_path = os.path.join(os.path.dirname(__file__), 'schema.sql')
        if os.path.exists(schema_path):
            with open(schema_path, 'r') as f:
                sql = f.read()
            
            with engine.begin() as conn:
                # Split on semicolons and execute each statement
                statements = [s.strip() for s in sql.split(';') if s.strip()]
                for statement in statements:
                    if statement and not statement.startswith('--'):
                        try:
                            conn.execute(text(statement))
                        except Exception as e:
                            # Ignore errors for CREATE IF NOT EXISTS statements
                            if 'already exists' not in str(e):
                                logger.warning(f"SQL statement skipped: {str(e)[:100]}")
            
            logger.info("✅ Schema SQL executed")
        
        logger.info("🎉 Database initialization complete!")
        return True
        
    except Exception as e:
        logger.error(f"❌ Database initialization failed: {e}")
        import traceback
        traceback.print_exc()
        return False

if __name__ == '__main__':
    success = init_database()
    sys.exit(0 if success else 1)
