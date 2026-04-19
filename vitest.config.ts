import { defineConfig } from 'vitest/config';
import { config as loadDotenv } from 'dotenv';

// Load .env.test BEFORE src/config.ts runs in any spawned fork.
// Subsequent dotenv.config() calls in src/config.ts won't override (default behavior).
loadDotenv({ path: '.env.test' });

export default defineConfig({
  test: {
    include: ['src/tests/**/*.test.ts'],
    globalSetup: './src/tests/global-setup.ts',
    setupFiles: ['./src/tests/setup.ts'],
    pool: 'threads',
    fileParallelism: false,
    isolate: false,
    testTimeout: 10000,
    hookTimeout: 15000,
    env: {
      NODE_ENV: 'test',
      PORT: '0',
      LOG_LEVEL: 'silent',
      DB_HOST: process.env['DB_HOST'] ?? '127.0.0.1',
      DB_PORT: process.env['DB_PORT'] ?? '3306',
      DB_USER: process.env['DB_USER'] ?? 'dev_test',
      DB_PASSWORD: process.env['DB_PASSWORD'] ?? 'dev_test_pw',
      DB_NAME: process.env['DB_NAME'] ?? 'watchd_test',
      JWT_SECRET: process.env['JWT_SECRET'] ?? 'test-jwt-secret',
      JWT_REFRESH_SECRET: process.env['JWT_REFRESH_SECRET'] ?? 'test-refresh-secret',
      TMDB_API_KEY: process.env['TMDB_API_KEY'] ?? 'fake-tmdb-key',
      CORS_ORIGINS: '*',
      BCRYPT_ROUNDS: '4',
    },
  },
});
