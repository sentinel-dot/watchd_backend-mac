import { describe, it, expect, vi } from 'vitest';
import { agent } from '../setup';
import { pool } from '../../db/connection';
import { createUser, createRoom, joinRoom, seedStackMovie, seedSwipe } from '../helpers';
import type { RowDataPacket } from 'mysql2';
// @ts-expect-error - test-only export from setup mock
import { __io } from '../../socket';

describe('POST /api/swipes', () => {
  it('records a left-swipe without creating a match', async () => {
    const user = await createUser(agent);
    const room = await createRoom(agent, user.accessToken);
    await seedStackMovie(room.id, 100, 1);

    const res = await agent
      .post('/api/swipes')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({ movieId: 100, roomId: room.id, direction: 'left' });

    expect(res.status).toBe(201);
    expect(res.body.match).toBeNull();

    const [rows] = await pool.query<RowDataPacket[]>(
      'SELECT direction FROM swipes WHERE user_id = ? AND movie_id = ? AND room_id = ?',
      [user.userId, 100, room.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].direction).toBe('left');
  });

  it('does not create a match with only one member in the room', async () => {
    const user = await createUser(agent);
    const room = await createRoom(agent, user.accessToken);
    await seedStackMovie(room.id, 200, 1);

    const res = await agent
      .post('/api/swipes')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({ movieId: 200, roomId: room.id, direction: 'right' });

    expect(res.status).toBe(201);
    expect(res.body.match).toBeNull();
  });

  it('creates a match when both members swipe right and emits a socket event', async () => {
    const alice = await createUser(agent, { email: 'alice-match@example.com' });
    const bob = await createUser(agent, { email: 'bob-match@example.com' });
    const room = await createRoom(agent, alice.accessToken);
    await joinRoom(agent, bob.accessToken, room.code);
    await seedStackMovie(room.id, 300, 1);

    // Alice swipes right first — no match yet (Bob hasn't swiped)
    const aliceSwipe = await agent
      .post('/api/swipes')
      .set('Authorization', `Bearer ${alice.accessToken}`)
      .send({ movieId: 300, roomId: room.id, direction: 'right' });
    expect(aliceSwipe.status).toBe(201);
    expect(aliceSwipe.body.match).toBeNull();

    // Bob swipes right → match
    const bobSwipe = await agent
      .post('/api/swipes')
      .set('Authorization', `Bearer ${bob.accessToken}`)
      .send({ movieId: 300, roomId: room.id, direction: 'right' });
    expect(bobSwipe.status).toBe(201);
    expect(bobSwipe.body.match).toMatchObject({ isMatch: true, movieId: 300 });
    expect(bobSwipe.body.match.matchId).toBeTypeOf('number');

    // Socket event emitted
    expect(__io.to).toHaveBeenCalledWith(`room:${room.id}`);
    expect(__io.to(`room:${room.id}`).emit).toHaveBeenCalledWith(
      'match',
      expect.objectContaining({ movieId: 300 }),
    );

    // Exactly one row in matches
    const [matchRows] = await pool.query<RowDataPacket[]>(
      'SELECT id FROM matches WHERE room_id = ? AND movie_id = ?',
      [room.id, 300],
    );
    expect(matchRows).toHaveLength(1);
  });

  it('is idempotent: duplicate right-swipe after match does not create a second match', async () => {
    const alice = await createUser(agent, { email: 'a-idem@example.com' });
    const bob = await createUser(agent, { email: 'b-idem@example.com' });
    const room = await createRoom(agent, alice.accessToken);
    await joinRoom(agent, bob.accessToken, room.code);
    await seedStackMovie(room.id, 400, 1);

    await seedSwipe(alice.userId, 400, room.id, 'right');

    // Bob's first right-swipe → match
    await agent
      .post('/api/swipes')
      .set('Authorization', `Bearer ${bob.accessToken}`)
      .send({ movieId: 400, roomId: room.id, direction: 'right' });

    // Bob re-posts the same right-swipe (client retry / double-tap)
    await agent
      .post('/api/swipes')
      .set('Authorization', `Bearer ${bob.accessToken}`)
      .send({ movieId: 400, roomId: room.id, direction: 'right' });

    const [rows] = await pool.query<RowDataPacket[]>(
      'SELECT id FROM matches WHERE room_id = ? AND movie_id = ?',
      [room.id, 400],
    );
    expect(rows).toHaveLength(1);
  });

  it('returns 403 when user is not a member of the room', async () => {
    const owner = await createUser(agent, { email: 'owner@example.com' });
    const outsider = await createUser(agent, { email: 'outside@example.com' });
    const room = await createRoom(agent, owner.accessToken);
    await seedStackMovie(room.id, 500, 1);

    const res = await agent
      .post('/api/swipes')
      .set('Authorization', `Bearer ${outsider.accessToken}`)
      .send({ movieId: 500, roomId: room.id, direction: 'right' });

    expect(res.status).toBe(403);
  });
});
