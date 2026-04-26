import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { pool } from '../../db/connection';
import {
  generateShareCode,
  containsProfanity,
  generateUniqueShareCode,
} from '../../services/share-code';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

describe('generateShareCode', () => {
  it('produces a code of exactly 8 characters', () => {
    for (let i = 0; i < 100; i++) {
      expect(generateShareCode()).toHaveLength(8);
    }
  });

  it('only uses Crockford-Base32 alphabet characters', () => {
    for (let i = 0; i < 100; i++) {
      const code = generateShareCode();
      for (const ch of code) {
        expect(ALPHABET).toContain(ch);
      }
    }
  });
});

describe('containsProfanity', () => {
  it('flags codes containing blocklisted substrings', () => {
    expect(containsProfanity('FUCK1234')).toBe(true);
    expect(containsProfanity('AANAZIBB')).toBe(true);
    expect(containsProfanity('XHURE000')).toBe(true);
  });

  it('passes clean codes', () => {
    expect(containsProfanity('12345678')).toBe(false);
    expect(containsProfanity('ABCDEFGH')).toBe(false);
  });
});

describe('generateUniqueShareCode', () => {
  // We can't `vi.mock('../../db/connection', …)` here: the module is already
  // loaded by setup.ts (via app.ts) and `isolate: false` shares it across files.
  // Instead we swap pool.query for a mock and explicitly restore afterwards.
  // mockRestore on vi.spyOn alone is NOT enough — under `isolate: false` the
  // restore can leak across files and break later tests that hit pool.query.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const originalQuery = pool.query.bind(pool) as any;
  let queryMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    queryMock = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (pool as unknown as { query: any }).query = queryMock;
  });

  afterEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (pool as unknown as { query: any }).query = originalQuery;
  });

  it('returns the first non-colliding code', async () => {
    queryMock.mockResolvedValueOnce([[{ c: 0 }], []]);
    const code = await generateUniqueShareCode();
    expect(code).toHaveLength(8);
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it('retries past collisions and returns once a code is unique', async () => {
    queryMock
      .mockResolvedValueOnce([[{ c: 1 }], []])
      .mockResolvedValueOnce([[{ c: 1 }], []])
      .mockResolvedValueOnce([[{ c: 0 }], []]);

    const code = await generateUniqueShareCode();
    expect(code).toHaveLength(8);
    expect(queryMock).toHaveBeenCalledTimes(3);
  });

  it('throws after 5 consecutive collisions', async () => {
    queryMock.mockResolvedValue([[{ c: 1 }], []]);

    await expect(generateUniqueShareCode()).rejects.toThrow('share-code collision ceiling');
    expect(queryMock).toHaveBeenCalledTimes(5);
  });
});
