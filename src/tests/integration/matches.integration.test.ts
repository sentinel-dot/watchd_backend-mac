import { describe, it, expect } from 'vitest';
import { agent } from '../setup';
import { pool } from '../../db/connection';
import { createUser, createPartnership, seedMatch } from '../helpers';
import type { RowDataPacket, ResultSetHeader } from 'mysql2';

// MySQL TIMESTAMP has 1-second precision by default, so back-to-back seedMatch
// calls can collide and make ORDER BY matched_at DESC non-deterministic. These
// helpers insert with an explicit timestamp so pagination/ordering tests are
// stable.
async function seedMatchAt(
  partnershipId: number,
  movieId: number,
  matchedAt: string,
): Promise<number> {
  const [res] = await pool.query<ResultSetHeader>(
    'INSERT INTO matches (partnership_id, movie_id, matched_at) VALUES (?, ?, ?)',
    [partnershipId, movieId, matchedAt],
  );
  return res.insertId;
}

async function seedFavoriteAt(userId: number, movieId: number, createdAt: string): Promise<number> {
  const [res] = await pool.query<ResultSetHeader>(
    'INSERT INTO favorites (user_id, movie_id, created_at) VALUES (?, ?, ?)',
    [userId, movieId, createdAt],
  );
  return res.insertId;
}

