import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import type { RowDataPacket, ResultSetHeader } from 'mysql2';
import type * as RoomStackModule from '../../services/room-stack';
import { pool } from '../../db/connection';
import { createUser } from '../helpers';
import { agent } from '../setup';

// Bypass the global mock from setup.ts for the real implementation under test.
let appendRoomStack!: typeof RoomStackModule.appendRoomStack;
beforeAll(async () => {
  const actual = await vi.importActual<typeof RoomStackModule>('../../services/room-stack');
  appendRoomStack = actual.appendRoomStack;
});

async function createBareRoom(
  ownerId: number,
  opts: { stackNextPage?: number; filters?: object | null; stackGenerating?: boolean } = {},
): Promise<number> {
  const code = `T${Math.floor(Math.random() * 1e5)
    .toString()
    .padStart(5, '0')}`;
  const filtersJson = opts.filters === undefined ? null : JSON.stringify(opts.filters);
  const [result] = await pool.query<ResultSetHeader>(
    `INSERT INTO rooms (code, created_by, status, name, filters, last_activity_at, stack_next_page, stack_generating, stack_exhausted)
     VALUES (?, ?, 'active', 'Append Test', ?, NOW(), ?, ?, 0)`,
    [code, ownerId, filtersJson, opts.stackNextPage ?? 6, opts.stackGenerating ? 1 : 0],
  );
  return result.insertId;
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

describe('appendRoomStack (real implementation)', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('appends 5 pages of movies, advances stack_next_page, clears the lock', async () => {
    const user = await createUser(agent, { email: 'rs-append@example.com' });
    const roomId = await createBareRoom(user.userId, { stackNextPage: 6, stackGenerating: true });

    mockTmdbPages({
      6: [601, 602],
      7: [701],
      8: [801, 802],
      9: [901],
      10: [1001],
    });

    await appendRoomStack(roomId);

    const [stackRows] = await pool.query<
      (RowDataPacket & { movie_id: number; position: number })[]
    >('SELECT movie_id, position FROM room_stack WHERE room_id = ? ORDER BY position ASC', [
      roomId,
    ]);
    expect(stackRows.map((r) => r.movie_id)).toEqual([601, 602, 701, 801, 802, 901, 1001]);
    expect(stackRows[0].position).toBe(0);

    const [roomRows] = await pool.query<
      (RowDataPacket & {
        stack_next_page: number;
        stack_generating: number;
        stack_exhausted: number;
      })[]
    >('SELECT stack_next_page, stack_generating, stack_exhausted FROM rooms WHERE id = ?', [
      roomId,
    ]);
    expect(roomRows[0].stack_next_page).toBe(11);
    expect(roomRows[0].stack_generating).toBe(0);
    expect(roomRows[0].stack_exhausted).toBe(0);
  });

  it('starts new positions after MAX(position) of the existing stack', async () => {
    const user = await createUser(agent, { email: 'rs-positions@example.com' });
    const roomId = await createBareRoom(user.userId, { stackNextPage: 11 });
    await pool.query(
      'INSERT INTO room_stack (room_id, movie_id, position) VALUES (?, 1, 0), (?, 2, 1), (?, 3, 2)',
      [roomId, roomId, roomId],
    );

    mockTmdbPages({ 11: [111], 12: [222] });

    await appendRoomStack(roomId);

    const [rows] = await pool.query<(RowDataPacket & { movie_id: number; position: number })[]>(
      'SELECT movie_id, position FROM room_stack WHERE room_id = ? ORDER BY position ASC',
      [roomId],
    );
    expect(rows.map((r) => r.position)).toEqual([0, 1, 2, 3, 4]);
    expect(rows.slice(3).map((r) => r.movie_id)).toEqual([111, 222]);

    const [roomRows] = await pool.query<(RowDataPacket & { stack_next_page: number })[]>(
      'SELECT stack_next_page FROM rooms WHERE id = ?',
      [roomId],
    );
    expect(roomRows[0].stack_next_page).toBe(16);
  });

  it('sets stack_exhausted=1 when TMDB returns no more results', async () => {
    const user = await createUser(agent, { email: 'rs-exhausted@example.com' });
    const roomId = await createBareRoom(user.userId, { stackNextPage: 501, stackGenerating: true });

    mockTmdbPages({}, 500);

    await appendRoomStack(roomId);

    const [roomRows] = await pool.query<
      (RowDataPacket & {
        stack_next_page: number;
        stack_generating: number;
        stack_exhausted: number;
      })[]
    >('SELECT stack_next_page, stack_generating, stack_exhausted FROM rooms WHERE id = ?', [
      roomId,
    ]);
    expect(roomRows[0].stack_generating).toBe(0);
    expect(roomRows[0].stack_exhausted).toBe(1);
    expect(roomRows[0].stack_next_page).toBe(501);
  });

  it('deduplicates movie ids returned across pages within a batch', async () => {
    const user = await createUser(agent, { email: 'rs-dedup@example.com' });
    const roomId = await createBareRoom(user.userId, { stackNextPage: 6 });

    mockTmdbPages({
      6: [500, 501],
      7: [501, 502],
      8: [502],
      9: [503],
      10: [500],
    });

    await appendRoomStack(roomId);

    const [rows] = await pool.query<(RowDataPacket & { movie_id: number })[]>(
      'SELECT movie_id FROM room_stack WHERE room_id = ? ORDER BY position ASC',
      [roomId],
    );
    const ids = rows.map((r) => r.movie_id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.sort()).toEqual([500, 501, 502, 503]);
  });

  it('releases the stack_generating lock when fetch throws', async () => {
    const user = await createUser(agent, { email: 'rs-err@example.com' });
    const roomId = await createBareRoom(user.userId, { stackNextPage: 6, stackGenerating: true });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      }),
    );

    await appendRoomStack(roomId);

    const [roomRows] = await pool.query<
      (RowDataPacket & { stack_generating: number; stack_exhausted: number })[]
    >('SELECT stack_generating, stack_exhausted FROM rooms WHERE id = ?', [roomId]);
    expect(roomRows[0].stack_generating).toBe(0);
    expect(roomRows[0].stack_exhausted).toBe(0);
  });
});
