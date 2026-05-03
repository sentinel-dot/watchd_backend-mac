import type { Request, Response } from 'express';
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { body, validationResult } from 'express-validator';
import {
  verifyIdToken as appleVerifyIdToken,
  getAuthorizationToken as appleGetAuthorizationToken,
  getClientSecret as appleGetClientSecret,
  revokeAuthorizationToken as appleRevokeAuthorizationToken,
} from 'apple-signin-auth';
import { OAuth2Client } from 'google-auth-library';
import { pool } from '../db/connection';
import { config } from '../config';
import { logger } from '../logger';
import type { AuthRequest } from '../middleware/auth';
import { authMiddleware } from '../middleware/auth';
import { sendPasswordResetEmail } from '../services/mail';
import { disconnectUserSockets } from '../socket';
import { generateUniqueShareCode } from '../services/share-code';
import type { RowDataPacket, ResultSetHeader } from 'mysql2';

const router = Router();

interface UserRow extends RowDataPacket {
  id: number;
  name: string;
  email: string | null;
  password_hash: string | null;
  share_code: string;
  created_at: Date;
}

interface AppleUserRow extends RowDataPacket {
  id: number;
  name: string;
  email: string | null;
  password_hash: string | null;
  share_code: string;
  apple_refresh_token: string | null;
}

interface GoogleUserRow extends RowDataPacket {
  id: number;
  name: string;
  email: string | null;
  password_hash: string | null;
  share_code: string;
}

// Module-level client — created once, reused per request.
// Top-level instantiation makes this easy to mock in unit/integration tests.
const googleOAuth2Client = new OAuth2Client();

interface ResetTokenRow extends RowDataPacket {
  id: number;
  user_id: number;
  expires_at: Date;
  used: boolean;
}

interface RefreshTokenRow extends RowDataPacket {
  id: number;
  user_id: number;
  family_id: string;
  expires_at: Date;
  revoked: boolean;
}

function signAccessToken(userId: number, email: string | null): string {
  return jwt.sign({ userId, email }, config.jwtSecret, { expiresIn: '15m' });
}

async function createRefreshToken(userId: number, familyId?: string): Promise<string> {
  const raw = crypto.randomBytes(48).toString('hex');
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  const family = familyId ?? crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  await pool.query(
    'INSERT INTO refresh_tokens (user_id, token_hash, family_id, expires_at) VALUES (?, ?, ?, ?)',
    [userId, hash, family, expiresAt],
  );
  return Buffer.from(JSON.stringify({ uid: userId, tok: raw, fam: family })).toString('base64url');
}

export function decodeRefreshToken(
  encoded: string,
): { uid: number; tok: string; fam: string } | null {
  try {
    return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf-8'));
  } catch {
    return null;
  }
}

async function issueTokenPair(
  user: {
    id: number;
    name: string;
    email: string | null;
    share_code: string;
    password_hash?: string | null;
  },
  existingFamily?: string,
) {
  const accessToken = signAccessToken(user.id, user.email);
  const refreshToken = await createRefreshToken(user.id, existingFamily);
  return {
    token: accessToken,
    refreshToken,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      shareCode: user.share_code,
      isPasswordResettable: !!user.password_hash,
    },
  };
}

// Revokes an Apple refresh token for GDPR/Apple account-deletion compliance.
// Called fire-and-forget after user deletion — failure is non-critical.
async function revokeAppleToken(refreshToken: string): Promise<void> {
  const privateKeyPem = Buffer.from(config.apple.privateKey, 'base64').toString('utf-8');
  const clientSecret = appleGetClientSecret({
    clientID: config.apple.servicesId,
    teamID: config.apple.teamId,
    privateKey: privateKeyPem,
    keyIdentifier: config.apple.keyId,
  });
  await appleRevokeAuthorizationToken(refreshToken, {
    clientID: config.apple.servicesId,
    clientSecret,
    tokenTypeHint: 'refresh_token',
  });
}

