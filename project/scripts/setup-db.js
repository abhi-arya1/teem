require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'teem_chat',
  user: process.env.DB_USER || 'teem',
  password: process.env.DB_PASSWORD || 'teem_dev_password',
});

async function setupDatabase() {
  const client = await pool.connect();
  
  try {
    console.log('Setting up database schema...');
    
    // Create users table
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(255) UNIQUE NOT NULL,
        display_name VARCHAR(255) NOT NULL,
        password_hash VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('✓ Users table created');
    
    // Create channels table
    await client.query(`
      CREATE TABLE IF NOT EXISTS channels (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) UNIQUE NOT NULL,
        description TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('✓ Channels table created');
    
    // Create messages table
    await client.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY,
        channel_id INTEGER REFERENCES channels(id) ON DELETE CASCADE,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        content TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('✓ Messages table created');
    
    // Create indexes
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_messages_channel_id ON messages(channel_id);
      CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
      CREATE INDEX IF NOT EXISTS idx_messages_user_id ON messages(user_id);
    `);
    console.log('✓ Indexes created');
    
    // Insert default channel
    await client.query(`
      INSERT INTO channels (name, description)
      VALUES ('general', 'General discussion')
      ON CONFLICT (name) DO NOTHING;
    `);
    console.log('✓ Default channel created');
    
    // Insert test users
    await client.query(`
      INSERT INTO users (username, display_name)
      VALUES 
        ('alice', 'Alice'),
        ('bob', 'Bob'),
        ('charlie', 'Charlie')
      ON CONFLICT (username) DO NOTHING;
    `);
    console.log('✓ Test users created');
    
    console.log('\n✅ Database setup complete!');
    
  } catch (error) {
    console.error('Error setting up database:', error);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

setupDatabase().catch(console.error);
