import { describe, it, expect } from 'vitest';
import type { RowDataPacket } from 'mysql2';
import { agent } from '../setup';
import { pool } from '../../db/connection';
import { createUser } from '../helpers';

describe('PATCH /api/users/me', () => {
  it('updates the name and returns the refreshed user', async () => {
    const user = await createUser(agent, { email: 'patch-me@example.com', name: 'Old' });

    const res = await agent
      .patch('/api/users/me')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({ name: 'New Name' });

    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ id: user.userId, name: 'New Name' });
    expect(res.body.user.shareCode).toBe(user.shareCode);

    const [rows] = await pool.query<(RowDataPacket & { name: string })[]>(
      'SELECT name FROM users WHERE id = ?',
      [user.userId],
    );
    expect(rows[0].name).toBe('New Name');
  });

  it('trims whitespace before applying', async () => {
    const user = await createUser(agent, { email: 'patch-trim@example.com' });

    const res = await agent
      .patch('/api/users/me')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({ name: '   Trimmed   ' });

    expect(res.status).toBe(200);
    expect(res.body.user.name).toBe('Trimmed');
  });

  it('returns 400 for empty name', async () => {
    const user = await createUser(agent, { email: 'patch-empty@example.com' });

    const res = await agent
      .patch('/api/users/me')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({ name: '   ' });

    expect(res.status).toBe(400);
  });

  it('returns 400 for name longer than 64 chars', async () => {
    const user = await createUser(agent, { email: 'patch-long@example.com' });

    const res = await agent
      .patch('/api/users/me')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({ name: 'x'.repeat(65) });

    expect(res.status).toBe(400);
  });

  it('returns 401 without auth', async () => {
    const res = await agent.patch('/api/users/me').send({ name: 'Whatever' });
    expect(res.status).toBe(401);
  });
});

describe('POST /api/users/me/device-token', () => {
  it('stores the device token for the authenticated user', async () => {
    const user = await createUser(agent, { email: 'dt-store@example.com' });
    const token = 'a'.repeat(64);

    const res = await agent
      .post('/api/users/me/device-token')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({ deviceToken: token });

    expect(res.status).toBe(204);

    const [rows] = await pool.query<(RowDataPacket & { device_token: string | null })[]>(
      'SELECT device_token FROM users WHERE id = ?',
      [user.userId],
    );
    expect(rows[0].device_token).toBe(token);
  });

  it('overwrites an existing device token', async () => {
    const user = await createUser(agent, { email: 'dt-update@example.com' });
    const first = 'a'.repeat(64);
    const second = 'b'.repeat(64);

    await agent
      .post('/api/users/me/device-token')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({ deviceToken: first });

    const res = await agent
      .post('/api/users/me/device-token')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({ deviceToken: second });

    expect(res.status).toBe(204);

    const [rows] = await pool.query<(RowDataPacket & { device_token: string | null })[]>(
      'SELECT device_token FROM users WHERE id = ?',
      [user.userId],
    );
    expect(rows[0].device_token).toBe(second);
  });

  it('returns 400 for a token shorter than 32 chars', async () => {
    const user = await createUser(agent, { email: 'dt-short@example.com' });

    const res = await agent
      .post('/api/users/me/device-token')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({ deviceToken: 'short' });

    expect(res.status).toBe(400);
  });

  it('returns 401 without auth', async () => {
    const res = await agent
      .post('/api/users/me/device-token')
      .send({ deviceToken: 'a'.repeat(64) });
    expect(res.status).toBe(401);
  });
});

describe('GET /api/users/me/share-code', () => {
  it('returns the share-code for the authenticated user', async () => {
    const user = await createUser(agent, { email: 'sc-get@example.com' });

    const res = await agent
      .get('/api/users/me/share-code')
      .set('Authorization', `Bearer ${user.accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.shareCode).toBe(user.shareCode);
  });

  it('returns 401 without auth', async () => {
    const res = await agent.get('/api/users/me/share-code');
    expect(res.status).toBe(401);
  });
});

describe('POST /api/users/me/share-code/regenerate', () => {
  it('replaces the share-code; old code becomes unusable', async () => {
    const user = await createUser(agent, { email: 'sc-regen@example.com' });

    const res = await agent
      .post('/api/users/me/share-code/regenerate')
      .set('Authorization', `Bearer ${user.accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.shareCode).toBeTypeOf('string');
    expect(res.body.shareCode).toHaveLength(8);
    expect(res.body.shareCode).not.toBe(user.shareCode);

    const [rows] = await pool.query<(RowDataPacket & { share_code: string })[]>(
      'SELECT share_code FROM users WHERE id = ?',
      [user.userId],
    );
    expect(rows[0].share_code).toBe(res.body.shareCode);

    // Looking up by the OLD code now finds nothing
    const [oldLookup] = await pool.query<RowDataPacket[]>(
      'SELECT id FROM users WHERE share_code = ?',
      [user.shareCode],
    );
    expect(oldLookup.length).toBe(0);
  });

  it('produces a different code than before', async () => {
    const user = await createUser(agent, { email: 'sc-regen2@example.com' });

    const first = await agent
      .post('/api/users/me/share-code/regenerate')
      .set('Authorization', `Bearer ${user.accessToken}`);
    const second = await agent
      .post('/api/users/me/share-code/regenerate')
      .set('Authorization', `Bearer ${user.accessToken}`);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.shareCode).not.toBe(first.body.shareCode);
  });

  it('returns 401 without auth', async () => {
    const res = await agent.post('/api/users/me/share-code/regenerate');
    expect(res.status).toBe(401);
  });
});
