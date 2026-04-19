import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { body, validationResult } from 'express-validator';
import { pool } from '../db/connection';
import { config } from '../config';
import { logger } from '../logger';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { sendPasswordResetEmail } from '../services/mail';
import { disconnectUserSockets } from '../socket';
import { RowDataPacket, ResultSetHeader } from 'mysql2';

const router = Router();

interface UserRow extends RowDataPacket {
  id: number;
  name: string;
  email: string | null;
  password_hash: string | null;
  is_guest: boolean;
  created_at: Date;
}

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

function signAccessToken(userId: number, email: string | null, isGuest: boolean): string {
  return jwt.sign({ userId, email, isGuest }, config.jwtSecret, { expiresIn: '15m' });
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

export function decodeRefreshToken(encoded: string): { uid: number; tok: string; fam: string } | null {
  try {
    return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf-8'));
  } catch {
    return null;
  }
}

async function issueTokenPair(
  user: { id: number; name: string; email: string | null; is_guest: boolean },
  existingFamily?: string,
) {
  const accessToken = signAccessToken(user.id, user.email, !!user.is_guest);
  const refreshToken = await createRefreshToken(user.id, existingFamily);
  return {
    token: accessToken,
    refreshToken,
    user: { id: user.id, name: user.name, email: user.email, isGuest: !!user.is_guest },
  };
}

const GUEST_ADJECTIVES = ['Roter', 'Blauer', 'Gruener', 'Gelber', 'Mutiger', 'Schneller', 'Kluger', 'Flinker', 'Starker', 'Wilder'];
const GUEST_ANIMALS = ['Panda', 'Tiger', 'Fuchs', 'Wolf', 'Baer', 'Adler', 'Falke', 'Loewe', 'Gepard', 'Delfin'];

function generateGuestName(): string {
  const adj = GUEST_ADJECTIVES[Math.floor(Math.random() * GUEST_ADJECTIVES.length)];
  const animal = GUEST_ANIMALS[Math.floor(Math.random() * GUEST_ANIMALS.length)];
  return `${adj} ${animal}`;
}

router.post('/register', [
  body('name').trim().isLength({ min: 1, max: 64 }).withMessage('Name muss zwischen 1 und 64 Zeichen lang sein'),
  body('email').isEmail().isLength({ max: 254 }).normalizeEmail().withMessage('Ungueltige E-Mail-Adresse'),
  body('password').isLength({ min: 8, max: 128 }).withMessage('Passwort muss zwischen 8 und 128 Zeichen lang sein'),
], async (req: Request, res: Response): Promise<void> => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) { res.status(400).json({ error: errors.array()[0].msg }); return; }
  const { name, email, password } = req.body as { name: string; email: string; password: string };
  try {
    const [existing] = await pool.query<UserRow[]>('SELECT id FROM users WHERE email = ?', [email]);
    if (existing.length > 0) { res.status(409).json({ error: 'Diese E-Mail ist bereits registriert' }); return; }
    const passwordHash = await bcrypt.hash(password, config.bcryptRounds);
    const [result] = await pool.query<ResultSetHeader>(
      'INSERT INTO users (name, email, password_hash, is_guest) VALUES (?, ?, ?, ?)',
      [name, email, passwordHash, false],
    );
    const response = await issueTokenPair({ id: result.insertId, name, email, is_guest: false });
    res.status(201).json(response);
  } catch (err) {
    logger.error({ err }, 'Register error');
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

router.post('/login', [
  body('email').isEmail().normalizeEmail().withMessage('Ungueltige E-Mail-Adresse'),
  body('password').isLength({ min: 1 }).withMessage('Passwort ist erforderlich'),
], async (req: Request, res: Response): Promise<void> => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) { res.status(400).json({ error: errors.array()[0].msg }); return; }
  const { email, password } = req.body as { email: string; password: string };
  try {
    const [rows] = await pool.query<UserRow[]>('SELECT id, name, email, password_hash, is_guest FROM users WHERE email = ?', [email]);
    if (rows.length === 0) { res.status(401).json({ error: 'Ungueltige Anmeldedaten' }); return; }
    const user = rows[0];
    if (!user.password_hash) { res.status(401).json({ error: 'Ungueltige Anmeldedaten' }); return; }
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) { res.status(401).json({ error: 'Ungueltige Anmeldedaten' }); return; }
    const response = await issueTokenPair(user);
    res.json(response);
  } catch (err) {
    logger.error({ err }, 'Login error');
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

router.post('/guest', async (_req: Request, res: Response): Promise<void> => {
  try {
    const name = generateGuestName();
    const [result] = await pool.query<ResultSetHeader>(
      'INSERT INTO users (name, email, password_hash, is_guest) VALUES (?, ?, ?, ?)',
      [name, null, null, true],
    );
    const response = await issueTokenPair({ id: result.insertId, name, email: null, is_guest: true });
    res.status(201).json(response);
  } catch (err) {
    logger.error({ err }, 'Guest creation error');
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

router.post('/refresh', async (req: Request, res: Response): Promise<void> => {
  const { refreshToken } = req.body as { refreshToken?: string };
  if (!refreshToken) { res.status(400).json({ error: 'Refresh-Token ist erforderlich' }); return; }
  const decoded = decodeRefreshToken(refreshToken);
  if (!decoded) { res.status(401).json({ error: 'Ungueltiger Refresh-Token' }); return; }
  const tokenHash = crypto.createHash('sha256').update(decoded.tok).digest('hex');
  try {
    const [rows] = await pool.query<RefreshTokenRow[]>(
      'SELECT id, user_id, family_id, expires_at, revoked FROM refresh_tokens WHERE token_hash = ?', [tokenHash],
    );
    if (rows.length === 0) { res.status(401).json({ error: 'Ungueltiger Refresh-Token' }); return; }
    const storedToken = rows[0];
    if (storedToken.revoked) {
      logger.warn({ userId: storedToken.user_id, familyId: storedToken.family_id }, 'Refresh token reuse detected');
      await pool.query('UPDATE refresh_tokens SET revoked = TRUE WHERE family_id = ?', [storedToken.family_id]);
      res.status(401).json({ error: 'Token wurde bereits verwendet. Bitte erneut anmelden.' });
      return;
    }
    if (new Date() > storedToken.expires_at) { res.status(401).json({ error: 'Refresh-Token abgelaufen' }); return; }
    await pool.query('UPDATE refresh_tokens SET revoked = TRUE WHERE id = ?', [storedToken.id]);
    const [users] = await pool.query<UserRow[]>('SELECT id, name, email, is_guest FROM users WHERE id = ?', [storedToken.user_id]);
    if (users.length === 0) { res.status(401).json({ error: 'Benutzer nicht gefunden' }); return; }
    const response = await issueTokenPair(users[0], storedToken.family_id);
    res.json(response);
  } catch (err) {
    logger.error({ err }, 'Refresh token error');
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

router.post('/upgrade', authMiddleware, [
  body('email').isEmail().isLength({ max: 254 }).normalizeEmail().withMessage('Ungueltige E-Mail-Adresse'),
  body('password').isLength({ min: 8, max: 128 }).withMessage('Passwort muss zwischen 8 und 128 Zeichen lang sein'),
], async (req: Request, res: Response): Promise<void> => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) { res.status(400).json({ error: errors.array()[0].msg }); return; }
  const userId = (req as AuthRequest).user.userId;
  const { email, password } = req.body as { email: string; password: string };
  try {
    const [users] = await pool.query<UserRow[]>('SELECT is_guest FROM users WHERE id = ?', [userId]);
    if (users.length === 0 || !users[0].is_guest) { res.status(400).json({ error: 'Nur Gast-Konten koennen aufgewertet werden' }); return; }
    const [existing] = await pool.query<UserRow[]>('SELECT id FROM users WHERE email = ?', [email]);
    if (existing.length > 0) { res.status(409).json({ error: 'Diese E-Mail ist bereits registriert' }); return; }
    const passwordHash = await bcrypt.hash(password, config.bcryptRounds);
    await pool.query('UPDATE users SET email = ?, password_hash = ?, is_guest = ? WHERE id = ?', [email, passwordHash, false, userId]);
    const [updated] = await pool.query<UserRow[]>('SELECT id, name, email, is_guest FROM users WHERE id = ?', [userId]);
    const response = await issueTokenPair(updated[0]);
    res.json(response);
  } catch (err) {
    logger.error({ err }, 'Upgrade account error');
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

router.post('/forgot-password', [
  body('email').isEmail().normalizeEmail().withMessage('Ungueltige E-Mail-Adresse'),
], async (req: Request, res: Response): Promise<void> => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) { res.status(400).json({ error: errors.array()[0].msg }); return; }
  const { email } = req.body as { email: string };
  try {
    const [users] = await pool.query<UserRow[]>('SELECT id, is_guest FROM users WHERE email = ?', [email]);
    if (users.length > 0 && !users[0].is_guest) {
      const userId = users[0].id;
      const token = crypto.randomBytes(32).toString('hex');
      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
      await pool.query('INSERT INTO password_reset_tokens (user_id, token_hash, expires_at, used) VALUES (?, ?, ?, ?)', [userId, tokenHash, expiresAt, false]);
      try { await sendPasswordResetEmail(email, token); } catch (mailErr) { logger.error({ mailErr, userId }, 'Failed to send reset email'); }
    }
    res.json({ message: 'Falls diese E-Mail registriert ist, wurde ein Reset-Link gesendet.' });
  } catch (err) {
    logger.error({ err }, 'Forgot password error');
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

router.post('/reset-password', [
  body('token').isLength({ min: 1 }).withMessage('Token ist erforderlich'),
  body('newPassword').isLength({ min: 8, max: 128 }).withMessage('Passwort muss zwischen 8 und 128 Zeichen lang sein'),
], async (req: Request, res: Response): Promise<void> => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) { res.status(400).json({ error: errors.array()[0].msg }); return; }
  const { token, newPassword } = req.body as { token: string; newPassword: string };
  try {
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const [tokens] = await pool.query<ResetTokenRow[]>('SELECT id, user_id, expires_at, used FROM password_reset_tokens WHERE token_hash = ?', [tokenHash]);
    if (tokens.length === 0 || tokens[0].used || new Date() > tokens[0].expires_at) { res.status(400).json({ error: 'Ungueltiger oder abgelaufener Token' }); return; }
    const resetToken = tokens[0];
    const passwordHash = await bcrypt.hash(newPassword, config.bcryptRounds);
    await pool.query('UPDATE users SET password_hash = ? WHERE id = ?', [passwordHash, resetToken.user_id]);
    await pool.query('UPDATE password_reset_tokens SET used = ? WHERE id = ?', [true, resetToken.id]);
    await pool.query('UPDATE refresh_tokens SET revoked = TRUE WHERE user_id = ?', [resetToken.user_id]);
    res.json({ message: 'Passwort erfolgreich zurueckgesetzt' });
  } catch (err) {
    logger.error({ err }, 'Reset password error');
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

router.post('/logout', async (req: Request, res: Response): Promise<void> => {
  const { refreshToken } = req.body as { refreshToken?: string };
  if (!refreshToken) { res.json({ message: 'Abgemeldet' }); return; }
  const decoded = decodeRefreshToken(refreshToken);
  if (!decoded) { res.json({ message: 'Abgemeldet' }); return; }
  try {
    const tokenHash = crypto.createHash('sha256').update(decoded.tok).digest('hex');
    await pool.query('UPDATE refresh_tokens SET revoked = TRUE WHERE token_hash = ?', [tokenHash]);
    res.json({ message: 'Abgemeldet' });
  } catch (err) {
    logger.error({ err }, 'Logout error');
    res.json({ message: 'Abgemeldet' });
  }
});

router.delete('/delete-account', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  const userId = (req as AuthRequest).user.userId;
  try {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query('UPDATE refresh_tokens SET revoked = TRUE WHERE user_id = ?', [userId]);
      await conn.query('UPDATE password_reset_tokens SET used = TRUE WHERE user_id = ?', [userId]);
      await conn.query('DELETE FROM users WHERE id = ?', [userId]);
      await conn.commit();
      disconnectUserSockets(userId);
      logger.info({ userId }, 'User account deleted (DSGVO/Apple compliance)');
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
});

export default router;