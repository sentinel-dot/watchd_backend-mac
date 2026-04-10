import fs from 'fs';
import path from 'path';
import mysql from 'mysql2/promise';
import { config } from '../config';
import { logger } from '../logger';

/**
 * When WATCHD_APPLY_SCHEMA=1|true and NODE_ENV is not production, runs
 * src/db/schema.sql (drops and recreates all tables). Use only for local dev.
 */
export async function applyDevSchemaIfEnabled(): Promise<void> {
  const flag = process.env['WATCHD_APPLY_SCHEMA'];
  if (flag !== '1' && flag !== 'true') return;

  if (config.nodeEnv === 'production') {
    logger.warn('WATCHD_APPLY_SCHEMA is set but NODE_ENV is production — skipping schema apply');
    return;
  }

  const schemaPath = path.join(__dirname, 'schema.sql');
  if (!fs.existsSync(schemaPath)) {
    throw new Error(`schema.sql not found at ${schemaPath} (run npm run build to copy it into dist/db/)`);
  }

  const sql = fs.readFileSync(schemaPath, 'utf8');
  const connection = await mysql.createConnection({
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    database: config.db.name,
    multipleStatements: true,
    timezone: '+00:00',
    charset: 'utf8mb4',
  });

  try {
    await connection.query(sql);
    logger.warn('Applied database schema (WATCHD_APPLY_SCHEMA) — all tables were recreated');
  } finally {
    await connection.end();
  }
}
