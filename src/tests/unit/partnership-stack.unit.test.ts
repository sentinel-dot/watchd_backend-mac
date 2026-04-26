import { describe, it, expect, vi } from 'vitest';

vi.unmock('../../services/partnership-stack');
import { buildTmdbUrl } from '../../services/partnership-stack';

describe('buildTmdbUrl', () => {
  it('builds a base URL with defaults on page 1', () => {
    const { url, headers } = buildTmdbUrl(1, {});
    const u = new URL(url);
    expect(u.hostname).toBe('api.themoviedb.org');
    expect(u.pathname).toBe('/3/discover/movie');
    expect(u.searchParams.get('language')).toBe('de');
    expect(u.searchParams.get('sort_by')).toBe('popularity.desc');
    expect(u.searchParams.get('page')).toBe('1');
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('uses api_key query param when read-access-token is absent', () => {
    const { url } = buildTmdbUrl(2, {});
    const u = new URL(url);
    // .env.test sets TMDB_API_KEY=fake-tmdb-key, no read token
    expect(u.searchParams.get('api_key')).toBe('fake-tmdb-key');
  });

  it('applies genre filter', () => {
    const { url } = buildTmdbUrl(1, { genres: [28, 12] });
    expect(new URL(url).searchParams.get('with_genres')).toBe('28,12');
  });

  it('applies yearFrom as primary_release_date.gte', () => {
    const { url } = buildTmdbUrl(1, { yearFrom: 2020 });
    expect(new URL(url).searchParams.get('primary_release_date.gte')).toBe('2020-01-01');
  });

  it('applies minRating, maxRuntime, language', () => {
    const { url } = buildTmdbUrl(1, { minRating: 7, maxRuntime: 120, language: 'en' });
    const u = new URL(url);
    expect(u.searchParams.get('vote_average.gte')).toBe('7');
    expect(u.searchParams.get('with_runtime.lte')).toBe('120');
    expect(u.searchParams.get('with_original_language')).toBe('en');
  });

  it('maps known streaming services to provider IDs and sets DE region', () => {
    const { url } = buildTmdbUrl(1, { streamingServices: ['netflix', 'prime'] });
    const u = new URL(url);
    expect(u.searchParams.get('with_watch_providers')).toBe('8|9');
    expect(u.searchParams.get('watch_region')).toBe('DE');
  });

  it('skips unknown streaming services silently', () => {
    const { url } = buildTmdbUrl(1, { streamingServices: ['unknown-service'] });
    const u = new URL(url);
    expect(u.searchParams.get('with_watch_providers')).toBeNull();
    expect(u.searchParams.get('watch_region')).toBeNull();
  });

  it('combines multiple filters', () => {
    const { url } = buildTmdbUrl(3, {
      genres: [28],
      yearFrom: 2010,
      minRating: 6,
      streamingServices: ['disney+'],
    });
    const u = new URL(url);
    expect(u.searchParams.get('page')).toBe('3');
    expect(u.searchParams.get('with_genres')).toBe('28');
    expect(u.searchParams.get('primary_release_date.gte')).toBe('2010-01-01');
    expect(u.searchParams.get('vote_average.gte')).toBe('6');
    expect(u.searchParams.get('with_watch_providers')).toBe('337');
  });
});
