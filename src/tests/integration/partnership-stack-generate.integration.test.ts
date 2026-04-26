import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import type { RowDataPacket, ResultSetHeader } from 'mysql2';
import type * as PartnershipStackModule from '../../services/partnership-stack';
import { pool } from '../../db/connection';
import { createUser } from '../helpers';
import { agent } from '../setup';

// Bypass the global mock from setup.ts for the real implementation under test.
let generatePartnershipStack!: typeof PartnershipStackModule.generatePartnershipStack;
beforeAll(async () => {
  const actual = await vi.importActual<typeof PartnershipStackModule>(
    '../../services/partnership-stack',
  );
  generatePartnershipStack = actual.generatePartnershipStack;
});

async function createBarePartnership(requesterId: number, addresseeId: number): Promise<number> {
  const [result] = await pool.query<ResultSetHeader>(
    `INSERT INTO partnerships (requester_id, addressee_id, status, filters, stack_next_page, stack_generating, stack_exhausted, accepted_at)
     VALUES (?, ?, 'active', NULL, 1, 1, 0, NOW())`,
    [requesterId, addresseeId],
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

describe('generatePartnershipStack (real implementation)', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('inserts 5 TMDB pages starting at position 0 and advances stack_next_page to 6', async () => {
    const a = await createUser(agent, { email: 'ps-gen-ok-a@example.com' });
    const b = await createUser(agent, { email: 'ps-gen-ok-b@example.com' });
    const partnershipId = await createBarePartnership(a.userId, b.userId);

    mockTmdbPages({
      1: [11, 12],
      2: [21],
      3: [31, 32],
      4: [41],
      5: [51],
    });

    await generatePartnershipStack(partnershipId, {});

    const [stackRows] = await pool.query<
      (RowDataPacket & { movie_id: number; position: number })[]
    >(
      'SELECT movie_id, position FROM partnership_stack WHERE partnership_id = ? ORDER BY position ASC',
      [partnershipId],
    );
    expect(stackRows.map((r) => r.movie_id)).toEqual([11, 12, 21, 31, 32, 41, 51]);
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
    expect(rows[0].stack_next_page).toBe(6);
    expect(rows[0].stack_generating).toBe(0);
    expect(rows[0].stack_exhausted).toBe(0);
  });

  it('wipes pre-existing partnership_stack rows before inserting the new batch', async () => {
    const a = await createUser(agent, { email: 'ps-gen-wipe-a@example.com' });
    const b = await createUser(agent, { email: 'ps-gen-wipe-b@example.com' });
    const partnershipId = await createBarePartnership(a.userId, b.userId);
    await pool.query(
      'INSERT INTO partnership_stack (partnership_id, movie_id, position) VALUES (?, 999, 0), (?, 998, 1)',
      [partnershipId, partnershipId],
    );

    mockTmdbPages({ 1: [100, 101] });

    await generatePartnershipStack(partnershipId, {});

    const [rows] = await pool.query<(RowDataPacket & { movie_id: number; position: number })[]>(
      'SELECT movie_id, position FROM partnership_stack WHERE partnership_id = ? ORDER BY position ASC',
      [partnershipId],
    );
    expect(rows.map((r) => r.movie_id)).toEqual([100, 101]);
    expect(rows.map((r) => r.position)).toEqual([0, 1]);
  });

  it('sets stack_exhausted=1 when TMDB returns no results', async () => {
    const a = await createUser(agent, { email: 'ps-gen-empty-a@example.com' });
    const b = await createUser(agent, { email: 'ps-gen-empty-b@example.com' });
    const partnershipId = await createBarePartnership(a.userId, b.userId);

    mockTmdbPages({});

    await generatePartnershipStack(partnershipId, {});

    const [stackRows] = await pool.query<(RowDataPacket & { movie_id: number })[]>(
      'SELECT movie_id FROM partnership_stack WHERE partnership_id = ?',
      [partnershipId],
    );
    expect(stackRows).toHaveLength(0);

    const [rows] = await pool.query<
      (RowDataPacket & {
        stack_next_page: number;
        stack_generating: number;
        stack_exhausted: number;
      })[]
    >('SELECT stack_next_page, stack_generating, stack_exhausted FROM partnerships WHERE id = ?', [
      partnershipId,
    ]);
    expect(rows[0].stack_next_page).toBe(6);
    expect(rows[0].stack_generating).toBe(0);
    expect(rows[0].stack_exhausted).toBe(1);
  });

  it('propagates errors when fetch throws (caller must reset stack_generating)', async () => {
    const a = await createUser(agent, { email: 'ps-gen-err-a@example.com' });
    const b = await createUser(agent, { email: 'ps-gen-err-b@example.com' });
    const partnershipId = await createBarePartnership(a.userId, b.userId);

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      }),
    );

    await expect(generatePartnershipStack(partnershipId, {})).rejects.toThrow('network down');

    const [rows] = await pool.query<(RowDataPacket & { movie_id: number })[]>(
      'SELECT movie_id FROM partnership_stack WHERE partnership_id = ?',
      [partnershipId],
    );
    expect(rows).toHaveLength(0);
  });
});
