import type supertest from 'supertest';
import type { ResultSetHeader } from 'mysql2';
import { pool } from '../db/connection';

type Agent = ReturnType<typeof supertest>;

export interface TestUser {
  userId: number;
  accessToken: string;
  refreshToken: string;
  name: string;
  email: string;
  shareCode: string;
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
    shareCode: res.body.user.shareCode,
  };
}

export interface TestPartnership {
  id: number;
  requesterId: number;
  addresseeId: number;
  status: 'pending' | 'active';
}

export async function createPartnership(
  requesterId: number,
  addresseeId: number,
  status: 'pending' | 'active' = 'active',
): Promise<TestPartnership> {
  const acceptedAt = status === 'active' ? new Date() : null;
  const [result] = await pool.query<ResultSetHeader>(
    'INSERT INTO partnerships (requester_id, addressee_id, status, accepted_at, user_a_id, user_b_id) VALUES (?, ?, ?, ?, ?, ?)',
    [
      requesterId,
      addresseeId,
      status,
      acceptedAt,
      Math.min(requesterId, addresseeId),
      Math.max(requesterId, addresseeId),
    ],
  );
  const partnershipId = result.insertId;

  await pool.query('INSERT INTO partnership_members (partnership_id, user_id) VALUES (?, ?)', [
    partnershipId,
    requesterId,
  ]);
  if (status === 'active') {
    await pool.query('INSERT INTO partnership_members (partnership_id, user_id) VALUES (?, ?)', [
      partnershipId,
      addresseeId,
    ]);
  }

  return { id: partnershipId, requesterId, addresseeId, status };
}

export async function createPendingRequest(
  requesterId: number,
  addresseeId: number,
): Promise<TestPartnership> {
  return createPartnership(requesterId, addresseeId, 'pending');
}

export async function seedStackMovie(
  partnershipId: number,
  movieId: number,
  position: number,
): Promise<void> {
  await pool.query(
    'INSERT INTO partnership_stack (partnership_id, movie_id, position) VALUES (?, ?, ?)',
    [partnershipId, movieId, position],
  );
}

export async function seedSwipe(
  userId: number,
  movieId: number,
  partnershipId: number,
  direction: 'left' | 'right',
): Promise<void> {
  await pool.query(
    'INSERT INTO swipes (user_id, movie_id, partnership_id, direction) VALUES (?, ?, ?, ?)',
    [userId, movieId, partnershipId, direction],
  );
}

export async function seedMatch(partnershipId: number, movieId: number): Promise<number> {
  const [result] = await pool.query<ResultSetHeader>(
    'INSERT INTO matches (partnership_id, movie_id) VALUES (?, ?)',
    [partnershipId, movieId],
  );
  return result.insertId;
}
