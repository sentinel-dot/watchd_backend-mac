import { Router, Request, Response } from 'express';
import { pool } from '../db/connection';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { getPopularMovies, TmdbMovie } from '../services/tmdb';
import { getStreamingOffers, StreamingOffer } from '../services/justwatch';
import { RowDataPacket } from 'mysql2';

const router = Router();

interface SwipedRow extends RowDataPacket {
  movie_id: number;
}

interface MembershipRow extends RowDataPacket {
  user_id: number;
}

export interface MovieWithStreaming extends TmdbMovie {
  streamingOptions: StreamingOffer[];
}

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
    // Verify membership
    const [membership] = await pool.query<MembershipRow[]>(
      'SELECT user_id FROM room_members WHERE room_id = ? AND user_id = ?',
      [roomId, userId],
    );
    if (membership.length === 0) {
      res.status(403).json({ error: 'Not a member of this room' });
      return;
    }

    // Get already-swiped movie IDs for this user in this room
    const [swiped] = await pool.query<SwipedRow[]>(
      'SELECT movie_id FROM swipes WHERE user_id = ? AND room_id = ?',
      [userId, roomId],
    );
    const swipedIds = new Set(swiped.map((r) => r.movie_id));

    // Fetch from TMDB and filter; try multiple pages to fill 20 results
    const results: MovieWithStreaming[] = [];
    let tmdbPage = page;
    const maxPages = page + 5;

    while (results.length < 20 && tmdbPage <= maxPages) {
      const movies = await getPopularMovies(tmdbPage);
      tmdbPage++;

      for (const movie of movies) {
        if (swipedIds.has(movie.id)) continue;
        if (!movie.overview || movie.overview.trim() === '') continue;
        results.push({ ...movie, streamingOptions: [] });
        if (results.length >= 20) break;
      }
    }

    // Enrich with JustWatch streaming data (in parallel, capped at 20)
    await Promise.all(
      results.map(async (movie) => {
        const releaseYear = movie.release_date
          ? parseInt(movie.release_date.slice(0, 4), 10)
          : new Date().getFullYear();

        movie.streamingOptions = await getStreamingOffers(
          movie.id,
          movie.title,
          releaseYear,
        );
      }),
    );

    res.json({ page, movies: results });
  } catch (err) {
    console.error('Movie feed error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
