import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import type { RowDataPacket, ResultSetHeader } from 'mysql2';
import type * as RoomStackModule from '../../services/room-stack';
import { pool } from '../../db/connection';
import { createUser } from '../helpers';
import { agent } from '../setup';

// Bypass the global mock from setup.ts for the real implementation under test.
let generateRoomStack!: typeof RoomStackModule.generateRoomStack;
beforeAll(async () => {
  const actual = await vi.importActual<typeof RoomStackModule>('../../services/room-stack');
  generateRoomStack = actual.generateRoomStack;
});

async function createBareRoom(ownerId: number): Promise<number> {
  const code = `G${Math.floor(Math.random() * 1e5)
    .toString()
    .padStart(5, '0')}`;
  const [result] = await pool.query<ResultSetHeader>(
    `INSERT INTO rooms (code, created_by, status, name, filters, last_activity_at, stack_next_page, stack_generating, stack_exhausted)
     VALUES (?, ?, 'active', 'Generate Test', NULL, NOW(), 1, 1, 0)`,
    [code, ownerId],
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

describe('generateRoomStack (real implementation)', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('inserts 5 TMDB pages starting at position 0 and advances stack_next_page to 6', async () => {
    const user = await createUser(agent, { email: 'rs-gen-ok@example.com' });
    const roomId = await createBareRoom(user.userId);

    mockTmdbPages({
      1: [11, 12],
      2: [21],
      3: [31, 32],
      4: [41],
      5: [51],
    });

    await generateRoomStack(roomId, {});

    const [stackRows] = await pool.query<
      (RowDataPacket & { movie_id: number; position: number })[]
    >('SELECT movie_id, position FROM room_stack WHERE room_id = ? ORDER BY position ASC', [
      roomId,
    ]);
    expect(stackRows.map((r) => r.movie_id)).toEqual([11, 12, 21, 31, 32, 41, 51]);
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
    expect(roomRows[0].stack_next_page).toBe(6);
    expect(roomRows[0].stack_generating).toBe(0);
    expect(roomRows[0].stack_exhausted).toBe(0);
  });

  it('wipes pre-existing room_stack rows before inserting the new batch', async () => {
    const user = await createUser(agent, { email: 'rs-gen-wipe@example.com' });
    const roomId = await createBareRoom(user.userId);
    await pool.query(
      'INSERT INTO room_stack (room_id, movie_id, position) VALUES (?, 999, 0), (?, 998, 1)',
      [roomId, roomId],
    );

    mockTmdbPages({ 1: [100, 101] });

    await generateRoomStack(roomId, {});

    const [rows] = await pool.query<(RowDataPacket & { movie_id: number; position: number })[]>(
      'SELECT movie_id, position FROM room_stack WHERE room_id = ? ORDER BY position ASC',
      [roomId],
    );
    expect(rows.map((r) => r.movie_id)).toEqual([100, 101]);
    expect(rows.map((r) => r.position)).toEqual([0, 1]);
  });

  it('sets stack_exhausted=1 when TMDB returns no results', async () => {
    const user = await createUser(agent, { email: 'rs-gen-empty@example.com' });
    const roomId = await createBareRoom(user.userId);

    mockTmdbPages({});

    await generateRoomStack(roomId, {});

    const [stackRows] = await pool.query<(RowDataPacket & { movie_id: number })[]>(
      'SELECT movie_id FROM room_stack WHERE room_id = ?',
      [roomId],
    );
    expect(stackRows).toHaveLength(0);

    const [roomRows] = await pool.query<
      (RowDataPacket & {
        stack_next_page: number;
        stack_generating: number;
        stack_exhausted: number;
      })[]
    >('SELECT stack_next_page, stack_generating, stack_exhausted FROM rooms WHERE id = ?', [
      roomId,
    ]);
    expect(roomRows[0].stack_next_page).toBe(6);
    expect(roomRows[0].stack_generating).toBe(0);
    expect(roomRows[0].stack_exhausted).toBe(1);
  });

  it('propagates errors when fetch throws (caller must reset stack_generating)', async () => {
    const user = await createUser(agent, { email: 'rs-gen-err@example.com' });
    const roomId = await createBareRoom(user.userId);

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      }),
    );

    await expect(generateRoomStack(roomId, {})).rejects.toThrow('network down');

    const [rows] = await pool.query<(RowDataPacket & { movie_id: number })[]>(
      'SELECT movie_id FROM room_stack WHERE room_id = ?',
      [roomId],
    );
    expect(rows).toHaveLength(0);
  });
});
