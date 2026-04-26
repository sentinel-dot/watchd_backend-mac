import { pool } from '../db/connection';
import { config } from '../config';
import { logger } from '../logger';
import type { ResultSetHeader, RowDataPacket } from 'mysql2';

export interface PartnershipFilters {
  genres?: number[];
  streamingServices?: string[];
  yearFrom?: number;
  minRating?: number;
  maxRuntime?: number;
  language?: string;
}

interface PartnershipStateRow extends RowDataPacket {
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

export function buildTmdbUrl(
  page: number,
  filters: PartnershipFilters,
): { url: string; headers: Record<string, string> } {
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
  filters: PartnershipFilters,
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

export async function generatePartnershipStack(
  partnershipId: number,
  filters: PartnershipFilters,
): Promise<void> {
  try {
    if (!config.tmdbApiKey && !config.tmdbReadAccessToken) {
      throw new Error('TMDB API credentials not configured');
    }

    await pool.query('DELETE FROM partnership_stack WHERE partnership_id = ?', [partnershipId]);

    const { movieIds } = await fetchTmdbPages(1, PAGES_PER_BATCH, filters);

    if (movieIds.length === 0) {
      logger.warn({ partnershipId, filters }, 'No movies found for partnership stack');
      await pool.query(
        'UPDATE partnerships SET stack_next_page = ?, stack_generating = 0, stack_exhausted = 1 WHERE id = ?',
        [PAGES_PER_BATCH + 1, partnershipId],
      );
      return;
    }

    const values = movieIds.map((movieId, index) => [partnershipId, movieId, index]);
    await pool.query(
      'INSERT IGNORE INTO partnership_stack (partnership_id, movie_id, position) VALUES ?',
      [values],
    );

    await pool.query(
      'UPDATE partnerships SET stack_next_page = ?, stack_generating = 0, stack_exhausted = 0 WHERE id = ?',
      [PAGES_PER_BATCH + 1, partnershipId],
    );

    logger.info({ partnershipId, movieCount: movieIds.length }, 'Partnership stack generated');
  } catch (err) {
    logger.error({ err, partnershipId }, 'Error generating partnership stack');
    throw err;
  }
}

export async function appendPartnershipStack(partnershipId: number): Promise<void> {
  let completed = false;

  try {
    const [partnershipRows] = await pool.query<PartnershipStateRow[]>(
      'SELECT stack_next_page, filters FROM partnerships WHERE id = ?',
      [partnershipId],
    );

    if (partnershipRows.length === 0) {
      completed = true;
      return;
    }

    const startPage = partnershipRows[0].stack_next_page;
    const filters: PartnershipFilters = partnershipRows[0].filters
      ? (JSON.parse(partnershipRows[0].filters) as PartnershipFilters)
      : {};

    const { movieIds } = await fetchTmdbPages(startPage, PAGES_PER_BATCH, filters);

    if (movieIds.length === 0) {
      await pool.query(
        'UPDATE partnerships SET stack_generating = 0, stack_exhausted = 1 WHERE id = ?',
        [partnershipId],
      );
      completed = true;
      logger.info({ partnershipId, startPage }, 'Partnership stack exhausted — no more TMDB pages');
      return;
    }

    const [maxRows] = await pool.query<MaxPositionRow[]>(
      'SELECT MAX(position) AS maxPos FROM partnership_stack WHERE partnership_id = ?',
      [partnershipId],
    );
    const startPosition = (maxRows[0].maxPos ?? -1) + 1;

    const uniqueIds = [...new Set(movieIds)];
    const values = uniqueIds.map((movieId, index) => [
      partnershipId,
      movieId,
      startPosition + index,
    ]);
    const [insertResult] = await pool.query<ResultSetHeader>(
      'INSERT IGNORE INTO partnership_stack (partnership_id, movie_id, position) VALUES ?',
      [values],
    );

    await pool.query(
      'UPDATE partnerships SET stack_next_page = ?, stack_generating = 0, stack_exhausted = 0 WHERE id = ?',
      [startPage + PAGES_PER_BATCH, partnershipId],
    );

    completed = true;
    logger.info(
      {
        partnershipId,
        newMovies: insertResult.affectedRows,
        nextPage: startPage + PAGES_PER_BATCH,
      },
      'Partnership stack appended',
    );
  } catch (err) {
    logger.error({ err, partnershipId }, 'Error appending partnership stack');
  } finally {
    if (!completed) {
      await pool
        .query('UPDATE partnerships SET stack_generating = 0 WHERE id = ?', [partnershipId])
        .catch(() => {});
    }
  }
}
