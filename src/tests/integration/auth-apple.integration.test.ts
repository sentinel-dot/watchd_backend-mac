import { describe, it, expect, vi } from 'vitest';
import { agent } from '../setup';
import { pool } from '../../db/connection';
import { createUser } from '../helpers';
import {
  verifyIdToken as appleVerifyIdToken,
  getAuthorizationToken as appleGetAuthorizationToken,
  revokeAuthorizationToken as appleRevokeAuthorizationToken,
} from 'apple-signin-auth';
import type { RowDataPacket } from 'mysql2';

// All calls that reach the Apple route will use the mocked apple-signin-auth from setup.ts.
// Individual tests override return values via mockResolvedValueOnce.

const VALID_APPLE_BODY = {
  identityToken: 'mock.identity.token',
  nonce: 'raw-nonce-32-chars-xxxxxxxxxxxxxxxxx',
  authorizationCode: 'c.mock_auth_code',
  name: 'Max Mustermann',
};

// Helper: configure the Apple config so the route doesn't short-circuit with 503.
// The route checks config.apple.servicesId + config.apple.privateKey.
// In tests those env vars are empty → 503 by default. We patch process.env before each test.
const APPLE_ENV_KEYS = [
  'APPLE_SERVICES_ID',
  'APPLE_TEAM_ID',
  'APPLE_KEY_ID',
  'APPLE_PRIVATE_KEY',
] as const;

