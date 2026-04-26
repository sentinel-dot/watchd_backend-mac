import { describe, it, expect, vi } from 'vitest';
import type { RowDataPacket } from 'mysql2';
import { pool } from '../../db/connection';
import { appendPartnershipStack } from '../../services/partnership-stack';
import { agent } from '../setup';
import { createUser, createPartnership, seedStackMovie, seedSwipe } from '../helpers';

interface PartnershipStateRow extends RowDataPacket {
  stack_generating: number;
  stack_exhausted: number;
}

interface PartnershipLockRow extends RowDataPacket {
  stack_generating: number;
}

describe('GET /api/movies/feed', () => {
  it('returns the first page of unseen movies with correct lastPosition', async () => {
    const a = await createUser(agent);
    const b = await createUser(agent);
    const partnership = await createPartnership(a.userId, b.userId, 'active');
    for (let i = 1; i <= 25; i++) {
      await seedStackMovie(partnership.id, 1000 + i, i);
    }

    const res = await agent
      .get(`/api/movies/feed?partnershipId=${partnership.id}&afterPosition=0`)
      .set('Authorization', `Bearer ${a.accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.movies).toHaveLength(20);
    expect(res.body.lastPosition).toBe(20);
    expect(res.body.movies[0].id).toBe(1001);
  });

  it('paginates using afterPosition with no overlap', async () => {
    const a = await createUser(agent);
    const b = await createUser(agent);
    const partnership = await createPartnership(a.userId, b.userId, 'active');
    for (let i = 1; i <= 25; i++) {
      await seedStackMovie(partnership.id, 2000 + i, i);
    }

    const res = await agent
      .get(`/api/movies/feed?partnershipId=${partnership.id}&afterPosition=20`)
      .set('Authorization', `Bearer ${a.accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.movies).toHaveLength(5);
    expect(res.body.movies[0].id).toBe(2021);
  });

  it('excludes movies the user has already swiped', async () => {
    const a = await createUser(agent);
    const b = await createUser(agent);
    const partnership = await createPartnership(a.userId, b.userId, 'active');
    await seedStackMovie(partnership.id, 3001, 1);
    await seedStackMovie(partnership.id, 3002, 2);
    await seedStackMovie(partnership.id, 3003, 3);
    await seedSwipe(a.userId, 3002, partnership.id, 'left');

    const res = await agent
      .get(`/api/movies/feed?partnershipId=${partnership.id}&afterPosition=0`)
      .set('Authorization', `Bearer ${a.accessToken}`);
    expect(res.status).toBe(200);
    const ids = res.body.movies.map((m: { id: number }) => m.id);
    expect(ids).toEqual([3001, 3003]);
  });

  it('returns an empty list when the stack is empty', async () => {
    const a = await createUser(agent);
    const b = await createUser(agent);
    const partnership = await createPartnership(a.userId, b.userId, 'active');
    const res = await agent
      .get(`/api/movies/feed?partnershipId=${partnership.id}&afterPosition=0`)
      .set('Authorization', `Bearer ${a.accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.movies).toEqual([]);
  });

  it('triggers a background refill when 10 unseen movies remain', async () => {
    const a = await createUser(agent);
    const b = await createUser(agent);
    const partnership = await createPartnership(a.userId, b.userId, 'active');
    const appendMock = vi.mocked(appendPartnershipStack);

    for (let i = 1; i <= 10; i++) {
      await seedStackMovie(partnership.id, 5000 + i, i);
    }

    const res = await agent
      .get(`/api/movies/feed?partnershipId=${partnership.id}&afterPosition=0`)
      .set('Authorization', `Bearer ${a.accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.movies).toHaveLength(10);

    await vi.waitFor(() => {
      expect(appendMock).toHaveBeenCalledTimes(1);
      expect(appendMock).toHaveBeenCalledWith(partnership.id);
    });

    const [rows] = await pool.query<PartnershipStateRow[]>(
      'SELECT stack_generating, stack_exhausted FROM partnerships WHERE id = ?',
      [partnership.id],
    );
    expect(rows[0]?.stack_generating).toBe(1);
    expect(rows[0]?.stack_exhausted).toBe(0);
  });

  it('does not trigger refill when stack_exhausted is already set', async () => {
    const a = await createUser(agent);
    const b = await createUser(agent);
    const partnership = await createPartnership(a.userId, b.userId, 'active');
    const appendMock = vi.mocked(appendPartnershipStack);

    for (let i = 1; i <= 10; i++) {
      await seedStackMovie(partnership.id, 6000 + i, i);
    }
    await pool.query('UPDATE partnerships SET stack_exhausted = 1 WHERE id = ?', [partnership.id]);

    const res = await agent
      .get(`/api/movies/feed?partnershipId=${partnership.id}&afterPosition=0`)
      .set('Authorization', `Bearer ${a.accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.movies).toHaveLength(10);
    expect(appendMock).not.toHaveBeenCalled();

    const [rows] = await pool.query<PartnershipStateRow[]>(
      'SELECT stack_generating, stack_exhausted FROM partnerships WHERE id = ?',
      [partnership.id],
    );
    expect(rows[0]?.stack_generating).toBe(0);
    expect(rows[0]?.stack_exhausted).toBe(1);
  });

  it('acquires the refill lock atomically across parallel requests', async () => {
    const a = await createUser(agent);
    const b = await createUser(agent);
    const partnership = await createPartnership(a.userId, b.userId, 'active');
    const appendMock = vi.mocked(appendPartnershipStack);

    for (let i = 1; i <= 10; i++) {
      await seedStackMovie(partnership.id, 7000 + i, i);
    }

    const [firstRes, secondRes] = await Promise.all([
      agent
        .get(`/api/movies/feed?partnershipId=${partnership.id}&afterPosition=0`)
        .set('Authorization', `Bearer ${a.accessToken}`),
      agent
        .get(`/api/movies/feed?partnershipId=${partnership.id}&afterPosition=0`)
        .set('Authorization', `Bearer ${a.accessToken}`),
    ]);

    expect(firstRes.status).toBe(200);
    expect(secondRes.status).toBe(200);

    await vi.waitFor(() => {
      expect(appendMock).toHaveBeenCalledTimes(1);
      expect(appendMock).toHaveBeenCalledWith(partnership.id);
    });

    const [rows] = await pool.query<PartnershipLockRow[]>(
      'SELECT stack_generating FROM partnerships WHERE id = ?',
      [partnership.id],
    );
    expect(rows[0]?.stack_generating).toBe(1);
  });

  it('returns 403 when the user is not a partnership member', async () => {
    const a = await createUser(agent);
    const b = await createUser(agent);
    const outsider = await createUser(agent);
    const partnership = await createPartnership(a.userId, b.userId, 'active');

    const res = await agent
      .get(`/api/movies/feed?partnershipId=${partnership.id}&afterPosition=0`)
      .set('Authorization', `Bearer ${outsider.accessToken}`);
    expect(res.status).toBe(403);
  });
});

describe('GET /api/movies/partnerships/:partnershipId/next-movie', () => {
  it('returns the next unseen movie', async () => {
    const a = await createUser(agent);
    const b = await createUser(agent);
    const partnership = await createPartnership(a.userId, b.userId, 'active');
    await seedStackMovie(partnership.id, 4001, 1);
    await seedStackMovie(partnership.id, 4002, 2);

    const res = await agent
      .get(`/api/movies/partnerships/${partnership.id}/next-movie`)
      .set('Authorization', `Bearer ${a.accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.movie.id).toBe(4001);
    expect(res.body.stackEmpty).toBe(false);
  });

  it('returns stackEmpty=true when no unseen movies remain', async () => {
    const a = await createUser(agent);
    const b = await createUser(agent);
    const partnership = await createPartnership(a.userId, b.userId, 'active');
    const res = await agent
      .get(`/api/movies/partnerships/${partnership.id}/next-movie`)
      .set('Authorization', `Bearer ${a.accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.movie).toBeNull();
    expect(res.body.stackEmpty).toBe(true);
  });
});
