import type { Request, Response } from 'express';
import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import { pool } from '../db/connection';
import type { AuthRequest } from '../middleware/auth';
import { authMiddleware } from '../middleware/auth';
import { logger } from '../logger';
import { generateUniqueShareCode } from '../services/share-code';
import type { RowDataPacket } from 'mysql2';

const router = Router();

interface UserRow extends RowDataPacket {
  id: number;
  name: string;
  email: string | null;
  share_code: string;
}

interface ShareCodeRow extends RowDataPacket {
  share_code: string;
}

router.patch(
  '/me',
  authMiddleware,
  [
    body('name')
      .trim()
      .isLength({ min: 1, max: 64 })
      .withMessage('Name muss zwischen 1 und 64 Zeichen lang sein'),
  ],
  async (req: Request, res: Response): Promise<void> => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ error: errors.array()[0].msg });
      return;
    }

    const userId = (req as AuthRequest).user.userId;
    const { name } = req.body as { name: string };

    try {
      await pool.query('UPDATE users SET name = ? WHERE id = ?', [name, userId]);

      const [users] = await pool.query<UserRow[]>(
        'SELECT id, name, email, share_code FROM users WHERE id = ?',
        [userId],
      );

      if (users.length === 0) {
        res.status(404).json({ error: 'Benutzer nicht gefunden' });
        return;
      }

      res.json({
        user: {
          id: users[0].id,
          name: users[0].name,
          email: users[0].email,
          shareCode: users[0].share_code,
        },
      });
    } catch (err) {
      logger.error({ err, userId }, 'Update user error');
      res.status(500).json({ error: 'Interner Serverfehler' });
    }
  },
);

router.post(
  '/me/device-token',
  authMiddleware,
  [
    body('deviceToken')
      .isString()
      .trim()
      .isLength({ min: 32, max: 255 })
      .withMessage('Ungültiger Geräte-Token'),
  ],
  async (req: Request, res: Response): Promise<void> => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ error: errors.array()[0].msg });
      return;
    }

    const userId = (req as AuthRequest).user.userId;
    const { deviceToken } = req.body as { deviceToken: string };

    try {
      await pool.query('UPDATE users SET device_token = ? WHERE id = ?', [deviceToken, userId]);
      res.status(204).send();
    } catch (err) {
      logger.error({ err, userId }, 'Save device token error');
      res.status(500).json({ error: 'Interner Serverfehler' });
    }
  },
);

router.get('/me/share-code', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  const userId = (req as AuthRequest).user.userId;
  try {
    const [rows] = await pool.query<ShareCodeRow[]>('SELECT share_code FROM users WHERE id = ?', [
      userId,
    ]);
    if (rows.length === 0) {
      res.status(404).json({ error: 'Benutzer nicht gefunden' });
      return;
    }
    res.json({ shareCode: rows[0].share_code });
  } catch (err) {
    logger.error({ err, userId }, 'Get share-code error');
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

router.post(
  '/me/share-code/regenerate',
  authMiddleware,
  async (req: Request, res: Response): Promise<void> => {
    const userId = (req as AuthRequest).user.userId;
    try {
      const newCode = await generateUniqueShareCode();
      await pool.query('UPDATE users SET share_code = ? WHERE id = ?', [newCode, userId]);
      logger.info({ userId }, 'Share-code regenerated');
      res.json({ shareCode: newCode });
    } catch (err) {
      logger.error({ err, userId }, 'Regenerate share-code error');
      res.status(500).json({ error: 'Interner Serverfehler' });
    }
  },
);

export default router;
