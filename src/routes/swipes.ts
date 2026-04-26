import type { Request, Response } from 'express';
import { Router } from 'express';
import { pool } from '../db/connection';
import type { AuthRequest } from '../middleware/auth';
import { authMiddleware } from '../middleware/auth';
import { logger } from '../logger';
import { checkAndCreateMatch } from '../services/matchmaking';
import { sendMatchPush } from '../services/apns';
import { getIo } from '../socket';
import { SocketEvents } from '../socket/events';
import type { RowDataPacket } from 'mysql2';

const router = Router();

interface MembershipRow extends RowDataPacket {
  user_id: number;
}

interface DeviceTokenRow extends RowDataPacket {
  device_token: string | null;
}

router.post('/', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  const userId = (req as AuthRequest).user.userId;
  const { movieId, partnershipId, direction } = req.body as {
    movieId?: number;
    partnershipId?: number;
    direction?: string;
  };

  if (!movieId || !partnershipId || !direction) {
    res.status(400).json({ error: 'movieId, partnershipId und direction sind erforderlich' });
    return;
  }

  if (direction !== 'left' && direction !== 'right') {
    res.status(400).json({ error: 'direction muss "left" oder "right" sein' });
    return;
  }

  try {
    const [membership] = await pool.query<MembershipRow[]>(
      'SELECT user_id FROM partnership_members WHERE partnership_id = ? AND user_id = ?',
      [partnershipId, userId],
    );
    if (membership.length === 0) {
      res.status(403).json({ error: 'Kein Mitglied dieser Partnerschaft' });
      return;
    }

    await pool.query(
      `INSERT INTO swipes (user_id, movie_id, partnership_id, direction)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE direction = VALUES(direction), swiped_at = CURRENT_TIMESTAMP`,
      [userId, movieId, partnershipId, direction],
    );

    await pool.query('UPDATE partnerships SET last_activity_at = NOW() WHERE id = ?', [
      partnershipId,
    ]);

    let matchResult = null;

    if (direction === 'right') {
      const result = await checkAndCreateMatch(userId, movieId, partnershipId);

      if (result.isMatch) {
        matchResult = result;
        const io = getIo();
        io.to(`partnership:${partnershipId}`).emit(SocketEvents.MATCH, {
          movieId: result.movieId,
          movieTitle: result.movieTitle,
          posterPath: result.posterPath,
          streamingOptions: result.streamingOptions ?? [],
        });

        // Push-Notifications an alle Partner mit hinterlegtem Device-Token.
        const [tokenRows] = await pool.query<DeviceTokenRow[]>(
          `SELECT u.device_token FROM users u
           INNER JOIN partnership_members pm ON pm.user_id = u.id
           WHERE pm.partnership_id = ? AND u.device_token IS NOT NULL`,
          [partnershipId],
        );
        const tokens = tokenRows.map((r) => r.device_token).filter((t): t is string => t !== null);
        logger.info(
          { partnershipId, tokenCount: tokens.length },
          'APNs: device tokens found for partnership',
        );
        if (tokens.length > 0) {
          sendMatchPush(
            tokens,
            result.movieTitle ?? 'einem Film',
            partnershipId,
            result.movieId ?? movieId,
          ).catch((err) => logger.error({ err }, 'APNs push failed'));
        }
      }
    }

    res.status(201).json({
      swipe: { user_id: userId, movie_id: movieId, partnership_id: partnershipId, direction },
      match: matchResult,
    });
  } catch (err) {
    logger.error({ err, userId, movieId, partnershipId }, 'Swipe error');
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

export default router;
