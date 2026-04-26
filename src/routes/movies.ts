import type { Request, Response } from 'express';
import { Router } from 'express';
import { pool } from '../db/connection';
import type { AuthRequest } from '../middleware/auth';
import { authMiddleware } from '../middleware/auth';
import { logger } from '../logger';
import type { TmdbMovie } from '../services/tmdb';
import { getMovieById } from '../services/tmdb';
import type { StreamingOffer } from '../services/justwatch';
import { getStreamingOffers } from '../services/justwatch';
import { appendPartnershipStack } from '../services/partnership-stack';
import type { RowDataPacket, ResultSetHeader } from 'mysql2';

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

interface PartnershipStateRow extends RowDataPacket {
  stack_generating: number;
  stack_exhausted: number;
}

export interface MovieWithStreaming extends TmdbMovie {
  streamingOptions: StreamingOffer[];
  genre_ids: number[];
}

function triggerRefillIfNeeded(
  partnershipId: number,
  unseenCount: number,
  state: PartnershipStateRow,
): void {
  if (unseenCount > REFILL_THRESHOLD || state.stack_exhausted) return;

  pool
    .query<ResultSetHeader>(
      'UPDATE partnerships SET stack_generating = 1 WHERE id = ? AND stack_generating = 0',
      [partnershipId],
    )
    .then(([result]) => {
      if (result.affectedRows > 0) {
        appendPartnershipStack(partnershipId).catch((err: unknown) =>
          logger.error({ err, partnershipId }, 'Background stack refill failed'),
        );
      }
    })
    .catch((err: unknown) =>
      logger.error({ err, partnershipId }, 'Failed to acquire stack_generating lock'),
    );
}

router.get(
  '/partnerships/:partnershipId/next-movie',
  authMiddleware,
  async (req: Request, res: Response): Promise<void> => {
    const userId = (req as AuthRequest).user.userId;
    const partnershipId = parseInt(req.params['partnershipId'], 10);

    if (isNaN(partnershipId)) {
      res.status(400).json({ error: 'Ungueltige Partnership-ID' });
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

      const [[partnershipState], [swiped], [stackRows]] = await Promise.all([
        pool.query<PartnershipStateRow[]>(
          'SELECT stack_generating, stack_exhausted FROM partnerships WHERE id = ?',
          [partnershipId],
        ),
        pool.query<SwipedRow[]>(
          'SELECT movie_id FROM swipes WHERE user_id = ? AND partnership_id = ?',
          [userId, partnershipId],
        ),
        pool.query<StackRow[]>(
          'SELECT movie_id, position FROM partnership_stack WHERE partnership_id = ? ORDER BY position ASC',
          [partnershipId],
        ),
      ]);

      const swipedIds = new Set((swiped as SwipedRow[]).map((r) => r.movie_id));
      const unseenMovies = (stackRows as StackRow[]).filter((row) => !swipedIds.has(row.movie_id));

      if (partnershipState.length > 0) {
        triggerRefillIfNeeded(
          partnershipId,
          unseenMovies.length,
          (partnershipState as PartnershipStateRow[])[0],
        );
      }

      const nextMovie = unseenMovies[0];

      if (!nextMovie) {
        res.json({ movie: null, stackEmpty: true });
        return;
      }

      const movie = await getMovieById(nextMovie.movie_id);
      const releaseYear = movie.release_date
        ? parseInt(movie.release_date.slice(0, 4), 10)
        : new Date().getFullYear();
      const streamingOptions = await getStreamingOffers(
        nextMovie.movie_id,
        movie.title,
        releaseYear,
      );

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
      logger.error({ err, userId, partnershipId }, 'Next movie error');
      res.status(500).json({ error: 'Interner Serverfehler' });
    }
  },
);

// GET /api/movies/feed?partnershipId=&afterPosition=
router.get('/feed', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  const userId = (req as AuthRequest).user.userId;
  const partnershipId = parseInt(req.query['partnershipId'] as string, 10);
  const rawAfterPosition = parseInt((req.query['afterPosition'] as string) ?? '0', 10);
  const afterPosition = isNaN(rawAfterPosition) ? 0 : rawAfterPosition;

  if (isNaN(partnershipId)) {
    res.status(400).json({ error: 'partnershipId Parameter ist erforderlich' });
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

    const [[partnershipState], [swiped], [stackRows]] = await Promise.all([
      pool.query<PartnershipStateRow[]>(
        'SELECT stack_generating, stack_exhausted FROM partnerships WHERE id = ?',
        [partnershipId],
      ),
      pool.query<SwipedRow[]>(
        'SELECT movie_id FROM swipes WHERE user_id = ? AND partnership_id = ?',
        [userId, partnershipId],
      ),
      pool.query<StackRow[]>(
        'SELECT movie_id, position FROM partnership_stack WHERE partnership_id = ? ORDER BY position ASC',
        [partnershipId],
      ),
    ]);

    const swipedIds = new Set((swiped as SwipedRow[]).map((r) => r.movie_id));
    const unseenMovies = (stackRows as StackRow[]).filter((row) => !swipedIds.has(row.movie_id));

    if (partnershipState.length > 0) {
      triggerRefillIfNeeded(
        partnershipId,
        unseenMovies.length,
        (partnershipState as PartnershipStateRow[])[0],
      );
    }

    const pageSize = 20;
    const movieSlice = unseenMovies
      .filter((row) => row.position > afterPosition)
      .slice(0, pageSize);
    const lastPosition =
      movieSlice.length > 0 ? movieSlice[movieSlice.length - 1]!.position : afterPosition;

    if (movieSlice.length === 0) {
      res.json({ movies: [], lastPosition: afterPosition });
      return;
    }

    const results: MovieWithStreaming[] = await Promise.all(
      movieSlice.map(async (row) => {
        const movie = await getMovieById(row.movie_id);
        const releaseYear = movie.release_date
          ? parseInt(movie.release_date.slice(0, 4), 10)
          : new Date().getFullYear();
        const streamingOptions = await getStreamingOffers(row.movie_id, movie.title, releaseYear);

        return {
          ...movie,
          genre_ids: movie.genre_ids || (movie.genres ? movie.genres.map((g) => g.id) : []),
          streamingOptions,
        };
      }),
    );

    res.json({ movies: results, lastPosition });
  } catch (err) {
    logger.error({ err, userId, partnershipId }, 'Movie feed error');
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

export default router;
