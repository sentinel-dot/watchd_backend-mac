import { pool } from '../db/connection';
import { logger } from '../logger';

/**
 * Periodically removes expired and revoked refresh tokens and used/expired
 * password reset tokens from the database. Runs every 6 hours to prevent
 * unbounded table growth.
 */
const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;

async function cleanupExpiredTokens(): Promise<void> {
  try {
    const [refreshResult] = await pool.query(
      'DELETE FROM refresh_tokens WHERE revoked = TRUE OR expires_at < NOW()',
    );
    const refreshDeleted = (refreshResult as { affectedRows: number }).affectedRows;

    const [resetResult] = await pool.query(
      'DELETE FROM password_reset_tokens WHERE used = TRUE OR expires_at < NOW()',
    );
    const resetDeleted = (resetResult as { affectedRows: number }).affectedRows;

    if (refreshDeleted > 0 || resetDeleted > 0) {
      logger.info({ refreshDeleted, resetDeleted }, 'Token cleanup completed');
    }
  } catch (err) {
    logger.error({ err }, 'Token cleanup failed');
  }
}

export function scheduleTokenCleanup(): void {
  setTimeout(cleanupExpiredTokens, 30_000);
  setInterval(cleanupExpiredTokens, CLEANUP_INTERVAL_MS);
  logger.info({ intervalHours: CLEANUP_INTERVAL_MS / (60 * 60 * 1000) }, 'Token cleanup scheduled');
}