router.post(
  '/register',
  [
    body('name')
      .trim()
      .isLength({ min: 1, max: 64 })
      .withMessage('Name muss zwischen 1 und 64 Zeichen lang sein'),
    body('email')
      .isEmail()
      .isLength({ max: 254 })
      .normalizeEmail()
      .withMessage('Ungültige E-Mail-Adresse'),
    body('password')
      .isLength({ min: 8, max: 128 })
      .withMessage('Passwort muss zwischen 8 und 128 Zeichen lang sein'),
  ],
  async (req: Request, res: Response): Promise<void> => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ error: errors.array()[0].msg });
      return;
    }
    const { name, email, password } = req.body as { name: string; email: string; password: string };
    try {
      const [existing] = await pool.query<UserRow[]>('SELECT id FROM users WHERE email = ?', [
        email,
      ]);
      if (existing.length > 0) {
        res.status(409).json({ error: 'Diese E-Mail ist bereits registriert' });
        return;
      }
      const passwordHash = await bcrypt.hash(password, config.bcryptRounds);
      const shareCode = await generateUniqueShareCode();
      const [result] = await pool.query<ResultSetHeader>(
        'INSERT INTO users (name, email, password_hash, share_code) VALUES (?, ?, ?, ?)',
        [name, email, passwordHash, shareCode],
      );
      const response = await issueTokenPair({
        id: result.insertId,
        name,
        email,
        share_code: shareCode,
        password_hash: passwordHash,
      });
      res.status(201).json(response);
    } catch (err) {
      logger.error({ err }, 'Register error');
      res.status(500).json({ error: 'Interner Serverfehler' });
    }
  },
);

router.post(
  '/login',
  [
    body('email').isEmail().normalizeEmail().withMessage('Ungültige E-Mail-Adresse'),
    body('password').isLength({ min: 1 }).withMessage('Passwort ist erforderlich'),
  ],
  async (req: Request, res: Response): Promise<void> => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ error: errors.array()[0].msg });
      return;
    }
    const { email, password } = req.body as { email: string; password: string };
    try {
      const [rows] = await pool.query<UserRow[]>(
        'SELECT id, name, email, password_hash, share_code FROM users WHERE email = ?',
        [email],
      );
      if (rows.length === 0) {
        res.status(401).json({ error: 'Ungültige Anmeldedaten' });
        return;
      }
      const user = rows[0];
      if (!user.password_hash) {
        res.status(401).json({ error: 'Ungültige Anmeldedaten' });
        return;
      }
      const match = await bcrypt.compare(password, user.password_hash);
      if (!match) {
        res.status(401).json({ error: 'Ungültige Anmeldedaten' });
        return;
      }
      const response = await issueTokenPair(user);
      res.json(response);
    } catch (err) {
      logger.error({ err }, 'Login error');
      res.status(500).json({ error: 'Interner Serverfehler' });
    }
  },
);

