import { describe, it, expect, vi } from 'vitest';
import { agent } from '../setup';
import { pool } from '../../db/connection';
import { createUser, createPartnership, seedSwipe, seedMatch, seedStackMovie } from '../helpers';
import { sendPasswordResetEmail } from '../../services/mail';
import crypto from 'crypto';
import type { RowDataPacket } from 'mysql2';

describe('POST /api/auth/register', () => {
  it('creates a user with a share-code and returns a token pair', async () => {
    const res = await agent
      .post('/api/auth/register')
      .send({ name: 'Alice', email: 'alice@example.com', password: 'testpassword123' });

    expect(res.status).toBe(201);
    expect(res.body.token).toBeTypeOf('string');
    expect(res.body.refreshToken).toBeTypeOf('string');
    expect(res.body.user).toMatchObject({
      name: 'Alice',
      email: 'alice@example.com',
    });
    expect(res.body.user.id).toBeTypeOf('number');
    expect(res.body.user.shareCode).toBeTypeOf('string');
    expect(res.body.user.shareCode).toHaveLength(8);

    const [rows] = await pool.query<(RowDataPacket & { share_code: string })[]>(
      'SELECT share_code FROM users WHERE id = ?',
      [res.body.user.id],
    );
    expect(rows[0].share_code).toBe(res.body.user.shareCode);
  });

  it('returns 409 for duplicate email', async () => {
    await createUser(agent, { email: 'dup@example.com' });
    const res = await agent
      .post('/api/auth/register')
      .send({ name: 'Bob', email: 'dup@example.com', password: 'testpassword123' });
    expect(res.status).toBe(409);
  });

  it('returns 400 for short password', async () => {
    const res = await agent
      .post('/api/auth/register')
      .send({ name: 'Charlie', email: 'c@example.com', password: 'short' });
    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid email', async () => {
    const res = await agent
      .post('/api/auth/register')
      .send({ name: 'Dave', email: 'not-an-email', password: 'testpassword123' });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/auth/login', () => {
  it('returns a token pair (incl. shareCode) on correct credentials', async () => {
    const created = await createUser(agent, {
      email: 'login@example.com',
      password: 'correct-password-1',
    });
    const res = await agent
      .post('/api/auth/login')
      .send({ email: 'login@example.com', password: 'correct-password-1' });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTypeOf('string');
    expect(res.body.refreshToken).toBeTypeOf('string');
    expect(res.body.user.shareCode).toBe(created.shareCode);
  });

  it('returns 401 on wrong password', async () => {
    await createUser(agent, { email: 'wrong@example.com', password: 'correct-password-1' });
    const res = await agent
      .post('/api/auth/login')
      .send({ email: 'wrong@example.com', password: 'incorrect-password-1' });
    expect(res.status).toBe(401);
  });

  it('returns 401 on unknown email (no user-enumeration leak)', async () => {
    const res = await agent
      .post('/api/auth/login')
      .send({ email: 'nobody@example.com', password: 'anything1234' });
    expect(res.status).toBe(401);
  });
});

describe('POST /api/auth/refresh', () => {
  it('rotates tokens and revokes the old one', async () => {
    const user = await createUser(agent);
    const res = await agent.post('/api/auth/refresh').send({ refreshToken: user.refreshToken });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTypeOf('string');
    expect(res.body.refreshToken).not.toBe(user.refreshToken);
    expect(res.body.user.shareCode).toBe(user.shareCode);

    const decoded = JSON.parse(Buffer.from(user.refreshToken, 'base64url').toString('utf-8'));
    const oldHash = crypto.createHash('sha256').update(decoded.tok).digest('hex');
    const [rows] = await pool.query<(RowDataPacket & { revoked: number })[]>(
      'SELECT revoked FROM refresh_tokens WHERE token_hash = ?',
      [oldHash],
    );
    expect(rows[0]?.revoked).toBe(1);
  });

  it('detects token reuse and revokes the whole family', async () => {
    const user = await createUser(agent);

    const first = await agent.post('/api/auth/refresh').send({ refreshToken: user.refreshToken });
    expect(first.status).toBe(200);

    const reuse = await agent.post('/api/auth/refresh').send({ refreshToken: user.refreshToken });
    expect(reuse.status).toBe(401);

    const newDecoded = JSON.parse(
      Buffer.from(first.body.refreshToken, 'base64url').toString('utf-8'),
    );
    const newHash = crypto.createHash('sha256').update(newDecoded.tok).digest('hex');
    const [rows] = await pool.query<(RowDataPacket & { revoked: number })[]>(
      'SELECT revoked FROM refresh_tokens WHERE token_hash = ?',
      [newHash],
    );
    expect(rows[0]?.revoked).toBe(1);
  });

  it('returns 401 for malformed refresh token', async () => {
    const res = await agent.post('/api/auth/refresh').send({ refreshToken: '!!!not-valid!!!' });
    expect(res.status).toBe(401);
  });

  it('returns 401 for expired refresh token', async () => {
    const user = await createUser(agent);
    const decoded = JSON.parse(Buffer.from(user.refreshToken, 'base64url').toString('utf-8'));
    const hash = crypto.createHash('sha256').update(decoded.tok).digest('hex');
    await pool.query('UPDATE refresh_tokens SET expires_at = ? WHERE token_hash = ?', [
      new Date(Date.now() - 1000),
      hash,
    ]);
    const res = await agent.post('/api/auth/refresh').send({ refreshToken: user.refreshToken });
    expect(res.status).toBe(401);
  });
});

describe('POST /api/auth/forgot-password', () => {
  it('sends a reset mail for a known email', async () => {
    await createUser(agent, { email: 'forgot@example.com' });
    const res = await agent.post('/api/auth/forgot-password').send({ email: 'forgot@example.com' });
    expect(res.status).toBe(200);
    expect(vi.mocked(sendPasswordResetEmail)).toHaveBeenCalledOnce();
  });

  it('returns 200 for unknown email without sending (no enumeration leak)', async () => {
    const res = await agent.post('/api/auth/forgot-password').send({ email: 'nobody@example.com' });
    expect(res.status).toBe(200);
    expect(vi.mocked(sendPasswordResetEmail)).not.toHaveBeenCalled();
  });
});

describe('POST /api/auth/reset-password', () => {
  async function requestResetToken(email: string): Promise<string> {
    await agent.post('/api/auth/forgot-password').send({ email });
    const calls = vi.mocked(sendPasswordResetEmail).mock.calls;
    return calls[calls.length - 1][1];
  }

  it('resets the password and revokes all refresh tokens', async () => {
    const user = await createUser(agent, {
      email: 'reset@example.com',
      password: 'old-password-1',
    });
    const token = await requestResetToken('reset@example.com');

    const res = await agent
      .post('/api/auth/reset-password')
      .send({ token, newPassword: 'new-password-1' });
    expect(res.status).toBe(200);

    const oldLogin = await agent
      .post('/api/auth/login')
      .send({ email: 'reset@example.com', password: 'old-password-1' });
    expect(oldLogin.status).toBe(401);

    const newLogin = await agent
      .post('/api/auth/login')
      .send({ email: 'reset@example.com', password: 'new-password-1' });
    expect(newLogin.status).toBe(200);

    const reuse = await agent.post('/api/auth/refresh').send({ refreshToken: user.refreshToken });
    expect(reuse.status).toBe(401);
  });

  it('rejects a used token', async () => {
    await createUser(agent, { email: 'reset2@example.com' });
    const token = await requestResetToken('reset2@example.com');

    const first = await agent
      .post('/api/auth/reset-password')
      .send({ token, newPassword: 'new-password-1' });
    expect(first.status).toBe(200);

    const second = await agent
      .post('/api/auth/reset-password')
      .send({ token, newPassword: 'other-password-1' });
    expect(second.status).toBe(400);
  });

  it('rejects an expired token', async () => {
    await createUser(agent, { email: 'reset3@example.com' });
    const token = await requestResetToken('reset3@example.com');
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    await pool.query('UPDATE password_reset_tokens SET expires_at = ? WHERE token_hash = ?', [
      new Date(Date.now() - 1000),
      hash,
    ]);
    const res = await agent
      .post('/api/auth/reset-password')
      .send({ token, newPassword: 'new-password-1' });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/auth/logout', () => {
  it('revokes the provided refresh token', async () => {
    const user = await createUser(agent);
    const res = await agent.post('/api/auth/logout').send({ refreshToken: user.refreshToken });
    expect(res.status).toBe(200);

    const reuse = await agent.post('/api/auth/refresh').send({ refreshToken: user.refreshToken });
    expect(reuse.status).toBe(401);
  });
});

describe('DELETE /api/auth/delete-account', () => {
  it('deletes the user and invalidates future login', async () => {
    const user = await createUser(agent, { email: 'del@example.com', password: 'delete-me-123' });
    const res = await agent
      .delete('/api/auth/delete-account')
      .set('Authorization', `Bearer ${user.accessToken}`);
    expect(res.status).toBe(200);

    const [rows] = await pool.query<RowDataPacket[]>('SELECT id FROM users WHERE id = ?', [
      user.userId,
    ]);
    expect(rows.length).toBe(0);

    const login = await agent
      .post('/api/auth/login')
      .send({ email: 'del@example.com', password: 'delete-me-123' });
    expect(login.status).toBe(401);
  });

  it('cascades to partnerships, swipes, matches and stack', async () => {
    const a = await createUser(agent);
    const b = await createUser(agent);
    const partnership = await createPartnership(a.userId, b.userId, 'active');
    await seedStackMovie(partnership.id, 101, 0);
    await seedSwipe(a.userId, 101, partnership.id, 'right');
    await seedSwipe(b.userId, 101, partnership.id, 'right');
    await seedMatch(partnership.id, 101);

    const del = await agent
      .delete('/api/auth/delete-account')
      .set('Authorization', `Bearer ${a.accessToken}`);
    expect(del.status).toBe(200);

    const [partnerships] = await pool.query<RowDataPacket[]>(
      'SELECT id FROM partnerships WHERE id = ?',
      [partnership.id],
    );
    expect(partnerships.length).toBe(0);

    const [swipes] = await pool.query<RowDataPacket[]>(
      'SELECT id FROM swipes WHERE partnership_id = ?',
      [partnership.id],
    );
    expect(swipes.length).toBe(0);

    const [matches] = await pool.query<RowDataPacket[]>(
      'SELECT id FROM matches WHERE partnership_id = ?',
      [partnership.id],
    );
    expect(matches.length).toBe(0);

    const [stack] = await pool.query<RowDataPacket[]>(
      'SELECT id FROM partnership_stack WHERE partnership_id = ?',
      [partnership.id],
    );
    expect(stack.length).toBe(0);

    const [members] = await pool.query<RowDataPacket[]>(
      'SELECT id FROM partnership_members WHERE partnership_id = ?',
      [partnership.id],
    );
    expect(members.length).toBe(0);
  });
});
