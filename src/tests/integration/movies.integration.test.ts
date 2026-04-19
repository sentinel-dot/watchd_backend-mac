import { describe, it, expect } from 'vitest';
import { agent } from '../setup';
import { createUser, createRoom, seedStackMovie, seedSwipe } from '../helpers';

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