router.post('/refresh', async (req: Request, res: Response): Promise<void> => {
  const { refreshToken } = req.body as { refreshToken?: string };
  if (!refreshToken) {
    res.status(400).json({ error: 'Refresh-Token ist erforderlich' });
    return;
  }
  const decoded = decodeRefreshToken(refreshToken);
  if (!decoded) {
    res.status(401).json({ error: 'Ungültiger Refresh-Token' });
    return;
  }
  const tokenHash = crypto.createHash('sha256').update(decoded.tok).digest('hex');
  try {
    const [rows] = await pool.query<RefreshTokenRow[]>(
      'SELECT id, user_id, family_id, expires_at, revoked FROM refresh_tokens WHERE token_hash = ?',
      [tokenHash],
    );
    if (rows.length === 0) {
      res.status(401).json({ error: 'Ungültiger Refresh-Token' });
      return;
    }
    const storedToken = rows[0];
    if (storedToken.revoked) {
      logger.warn(
        { userId: storedToken.user_id, familyId: storedToken.family_id },
        'Refresh token reuse detected',
      );
      await pool.query('UPDATE refresh_tokens SET revoked = TRUE WHERE family_id = ?', [
        storedToken.family_id,
      ]);
      res.status(401).json({ error: 'Token wurde bereits verwendet. Bitte erneut anmelden.' });
      return;
    }
    if (new Date() > storedToken.expires_at) {
      res.status(401).json({ error: 'Refresh-Token abgelaufen' });
      return;
    }
    await pool.query('UPDATE refresh_tokens SET revoked = TRUE WHERE id = ?', [storedToken.id]);
    const [users] = await pool.query<UserRow[]>(
      'SELECT id, name, email, password_hash, share_code FROM users WHERE id = ?',
      [storedToken.user_id],
    );
    if (users.length === 0) {
      res.status(401).json({ error: 'Benutzer nicht gefunden' });
      return;
    }
    const response = await issueTokenPair(users[0], storedToken.family_id);
    res.json(response);
  } catch (err) {
    logger.error({ err }, 'Refresh token error');
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

router.post(
  '/apple',
  [
    body('identityToken').isString().notEmpty().withMessage('identityToken ist erforderlich'),
    body('nonce').isString().notEmpty().withMessage('nonce ist erforderlich'),
    body('authorizationCode').isString().notEmpty().withMessage('authorizationCode ist erforderlich'),
    body('name').optional({ nullable: true }).isString().isLength({ max: 64 }),
  ],
  async (req: Request, res: Response): Promise<void> => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ error: errors.array()[0].msg });
      return;
    }

    if (!config.apple.servicesId || !config.apple.privateKey) {
      res.status(503).json({ error: 'Apple Sign-In ist nicht konfiguriert' });
      return;
    }

    const { identityToken, nonce, authorizationCode, name } = req.body as {
      identityToken: string;
      nonce: string;
      authorizationCode: string;
      name?: string | null;
    };

    try {
      // 1. Verify Apple identity token (throws on invalid/expired/nonce-mismatch)
      let applePayload: { sub: string; email?: string };
      try {
        applePayload = await appleVerifyIdToken(identityToken, {
          audience: config.apple.servicesId,
          nonce: crypto.createHash('sha256').update(nonce).digest('hex'),
        });
      } catch (verifyErr) {
        logger.warn({ verifyErr }, 'Apple identity token verification failed');
        res.status(401).json({ error: 'Apple-Authentifizierung fehlgeschlagen' });
        return;
      }

      const appleUserId = applePayload.sub;
      const appleEmail = applePayload.email ?? null;

      // 2. Exchange authorization code → Apple refresh token (for future revocation on delete)
      let appleRefreshToken: string | null = null;
      const privateKeyPem = Buffer.from(config.apple.privateKey, 'base64').toString('utf-8');
      try {
        const clientSecret = appleGetClientSecret({
          clientID: config.apple.servicesId,
          teamID: config.apple.teamId,
          privateKey: privateKeyPem,
          keyIdentifier: config.apple.keyId,
        });
        const tokenResponse = await appleGetAuthorizationToken(authorizationCode, {
          clientID: config.apple.servicesId,
          redirectUri: '',
          clientSecret,
        });
        appleRefreshToken = tokenResponse.refresh_token ?? null;
      } catch (tokenErr) {
        logger.warn({ tokenErr }, 'Apple auth code exchange failed — sign-in proceeds without refresh token');
      }

      // 3a. Find by apple_id → existing Apple user
      let [rows] = await pool.query<AppleUserRow[]>(
        'SELECT id, name, email, password_hash, share_code, apple_refresh_token FROM users WHERE apple_id = ?',
        [appleUserId],
      );
      if (rows.length > 0) {
        const user = rows[0];
        if (appleRefreshToken) {
          await pool.query('UPDATE users SET apple_refresh_token = ? WHERE id = ?', [
            appleRefreshToken,
            user.id,
          ]);
        }
        const response = await issueTokenPair({
          id: user.id,
          name: user.name,
          email: user.email,
          share_code: user.share_code,
          password_hash: user.password_hash,
        });
        res.json(response);
        return;
      }

      // 3b. Find by email → account linking (email+password account ↔ Apple ID)
      if (appleEmail) {
        [rows] = await pool.query<AppleUserRow[]>(
          'SELECT id, name, email, password_hash, share_code, apple_refresh_token FROM users WHERE email = ?',
          [appleEmail],
        );
        if (rows.length > 0) {
          const user = rows[0];
          await pool.query('UPDATE users SET apple_id = ?, apple_refresh_token = ? WHERE id = ?', [
            appleUserId,
            appleRefreshToken,
            user.id,
          ]);
          logger.info({ userId: user.id }, 'Apple account linked via email match');
          const response = await issueTokenPair({
            id: user.id,
            name: user.name,
            email: user.email,
            share_code: user.share_code,
            password_hash: user.password_hash,
          });
          res.json(response);
          return;
        }
      }

      // 3c. New user — Apple only (no password)
      const userName =
        typeof name === 'string' && name.trim().length > 0 ? name.trim().slice(0, 64) : 'Watchd-User';
      const shareCode = await generateUniqueShareCode();
      const [result] = await pool.query<ResultSetHeader>(
        'INSERT INTO users (name, email, apple_id, apple_refresh_token, share_code) VALUES (?, ?, ?, ?, ?)',
        [userName, appleEmail, appleUserId, appleRefreshToken, shareCode],
      );
      logger.info({ userId: result.insertId }, 'New user created via Apple Sign-In');
      const response = await issueTokenPair({
        id: result.insertId,
        name: userName,
        email: appleEmail,
        share_code: shareCode,
        password_hash: null,
      });
      res.status(201).json(response);
    } catch (err) {
      logger.error({ err }, 'Apple sign-in error');
      res.status(500).json({ error: 'Interner Serverfehler' });
    }
  },
);

