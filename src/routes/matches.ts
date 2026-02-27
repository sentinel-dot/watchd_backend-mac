import { Router, Request, Response } from 'express';
import { pool } from '../db/connection';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { logger } from '../logger';
import { getMovieById } from '../services/tmdb';
import { getStreamingOffers } from '../services/justwatch';
import { RowDataPacket, ResultSetHeader } from 'mysql2';

const router = Router();

interface MatchRow extends RowDataPacket {
  id: number;
  room_id: number;
  movie_id: number;
  matched_at: Date;
  watched: boolean | number | null;
}

interface MembershipRow extends RowDataPacket {
  user_id: number;
}

interface FavoriteRow extends RowDataPacket {
  id: number;
  movie_id: number;
  created_at: Date;
}

router.get('/:roomId', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  const userId = (req as AuthRequest).user.userId;
  const roomId = parseInt(req.params['roomId'], 10);

  if (isNaN(roomId)) {
    res.status(400).json({ error: 'Invalid roomId' });
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

    const [matchRows] = await pool.query<MatchRow[]>(
      'SELECT id, room_id, movie_id, matched_at, COALESCE(watched, FALSE) AS watched FROM matches WHERE room_id = ? ORDER BY matched_at DESC',
      [roomId],
    );

    const matches = await Promise.all(
      matchRows.map(async (match) => {
        try {
          const movie = await getMovieById(match.movie_id);
          const releaseYear = movie.release_date ? parseInt(movie.release_date.slice(0, 4), 10) : new Date().getFullYear();

          const streamingOptions = await getStreamingOffers(match.movie_id, movie.title, releaseYear);

          return {
            id: match.id,
            roomId: match.room_id,
            matchedAt: match.matched_at,
            watched: Boolean(match.watched),
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
        } catch (err) {
          logger.warn({ err, matchId: match.id, movieId: match.movie_id }, 'Failed to fetch movie details for match');
          return {
            id: match.id,
            roomId: match.room_id,
            matchedAt: match.matched_at,
            watched: Boolean(match.watched),
            movie: {
              id: match.movie_id,
              title: 'Unknown Movie',
              overview: '',
              posterPath: null,
              backdropPath: null,
              releaseDate: null,
              voteAverage: 0,
            },
            streamingOptions: [],
          };
        }
      }),
    );

    res.json({ matches });
  } catch (err) {
    logger.error({ err, userId, roomId }, 'Get matches error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.patch('/:matchId', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  const userId = (req as AuthRequest).user.userId;
  const matchId = parseInt(req.params['matchId'], 10);
  const { watched } = req.body as { watched?: boolean };

  if (isNaN(matchId)) {
    res.status(400).json({ error: 'Invalid matchId' });
    return;
  }

  if (typeof watched !== 'boolean') {
    res.status(400).json({ error: 'watched must be a boolean' });
    return;
  }

  try {
    const [matches] = await pool.query<MatchRow[]>('SELECT room_id FROM matches WHERE id = ?', [matchId]);

    if (matches.length === 0) {
      res.status(404).json({ error: 'Match not found' });
      return;
    }

    const roomId = matches[0].room_id;

    const [membership] = await pool.query<MembershipRow[]>(
      'SELECT user_id FROM room_members WHERE room_id = ? AND user_id = ?',
      [roomId, userId],
    );
    if (membership.length === 0) {
      res.status(403).json({ error: 'Not a member of this room' });
      return;
    }

    await pool.query('UPDATE matches SET watched = ? WHERE id = ?', [watched, matchId]);

    res.json({ message: 'Match updated', matchId, watched });
  } catch (err) {
    logger.error({ err, userId, matchId }, 'Update match error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/favorites', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  const userId = (req as AuthRequest).user.userId;
  const { movieId } = req.body as { movieId?: number };

  if (!movieId) {
    res.status(400).json({ error: 'movieId is required' });
    return;
  }

  try {
    await pool.query(
      'INSERT INTO favorites (user_id, movie_id) VALUES (?, ?) ON DUPLICATE KEY UPDATE movie_id = movie_id',
      [userId, movieId],
    );

    res.status(201).json({ message: 'Favorite added', movieId });
  } catch (err) {
    logger.error({ err, userId, movieId }, 'Add favorite error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/favorites/:movieId', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  const userId = (req as AuthRequest).user.userId;
  const movieId = parseInt(req.params['movieId'], 10);

  if (isNaN(movieId)) {
    res.status(400).json({ error: 'Invalid movieId' });
    return;
  }

  try {
    await pool.query('DELETE FROM favorites WHERE user_id = ? AND movie_id = ?', [userId, movieId]);

    res.json({ message: 'Favorite removed', movieId });
  } catch (err) {
    logger.error({ err, userId, movieId }, 'Remove favorite error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/favorites/list', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  const userId = (req as AuthRequest).user.userId;

  try {
    const [favoriteRows] = await pool.query<FavoriteRow[]>(
      'SELECT id, movie_id, created_at FROM favorites WHERE user_id = ? ORDER BY created_at DESC',
      [userId],
    );

    const favorites = await Promise.all(
      favoriteRows.map(async (fav) => {
        try {
          const movie = await getMovieById(fav.movie_id);
          const releaseYear = movie.release_date ? parseInt(movie.release_date.slice(0, 4), 10) : new Date().getFullYear();
          const streamingOptions = await getStreamingOffers(fav.movie_id, movie.title, releaseYear);

          return {
            id: fav.id,
            createdAt: fav.created_at,
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
        } catch (err) {
          logger.warn({ err, favoriteId: fav.id, movieId: fav.movie_id }, 'Failed to fetch movie details for favorite');
          return {
            id: fav.id,
            createdAt: fav.created_at,
            movie: {
              id: fav.movie_id,
              title: 'Unknown Movie',
              overview: '',
              posterPath: null,
              backdropPath: null,
              releaseDate: null,
              voteAverage: 0,
            },
            streamingOptions: [],
          };
        }
      }),
    );

    res.json({ favorites });
  } catch (err) {
    logger.error({ err, userId }, 'Get favorites error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
