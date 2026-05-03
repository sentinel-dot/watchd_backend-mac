import type { Request, Response } from 'express';
import { Router } from 'express';
import { pool } from '../db/connection';
import type { AuthRequest } from '../middleware/auth';
import { authMiddleware } from '../middleware/auth';
import { logger } from '../logger';
import { getIo } from '../socket';
import { SocketEvents } from '../socket/events';
import { generatePartnershipStack, type PartnershipFilters } from '../services/partnership-stack';
import { sendPartnershipAcceptedPush, sendPartnershipRequestPush } from '../services/apns';
import type { ResultSetHeader, RowDataPacket } from 'mysql2';

const router = Router();

interface UserLookupRow extends RowDataPacket {
  id: number;
  name: string;
  device_token: string | null;
}

interface PartnershipRow extends RowDataPacket {
  id: number;
  status: 'pending' | 'active';
  requester_id: number;
  addressee_id: number;
  filters: string | Record<string, unknown> | null;
  last_activity_at: Date;
  created_at: Date;
  accepted_at: Date | null;
  partner_id: number;
  partner_name: string;
}

interface MembershipRow extends RowDataPacket {
  user_id: number;
}

interface CountRow extends RowDataPacket {
  c: number;
}

interface FiltersRow extends RowDataPacket {
  filters: string | Record<string, unknown> | null;
}

function parseFilters(raw: string | Record<string, unknown> | null): PartnershipFilters | null {
  if (!raw) return null;
  if (typeof raw === 'object') return raw as PartnershipFilters;
  try {
    return JSON.parse(raw) as PartnershipFilters;
  } catch {
    return null;
  }
}

function serializePartnership(row: PartnershipRow) {
  return {
    id: row.id,
    status: row.status,
    requesterId: row.requester_id,
    addresseeId: row.addressee_id,
    filters: parseFilters(row.filters),
    partner: { id: row.partner_id, name: row.partner_name },
    createdAt: row.created_at,
    acceptedAt: row.accepted_at,
    lastActivityAt: row.last_activity_at,
  };
}

function validateFilters(filters: unknown): { ok: true } | { ok: false; error: string } {
  if (filters === undefined || filters === null) return { ok: true };
  if (typeof filters !== 'object' || Array.isArray(filters)) {
    return { ok: false, error: 'Ungueltige Filter' };
  }
  const { genres, streamingServices, yearFrom, minRating, maxRuntime, language } =
    filters as Record<string, unknown>;
  if (genres !== undefined && (!Array.isArray(genres) || genres.length > 20)) {
    return { ok: false, error: 'Maximal 20 Genres erlaubt' };
  }
  if (
    streamingServices !== undefined &&
    (!Array.isArray(streamingServices) || streamingServices.length > 10)
  ) {
    return { ok: false, error: 'Maximal 10 Streaming-Dienste erlaubt' };
  }
  if (
    yearFrom !== undefined &&
    (typeof yearFrom !== 'number' || yearFrom < 1900 || yearFrom > 2100)
  ) {
    return { ok: false, error: 'Ungueltige Jahresangabe' };
  }
  if (
    minRating !== undefined &&
    (typeof minRating !== 'number' || minRating < 0 || minRating > 10)
  ) {
    return { ok: false, error: 'Bewertung muss zwischen 0 und 10 liegen' };
  }
  if (
    maxRuntime !== undefined &&
    (typeof maxRuntime !== 'number' || maxRuntime < 1 || maxRuntime > 600)
  ) {
    return { ok: false, error: 'Ungueltige Laufzeit' };
  }
  if (language !== undefined && (typeof language !== 'string' || language.length > 5)) {
    return { ok: false, error: 'Ungueltige Sprache' };
  }
  return { ok: true };
}