router.post(
  '/google',
  [body('idToken').isString().notEmpty().withMessage('idToken ist erforderlich')],
  async (req: Request, res: Response): Promise<void> => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ error: errors.array()[0].msg });
      return;
    }

    if (!config.google.clientIdIos) {
      res.status(503).json({ error: 'Google Sign-In ist nicht konfiguriert' });
      return;
    }

    const { idToken } = req.body as { idToken: string };

    try {
      // 1. Verify Google ID token against the iOS client ID (audience claim).
      //    We also accept the web client ID if configured — useful for future platforms.
      let googleSub: string;
      let googleEmail: string | null;
      let googleName: string | null;
      try {
        const audiences = [config.google.clientIdIos];
        if (config.google.clientIdWeb) audiences.push(config.google.clientIdWeb);
        const ticket = await googleOAuth2Client.verifyIdToken({ idToken, audience: audiences });
        const payload = ticket.getPayload();
        if (!payload?.sub) throw new Error('Empty payload');
        googleSub = payload.sub;
        googleEmail = payload.email ?? null;
        googleName = payload.name ?? payload.given_name ?? null;
      } catch (verifyErr) {
        logger.warn({ verifyErr }, 'Google ID token verification failed');
        res.status(401).json({ error: 'Google-Authentifizierung fehlgeschlagen' });
        return;
      }

      // 2a. Find by google_id → existing Google user
      let [rows] = await pool.query<GoogleUserRow[]>(
        'SELECT id, name, email, password_hash, share_code FROM users WHERE google_id = ?',
        [googleSub],
      );
      if (rows.length > 0) {
        const response = await issueTokenPair(rows[0]);
        res.json(response);
        return;
      }

      // 2b. Find by email → account linking (email+password or Apple account ↔ Google ID)
      if (googleEmail) {
        [rows] = await pool.query<GoogleUserRow[]>(
          'SELECT id, name, email, password_hash, share_code FROM users WHERE email = ?',
          [googleEmail],
        );
        if (rows.length > 0) {
          const user = rows[0];
          await pool.query('UPDATE users SET google_id = ? WHERE id = ?', [googleSub, user.id]);
          logger.info({ userId: user.id }, 'Google account linked via email match');
          const response = await issueTokenPair(user);
          res.json(response);
          return;
        }
      }

      // 2c. New user — Google only (no password)
      const userName =
        typeof googleName === 'string' && googleName.trim().length > 0
          ? googleName.trim().slice(0, 64)
          : 'Watchd-User';
      const shareCode = await generateUniqueShareCode();
      const [result] = await pool.query<ResultSetHeader>(
        'INSERT INTO users (name, email, google_id, share_code) VALUES (?, ?, ?, ?)',
        [userName, googleEmail, googleSub, shareCode],
      );
      logger.info({ userId: result.insertId }, 'New user created via Google Sign-In');
      const response = await issueTokenPair({
        id: result.insertId,
        name: userName,
        email: googleEmail,
        share_code: shareCode,
        password_hash: null,
      });
      res.status(201).json(response);
    } catch (err) {
      logger.error({ err }, 'Google sign-in error');
      res.status(500).json({ error: 'Interner Serverfehler' });
    }
  },
);

router.post(
  '/forgot-password',
  [body('email').isEmail().normalizeEmail().withMessage('Ungültige E-Mail-Adresse')],
  async (req: Request, res: Response): Promise<void> => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ error: errors.array()[0].msg });
      return;
    }
    const { email } = req.body as { email: string };
    try {
      const [users] = await pool.query<UserRow[]>(
        'SELECT id, password_hash FROM users WHERE email = ?',
        [email],
      );
      if (users.length > 0 && users[0].password_hash) {
        const userId = users[0].id;
        const token = crypto.randomBytes(32).toString('hex');
        const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
        const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
        await pool.query(
          'INSERT INTO password_reset_tokens (user_id, token_hash, expires_at, used) VALUES (?, ?, ?, ?)',
          [userId, tokenHash, expiresAt, false],
        );
        try {
          await sendPasswordResetEmail(email, token);
        } catch (mailErr) {
          logger.error({ mailErr, userId }, 'Failed to send reset email');
        }
      }
      res.json({ message: 'Falls diese E-Mail registriert ist, wurde ein Reset-Link gesendet.' });
    } catch (err) {
      logger.error({ err }, 'Forgot password error');
      res.status(500).json({ error: 'Interner Serverfehler' });
    }
  },
);

