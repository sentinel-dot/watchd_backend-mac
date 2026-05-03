import { describe, it, expect } from 'vitest';
import type { vi } from 'vitest';
import { agent } from '../setup';
import { pool } from '../../db/connection';
import { createUser } from '../helpers';
import { OAuth2Client } from 'google-auth-library';
import type { RowDataPacket } from 'mysql2';

// All calls that reach the Google route use the mocked OAuth2Client from setup.ts.
// The mock constructor always returns the same instance, so we retrieve the
// verifyIdToken spy by calling new OAuth2Client() here — same reference the route holds.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockInstance = new (OAuth2Client as any)() as { verifyIdToken: ReturnType<typeof vi.fn> };
const mockVerifyIdToken = mockInstance.verifyIdToken;

const VALID_GOOGLE_BODY = { idToken: 'mock.google.id.token' };

const GOOGLE_ENV_KEYS = ['GOOGLE_CLIENT_ID_IOS', 'GOOGLE_CLIENT_ID_WEB'] as const;

function withGoogleConfig(fn: () => Promise<void>): Promise<void> {
  const original = Object.fromEntries(GOOGLE_ENV_KEYS.map((k) => [k, process.env[k]])) as Record<
    string,
    string | undefined
  >;
  process.env['GOOGLE_CLIENT_ID_IOS'] = 'com.example.watchd.ios';
  return fn().finally(() => {
    for (const key of GOOGLE_ENV_KEYS) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  });
}

describe('POST /api/auth/google', () => {
  it('returns 503 when Google Sign-In is not configured', async () => {
    const saved = process.env['GOOGLE_CLIENT_ID_IOS'];
    delete process.env['GOOGLE_CLIENT_ID_IOS'];
    try {
      const res = await agent.post('/api/auth/google').send(VALID_GOOGLE_BODY);
      expect(res.status).toBe(503);
    } finally {
      if (saved !== undefined) process.env['GOOGLE_CLIENT_ID_IOS'] = saved;
    }
  });

  it('returns 400 for missing idToken', async () => {
    await withGoogleConfig(async () => {
      const res = await agent.post('/api/auth/google').send({});
      expect(res.status).toBe(400);
    });
  });

  it('returns 401 when Google token verification fails', async () => {
    await withGoogleConfig(async () => {
      mockVerifyIdToken.mockRejectedValueOnce(new Error('Token expired'));
      const res = await agent.post('/api/auth/google').send(VALID_GOOGLE_BODY);
      expect(res.status).toBe(401);
    });
  });

  it('returns 401 when payload has no sub', async () => {
    await withGoogleConfig(async () => {
      mockVerifyIdToken.mockResolvedValueOnce({ getPayload: () => null });
      const res = await agent.post('/api/auth/google').send(VALID_GOOGLE_BODY);
      expect(res.status).toBe(401);
    });
  });

  it('creates a new user on first sign-in and returns 201', async () => {
    await withGoogleConfig(async () => {
      mockVerifyIdToken.mockResolvedValueOnce({
        getPayload: () => ({
          sub: 'google_new_001',
          email: 'new@gmail.com',
          name: 'Max Mustermann',
        }),
      });

      const res = await agent.post('/api/auth/google').send(VALID_GOOGLE_BODY);
      expect(res.status).toBe(201);
      expect(res.body.token).toBeTypeOf('string');
      expect(res.body.refreshToken).toBeTypeOf('string');
      expect(res.body.user.name).toBe('Max Mustermann');
      expect(res.body.user.shareCode).toHaveLength(8);
      expect(res.body.user.isPasswordResettable).toBe(false);

      const [rows] = await pool.query<RowDataPacket[]>('SELECT google_id FROM users WHERE id = ?', [
        res.body.user.id,
      ]);
      expect(rows[0].google_id).toBe('google_new_001');
    });
  });

  it('returns existing user on re-sign-in with same Google ID', async () => {
    await withGoogleConfig(async () => {
      const googleId = 'google_existing_002';

      // First sign-in
      mockVerifyIdToken.mockResolvedValueOnce({
        getPayload: () => ({ sub: googleId, name: 'Alice' }),
      });
      const first = await agent.post('/api/auth/google').send(VALID_GOOGLE_BODY);
      expect(first.status).toBe(201);
      const userId = first.body.user.id;

      // Second sign-in — same google_id
      mockVerifyIdToken.mockResolvedValueOnce({
        getPayload: () => ({ sub: googleId }),
      });
      const second = await agent.post('/api/auth/google').send(VALID_GOOGLE_BODY);
      expect(second.status).toBe(200);
      expect(second.body.user.id).toBe(userId);
    });
  });

  it('links Google ID to existing email+password account', async () => {
    await withGoogleConfig(async () => {
      const emailUser = await createUser(agent, { email: 'link@example.com' });

      mockVerifyIdToken.mockResolvedValueOnce({
        getPayload: () => ({
          sub: 'google_link_003',
          email: 'link@example.com',
          name: 'Link User',
        }),
      });

      const res = await agent.post('/api/auth/google').send(VALID_GOOGLE_BODY);
      expect(res.status).toBe(200);
      expect(res.body.user.id).toBe(emailUser.userId);
      expect(res.body.user.isPasswordResettable).toBe(true);

      const [rows] = await pool.query<RowDataPacket[]>('SELECT google_id FROM users WHERE id = ?', [
        emailUser.userId,
      ]);
      expect(rows[0].google_id).toBe('google_link_003');
    });
  });

  it('falls back to "Watchd-User" when name is absent', async () => {
    await withGoogleConfig(async () => {
      mockVerifyIdToken.mockResolvedValueOnce({
        getPayload: () => ({ sub: 'google_noname_004' }),
      });

      const res = await agent.post('/api/auth/google').send(VALID_GOOGLE_BODY);
      expect(res.status).toBe(201);
      expect(res.body.user.name).toBe('Watchd-User');
    });
  });

  it('creates user with null email when email is absent from token', async () => {
    await withGoogleConfig(async () => {
      mockVerifyIdToken.mockResolvedValueOnce({
        getPayload: () => ({ sub: 'google_noemail_005', name: 'No Email' }),
      });

      const res = await agent.post('/api/auth/google').send(VALID_GOOGLE_BODY);
      expect(res.status).toBe(201);
      expect(res.body.user.email).toBeNull();
      expect(res.body.user.isPasswordResettable).toBe(false);
    });
  });
});
