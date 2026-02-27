import { Router, Request, Response } from 'express';
import { pool } from '../db/connection';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { logger } from '../logger';
import { checkAndCreateMatch } from '../services/matchmaking';
import { getIo } from '../socket';
import { SocketEvents } from '../socket/events';
import { RowDataPacket } from 'mysql2';

const router = Router();

interface MembershipRow extends RowDataPacket {
  user_id: number;
}

router.post('/', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  const userId = (req as AuthRequest).user.userId;
  const { movieId, roomId, direction } = req.body as {
    movieId?: number;
    roomId?: number;
    direction?: string;
  };

  if (!movieId || !roomId || !direction) {
    res.status(400).json({ error: 'movieId, roomId and direction are required' });
    return;
  }

  if (direction !== 'left' && direction !== 'right') {
    res.status(400).json({ error: 'direction must be "left" or "right"' });
    return;
  }

  try {
    const [membership] = await pool.query<MembershipRow[]>(
      'SELECT user_id FROM room_members WHERE room_id = ? AND user_id = ?',
      [roomId, userId],
    );
    if (membership.length === 0) {
      res.status(403).json({ error: 'Not a member of this room' });
      return;
    }

    await pool.query(
      `INSERT INTO swipes (user_id, movie_id, room_id, direction)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE direction = VALUES(direction), swiped_at = CURRENT_TIMESTAMP`,
      [userId, movieId, roomId, direction],
    );

    await pool.query('UPDATE rooms SET last_activity_at = NOW() WHERE id = ?', [roomId]);

    let matchResult = null;

    if (direction === 'right') {
      const result = await checkAndCreateMatch(userId, movieId, roomId);

      if (result.isMatch) {
        matchResult = result;
        const io = getIo();
        io.to(`room:${roomId}`).emit(SocketEvents.MATCH, {
          movieId: result.movieId,
          movieTitle: result.movieTitle,
          posterPath: result.posterPath,
          streamingOptions: result.streamingOptions ?? [],
        });
      }
    }

    res.status(201).json({
      swipe: { user_id: userId, movie_id: movieId, room_id: roomId, direction },
      match: matchResult,
    });
  } catch (err) {
    logger.error({ err, userId, movieId, roomId }, 'Swipe error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
