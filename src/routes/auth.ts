import { Router, Request, Response } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { body, validationResult } from 'express-validator';
import { pool } from '../db/connection';
import { config } from '../config';
import { logger } from '../logger';
import { authMiddleware, AuthRequest } from '../middleware/auth';
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

function signToken(userId: number, email: string | null, isGuest: boolean): string {
  return jwt.sign({ userId, email, isGuest }, config.jwtSecret, { expiresIn: '7d' });
}

const GUEST_ADJECTIVES = [
  'Roter',
  'Blauer',
  'Grüner',
  'Gelber',
  'Mutiger',
  'Schneller',
  'Kluger',
  'Flinker',
  'Starker',
  'Wilder',
];

const GUEST_ANIMALS = [
  'Panda',
  'Tiger',
  'Fuchs',
  'Wolf',
  'Bär',
  'Adler',
  'Falke',
  'Löwe',
  'Gepard',
  'Delfin',
];

function generateGuestName(): string {
  const adj = GUEST_ADJECTIVES[Math.floor(Math.random() * GUEST_ADJECTIVES.length)];
  const animal = GUEST_ANIMALS[Math.floor(Math.random() * GUEST_ANIMALS.length)];
  return `${adj} ${animal}`;
}

router.post(
  '/register',
  [
    body('name').trim().isLength({ min: 1, max: 64 }).withMessage('Name muss zwischen 1 und 64 Zeichen lang sein'),
    body('email').isEmail().isLength({ max: 254 }).normalizeEmail().withMessage('Ungültige E-Mail-Adresse'),
    body('password').isLength({ min: 8, max: 128 }).withMessage('Passwort muss zwischen 8 und 128 Zeichen lang sein'),
  ],
  async (req: Request, res: Response): Promise<void> => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ error: errors.array()[0].msg });
      return;
    }

    const { name, email, password } = req.body as {
      name: string;
      email: string;
      password: string;
    };

    try {
      const [existing] = await pool.query<UserRow[]>('SELECT id FROM users WHERE email = ?', [email]);
      if (existing.length > 0) {
        res.status(409).json({ error: 'Email already registered' });
        return;
      }

      const passwordHash = await bcrypt.hash(password, 12);
      const [result] = await pool.query<ResultSetHeader>(
        'INSERT INTO users (name, email, password_hash, is_guest) VALUES (?, ?, ?, ?)',
        [name, email, passwordHash, false],
      );

      const userId = result.insertId;
      const token = signToken(userId, email, false);

      res.status(201).json({
        token,
        user: { id: userId, name, email, isGuest: false },
      });
    } catch (err) {
      logger.error({ err }, 'Register error');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

router.post('/login', async (req: Request, res: Response): Promise<void> => {
  const { email, password } = req.body as { email?: string; password?: string };

  if (!email || !password) {
    res.status(400).json({ error: 'email and password are required' });
    return;
  }

  try {
    const [rows] = await pool.query<UserRow[]>(
      'SELECT id, name, email, password_hash, is_guest FROM users WHERE email = ?',
      [email],
    );

    if (rows.length === 0) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }

    const user = rows[0];
    
    if (!user.password_hash) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }

    const token = signToken(user.id, user.email, user.is_guest);
    res.json({
      token,
      user: { id: user.id, name: user.name, email: user.email, isGuest: user.is_guest },
    });
  } catch (err) {
    logger.error({ err }, 'Login error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/guest', async (_req: Request, res: Response): Promise<void> => {
  try {
    const guestId = crypto.randomUUID();
    const name = generateGuestName();

    const [result] = await pool.query<ResultSetHeader>(
      'INSERT INTO users (name, email, password_hash, is_guest) VALUES (?, ?, ?, ?)',
      [name, null, null, true],
    );

    const userId = result.insertId;
    const token = signToken(userId, null, true);

    res.status(201).json({
      token,
      user: { id: userId, name, email: null, isGuest: true },
    });
  } catch (err) {
    logger.error({ err }, 'Guest creation error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post(
  '/upgrade',
  authMiddleware,
  [
    body('email').isEmail().isLength({ max: 254 }).normalizeEmail().withMessage('Ungültige E-Mail-Adresse'),
    body('password').isLength({ min: 8, max: 128 }).withMessage('Passwort muss zwischen 8 und 128 Zeichen lang sein'),
  ],
  async (req: Request, res: Response): Promise<void> => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ error: errors.array()[0].msg });
      return;
    }

    const userId = (req as AuthRequest).user.userId;
    const { email, password } = req.body as { email: string; password: string };

    try {
      const [users] = await pool.query<UserRow[]>('SELECT is_guest FROM users WHERE id = ?', [userId]);
      if (users.length === 0 || !users[0].is_guest) {
        res.status(400).json({ error: 'Only guest accounts can be upgraded' });
        return;
      }

      const [existing] = await pool.query<UserRow[]>('SELECT id FROM users WHERE email = ?', [email]);
      if (existing.length > 0) {
        res.status(409).json({ error: 'Email already registered' });
        return;
      }

      const passwordHash = await bcrypt.hash(password, 12);
      await pool.query('UPDATE users SET email = ?, password_hash = ?, is_guest = ? WHERE id = ?', [
        email,
        passwordHash,
        false,
        userId,
      ]);

      const token = signToken(userId, email, false);
      const [updated] = await pool.query<UserRow[]>('SELECT id, name, email, is_guest FROM users WHERE id = ?', [
        userId,
      ]);

      res.json({
        token,
        user: {
          id: updated[0].id,
          name: updated[0].name,
          email: updated[0].email,
          isGuest: updated[0].is_guest,
        },
      });
    } catch (err) {
      logger.error({ err }, 'Upgrade account error');
      res.status(500).json({ error: 'Internal server error' });
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
      const [users] = await pool.query<UserRow[]>('SELECT id, is_guest FROM users WHERE email = ?', [email]);

      if (users.length > 0 && !users[0].is_guest) {
        const userId = users[0].id;
        const token = crypto.randomBytes(32).toString('hex');
        const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
        const expiresAt = new Date(Date.now() + 60 * 60 * 1000);

        await pool.query(
          'INSERT INTO password_reset_tokens (user_id, token_hash, expires_at, used) VALUES (?, ?, ?, ?)',
          [userId, tokenHash, expiresAt, false],
        );

        logger.info({ userId, email }, `Password reset requested. Token (dev only): watchd://reset-password?token=${token}`);
      }

      res.json({ message: 'Falls diese E-Mail registriert ist, wurde ein Reset-Link gesendet.' });
    } catch (err) {
      logger.error({ err }, 'Forgot password error');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

router.post(
  '/reset-password',
  [
    body('token').isLength({ min: 1 }).withMessage('Token ist erforderlich'),
    body('newPassword').isLength({ min: 8, max: 128 }).withMessage('Passwort muss zwischen 8 und 128 Zeichen lang sein'),
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
      const passwordHash = await bcrypt.hash(newPassword, 12);

      await pool.query('UPDATE users SET password_hash = ? WHERE id = ?', [passwordHash, resetToken.user_id]);
      await pool.query('UPDATE password_reset_tokens SET used = ? WHERE id = ?', [true, resetToken.id]);

      res.json({ message: 'Passwort erfolgreich zurückgesetzt' });
    } catch (err) {
      logger.error({ err }, 'Reset password error');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

export default router;
