import { readFileSync } from 'fs';
import path from 'path';
import { config as loadDotenv } from 'dotenv';
import mysql from 'mysql2/promise';

export default async function globalSetup(): Promise<void> {
  loadDotenv({ path: '.env.test' });

  const host = process.env['DB_HOST'] ?? '127.0.0.1';
  const port = parseInt(process.env['DB_PORT'] ?? '3306', 10);
  const user = process.env['DB_USER'] ?? 'dev_test';
  const password = process.env['DB_PASSWORD'] ?? 'dev_test_pw';
  const database = process.env['DB_NAME'] ?? 'watchd_test';

  // Safety net: refuse to wipe anything that's not clearly a test DB.
  if (!database.endsWith('_test')) {
    throw new Error(`Refusing to run tests against non-_test database: ${database}`);
  }

  const schemaPath = path.join(process.cwd(), 'src', 'db', 'schema.sql');
  const schemaSql = readFileSync(schemaPath, 'utf-8');

  let dbConn: mysql.Connection;
  try {
    dbConn = await mysql.createConnection({ host, port, user, password, database, multipleStatements: true });
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'ER_ACCESS_DENIED_ERROR' || code === 'ER_BAD_DB_ERROR' || code === 'ER_DBACCESS_DENIED_ERROR') {
      throw new Error(
        `Cannot connect to test DB as ${user}@${host}/${database}. One-time bootstrap required:\n\n` +
        `  sudo mariadb <<'SQL'\n` +
        `  CREATE DATABASE IF NOT EXISTS ${database} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;\n` +
        `  CREATE USER IF NOT EXISTS '${user}'@'localhost' IDENTIFIED BY '${password}';\n` +
        `  GRANT ALL PRIVILEGES ON ${database}.* TO '${user}'@'localhost';\n` +
        `  FLUSH PRIVILEGES;\n` +
        `  SQL\n\nOriginal error: ${(err as Error).message}`,
      );
    }
    throw err;
  }

  await dbConn.query(schemaSql);
  await dbConn.end();
}
