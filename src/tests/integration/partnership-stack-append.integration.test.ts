import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import type { RowDataPacket, ResultSetHeader } from 'mysql2';
import type * as PartnershipStackModule from '../../services/partnership-stack';
import { pool } from '../../db/connection';
import { createUser } from '../helpers';
import { agent } from '../setup';

// Bypass the global mock from setup.ts for the real implementation under test.
let appendPartnershipStack!: typeof PartnershipStackModule.appendPartnershipStack;
beforeAll(async () => {
  const actual = await vi.importActual<typeof PartnershipStackModule>(
    '../../services/partnership-stack',
  );
  appendPartnershipStack = actual.appendPartnershipStack;
});

async function createBarePartnership(
  requesterId: number,
  addresseeId: number,
  opts: { stackNextPage?: number; filters?: object | null; stackGenerating?: boolean } = {},
): Promise<number> {
  const filtersJson = opts.filters === undefined ? null : JSON.stringify(opts.filters);
  const [result] = await pool.query<ResultSetHeader>(
    `INSERT INTO partnerships (requester_id, addressee_id, status, filters, stack_next_page, stack_generating, stack_exhausted, accepted_at)
     VALUES (?, ?, 'active', ?, ?, ?, 0, NOW())`,
    [requesterId, addresseeId, filtersJson, opts.stackNextPage ?? 6, opts.stackGenerating ? 1 : 0],
  );
  const partnershipId = result.insertId;
  await pool.query(
    'INSERT INTO partnership_members (partnership_id, user_id) VALUES (?, ?), (?, ?)',
    [partnershipId, requesterId, partnershipId, addresseeId],
  );
  return partnershipId;
}

function mockTmdbPages(pageToIds: Record<number, number[]>, totalPages = 500): void {
  const fetchSpy = vi.fn(async (input: string | URL) => {
    const url = new URL(input.toString());
    const page = parseInt(url.searchParams.get('page') ?? '1', 10);
    const results = (pageToIds[page] ?? []).map((id) => ({ id }));
    return new Response(JSON.stringify({ results, total_pages: totalPages }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchSpy);
}

describe('appendPartnershipStack (real implementation)', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('appends 5 pages of movies, advances stack_next_page, clears the lock', async () => {
    const a = await createUser(agent, { email: 'ps-append-a@example.com' });
    const b = await createUser(agent, { email: 'ps-append-b@example.com' });
    const partnershipId = await createBarePartnership(a.userId, b.userId, {
      stackNextPage: 6,
      stackGenerating: true,
    });

    mockTmdbPages({
      6: [601, 602],
      7: [701],
      8: [801, 802],
      9: [901],
      10: [1001],
    });

    await appendPartnershipStack(partnershipId);

    const [stackRows] = await pool.query<
      (RowDataPacket & { movie_id: number; position: number })[]
    >(
      'SELECT movie_id, position FROM partnership_stack WHERE partnership_id = ? ORDER BY position ASC',
      [partnershipId],
    );
    expect(stackRows.map((r) => r.movie_id)).toEqual([601, 602, 701, 801, 802, 901, 1001]);
    expect(stackRows[0].position).toBe(0);

    const [rows] = await pool.query<
      (RowDataPacket & {
        stack_next_page: number;
        stack_generating: number;
        stack_exhausted: number;
      })[]
    >('SELECT stack_next_page, stack_generating, stack_exhausted FROM partnerships WHERE id = ?', [
      partnershipId,
    ]);
    expect(rows[0].stack_next_page).toBe(11);
    expect(rows[0].stack_generating).toBe(0);
    expect(rows[0].stack_exhausted).toBe(0);
  });

  it('starts new positions after MAX(position) of the existing stack', async () => {
    const a = await createUser(agent, { email: 'ps-pos-a@example.com' });
    const b = await createUser(agent, { email: 'ps-pos-b@example.com' });
    const partnershipId = await createBarePartnership(a.userId, b.userId, { stackNextPage: 11 });
    await pool.query(
      'INSERT INTO partnership_stack (partnership_id, movie_id, position) VALUES (?, 1, 0), (?, 2, 1), (?, 3, 2)',
      [partnershipId, partnershipId, partnershipId],
    );

    mockTmdbPages({ 11: [111], 12: [222] });

    await appendPartnershipStack(partnershipId);

    const [rows] = await pool.query<(RowDataPacket & { movie_id: number; position: number })[]>(
      'SELECT movie_id, position FROM partnership_stack WHERE partnership_id = ? ORDER BY position ASC',
      [partnershipId],
    );
    expect(rows.map((r) => r.position)).toEqual([0, 1, 2, 3, 4]);
    expect(rows.slice(3).map((r) => r.movie_id)).toEqual([111, 222]);

    const [partnershipRows] = await pool.query<(RowDataPacket & { stack_next_page: number })[]>(
      'SELECT stack_next_page FROM partnerships WHERE id = ?',
      [partnershipId],
    );
    expect(partnershipRows[0].stack_next_page).toBe(16);
  });

  it('sets stack_exhausted=1 when TMDB returns no more results', async () => {
    const a = await createUser(agent, { email: 'ps-exhausted-a@example.com' });
    const b = await createUser(agent, { email: 'ps-exhausted-b@example.com' });
    const partnershipId = await createBarePartnership(a.userId, b.userId, {
      stackNextPage: 501,
      stackGenerating: true,
    });

    mockTmdbPages({}, 500);

    await appendPartnershipStack(partnershipId);

    const [rows] = await pool.query<
      (RowDataPacket & {
        stack_next_page: number;
        stack_generating: number;
        stack_exhausted: number;
      })[]
    >('SELECT stack_next_page, stack_generating, stack_exhausted FROM partnerships WHERE id = ?', [
      partnershipId,
    ]);
    expect(rows[0].stack_generating).toBe(0);
    expect(rows[0].stack_exhausted).toBe(1);
    expect(rows[0].stack_next_page).toBe(501);
  });

  it('deduplicates movie ids returned across pages within a batch', async () => {
    const a = await createUser(agent, { email: 'ps-dedup-a@example.com' });
    const b = await createUser(agent, { email: 'ps-dedup-b@example.com' });
    const partnershipId = await createBarePartnership(a.userId, b.userId, { stackNextPage: 6 });

    mockTmdbPages({
      6: [500, 501],
      7: [501, 502],
      8: [502],
      9: [503],
      10: [500],
    });

    await appendPartnershipStack(partnershipId);

    const [rows] = await pool.query<(RowDataPacket & { movie_id: number })[]>(
      'SELECT movie_id FROM partnership_stack WHERE partnership_id = ? ORDER BY position ASC',
      [partnershipId],
    );
    const ids = rows.map((r) => r.movie_id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.sort()).toEqual([500, 501, 502, 503]);
  });

  it('releases the stack_generating lock when fetch throws', async () => {
    const a = await createUser(agent, { email: 'ps-err-a@example.com' });
    const b = await createUser(agent, { email: 'ps-err-b@example.com' });
    const partnershipId = await createBarePartnership(a.userId, b.userId, {
      stackNextPage: 6,
      stackGenerating: true,
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      }),
    );

    await appendPartnershipStack(partnershipId);

    const [rows] = await pool.query<
      (RowDataPacket & { stack_generating: number; stack_exhausted: number })[]
    >('SELECT stack_generating, stack_exhausted FROM partnerships WHERE id = ?', [partnershipId]);
    expect(rows[0].stack_generating).toBe(0);
    expect(rows[0].stack_exhausted).toBe(0);
  });
});