router.post(
  '/reset-password',
  [
    body('token').isLength({ min: 1 }).withMessage('Token ist erforderlich'),
    body('newPassword')
      .isLength({ min: 8, max: 128 })
      .withMessage('Passwort muss zwischen 8 und 128 Zeichen lang sein'),
  ],
  async (req: Request, res: Response): Promise<void> => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ error: errors.array()[0].msg });
      return;
    }
    const { token, newPassword } = req.body as { token: string; newPassword: string };
    try {
      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
      const [tokens] = await pool.query<ResetTokenRow[]>(
        'SELECT id, user_id, expires_at, used FROM password_reset_tokens WHERE token_hash = ?',
        [tokenHash],
      );
      if (tokens.length === 0 || tokens[0].used || new Date() > tokens[0].expires_at) {
        res.status(400).json({ error: 'Ungültiger oder abgelaufener Token' });
        return;
      }
      const resetToken = tokens[0];
      const passwordHash = await bcrypt.hash(newPassword, config.bcryptRounds);
      await pool.query('UPDATE users SET password_hash = ? WHERE id = ?', [
        passwordHash,
        resetToken.user_id,
      ]);
      await pool.query('UPDATE password_reset_tokens SET used = ? WHERE id = ?', [
        true,
        resetToken.id,
      ]);
      await pool.query('UPDATE refresh_tokens SET revoked = TRUE WHERE user_id = ?', [
        resetToken.user_id,
      ]);
      res.json({ message: 'Passwort erfolgreich zurueckgesetzt' });
    } catch (err) {
      logger.error({ err }, 'Reset password error');
      res.status(500).json({ error: 'Interner Serverfehler' });
    }
  },
);

router.post('/logout', async (req: Request, res: Response): Promise<void> => {
  const { refreshToken } = req.body as { refreshToken?: string };
  if (!refreshToken) {
    res.json({ message: 'Abgemeldet' });
    return;
  }
  const decoded = decodeRefreshToken(refreshToken);
  if (!decoded) {
    res.json({ message: 'Abgemeldet' });
    return;
  }
  try {
    const tokenHash = crypto.createHash('sha256').update(decoded.tok).digest('hex');
    await pool.query('UPDATE refresh_tokens SET revoked = TRUE WHERE token_hash = ?', [tokenHash]);
    res.json({ message: 'Abgemeldet' });
  } catch (err) {
    logger.error({ err }, 'Logout error');
    res.json({ message: 'Abgemeldet' });
  }
});

router.delete(
  '/delete-account',
  authMiddleware,
  async (req: Request, res: Response): Promise<void> => {
    const userId = (req as AuthRequest).user.userId;
    try {
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();

        // Fetch Apple refresh token before cascade-delete (needed for revocation)
        const [appleRows] = await conn.query<AppleUserRow[]>(
          'SELECT apple_refresh_token FROM users WHERE id = ?',
          [userId],
        );
        const appleRefreshToken = appleRows[0]?.apple_refresh_token ?? null;

        await conn.query('UPDATE refresh_tokens SET revoked = TRUE WHERE user_id = ?', [userId]);
        await conn.query('UPDATE password_reset_tokens SET used = TRUE WHERE user_id = ?', [
          userId,
        ]);
        await conn.query('DELETE FROM users WHERE id = ?', [userId]);
        await conn.commit();

        disconnectUserSockets(userId);
        logger.info({ userId }, 'User account deleted (DSGVO/Apple compliance)');

        // Revoke Apple token fire-and-forget after successful DB commit
        if (appleRefreshToken && config.apple.servicesId && config.apple.privateKey) {
          revokeAppleToken(appleRefreshToken).catch((revokeErr) => {
            logger.warn({ revokeErr, userId }, 'Apple token revocation failed — non-critical');
          });
        }

        res.json({ message: 'Konto wurde vollstaendig geloescht' });
      } catch (txErr) {
        await conn.rollback();
        throw txErr;
      } finally {
        conn.release();
      }
    } catch (err) {
      logger.error({ err, userId }, 'Delete account error');
      res.status(500).json({ error: 'Interner Serverfehler' });
    }
  },
);

export default router;