function withAppleConfig(fn: () => Promise<void>): Promise<void> {
  const original = Object.fromEntries(
    APPLE_ENV_KEYS.map((k) => [k, process.env[k]]),
  ) as Record<string, string | undefined>;
  // base64 of a dummy PEM (not a real key — mock intercepts before any real crypto)
  process.env['APPLE_SERVICES_ID'] = 'com.example.watchd.signin';
  process.env['APPLE_TEAM_ID'] = 'TEAM123456';
  process.env['APPLE_KEY_ID'] = 'KEY1234567';
  process.env['APPLE_PRIVATE_KEY'] = Buffer.from('DUMMY_PEM_KEY').toString('base64');
  return fn().finally(() => {
    for (const key of APPLE_ENV_KEYS) {
      if (original[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = original[key];
      }
    }
  });
}

describe('POST /api/auth/apple', () => {
  it('returns 503 when Apple Sign-In is not configured', async () => {
    const saved = Object.fromEntries(
      APPLE_ENV_KEYS.map((k) => [k, process.env[k]]),
    ) as Record<string, string | undefined>;
    for (const key of APPLE_ENV_KEYS) delete process.env[key];
    try {
      const res = await agent.post('/api/auth/apple').send(VALID_APPLE_BODY);
      expect(res.status).toBe(503);
    } finally {
      for (const key of APPLE_ENV_KEYS) {
        if (saved[key] !== undefined) process.env[key] = saved[key];
      }
    }
  });

  it('returns 400 for missing identityToken', async () => {
    await withAppleConfig(async () => {
      const res = await agent
        .post('/api/auth/apple')
        .send({ nonce: 'abc', authorizationCode: 'code' });
      expect(res.status).toBe(400);
    });
  });

  it('returns 401 when Apple token verification fails', async () => {
    await withAppleConfig(async () => {
      vi.mocked(appleVerifyIdToken).mockRejectedValueOnce(new Error('TokenExpiredError'));
      const res = await agent.post('/api/auth/apple').send(VALID_APPLE_BODY);
      expect(res.status).toBe(401);
    });
  });

  it('creates a new user on first sign-in and returns 201', async () => {
    await withAppleConfig(async () => {
      vi.mocked(appleVerifyIdToken).mockResolvedValueOnce({
        sub: 'apple_new_user_001',
        email: 'new@privaterelay.appleid.com',
      } as never);
      vi.mocked(appleGetAuthorizationToken).mockResolvedValueOnce({
        refresh_token: 'apple_rt_new_001',
      } as never);

      const res = await agent.post('/api/auth/apple').send(VALID_APPLE_BODY);
      expect(res.status).toBe(201);
      expect(res.body.token).toBeTypeOf('string');
      expect(res.body.refreshToken).toBeTypeOf('string');
      expect(res.body.user.name).toBe('Max Mustermann');
      expect(res.body.user.shareCode).toHaveLength(8);
      expect(res.body.user.isPasswordResettable).toBe(false);

      const [rows] = await pool.query<RowDataPacket[]>(
        'SELECT apple_id, apple_refresh_token FROM users WHERE id = ?',
        [res.body.user.id],
      );
      expect(rows[0].apple_id).toBe('apple_new_user_001');
      expect(rows[0].apple_refresh_token).toBe('apple_rt_new_001');
    });
  });

  it('returns existing user on re-sign-in with same Apple ID', async () => {
    await withAppleConfig(async () => {
      const appleId = 'apple_existing_002';

      // First sign-in
      vi.mocked(appleVerifyIdToken).mockResolvedValueOnce({ sub: appleId } as never);
      vi.mocked(appleGetAuthorizationToken).mockResolvedValueOnce({
        refresh_token: 'apple_rt_002_first',
      } as never);
      const first = await agent.post('/api/auth/apple').send({ ...VALID_APPLE_BODY, name: 'Alice' });
      expect(first.status).toBe(201);
      const userId = first.body.user.id;

      // Second sign-in — same apple_id, new refresh token
      vi.mocked(appleVerifyIdToken).mockResolvedValueOnce({ sub: appleId } as never);
      vi.mocked(appleGetAuthorizationToken).mockResolvedValueOnce({
        refresh_token: 'apple_rt_002_second',
      } as never);
      const second = await agent.post('/api/auth/apple').send(VALID_APPLE_BODY);
      expect(second.status).toBe(200);
      expect(second.body.user.id).toBe(userId);

      // Refresh token updated
      const [rows] = await pool.query<RowDataPacket[]>(
        'SELECT apple_refresh_token FROM users WHERE id = ?',
        [userId],
      );
      expect(rows[0].apple_refresh_token).toBe('apple_rt_002_second');
    });
  });

  it('links Apple ID to existing email+password account', async () => {
    await withAppleConfig(async () => {
      const emailUser = await createUser(agent, { email: 'link@example.com' });

      vi.mocked(appleVerifyIdToken).mockResolvedValueOnce({
        sub: 'apple_link_003',
        email: 'link@example.com',
      } as never);
      vi.mocked(appleGetAuthorizationToken).mockResolvedValueOnce({
        refresh_token: 'apple_rt_003',
      } as never);

      const res = await agent.post('/api/auth/apple').send({ ...VALID_APPLE_BODY, name: null });
      expect(res.status).toBe(200);
      expect(res.body.user.id).toBe(emailUser.userId);
      expect(res.body.user.isPasswordResettable).toBe(true);

      const [rows] = await pool.query<RowDataPacket[]>(
        'SELECT apple_id FROM users WHERE id = ?',
        [emailUser.userId],
      );
      expect(rows[0].apple_id).toBe('apple_link_003');
    });
  });

  it('falls back to "Watchd-User" when name is absent (relay email, no name)', async () => {
    await withAppleConfig(async () => {
      vi.mocked(appleVerifyIdToken).mockResolvedValueOnce({
        sub: 'apple_noname_004',
      } as never);
      vi.mocked(appleGetAuthorizationToken).mockResolvedValueOnce({
        refresh_token: 'apple_rt_004',
      } as never);

      const res = await agent
        .post('/api/auth/apple')
        .send({ ...VALID_APPLE_BODY, name: null });
      expect(res.status).toBe(201);
      expect(res.body.user.name).toBe('Watchd-User');
    });
  });

  it('sign-in succeeds even when auth-code exchange fails', async () => {
    await withAppleConfig(async () => {
      vi.mocked(appleVerifyIdToken).mockResolvedValueOnce({
        sub: 'apple_nocode_005',
      } as never);
      vi.mocked(appleGetAuthorizationToken).mockRejectedValueOnce(
        new Error('invalid_grant'),
      );

      const res = await agent.post('/api/auth/apple').send(VALID_APPLE_BODY);
      expect(res.status).toBe(201);
      expect(res.body.token).toBeTypeOf('string');

      const [rows] = await pool.query<RowDataPacket[]>(
        'SELECT apple_refresh_token FROM users WHERE id = ?',
        [res.body.user.id],
      );
      expect(rows[0].apple_refresh_token).toBeNull();
    });
  });
});

describe('DELETE /api/auth/delete-account (Apple revocation)', () => {
  it('revokes Apple token on account deletion', async () => {
    await withAppleConfig(async () => {
      // Create an Apple user
      vi.mocked(appleVerifyIdToken).mockResolvedValueOnce({ sub: 'apple_del_006' } as never);
      vi.mocked(appleGetAuthorizationToken).mockResolvedValueOnce({
        refresh_token: 'apple_rt_to_revoke',
      } as never);
      const signIn = await agent.post('/api/auth/apple').send(VALID_APPLE_BODY);
      expect(signIn.status).toBe(201);

      const del = await agent
        .delete('/api/auth/delete-account')
        .set('Authorization', `Bearer ${signIn.body.token}`);
      expect(del.status).toBe(200);

      // Revocation is fire-and-forget; give it a tick to run
      await new Promise((r) => setTimeout(r, 20));
      expect(vi.mocked(appleRevokeAuthorizationToken)).toHaveBeenCalledOnce();
    });
  });

  it('does not call Apple revocation for email-only accounts', async () => {
    const user = await createUser(agent, { email: 'nonapple@example.com' });
    const del = await agent
      .delete('/api/auth/delete-account')
      .set('Authorization', `Bearer ${user.accessToken}`);
    expect(del.status).toBe(200);
    await new Promise((r) => setTimeout(r, 20));
    expect(vi.mocked(appleRevokeAuthorizationToken)).not.toHaveBeenCalled();
  });
});
