import { pool } from '../db/connection';
import { config } from '../config';
import { logger } from '../logger';
import { ResultSetHeader, RowDataPacket } from 'mysql2';

interface RoomFilters {
  genres?: number[];
  streamingServices?: string[];
  yearFrom?: number;
  minRating?: number;
  maxRuntime?: number;
  language?: string;
}

interface RoomStateRow extends RowDataPacket {
  stack_next_page: number;
  filters: string | null;
}

interface MaxPositionRow extends RowDataPacket {
  maxPos: number | null;
}

const STREAMING_SERVICE_IDS: Record<string, number> = {
  netflix: 8,
  prime: 9,
  'disney+': 337,
  'apple-tv': 2,
  'paramount+': 531,
};

const PAGES_PER_BATCH = 5;

function buildTmdbUrl(page: number, filters: RoomFilters): { url: string; headers: Record<string, string> } {
  const url = new URL('https://api.themoviedb.org/3/discover/movie');
  url.searchParams.set('language', 'de');
  url.searchParams.set('sort_by', 'popularity.desc');
  url.searchParams.set('page', String(page));

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.tmdbReadAccessToken) {
    headers['Authorization'] = `Bearer ${config.tmdbReadAccessToken}`;
  } else {
    url.searchParams.set('api_key', config.tmdbApiKey);
  }

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

  return { url: url.toString(), headers };
}

async function fetchTmdbPages(
  startPage: number,
  numPages: number,
  filters: RoomFilters,
): Promise<{ movieIds: number[]; totalPages: number }> {
  const movieIds: number[] = [];
  let totalPages = startPage + numPages - 1;

  for (let page = startPage; page <= startPage + numPages - 1; page++) {
    if (page > totalPages) break;

    const { url, headers } = buildTmdbUrl(page, filters);
    const response = await fetch(url, { headers });

    if (!response.ok) {
      logger.error({ status: response.status, page }, 'TMDB request failed');
      break;
    }

    const data = (await response.json()) as { results: Array<{ id: number }>; total_pages: number };
    totalPages = data.total_pages;

    if (data.results.length === 0) break;
    movieIds.push(...data.results.map((m) => m.id));
  }

  return { movieIds, totalPages };
}

export async function generateRoomStack(roomId: number, filters: RoomFilters): Promise<void> {
  try {
    if (!config.tmdbApiKey && !config.tmdbReadAccessToken) {
      throw new Error('TMDB API credentials not configured');
    }

    await pool.query('DELETE FROM room_stack WHERE room_id = ?', [roomId]);

    const { movieIds } = await fetchTmdbPages(1, PAGES_PER_BATCH, filters);

    if (movieIds.length === 0) {
      logger.warn({ roomId, filters }, 'No movies found for room stack');
      await pool.query(
        'UPDATE rooms SET stack_next_page = ?, stack_generating = 0, stack_exhausted = 1 WHERE id = ?',
        [PAGES_PER_BATCH + 1, roomId],
      );
      return;
    }

    const values = movieIds.map((movieId, index) => [roomId, movieId, index]);
    await pool.query('INSERT IGNORE INTO room_stack (room_id, movie_id, position) VALUES ?', [values]);

    await pool.query(
      'UPDATE rooms SET stack_next_page = ?, stack_generating = 0, stack_exhausted = 0 WHERE id = ?',
      [PAGES_PER_BATCH + 1, roomId],
    );

    logger.info({ roomId, movieCount: movieIds.length }, 'Room stack generated');
  } catch (err) {
    logger.error({ err, roomId }, 'Error generating room stack');
    throw err;
  }
}

export async function appendRoomStack(roomId: number): Promise<void> {
  let completed = false;

  try {
    const [roomRows] = await pool.query<RoomStateRow[]>(
      'SELECT stack_next_page, filters FROM rooms WHERE id = ?',
      [roomId],
    );

    if (roomRows.length === 0) {
      completed = true;
      return;
    }

    const startPage = roomRows[0].stack_next_page;
    const filters: RoomFilters = roomRows[0].filters ? (JSON.parse(roomRows[0].filters) as RoomFilters) : {};

    const { movieIds } = await fetchTmdbPages(startPage, PAGES_PER_BATCH, filters);

    if (movieIds.length === 0) {
      await pool.query(
        'UPDATE rooms SET stack_generating = 0, stack_exhausted = 1 WHERE id = ?',
        [roomId],
      );
      completed = true;
      logger.info({ roomId, startPage }, 'Room stack exhausted — no more TMDB pages');
      return;
    }

    const [maxRows] = await pool.query<MaxPositionRow[]>(
      'SELECT MAX(position) AS maxPos FROM room_stack WHERE room_id = ?',
      [roomId],
    );
    const startPosition = (maxRows[0].maxPos ?? -1) + 1;

    const uniqueIds = [...new Set(movieIds)];
    const values = uniqueIds.map((movieId, index) => [roomId, movieId, startPosition + index]);
    const [insertResult] = await pool.query<ResultSetHeader>(
      'INSERT IGNORE INTO room_stack (room_id, movie_id, position) VALUES ?',
      [values],
    );

    await pool.query(
      'UPDATE rooms SET stack_next_page = ?, stack_generating = 0, stack_exhausted = 0 WHERE id = ?',
      [startPage + PAGES_PER_BATCH, roomId],
    );

    completed = true;
    logger.info(
      { roomId, newMovies: insertResult.affectedRows, nextPage: startPage + PAGES_PER_BATCH },
      'Room stack appended',
    );
  } catch (err) {
    logger.error({ err, roomId }, 'Error appending room stack');
  } finally {
    if (!completed) {
      await pool.query('UPDATE rooms SET stack_generating = 0 WHERE id = ?', [roomId]).catch(() => {});
    }
  }
}
