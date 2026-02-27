import { pool } from '../db/connection';
import { logger } from '../logger';
import { ResultSetHeader } from 'mysql2';

interface RoomFilters {
  genres?: number[];
  streamingServices?: string[];
  yearFrom?: number;
  minRating?: number;
  maxRuntime?: number;
  language?: string;
}

const STREAMING_SERVICE_IDS: Record<string, number> = {
  netflix: 8,
  prime: 9,
  'disney+': 337,
  'apple-tv': 2,
  'paramount+': 531,
};

export async function generateRoomStack(roomId: number, filters: RoomFilters): Promise<void> {
  try {
    await pool.query('DELETE FROM room_stack WHERE room_id = ?', [roomId]);

    const tmdbApiKey = process.env['TMDB_API_KEY'];
    if (!tmdbApiKey) {
      throw new Error('TMDB_API_KEY not configured');
    }

    const movieIds: number[] = [];

    for (let page = 1; page <= 5; page++) {
      const url = new URL('https://api.themoviedb.org/3/discover/movie');
      url.searchParams.set('api_key', tmdbApiKey);
      url.searchParams.set('language', 'de');
      url.searchParams.set('sort_by', 'popularity.desc');
      url.searchParams.set('page', String(page));

      if (filters.genres && filters.genres.length > 0) {
        url.searchParams.set('with_genres', filters.genres.join(','));
      }

      if (filters.yearFrom) {
        url.searchParams.set('primary_release_date.gte', `${filters.yearFrom}-01-01`);
      }

      if (filters.minRating) {
        url.searchParams.set('vote_average.gte', String(filters.minRating));
      }

      if (filters.maxRuntime) {
        url.searchParams.set('with_runtime.lte', String(filters.maxRuntime));
      }

      if (filters.language) {
        url.searchParams.set('with_original_language', filters.language);
      }

      if (filters.streamingServices && filters.streamingServices.length > 0) {
        const providerIds = filters.streamingServices
          .map((s) => STREAMING_SERVICE_IDS[s.toLowerCase()])
          .filter((id) => id !== undefined);
        if (providerIds.length > 0) {
          url.searchParams.set('with_watch_providers', providerIds.join('|'));
          url.searchParams.set('watch_region', 'DE');
        }
      }

      const response = await fetch(url.toString());
      if (!response.ok) {
        logger.error({ status: response.status, page }, 'TMDB request failed for room stack generation');
        break;
      }

      const data = (await response.json()) as { results: Array<{ id: number }> };
      movieIds.push(...data.results.map((m) => m.id));
    }

    if (movieIds.length === 0) {
      logger.warn({ roomId, filters }, 'No movies found for room stack');
      return;
    }

    const values = movieIds.map((movieId, index) => [roomId, movieId, index]);
    await pool.query('INSERT INTO room_stack (room_id, movie_id, position) VALUES ?', [values]);

    logger.info({ roomId, movieCount: movieIds.length }, 'Room stack generated');
  } catch (err) {
    logger.error({ err, roomId }, 'Error generating room stack');
    throw err;
  }
}
