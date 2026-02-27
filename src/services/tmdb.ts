import { config } from '../config';

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

async function tmdbGet<T>(path: string, params: Record<string, string> = {}): Promise<T> {
  const url = new URL(`${TMDB_BASE}${path}`);
  url.searchParams.set('api_key', config.tmdbApiKey);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }

  const response = await fetch(url.toString());
  if (!response.ok) {
    throw new Error(`TMDB request failed: ${response.status} ${response.statusText}`);
  }
  return response.json() as Promise<T>;
}

export async function getPopularMovies(page: number): Promise<TmdbMovie[]> {
  const data = await tmdbGet<TmdbPageResult>('/movie/popular', {
    page: String(page),
    language: 'de',
  });
  return data.results;
}

export async function getMovieById(movieId: number): Promise<TmdbMovie> {
  return tmdbGet<TmdbMovie>(`/movie/${movieId}`, { language: 'de' });
}
