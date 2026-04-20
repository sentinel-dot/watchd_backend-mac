import { describe, it, expect, vi } from 'vitest';
import type { RowDataPacket } from 'mysql2';
import { pool } from '../../db/connection';
import { appendRoomStack } from '../../services/room-stack';
import { agent } from '../setup';
import { createUser, createRoom, seedStackMovie, seedSwipe } from '../helpers';

interface RoomStateRow extends RowDataPacket {
  stack_generating: number;
  stack_exhausted: number;
}

interface RoomLockRow extends RowDataPacket {
  stack_generating: number;
}

describe('GET /api/movies/feed', () => {
  it('returns the first page of unseen movies with correct lastPosition', async () => {
    const user = await createUser(agent);
    const room = await createRoom(agent, user.accessToken);
    for (let i = 1; i <= 25; i++) {
      await seedStackMovie(room.id, 1000 + i, i);
    }

    const res = await agent
      .get(`/api/movies/feed?roomId=${room.id}&afterPosition=0`)
      .set('Authorization', `Bearer ${user.accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.movies).toHaveLength(20);
    expect(res.body.lastPosition).toBe(20);
    expect(res.body.movies[0].id).toBe(1001);
  });

  it('paginates using afterPosition with no overlap', async () => {
    const user = await createUser(agent);
    const room = await createRoom(agent, user.accessToken);
    for (let i = 1; i <= 25; i++) {
      await seedStackMovie(room.id, 2000 + i, i);
    }

    const res = await agent
      .get(`/api/movies/feed?roomId=${room.id}&afterPosition=20`)
      .set('Authorization', `Bearer ${user.accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.movies).toHaveLength(5);
    expect(res.body.movies[0].id).toBe(2021);
  });

  it('excludes movies the user has already swiped', async () => {
    const user = await createUser(agent);
    const room = await createRoom(agent, user.accessToken);
    await seedStackMovie(room.id, 3001, 1);
    await seedStackMovie(room.id, 3002, 2);
    await seedStackMovie(room.id, 3003, 3);
    await seedSwipe(user.userId, 3002, room.id, 'left');

    const res = await agent
      .get(`/api/movies/feed?roomId=${room.id}&afterPosition=0`)
      .set('Authorization', `Bearer ${user.accessToken}`);
    expect(res.status).toBe(200);
    const ids = res.body.movies.map((m: { id: number }) => m.id);
    expect(ids).toEqual([3001, 3003]);
  });

  it('returns an empty list when the stack is empty', async () => {
    const user = await createUser(agent);
    const room = await createRoom(agent, user.accessToken);
    const res = await agent
      .get(`/api/movies/feed?roomId=${room.id}&afterPosition=0`)
      .set('Authorization', `Bearer ${user.accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.movies).toEqual([]);
  });

  it('triggers a background refill when 10 unseen movies remain', async () => {
    const user = await createUser(agent);
    const room = await createRoom(agent, user.accessToken);
    const appendRoomStackMock = vi.mocked(appendRoomStack);

    for (let i = 1; i <= 10; i++) {
      await seedStackMovie(room.id, 5000 + i, i);
    }

    const res = await agent
      .get(`/api/movies/feed?roomId=${room.id}&afterPosition=0`)
      .set('Authorization', `Bearer ${user.accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.movies).toHaveLength(10);

    await vi.waitFor(() => {
      expect(appendRoomStackMock).toHaveBeenCalledTimes(1);
      expect(appendRoomStackMock).toHaveBeenCalledWith(room.id);
    });

    const [roomRows] = await pool.query<RoomStateRow[]>(
      'SELECT stack_generating, stack_exhausted FROM rooms WHERE id = ?',
      [room.id],
    );
    expect(roomRows[0]?.stack_generating).toBe(1);
    expect(roomRows[0]?.stack_exhausted).toBe(0);
  });

  it('does not trigger refill when stack_exhausted is already set', async () => {
    const user = await createUser(agent);
    const room = await createRoom(agent, user.accessToken);
    const appendRoomStackMock = vi.mocked(appendRoomStack);

    for (let i = 1; i <= 10; i++) {
      await seedStackMovie(room.id, 6000 + i, i);
    }
    await pool.query('UPDATE rooms SET stack_exhausted = 1 WHERE id = ?', [room.id]);

    const res = await agent
      .get(`/api/movies/feed?roomId=${room.id}&afterPosition=0`)
      .set('Authorization', `Bearer ${user.accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.movies).toHaveLength(10);
    expect(appendRoomStackMock).not.toHaveBeenCalled();

    const [roomRows] = await pool.query<RoomStateRow[]>(
      'SELECT stack_generating, stack_exhausted FROM rooms WHERE id = ?',
      [room.id],
    );
    expect(roomRows[0]?.stack_generating).toBe(0);
    expect(roomRows[0]?.stack_exhausted).toBe(1);
  });

  it('acquires the refill lock atomically across parallel requests', async () => {
    const user = await createUser(agent);
    const room = await createRoom(agent, user.accessToken);
    const appendRoomStackMock = vi.mocked(appendRoomStack);

    for (let i = 1; i <= 10; i++) {
      await seedStackMovie(room.id, 7000 + i, i);
    }

    const [firstRes, secondRes] = await Promise.all([
      agent
        .get(`/api/movies/feed?roomId=${room.id}&afterPosition=0`)
        .set('Authorization', `Bearer ${user.accessToken}`),
      agent
        .get(`/api/movies/feed?roomId=${room.id}&afterPosition=0`)
        .set('Authorization', `Bearer ${user.accessToken}`),
    ]);

    expect(firstRes.status).toBe(200);
    expect(secondRes.status).toBe(200);

    await vi.waitFor(() => {
      expect(appendRoomStackMock).toHaveBeenCalledTimes(1);
      expect(appendRoomStackMock).toHaveBeenCalledWith(room.id);
    });

    const [roomRows] = await pool.query<RoomLockRow[]>(
      'SELECT stack_generating FROM rooms WHERE id = ?',
      [room.id],
    );
    expect(roomRows[0]?.stack_generating).toBe(1);
  });
});

describe('GET /api/movies/rooms/:roomId/next-movie', () => {
  it('returns the next unseen movie', async () => {
    const user = await createUser(agent);
    const room = await createRoom(agent, user.accessToken);
    await seedStackMovie(room.id, 4001, 1);
    await seedStackMovie(room.id, 4002, 2);

    const res = await agent
      .get(`/api/movies/rooms/${room.id}/next-movie`)
      .set('Authorization', `Bearer ${user.accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.movie.id).toBe(4001);
    expect(res.body.stackEmpty).toBe(false);
  });

  it('returns stackEmpty=true when no unseen movies remain', async () => {
    const user = await createUser(agent);
    const room = await createRoom(agent, user.accessToken);
    const res = await agent
      .get(`/api/movies/rooms/${room.id}/next-movie`)
      .set('Authorization', `Bearer ${user.accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.movie).toBeNull();
    expect(res.body.stackEmpty).toBe(true);
  });
});
