import { pool } from '../db/connection';
import { logger } from '../logger';

/**
 * Periodically removes expired and revoked refresh tokens,
 * used/expired password reset tokens, and stale guest accounts
 * from the database.
 *
 * Runs every 6 hours to prevent unbounded table growth.
 */
const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

/**
 * Guest accounts older than this threshold with no active session are deleted.
 * All child rows (room_members, swipes, refresh_tokens, favorites, rooms created
 * by the guest) are removed via ON DELETE CASCADE.
 */
const GUEST_TTL_DAYS = 7;

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

    // Remove guest accounts that have no active (non-revoked) refresh token and
    // are older than GUEST_TTL_DAYS. These users can no longer authenticate and
    // their data has no value — cascading deletes clean up all child rows.
    const [guestResult] = await pool.query(
      `DELETE FROM users
       WHERE is_guest = TRUE
         AND created_at < NOW() - INTERVAL ? DAY
         AND id NOT IN (
           SELECT DISTINCT user_id FROM refresh_tokens WHERE revoked = FALSE
         )`,
      [GUEST_TTL_DAYS],
    );
    const guestsDeleted = (guestResult as { affectedRows: number }).affectedRows;

    if (refreshDeleted > 0 || resetDeleted > 0 || guestsDeleted > 0) {
      logger.info(
        { refreshDeleted, resetDeleted, guestsDeleted },
        'Token cleanup completed',
      );
    }
  } catch (err) {
    logger.error({ err }, 'Token cleanup failed');
  }
}

export function scheduleTokenCleanup(): void {
  // Run once on startup (delayed by 30s to let the server finish booting)
  setTimeout(cleanupExpiredTokens, 30_000);

  // Then run periodically
  setInterval(cleanupExpiredTokens, CLEANUP_INTERVAL_MS);

  logger.info(
    { intervalHours: CLEANUP_INTERVAL_MS / (60 * 60 * 1000) },
    'Token cleanup scheduled',
  );
}
