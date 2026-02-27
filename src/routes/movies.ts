import { Router, Request, Response } from 'express';
import { pool } from '../db/connection';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { logger } from '../logger';
import { getPopularMovies, getMovieById, TmdbMovie } from '../services/tmdb';
import { getStreamingOffers, StreamingOffer } from '../services/justwatch';
import { RowDataPacket } from 'mysql2';

const router = Router();

interface SwipedRow extends RowDataPacket {
  movie_id: number;
}

interface MembershipRow extends RowDataPacket {
  user_id: number;
}

interface StackRow extends RowDataPacket {
  movie_id: number;
  position: number;
}

export interface MovieWithStreaming extends TmdbMovie {
  streamingOptions: StreamingOffer[];
  genre_ids: number[];
}

router.get('/rooms/:roomId/next-movie', authMiddleware, async (req: Request, res: Response): Promise<void> => {
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

    const [swiped] = await pool.query<SwipedRow[]>('SELECT movie_id FROM swipes WHERE user_id = ? AND room_id = ?', [
      userId,
      roomId,
    ]);
    const swipedIds = new Set(swiped.map((r) => r.movie_id));

    const [stackRows] = await pool.query<StackRow[]>(
      'SELECT movie_id, position FROM room_stack WHERE room_id = ? ORDER BY position ASC',
      [roomId],
    );

    const nextMovie = stackRows.find((row) => !swipedIds.has(row.movie_id));

    if (!nextMovie) {
      res.json({ movie: null, stackEmpty: true });
      return;
    }

    const movie = await getMovieById(nextMovie.movie_id);
    const releaseYear = movie.release_date ? parseInt(movie.release_date.slice(0, 4), 10) : new Date().getFullYear();
    const streamingOptions = await getStreamingOffers(nextMovie.movie_id, movie.title, releaseYear);

    res.json({
      movie: {
        id: movie.id,
        title: movie.title,
        overview: movie.overview,
        posterPath: movie.poster_path,
        backdropPath: movie.backdrop_path,
        releaseDate: movie.release_date,
        voteAverage: movie.vote_average,
        streamingOptions,
      },
      stackEmpty: false,
    });
  } catch (err) {
    logger.error({ err, userId, roomId }, 'Next movie error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/movies/feed?roomId=&page=
router.get('/feed', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  const userId = (req as AuthRequest).user.userId;
  const roomId = parseInt(req.query['roomId'] as string, 10);
  const page = Math.max(1, parseInt((req.query['page'] as string) ?? '1', 10));

  if (isNaN(roomId)) {
    res.status(400).json({ error: 'roomId query parameter is required' });
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

    const [swiped] = await pool.query<SwipedRow[]>('SELECT movie_id FROM swipes WHERE user_id = ? AND room_id = ?', [
      userId,
      roomId,
    ]);
    const swipedIds = new Set(swiped.map((r) => r.movie_id));

    const [stackRows] = await pool.query<StackRow[]>(
      'SELECT movie_id, position FROM room_stack WHERE room_id = ? ORDER BY position ASC',
      [roomId],
    );

    const pageSize = 20;
    const startIndex = (page - 1) * pageSize;
    const unseenMovies = stackRows.filter((row) => !swipedIds.has(row.movie_id));
    const movieSlice = unseenMovies.slice(startIndex, startIndex + pageSize);

    if (movieSlice.length === 0) {
      res.json({ page, movies: [] });
      return;
    }

    const results: MovieWithStreaming[] = await Promise.all(
      movieSlice.map(async (row) => {
        const movie = await getMovieById(row.movie_id);
        const releaseYear = movie.release_date ? parseInt(movie.release_date.slice(0, 4), 10) : new Date().getFullYear();
        const streamingOptions = await getStreamingOffers(row.movie_id, movie.title, releaseYear);

        return {
          ...movie,
          genre_ids: movie.genre_ids || (movie.genres ? movie.genres.map(g => g.id) : []),
          streamingOptions,
        };
      }),
    );

    res.json({ page, movies: results });
  } catch (err) {
    logger.error({ err, userId, roomId }, 'Movie feed error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
