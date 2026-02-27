import { Router, Request, Response } from 'express';
import { body, validationResult } from 'express-validator';
import { pool } from '../db/connection';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { logger } from '../logger';
import { RowDataPacket } from 'mysql2';

const router = Router();

interface UserRow extends RowDataPacket {
  id: number;
  name: string;
  email: string | null;
  is_guest: boolean;
}

router.patch(
  '/me',
  authMiddleware,
  [body('name').trim().isLength({ min: 1, max: 64 }).withMessage('Name muss zwischen 1 und 64 Zeichen lang sein')],
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

      const [users] = await pool.query<UserRow[]>('SELECT id, name, email, is_guest FROM users WHERE id = ?', [
        userId,
      ]);

      if (users.length === 0) {
        res.status(404).json({ error: 'User not found' });
        return;
      }

      res.json({
        user: {
          id: users[0].id,
          name: users[0].name,
          email: users[0].email,
          isGuest: users[0].is_guest,
        },
      });
    } catch (err) {
      logger.error({ err, userId }, 'Update user error');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

export default router;
