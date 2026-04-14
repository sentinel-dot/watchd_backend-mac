import { Router, Request, Response } from 'express';
import { pool } from '../db/connection';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { logger } from '../logger';
import { getPopularMovies, getMovieById, TmdbMovie } from '../services/tmdb';
import { getStreamingOffers, StreamingOffer } from '../services/justwatch';
import { appendRoomStack } from '../services/room-stack';
import { RowDataPacket, ResultSetHeader } from 'mysql2';

const router = Router();

const REFILL_THRESHOLD = 10;

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

interface RoomStateRow extends RowDataPacket {
  stack_generating: number;
  stack_exhausted: number;
}

export interface MovieWithStreaming extends TmdbMovie {
  streamingOptions: StreamingOffer[];
  genre_ids: number[];
}

function triggerRefillIfNeeded(roomId: number, unseenCount: number, roomState: RoomStateRow): void {
  if (unseenCount > REFILL_THRESHOLD || roomState.stack_exhausted) return;

  pool
    .query<ResultSetHeader>('UPDATE rooms SET stack_generating = 1 WHERE id = ? AND stack_generating = 0', [roomId])
    .then(([result]) => {
      if (result.affectedRows > 0) {
        appendRoomStack(roomId).catch((err) =>
          logger.error({ err, roomId }, 'Background stack refill failed'),
        );
      }
    })
    .catch((err) => logger.error({ err, roomId }, 'Failed to acquire stack_generating lock'));
}

router.get('/rooms/:roomId/next-movie', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  const userId = (req as AuthRequest).user.userId;
  const roomId = parseInt(req.params['roomId'], 10);

  if (isNaN(roomId)) {
    res.status(400).json({ error: 'Ungueltige Room-ID' });
    return;
  }

  try {
    const [membership] = await pool.query<MembershipRow[]>(
      'SELECT user_id FROM room_members WHERE room_id = ? AND user_id = ?',
      [roomId, userId],
    );
    if (membership.length === 0) {
      res.status(403).json({ error: 'Kein Mitglied dieses Rooms' });
      return;
    }

    const [[roomState], [swiped], [stackRows]] = await Promise.all([
      pool.query<RoomStateRow[]>(
        'SELECT stack_generating, stack_exhausted FROM rooms WHERE id = ?',
        [roomId],
      ),
      pool.query<SwipedRow[]>('SELECT movie_id FROM swipes WHERE user_id = ? AND room_id = ?', [userId, roomId]),
      pool.query<StackRow[]>(
        'SELECT movie_id, position FROM room_stack WHERE room_id = ? ORDER BY position ASC',
        [roomId],
      ),
    ]);

    const swipedIds = new Set((swiped as SwipedRow[]).map((r) => r.movie_id));
    const unseenMovies = (stackRows as StackRow[]).filter((row) => !swipedIds.has(row.movie_id));

    if (roomState.length > 0) {
      triggerRefillIfNeeded(roomId, unseenMovies.length, (roomState as RoomStateRow[])[0]);
    }

    const nextMovie = unseenMovies[0];

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
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

// GET /api/movies/feed?roomId=&afterPosition=
router.get('/feed', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  const userId = (req as AuthRequest).user.userId;
  const roomId = parseInt(req.query['roomId'] as string, 10);
  const rawAfterPosition = parseInt((req.query['afterPosition'] as string) ?? '0', 10);
  const afterPosition = isNaN(rawAfterPosition) ? 0 : rawAfterPosition;

  if (isNaN(roomId)) {
    res.status(400).json({ error: 'roomId Parameter ist erforderlich' });
    return;
  }

  try {
    const [membership] = await pool.query<MembershipRow[]>(
      'SELECT user_id FROM room_members WHERE room_id = ? AND user_id = ?',
      [roomId, userId],
    );
    if (membership.length === 0) {
      res.status(403).json({ error: 'Kein Mitglied dieses Rooms' });
      return;
    }

    const [[roomState], [swiped], [stackRows]] = await Promise.all([
      pool.query<RoomStateRow[]>(
        'SELECT stack_generating, stack_exhausted FROM rooms WHERE id = ?',
        [roomId],
      ),
      pool.query<SwipedRow[]>('SELECT movie_id FROM swipes WHERE user_id = ? AND room_id = ?', [userId, roomId]),
      pool.query<StackRow[]>(
        'SELECT movie_id, position FROM room_stack WHERE room_id = ? ORDER BY position ASC',
        [roomId],
      ),
    ]);

    const swipedIds = new Set((swiped as SwipedRow[]).map((r) => r.movie_id));
    const unseenMovies = (stackRows as StackRow[]).filter((row) => !swipedIds.has(row.movie_id));

    if (roomState.length > 0) {
      triggerRefillIfNeeded(roomId, unseenMovies.length, (roomState as RoomStateRow[])[0]);
    }

    const pageSize = 20;
    const movieSlice = unseenMovies.filter((row) => row.position > afterPosition).slice(0, pageSize);
    const lastPosition = movieSlice.length > 0 ? movieSlice[movieSlice.length - 1]!.position : afterPosition;

    if (movieSlice.length === 0) {
      res.json({ movies: [], lastPosition: afterPosition });
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

    res.json({ movies: results, lastPosition });
  } catch (err) {
    logger.error({ err, userId, roomId }, 'Movie feed error');
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

export default router;
