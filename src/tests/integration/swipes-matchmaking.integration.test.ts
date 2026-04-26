import { describe, it, expect } from 'vitest';
import { agent } from '../setup';
import { pool } from '../../db/connection';
import { createUser, createPartnership, seedStackMovie, seedSwipe } from '../helpers';
import type { RowDataPacket } from 'mysql2';
// @ts-expect-error - test-only export from setup mock
import { __io } from '../../socket';

describe('POST /api/swipes', () => {
  it('records a left-swipe without creating a match', async () => {
    const a = await createUser(agent);
    const b = await createUser(agent);
    const partnership = await createPartnership(a.userId, b.userId, 'active');
    await seedStackMovie(partnership.id, 100, 1);

    const res = await agent
      .post('/api/swipes')
      .set('Authorization', `Bearer ${a.accessToken}`)
      .send({ movieId: 100, partnershipId: partnership.id, direction: 'left' });

    expect(res.status).toBe(201);
    expect(res.body.match).toBeNull();

    const [rows] = await pool.query<RowDataPacket[]>(
      'SELECT direction FROM swipes WHERE user_id = ? AND movie_id = ? AND partnership_id = ?',
      [a.userId, 100, partnership.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].direction).toBe('left');
  });

  it('does not create a match with only one member (pending partnership)', async () => {
    const a = await createUser(agent);
    const b = await createUser(agent);
    // Pending partnership has only the requester as member
    const partnership = await createPartnership(a.userId, b.userId, 'pending');
    await seedStackMovie(partnership.id, 200, 1);

    const res = await agent
      .post('/api/swipes')
      .set('Authorization', `Bearer ${a.accessToken}`)
      .send({ movieId: 200, partnershipId: partnership.id, direction: 'right' });

    expect(res.status).toBe(201);
    expect(res.body.match).toBeNull();
  });

  it('creates a match when both members swipe right and emits a socket event', async () => {
    const alice = await createUser(agent, { email: 'alice-match@example.com' });
    const bob = await createUser(agent, { email: 'bob-match@example.com' });
    const partnership = await createPartnership(alice.userId, bob.userId, 'active');
    await seedStackMovie(partnership.id, 300, 1);

    const aliceSwipe = await agent
      .post('/api/swipes')
      .set('Authorization', `Bearer ${alice.accessToken}`)
      .send({ movieId: 300, partnershipId: partnership.id, direction: 'right' });
    expect(aliceSwipe.status).toBe(201);
    expect(aliceSwipe.body.match).toBeNull();

    const bobSwipe = await agent
      .post('/api/swipes')
      .set('Authorization', `Bearer ${bob.accessToken}`)
      .send({ movieId: 300, partnershipId: partnership.id, direction: 'right' });
    expect(bobSwipe.status).toBe(201);
    expect(bobSwipe.body.match).toMatchObject({ isMatch: true, movieId: 300 });
    expect(bobSwipe.body.match.matchId).toBeTypeOf('number');

    expect(__io.to).toHaveBeenCalledWith(`partnership:${partnership.id}`);
    expect(__io.to(`partnership:${partnership.id}`).emit).toHaveBeenCalledWith(
      'match',
      expect.objectContaining({ movieId: 300 }),
    );

    const [matchRows] = await pool.query<RowDataPacket[]>(
      'SELECT id FROM matches WHERE partnership_id = ? AND movie_id = ?',
      [partnership.id, 300],
    );
    expect(matchRows).toHaveLength(1);
  });

  it('is idempotent: duplicate right-swipe after match does not create a second match', async () => {
    const alice = await createUser(agent, { email: 'a-idem@example.com' });
    const bob = await createUser(agent, { email: 'b-idem@example.com' });
    const partnership = await createPartnership(alice.userId, bob.userId, 'active');
    await seedStackMovie(partnership.id, 400, 1);

    await seedSwipe(alice.userId, 400, partnership.id, 'right');

    await agent
      .post('/api/swipes')
      .set('Authorization', `Bearer ${bob.accessToken}`)
      .send({ movieId: 400, partnershipId: partnership.id, direction: 'right' });

    await agent
      .post('/api/swipes')
      .set('Authorization', `Bearer ${bob.accessToken}`)
      .send({ movieId: 400, partnershipId: partnership.id, direction: 'right' });

    const [rows] = await pool.query<RowDataPacket[]>(
      'SELECT id FROM matches WHERE partnership_id = ? AND movie_id = ?',
      [partnership.id, 400],
    );
    expect(rows).toHaveLength(1);
  });

  it('returns 403 when user is not a member of the partnership', async () => {
    const a = await createUser(agent, { email: 'owner@example.com' });
    const b = await createUser(agent, { email: 'partner@example.com' });
    const outsider = await createUser(agent, { email: 'outside@example.com' });
    const partnership = await createPartnership(a.userId, b.userId, 'active');
    await seedStackMovie(partnership.id, 500, 1);

    const res = await agent
      .post('/api/swipes')
      .set('Authorization', `Bearer ${outsider.accessToken}`)
      .send({ movieId: 500, partnershipId: partnership.id, direction: 'right' });

    expect(res.status).toBe(403);
  });
});
