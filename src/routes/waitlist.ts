import type { Request, Response } from 'express';
import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import { pool } from '../db/connection';
import { logger } from '../logger';

const router = Router();

router.post(
  '/',
  [
    body('email')
      .trim()
      .isEmail()
      .withMessage('Ungültige E-Mail-Adresse.')
      .isLength({ max: 255 })
      .withMessage('Ungültige E-Mail-Adresse.')
      .normalizeEmail({ gmail_remove_dots: false }),
  ],
  async (req: Request, res: Response): Promise<void> => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ error: 'Ungültige E-Mail-Adresse.' });
      return;
    }

    const { email } = req.body as { email: string };

    try {
      await pool.query('INSERT INTO waitlist_emails (email) VALUES (?)', [email]);
      logger.info({ email }, 'Waitlist signup');
      res.status(201).json({ message: 'Erfolgreich eingetragen' });
    } catch (err: unknown) {
      if ((err as { code?: string }).code === 'ER_DUP_ENTRY') {
        res.status(409).json({ error: 'Diese E-Mail ist bereits eingetragen.' });
        return;
      }
      logger.error({ err }, 'Waitlist insert failed');
      res.status(500).json({ error: 'Interner Serverfehler' });
    }
  },
);

export default router;