// POST /api/partnerships/request — User schickt Anfrage via Code des anderen
router.post('/request', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  const userId = (req as AuthRequest).user.userId;
  const { shareCode } = req.body as { shareCode?: string };

  if (!shareCode || typeof shareCode !== 'string') {
    res.status(400).json({ error: 'shareCode ist erforderlich' });
    return;
  }

  const normalized = shareCode.trim().toUpperCase();
  if (normalized.length !== 8) {
    res.status(400).json({ error: 'Share-Code muss 8 Zeichen lang sein' });
    return;
  }

  try {
    const [targetRows] = await pool.query<UserLookupRow[]>(
      'SELECT id, name, device_token FROM users WHERE share_code = ?',
      [normalized],
    );

    if (targetRows.length === 0) {
      res.status(404).json({ error: 'Code unbekannt' });
      return;
    }

    const target = targetRows[0];

    if (target.id === userId) {
      res.status(400).json({ error: 'Du kannst dich nicht selbst hinzufügen' });
      return;
    }

    const [existing] = await pool.query<RowDataPacket[]>(
      `SELECT id FROM partnerships
       WHERE (requester_id = ? AND addressee_id = ?)
          OR (requester_id = ? AND addressee_id = ?)`,
      [userId, target.id, target.id, userId],
    );

    if (existing.length > 0) {
      res.status(409).json({ error: 'Eine Partnerschaft existiert bereits' });
      return;
    }

    const [requesterRows] = await pool.query<UserLookupRow[]>(
      'SELECT id, name, device_token FROM users WHERE id = ?',
      [userId],
    );
    if (requesterRows.length === 0) {
      res.status(404).json({ error: 'Benutzer nicht gefunden' });
      return;
    }
    const requester = requesterRows[0];

    const conn = await pool.getConnection();
    let partnershipId: number;
    try {
      await conn.beginTransaction();
      const [insertResult] = await conn.query<ResultSetHeader>(
        'INSERT INTO partnerships (requester_id, addressee_id, status, user_a_id, user_b_id) VALUES (?, ?, ?, ?, ?)',
        [userId, target.id, 'pending', Math.min(userId, target.id), Math.max(userId, target.id)],
      );
      partnershipId = insertResult.insertId;
      await conn.query('INSERT INTO partnership_members (partnership_id, user_id) VALUES (?, ?)', [
        partnershipId,
        userId,
      ]);
      await conn.commit();
    } catch (txErr) {
      await conn.rollback();
      throw txErr;
    } finally {
      conn.release();
    }

    const io = getIo();
    io.to(`user:${target.id}`).emit(SocketEvents.PARTNERSHIP_REQUEST, {
      partnershipId,
      requester: { id: requester.id, name: requester.name },
    });

    if (target.device_token) {
      sendPartnershipRequestPush(target.device_token, requester.name, partnershipId).catch(
        (err: unknown) => logger.error({ err }, 'Partnership request push failed'),
      );
    }

    res.status(201).json({
      partnership: {
        id: partnershipId,
        status: 'pending',
        requesterId: userId,
        addresseeId: target.id,
        partner: { id: target.id, name: target.name },
      },
    });
  } catch (err) {
    logger.error({ err, userId }, 'Partnership request error');
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

// POST /api/partnerships/:id/accept — Addressee bestätigt
router.post('/:id/accept', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  const userId = (req as AuthRequest).user.userId;
  const partnershipId = parseInt(req.params['id'], 10);

  if (isNaN(partnershipId)) {
    res.status(400).json({ error: 'Ungueltige Partnership-ID' });
    return;
  }

  try {
    const [rows] = await pool.query<RowDataPacket[]>(
      'SELECT id, status, requester_id, addressee_id, filters FROM partnerships WHERE id = ?',
      [partnershipId],
    );
    if (rows.length === 0) {
      res.status(404).json({ error: 'Partnerschaft nicht gefunden' });
      return;
    }
    const partnership = rows[0] as {
      id: number;
      status: 'pending' | 'active';
      requester_id: number;
      addressee_id: number;
      filters: string | null;
    };

    if (partnership.addressee_id !== userId) {
      res.status(403).json({ error: 'Nur der Empfänger darf bestätigen' });
      return;
    }
    if (partnership.status !== 'pending') {
      res.status(400).json({ error: 'Partnerschaft ist nicht ausstehend' });
      return;
    }

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query(
        "UPDATE partnerships SET status = 'active', accepted_at = NOW(), last_activity_at = NOW() WHERE id = ?",
        [partnershipId],
      );
      await conn.query(
        'INSERT IGNORE INTO partnership_members (partnership_id, user_id) VALUES (?, ?)',
        [partnershipId, userId],
      );
      await conn.commit();
    } catch (txErr) {
      await conn.rollback();
      throw txErr;
    } finally {
      conn.release();
    }

    const filters = parseFilters(partnership.filters) ?? {};
    try {
      await generatePartnershipStack(partnershipId, filters);
    } catch (stackErr) {
      logger.error(
        { stackErr, partnershipId },
        'Initial stack generation failed after accept (continuing)',
      );
    }

    const [requesterRows] = await pool.query<UserLookupRow[]>(
      'SELECT id, name, device_token FROM users WHERE id = ?',
      [partnership.requester_id],
    );
    const [addresseeRows] = await pool.query<UserLookupRow[]>(
      'SELECT id, name FROM users WHERE id = ?',
      [userId],
    );

    const io = getIo();
    io.to(`user:${partnership.requester_id}`).emit(SocketEvents.PARTNERSHIP_ACCEPTED, {
      partnershipId,
      partner: addresseeRows[0]
        ? { id: addresseeRows[0].id, name: addresseeRows[0].name }
        : { id: userId, name: '' },
    });

    if (requesterRows.length > 0 && requesterRows[0].device_token && addresseeRows.length > 0) {
      sendPartnershipAcceptedPush(
        requesterRows[0].device_token,
        addresseeRows[0].name,
        partnershipId,
      ).catch((err: unknown) => logger.error({ err }, 'Partnership accepted push failed'));
    }

    res.json({
      partnership: {
        id: partnershipId,
        status: 'active',
        requesterId: partnership.requester_id,
        addresseeId: userId,
        partner: requesterRows[0] ? { id: requesterRows[0].id, name: requesterRows[0].name } : null,
      },
    });
  } catch (err) {
    logger.error({ err, userId, partnershipId }, 'Partnership accept error');
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

// POST /api/partnerships/:id/decline — Addressee lehnt ab
router.post('/:id/decline', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  const userId = (req as AuthRequest).user.userId;
  const partnershipId = parseInt(req.params['id'], 10);

  if (isNaN(partnershipId)) {
    res.status(400).json({ error: 'Ungueltige Partnership-ID' });
    return;
  }

  try {
    const [rows] = await pool.query<RowDataPacket[]>(
      'SELECT id, status, addressee_id FROM partnerships WHERE id = ?',
      [partnershipId],
    );
    if (rows.length === 0) {
      res.status(404).json({ error: 'Partnerschaft nicht gefunden' });
      return;
    }
    const partnership = rows[0] as {
      id: number;
      status: 'pending' | 'active';
      addressee_id: number;
    };
    if (partnership.addressee_id !== userId) {
      res.status(403).json({ error: 'Nur der Empfänger darf ablehnen' });
      return;
    }
    if (partnership.status !== 'pending') {
      res.status(400).json({ error: 'Partnerschaft ist nicht ausstehend' });
      return;
    }

    await pool.query('DELETE FROM partnerships WHERE id = ?', [partnershipId]);
    res.json({ deleted: true });
  } catch (err) {
    logger.error({ err, userId, partnershipId }, 'Partnership decline error');
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

// DELETE /api/partnerships/:id/cancel-request — Requester zieht zurück
router.delete(
  '/:id/cancel-request',
  authMiddleware,
  async (req: Request, res: Response): Promise<void> => {
    const userId = (req as AuthRequest).user.userId;
    const partnershipId = parseInt(req.params['id'], 10);

    if (isNaN(partnershipId)) {
      res.status(400).json({ error: 'Ungueltige Partnership-ID' });
      return;
    }

    try {
      const [rows] = await pool.query<RowDataPacket[]>(
        'SELECT id, status, requester_id FROM partnerships WHERE id = ?',
        [partnershipId],
      );
      if (rows.length === 0) {
        res.status(404).json({ error: 'Partnerschaft nicht gefunden' });
        return;
      }
      const partnership = rows[0] as {
        id: number;
        status: 'pending' | 'active';
        requester_id: number;
      };
      if (partnership.requester_id !== userId) {
        res.status(403).json({ error: 'Nur der Anfragende darf zurückziehen' });
        return;
      }
      if (partnership.status !== 'pending') {
        res.status(400).json({ error: 'Partnerschaft ist nicht ausstehend' });
        return;
      }

      await pool.query('DELETE FROM partnerships WHERE id = ?', [partnershipId]);
      res.json({ deleted: true });
    } catch (err) {
      logger.error({ err, userId, partnershipId }, 'Partnership cancel-request error');
      res.status(500).json({ error: 'Interner Serverfehler' });
    }
  },
);

// GET /api/partnerships — incoming / outgoing / active
router.get('/', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  const userId = (req as AuthRequest).user.userId;

  try {
    const baseSelect = `
      SELECT
        p.id, p.status, p.requester_id, p.addressee_id, p.filters,
        p.last_activity_at, p.created_at, p.accepted_at,
        partner.id AS partner_id,
        partner.name AS partner_name
      FROM partnerships p
      JOIN users partner
        ON partner.id = CASE WHEN p.requester_id = ? THEN p.addressee_id ELSE p.requester_id END
    `;

    const [incomingRows] = await pool.query<PartnershipRow[]>(
      `${baseSelect} WHERE p.addressee_id = ? AND p.status = 'pending' ORDER BY p.created_at DESC`,
      [userId, userId],
    );
    const [outgoingRows] = await pool.query<PartnershipRow[]>(
      `${baseSelect} WHERE p.requester_id = ? AND p.status = 'pending' ORDER BY p.created_at DESC`,
      [userId, userId],
    );
    const [activeRows] = await pool.query<PartnershipRow[]>(
      `${baseSelect} WHERE (p.requester_id = ? OR p.addressee_id = ?) AND p.status = 'active' ORDER BY p.last_activity_at DESC`,
      [userId, userId, userId],
    );

    res.json({
      incoming: incomingRows.map(serializePartnership),
      outgoing: outgoingRows.map(serializePartnership),
      active: activeRows.map(serializePartnership),
    });
  } catch (err) {
    logger.error({ err, userId }, 'List partnerships error');
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

// GET /api/partnerships/:id — Detail
router.get('/:id', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  const userId = (req as AuthRequest).user.userId;
  const partnershipId = parseInt(req.params['id'], 10);

  if (isNaN(partnershipId)) {
    res.status(400).json({ error: 'Ungueltige Partnership-ID' });
    return;
  }

  try {
    const [rows] = await pool.query<PartnershipRow[]>(
      `SELECT
         p.id, p.status, p.requester_id, p.addressee_id, p.filters,
         p.last_activity_at, p.created_at, p.accepted_at,
         partner.id AS partner_id,
         partner.name AS partner_name
       FROM partnerships p
       JOIN users partner
         ON partner.id = CASE WHEN p.requester_id = ? THEN p.addressee_id ELSE p.requester_id END
       WHERE p.id = ?`,
      [userId, partnershipId],
    );

    if (rows.length === 0) {
      res.status(404).json({ error: 'Partnerschaft nicht gefunden' });
      return;
    }

    const partnership = rows[0];
    if (partnership.requester_id !== userId && partnership.addressee_id !== userId) {
      res.status(403).json({ error: 'Kein Zugriff auf diese Partnerschaft' });
      return;
    }

    res.json({ partnership: serializePartnership(partnership) });
  } catch (err) {
    logger.error({ err, userId, partnershipId }, 'Get partnership error');
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

// PATCH /api/partnerships/:id/filters
router.patch('/:id/filters', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  const userId = (req as AuthRequest).user.userId;
  const partnershipId = parseInt(req.params['id'], 10);
  const { filters } = req.body as { filters?: Record<string, unknown> };

  if (isNaN(partnershipId)) {
    res.status(400).json({ error: 'Ungueltige Partnership-ID' });
    return;
  }

  const validation = validateFilters(filters);
  if (!validation.ok) {
    res.status(400).json({ error: validation.error });
    return;
  }

  try {
    const [membership] = await pool.query<MembershipRow[]>(
      'SELECT user_id FROM partnership_members WHERE partnership_id = ? AND user_id = ?',
      [partnershipId, userId],
    );
    if (membership.length === 0) {
      res.status(403).json({ error: 'Kein Mitglied dieser Partnerschaft' });
      return;
    }

    const filtersJson = filters ? JSON.stringify(filters) : null;
    await pool.query('UPDATE partnerships SET filters = ?, last_activity_at = NOW() WHERE id = ?', [
      filtersJson,
      partnershipId,
    ]);

    try {
      await generatePartnershipStack(partnershipId, (filters as PartnershipFilters) || {});
    } catch (stackErr) {
      logger.error(
        { stackErr, partnershipId },
        'Stack regeneration failed after filter change (continuing)',
      );
    }

    const io = getIo();
    io.to(`partnership:${partnershipId}`).emit(SocketEvents.FILTERS_UPDATED, {
      filters: filters ?? null,
    });

    const [stored] = await pool.query<FiltersRow[]>(
      'SELECT filters FROM partnerships WHERE id = ?',
      [partnershipId],
    );

    res.json({
      partnershipId,
      filters: stored.length > 0 ? parseFilters(stored[0].filters) : null,
    });
  } catch (err) {
    logger.error({ err, userId, partnershipId }, 'Update partnership filters error');
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

// DELETE /api/partnerships/:id — Partnerschaft beenden (cascade)
router.delete('/:id', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  const userId = (req as AuthRequest).user.userId;
  const partnershipId = parseInt(req.params['id'], 10);

  if (isNaN(partnershipId)) {
    res.status(400).json({ error: 'Ungueltige Partnership-ID' });
    return;
  }

  try {
    const [rows] = await pool.query<CountRow[]>(
      `SELECT COUNT(*) AS c FROM partnerships
       WHERE id = ? AND (requester_id = ? OR addressee_id = ?)`,
      [partnershipId, userId, userId],
    );
    if (rows[0].c === 0) {
      res.status(403).json({ error: 'Kein Zugriff auf diese Partnerschaft' });
      return;
    }

    await pool.query('DELETE FROM partnerships WHERE id = ?', [partnershipId]);

    const io = getIo();
    const channel = `partnership:${partnershipId}`;
    io.to(channel).emit(SocketEvents.PARTNERSHIP_ENDED, { partnershipId });
    io.in(channel).disconnectSockets(true);

    res.json({ deleted: true });
  } catch (err) {
    logger.error({ err, userId, partnershipId }, 'Delete partnership error');
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

export default router;
