import { config } from '../config';
import { logger } from '../logger';

const TMDB_BASE = 'https://api.themoviedb.org/3';

export interface TmdbMovie {
  id: number;
  title: string;
  overview: string;
  poster_path: string | null;
  backdrop_path: string | null;
  release_date: string;
  vote_average: number;
  genre_ids?: number[];
  genres?: Array<{ id: number; name: string }>;
}

interface TmdbPageResult {
  page: number;
  results: TmdbMovie[];
  total_pages: number;
  total_results: number;
}

// ── LRU Cache for movie details ──────────────────────────────────────────────

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const MOVIE_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const MOVIE_CACHE_MAX_SIZE = 2000;
const movieCache = new Map<number, CacheEntry<TmdbMovie>>();

function getCached(movieId: number): TmdbMovie | null {
  const entry = movieCache.get(movieId);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    movieCache.delete(movieId);
    return null;
  }
  return entry.value;
}

function setCache(movieId: number, movie: TmdbMovie): void {
  // Evict oldest entries if over capacity
  if (movieCache.size >= MOVIE_CACHE_MAX_SIZE) {
    const firstKey = movieCache.keys().next().value;
    if (firstKey !== undefined) movieCache.delete(firstKey);
  }
  movieCache.set(movieId, { value: movie, expiresAt: Date.now() + MOVIE_CACHE_TTL_MS });
}

// ── TMDB HTTP client using Bearer token ──────────────────────────────────────

async function tmdbGet<T>(path: string, params: Record<string, string> = {}): Promise<T> {
  const url = new URL(`${TMDB_BASE}${path}`);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };

  // Prefer Read Access Token (Bearer) over query-param api_key
  if (config.tmdbReadAccessToken) {
    headers['Authorization'] = `Bearer ${config.tmdbReadAccessToken}`;
  } else {
    url.searchParams.set('api_key', config.tmdbApiKey);
  }

  const response = await fetch(url.toString(), { headers });
  if (!response.ok) {
    throw new Error(`TMDB request failed: ${response.status} ${response.statusText}`);
  }
  return response.json() as Promise<T>;
}

// ── Public API ───────────────────────────────────────────────────────────────

export async function getPopularMovies(page: number): Promise<TmdbMovie[]> {
  const data = await tmdbGet<TmdbPageResult>('/movie/popular', {
    page: String(page),
    language: 'de',
  });
  // Populate cache while we have the data
  for (const movie of data.results) {
    setCache(movie.id, movie);
  }
  return data.results;
}

export async function getMovieById(movieId: number): Promise<TmdbMovie> {
  const cached = getCached(movieId);
  if (cached) return cached;

  const movie = await tmdbGet<TmdbMovie>(`/movie/${movieId}`, { language: 'de' });
  setCache(movieId, movie);
  return movie;
}