describe('GET /api/matches/:partnershipId', () => {
  it('returns paginated matches with watched flag', async () => {
    const alice = await createUser(agent, { email: 'a-matchlist@example.com' });
    const bob = await createUser(agent, { email: 'b-matchlist@example.com' });
    const partnership = await createPartnership(alice.userId, bob.userId, 'active');
    await seedMatch(partnership.id, 10001);
    await seedMatch(partnership.id, 10002);

    const res = await agent
      .get(`/api/matches/${partnership.id}`)
      .set('Authorization', `Bearer ${alice.accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.matches).toHaveLength(2);
    expect(res.body.matches[0].watched).toBe(false);
    expect(res.body.pagination.total).toBe(2);
  });

  it('paginates across two pages without overlap and reports hasMore correctly', async () => {
    const alice = await createUser(agent, { email: 'a-matchpage@example.com' });
    const bob = await createUser(agent, { email: 'b-matchpage@example.com' });
    const partnership = await createPartnership(alice.userId, bob.userId, 'active');
    await seedMatchAt(partnership.id, 11001, '2026-04-01 10:00:00');
    await seedMatchAt(partnership.id, 11002, '2026-04-01 10:00:01');
    await seedMatchAt(partnership.id, 11003, '2026-04-01 10:00:02');

    const page1 = await agent
      .get(`/api/matches/${partnership.id}?limit=2&offset=0`)
      .set('Authorization', `Bearer ${alice.accessToken}`);
    expect(page1.status).toBe(200);
    expect(page1.body.matches.map((m: { movie: { id: number } }) => m.movie.id)).toEqual([
      11003, 11002,
    ]);
    expect(page1.body.pagination).toMatchObject({ total: 3, limit: 2, offset: 0, hasMore: true });

    const page2 = await agent
      .get(`/api/matches/${partnership.id}?limit=2&offset=2`)
      .set('Authorization', `Bearer ${alice.accessToken}`);
    expect(page2.status).toBe(200);
    expect(page2.body.matches.map((m: { movie: { id: number } }) => m.movie.id)).toEqual([11001]);
    expect(page2.body.pagination).toMatchObject({ total: 3, limit: 2, offset: 2, hasMore: false });

    const allIds = [...page1.body.matches, ...page2.body.matches].map(
      (m: { movie: { id: number } }) => m.movie.id,
    );
    expect(new Set(allIds).size).toBe(3);
  });

  it('clamps limit above 50 to 50', async () => {
    const alice = await createUser(agent, { email: 'a-matchclamp@example.com' });
    const bob = await createUser(agent, { email: 'b-matchclamp@example.com' });
    const partnership = await createPartnership(alice.userId, bob.userId, 'active');
    await seedMatch(partnership.id, 12001);

    const res = await agent
      .get(`/api/matches/${partnership.id}?limit=999`)
      .set('Authorization', `Bearer ${alice.accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.pagination.limit).toBe(50);
  });

  it('returns 403 when the user is not a partnership member', async () => {
    const alice = await createUser(agent, { email: 'a-match403@example.com' });
    const bob = await createUser(agent, { email: 'b-match403@example.com' });
    const outsider = await createUser(agent, { email: 'out-match403@example.com' });
    const partnership = await createPartnership(alice.userId, bob.userId, 'active');

    const res = await agent
      .get(`/api/matches/${partnership.id}`)
      .set('Authorization', `Bearer ${outsider.accessToken}`);
    expect(res.status).toBe(403);
  });
});

describe('PATCH /api/matches/:matchId', () => {
  it('toggles watched flag', async () => {
    const alice = await createUser(agent, { email: 'a-watch@example.com' });
    const bob = await createUser(agent, { email: 'b-watch@example.com' });
    const partnership = await createPartnership(alice.userId, bob.userId, 'active');
    const matchId = await seedMatch(partnership.id, 20001);

    const setTrue = await agent
      .patch(`/api/matches/${matchId}`)
      .set('Authorization', `Bearer ${alice.accessToken}`)
      .send({ watched: true });
    expect(setTrue.status).toBe(200);
    expect(setTrue.body.watched).toBe(true);

    const [rows] = await pool.query<(RowDataPacket & { watched: number })[]>(
      'SELECT watched FROM matches WHERE id = ?',
      [matchId],
    );
    expect(rows[0].watched).toBe(1);

    const setFalse = await agent
      .patch(`/api/matches/${matchId}`)
      .set('Authorization', `Bearer ${alice.accessToken}`)
      .send({ watched: false });
    expect(setFalse.status).toBe(200);
    expect(setFalse.body.watched).toBe(false);
  });
});

describe('POST /api/matches/favorites', () => {
  it('adds a movie to favorites', async () => {
    const user = await createUser(agent);
    const res = await agent
      .post('/api/matches/favorites')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({ movieId: 30001 });
    expect(res.status).toBe(201);

    const [rows] = await pool.query<RowDataPacket[]>(
      'SELECT movie_id FROM favorites WHERE user_id = ?',
      [user.userId],
    );
    expect(rows).toHaveLength(1);
  });

  it('treats duplicate favorites as success (ON DUPLICATE KEY)', async () => {
    const user = await createUser(agent);
    const first = await agent
      .post('/api/matches/favorites')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({ movieId: 30002 });
    expect(first.status).toBe(201);

    const second = await agent
      .post('/api/matches/favorites')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({ movieId: 30002 });
    expect(second.status).toBe(201);

    const [rows] = await pool.query<RowDataPacket[]>(
      'SELECT id FROM favorites WHERE user_id = ? AND movie_id = ?',
      [user.userId, 30002],
    );
    expect(rows).toHaveLength(1);
  });
});

describe('DELETE /api/matches/favorites/:movieId', () => {
  it('removes a favorite', async () => {
    const user = await createUser(agent);
    await agent
      .post('/api/matches/favorites')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({ movieId: 40001 });

    const res = await agent
      .delete('/api/matches/favorites/40001')
      .set('Authorization', `Bearer ${user.accessToken}`);
    expect(res.status).toBe(200);

    const [rows] = await pool.query<RowDataPacket[]>(
      'SELECT id FROM favorites WHERE user_id = ? AND movie_id = ?',
      [user.userId, 40001],
    );
    expect(rows).toHaveLength(0);
  });
});

describe('GET /api/matches/favorites/list', () => {
  it('returns paginated favorites', async () => {
    const user = await createUser(agent);
    for (const id of [50001, 50002, 50003]) {
      await agent
        .post('/api/matches/favorites')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send({ movieId: id });
    }

    const res = await agent
      .get('/api/matches/favorites/list')
      .set('Authorization', `Bearer ${user.accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.favorites).toHaveLength(3);
    expect(res.body.pagination.total).toBe(3);
  });

  it('paginates favorites across two pages ordered by created_at DESC without overlap', async () => {
    const user = await createUser(agent, { email: 'fav-page@example.com' });
    await seedFavoriteAt(user.userId, 60001, '2026-04-01 10:00:00');
    await seedFavoriteAt(user.userId, 60002, '2026-04-01 10:00:01');
    await seedFavoriteAt(user.userId, 60003, '2026-04-01 10:00:02');

    const page1 = await agent
      .get('/api/matches/favorites/list?limit=2&offset=0')
      .set('Authorization', `Bearer ${user.accessToken}`);
    expect(page1.status).toBe(200);
    expect(page1.body.favorites.map((f: { movie: { id: number } }) => f.movie.id)).toEqual([
      60003, 60002,
    ]);
    expect(page1.body.pagination).toMatchObject({ total: 3, limit: 2, offset: 0, hasMore: true });

    const page2 = await agent
      .get('/api/matches/favorites/list?limit=2&offset=2')
      .set('Authorization', `Bearer ${user.accessToken}`);
    expect(page2.status).toBe(200);
    expect(page2.body.favorites.map((f: { movie: { id: number } }) => f.movie.id)).toEqual([60001]);
    expect(page2.body.pagination).toMatchObject({ total: 3, limit: 2, offset: 2, hasMore: false });
  });
});
