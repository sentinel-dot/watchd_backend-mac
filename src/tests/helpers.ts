import supertest from 'supertest';
import { pool } from '../db/connection';

type Agent = ReturnType<typeof supertest>;

export interface TestUser {
  userId: number;
  accessToken: string;
  refreshToken: string;
  name: string;
  email: string | null;
  isGuest: boolean;
}

let userCounter = 0;

export async function createUser(
  agent: Agent,
  overrides: { name?: string; email?: string; password?: string } = {},
): Promise<TestUser> {
  userCounter++;
  const name = overrides.name ?? `User${userCounter}`;
  const email = overrides.email ?? `user${userCounter}_${Date.now()}@example.com`;
  const password = overrides.password ?? 'testpassword123';

  const res = await agent.post('/api/auth/register').send({ name, email, password });
  if (res.status !== 201) {
    throw new Error(`createUser failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return {
    userId: res.body.user.id,
    accessToken: res.body.token,
    refreshToken: res.body.refreshToken,
    name: res.body.user.name,
    email: res.body.user.email,
    isGuest: res.body.user.isGuest,
  };
}

export async function createGuestUser(agent: Agent): Promise<TestUser> {
  const res = await agent.post('/api/auth/guest').send({});
  if (res.status !== 201) {
    throw new Error(`createGuestUser failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return {
    userId: res.body.user.id,
    accessToken: res.body.token,
    refreshToken: res.body.refreshToken,
    name: res.body.user.name,
    email: res.body.user.email,
    isGuest: res.body.user.isGuest,
  };
}

export async function createRoom(
  agent: Agent,
  token: string,
  body: { name?: string; filters?: object } = {},
): Promise<{ id: number; code: string }> {
  const res = await agent
    .post('/api/rooms')
    .set('Authorization', `Bearer ${token}`)
    .send(body);
  if (res.status !== 201) {
    throw new Error(`createRoom failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return { id: res.body.room.id, code: res.body.room.code };
}

export async function joinRoom(
  agent: Agent,
  token: string,
  code: string,
): Promise<{ id: number; code: string }> {
  const res = await agent
    .post('/api/rooms/join')
    .set('Authorization', `Bearer ${token}`)
    .send({ code });
  if (res.status !== 200) {
    throw new Error(`joinRoom failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return { id: res.body.room.id, code: res.body.room.code };
}

export async function seedStackMovie(roomId: number, movieId: number, position: number): Promise<void> {
  await pool.query(
    'INSERT INTO room_stack (room_id, movie_id, position) VALUES (?, ?, ?)',
    [roomId, movieId, position],
  );
}

export async function seedSwipe(
  userId: number,
  movieId: number,
  roomId: number,
  direction: 'left' | 'right',
): Promise<void> {
  await pool.query(
    'INSERT INTO swipes (user_id, movie_id, room_id, direction) VALUES (?, ?, ?, ?)',
    [userId, movieId, roomId, direction],
  );
}

export async function seedMatch(roomId: number, movieId: number): Promise<number> {
  const [result] = await pool.query<import('mysql2').ResultSetHeader>(
    'INSERT INTO matches (room_id, movie_id) VALUES (?, ?)',
    [roomId, movieId],
  );
  return result.insertId;
}
