import { Router, Request, Response } from 'express';
import { pool } from '../db/connection';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { getMovieById } from '../services/tmdb';
import { getStreamingOffers } from '../services/justwatch';
import { RowDataPacket } from 'mysql2';

const router = Router();

interface MatchRow extends RowDataPacket {
  id: number;
  room_id: number;
  movie_id: number;
  matched_at: Date;
}

interface MembershipRow extends RowDataPacket {
  user_id: number;
}

// GET /api/matches/:roomId
router.get('/:roomId', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  const userId = (req as AuthRequest).user.userId;
  const roomId = parseInt(req.params['roomId'], 10);

  if (isNaN(roomId)) {
    res.status(400).json({ error: 'Invalid roomId' });
    return;
  }

  try {
    // Verify membership
    const [membership] = await pool.query<MembershipRow[]>(
      'SELECT user_id FROM room_members WHERE room_id = ? AND user_id = ?',
      [roomId, userId],
    );
    if (membership.length === 0) {
      res.status(403).json({ error: 'Not a member of this room' });
      return;
    }

    const [matchRows] = await pool.query<MatchRow[]>(
      'SELECT id, room_id, movie_id, matched_at FROM matches WHERE room_id = ? ORDER BY matched_at DESC',
      [roomId],
    );

    const matches = await Promise.all(
      matchRows.map(async (match) => {
        try {
          const movie = await getMovieById(match.movie_id);
          const releaseYear = movie.release_date
            ? parseInt(movie.release_date.slice(0, 4), 10)
            : new Date().getFullYear();

          const streamingOptions = await getStreamingOffers(
            match.movie_id,
            movie.title,
            releaseYear,
          );

          return {
            id: match.id,
            roomId: match.room_id,
            matchedAt: match.matched_at,
            movie: {
              id: movie.id,
              title: movie.title,
              overview: movie.overview,
              posterPath: movie.poster_path,
              backdropPath: movie.backdrop_path,
              releaseDate: movie.release_date,
              voteAverage: movie.vote_average,
            },
            streamingOptions,
          };
        } catch {
          return {
            id: match.id,
            roomId: match.room_id,
            matchedAt: match.matched_at,
            movie: { id: match.movie_id },
            streamingOptions: [],
          };
        }
      }),
    );

    res.json({ matches });
  } catch (err) {
    console.error('Get matches error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
