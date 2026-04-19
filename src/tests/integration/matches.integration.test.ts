import { describe, it, expect } from 'vitest';
import { agent } from '../setup';
import { pool } from '../../db/connection';
import { createUser, createRoom, joinRoom, seedMatch } from '../helpers';
import type { RowDataPacket } from 'mysql2';

describe('GET /api/matches/:roomId', () => {
  it('returns paginated matches with watched flag', async () => {
    const alice = await createUser(agent, { email: 'a-matchlist@example.com' });
    const bob = await createUser(agent, { email: 'b-matchlist@example.com' });
    const room = await createRoom(agent, alice.accessToken);
    await joinRoom(agent, bob.accessToken, room.code);
    await seedMatch(room.id, 10001);
    await seedMatch(room.id, 10002);

    const res = await agent
      .get(`/api/matches/${room.id}`)
      .set('Authorization', `Bearer ${alice.accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.matches).toHaveLength(2);
    expect(res.body.matches[0].watched).toBe(false);
    expect(res.body.pagination.total).toBe(2);
  });
});

describe('PATCH /api/matches/:matchId', () => {
  it('toggles watched flag', async () => {
    const alice = await createUser(agent, { email: 'a-watch@example.com' });
    const bob = await createUser(agent, { email: 'b-watch@example.com' });
    const room = await createRoom(agent, alice.accessToken);
    await joinRoom(agent, bob.accessToken, room.code);
    const matchId = await seedMatch(room.id, 20001);

    const setTrue = await agent
      .patch(`/api/matches/${matchId}`)
      .set('Authorization', `Bearer ${alice.accessToken}`)
      .send({ watched: true });
    expect(setTrue.status).toBe(200);
    expect(setTrue.body.watched).toBe(true);

    const [rows] = await pool.query<(RowDataPacket & { watched: number })[]>(
      'SELECT watched FROM matches WHERE id = ?', [matchId],
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
      'SELECT movie_id FROM favorites WHERE user_id = ?', [user.userId],
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
});
