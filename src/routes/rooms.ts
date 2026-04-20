import { Router, Request, Response } from 'express';
import { pool } from '../db/connection';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { logger } from '../logger';
import { getIo } from '../socket';
import { SocketEvents } from '../socket/events';
import { generateRoomStack } from '../services/room-stack';
import { RowDataPacket, ResultSetHeader } from 'mysql2';

const router = Router();

interface RoomRow extends RowDataPacket {
  id: number;
  code: string;
  created_by: number;
  created_at: Date;
  status: 'waiting' | 'active' | 'dissolved';
  name: string | null;
  filters: string | null;
  last_activity_at: Date;
}

interface MemberRow extends RowDataPacket {
  user_id: number;
  name: string;
  email: string | null;
  joined_at: Date;
  is_active: boolean;
  deleted_from_archive_at: Date | null;
}

interface CountRow extends RowDataPacket {
  count: number;
}

function generateRoomCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

// POST /api/rooms — create a room
router.post('/', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  const userId = (req as AuthRequest).user.userId;
  const { name, filters } = req.body as { name?: string; filters?: object };

  try {
    let code: string;
    let attempts = 0;
    do {
      code = generateRoomCode();
      attempts++;
      if (attempts > 10) {
        res.status(500).json({ error: 'Eindeutiger Room-Code konnte nicht generiert werden' });
        return;
      }
      const [existing] = await pool.query<RoomRow[]>('SELECT id FROM rooms WHERE code = ?', [code]);
      if (existing.length === 0) break;
    } while (true);

    const filtersJson = filters ? JSON.stringify(filters) : null;

    const [result] = await pool.query<ResultSetHeader>(
      'INSERT INTO rooms (code, created_by, status, name, filters, last_activity_at) VALUES (?, ?, ?, ?, ?, NOW())',
      [code, userId, 'waiting', name || null, filtersJson],
    );
    const roomId = result.insertId;

    await pool.query('INSERT INTO room_members (room_id, user_id, is_active) VALUES (?, ?, ?)', [roomId, userId, true]);

    await generateRoomStack(roomId, filters || {});

    const [rooms] = await pool.query<RoomRow[]>(
      'SELECT id, code, created_by, created_at, status, name, filters, last_activity_at FROM rooms WHERE id = ?',
      [roomId],
    );

    res.status(201).json({ room: rooms[0] });
  } catch (err) {
    logger.error({ err, userId }, 'Create room error');
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

// POST /api/rooms/join — join a room by code
router.post('/join', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  const userId = (req as AuthRequest).user.userId;
  const { code } = req.body as { code?: string };

  if (!code) {
    res.status(400).json({ error: 'Code ist erforderlich' });
    return;
  }

  try {
    const [rooms] = await pool.query<RoomRow[]>(
      'SELECT id, code, created_by, created_at, status, name, filters, last_activity_at FROM rooms WHERE code = ?',
      [code.toUpperCase()],
    );

    if (rooms.length === 0) {
      res.status(404).json({ error: 'Room nicht gefunden' });
      return;
    }

    const room = rooms[0];

    if (room.status === 'dissolved') {
      res.status(410).json({ error: 'Dieser Raum existiert nicht mehr' });
      return;
    }

    const [membership] = await pool.query<MemberRow[]>(
      'SELECT user_id, is_active FROM room_members WHERE room_id = ? AND user_id = ?',
      [room.id, userId],
    );

    if (membership.length > 0) {
      if (!membership[0].is_active) {
        await pool.query('UPDATE room_members SET is_active = ? WHERE room_id = ? AND user_id = ?', [
          true,
          room.id,
          userId,
        ]);
        await pool.query('UPDATE rooms SET status = ?, last_activity_at = NOW() WHERE id = ?', ['active', room.id]);
        room.status = 'active';

        const io = getIo();
        io.to(`room:${room.id}`).emit(SocketEvents.PARTNER_JOINED, { userId });
      }

      res.json({ room });
      return;
    }

    const [countRows] = await pool.query<CountRow[]>(
      'SELECT COUNT(*) AS count FROM room_members WHERE room_id = ?',
      [room.id],
    );

    if (countRows[0].count >= 2) {
      res.status(409).json({ error: 'Room ist voll' });
      return;
    }

    await pool.query('INSERT INTO room_members (room_id, user_id, is_active) VALUES (?, ?, ?)', [
      room.id,
      userId,
      true,
    ]);

    const newStatus = countRows[0].count === 1 ? 'active' : 'waiting';
    await pool.query('UPDATE rooms SET status = ?, last_activity_at = NOW() WHERE id = ?', [newStatus, room.id]);
    room.status = newStatus;

    const io = getIo();
    io.to(`room:${room.id}`).emit(SocketEvents.PARTNER_JOINED, { userId });

    res.json({ room });
  } catch (err) {
    logger.error({ err, userId }, 'Join room error');
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

// GET /api/rooms/:id — room info + members
router.get('/:id', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  const userId = (req as AuthRequest).user.userId;
  const roomId = parseInt(req.params['id'], 10);

  if (isNaN(roomId)) {
    res.status(400).json({ error: 'Ungueltige Room-ID' });
    return;
  }

  try {
    const [rooms] = await pool.query<RoomRow[]>(
      'SELECT id, code, created_by, created_at, status, name, filters, last_activity_at FROM rooms WHERE id = ?',
      [roomId],
    );

    if (rooms.length === 0) {
      res.status(404).json({ error: 'Room nicht gefunden' });
      return;
    }

    const [membership] = await pool.query<RowDataPacket[]>(
      'SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ?',
      [roomId, userId],
    );
    if (membership.length === 0) {
      res.status(403).json({ error: 'Kein Mitglied dieses Rooms' });
      return;
    }

    const [members] = await pool.query<MemberRow[]>(
      `SELECT u.id AS user_id, u.name, u.email, rm.joined_at, rm.is_active
       FROM room_members rm
       JOIN users u ON u.id = rm.user_id
       WHERE rm.room_id = ?`,
      [roomId],
    );

    res.json({ room: rooms[0], members });
  } catch (err) {
    logger.error({ err, userId, roomId }, 'Get room error');
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

router.get('/', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  const userId = (req as AuthRequest).user.userId;

  try {
    const [rooms] = await pool.query<RoomRow[]>(
      `SELECT r.id, r.code, r.created_by, r.created_at, r.status, r.name, r.filters, r.last_activity_at
       FROM rooms r
       JOIN room_members rm ON rm.room_id = r.id
       WHERE rm.user_id = ?
         AND rm.is_active = true
         AND rm.deleted_from_archive_at IS NULL
       ORDER BY r.last_activity_at DESC`,
      [userId],
    );

    res.json({ rooms });
  } catch (err) {
    logger.error({ err, userId }, 'Get rooms error');
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

router.patch('/:id', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  const userId = (req as AuthRequest).user.userId;
  const roomId = parseInt(req.params['id'], 10);
  const { name } = req.body as { name?: string };

  if (isNaN(roomId)) {
    res.status(400).json({ error: 'Ungueltige Room-ID' });
    return;
  }

  if (!name || name.length > 64) {
    res.status(400).json({ error: 'Name muss zwischen 1 und 64 Zeichen lang sein' });
    return;
  }

  try {
    const [membership] = await pool.query<RowDataPacket[]>(
      'SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ?',
      [roomId, userId],
    );
    if (membership.length === 0) {
      res.status(403).json({ error: 'Kein Mitglied dieses Rooms' });
      return;
    }

    await pool.query('UPDATE rooms SET name = ?, last_activity_at = NOW() WHERE id = ?', [name, roomId]);

    const [rooms] = await pool.query<RoomRow[]>(
      'SELECT id, code, created_by, created_at, status, name, filters, last_activity_at FROM rooms WHERE id = ?',
      [roomId],
    );

    res.json({ room: rooms[0] });
  } catch (err) {
    logger.error({ err, userId, roomId }, 'Update room name error');
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

router.patch('/:id/filters', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  const userId = (req as AuthRequest).user.userId;
  const roomId = parseInt(req.params['id'], 10);
  const { filters } = req.body as { filters?: Record<string, unknown> };

  if (isNaN(roomId)) {
    res.status(400).json({ error: 'Ungueltige Room-ID' });
    return;
  }

  // Validate filter shape to prevent arbitrary large payloads
  if (filters) {
    const { genres, streamingServices, yearFrom, minRating, maxRuntime, language } = filters as Record<string, unknown>;
    if (genres !== undefined && (!Array.isArray(genres) || genres.length > 20)) {
      res.status(400).json({ error: 'Maximal 20 Genres erlaubt' }); return;
    }
    if (streamingServices !== undefined && (!Array.isArray(streamingServices) || streamingServices.length > 10)) {
      res.status(400).json({ error: 'Maximal 10 Streaming-Dienste erlaubt' }); return;
    }
    if (yearFrom !== undefined && (typeof yearFrom !== 'number' || yearFrom < 1900 || yearFrom > 2100)) {
      res.status(400).json({ error: 'Ungueltige Jahresangabe' }); return;
    }
    if (minRating !== undefined && (typeof minRating !== 'number' || minRating < 0 || minRating > 10)) {
      res.status(400).json({ error: 'Bewertung muss zwischen 0 und 10 liegen' }); return;
    }
    if (maxRuntime !== undefined && (typeof maxRuntime !== 'number' || maxRuntime < 1 || maxRuntime > 600)) {
      res.status(400).json({ error: 'Ungueltige Laufzeit' }); return;
    }
    if (language !== undefined && (typeof language !== 'string' || language.length > 5)) {
      res.status(400).json({ error: 'Ungueltige Sprache' }); return;
    }
  }

  try {
    const [membership] = await pool.query<RowDataPacket[]>(
      'SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ?',
      [roomId, userId],
    );
    if (membership.length === 0) {
      res.status(403).json({ error: 'Kein Mitglied dieses Rooms' });
      return;
    }

    const filtersJson = filters ? JSON.stringify(filters) : null;
    await pool.query('UPDATE rooms SET filters = ?, last_activity_at = NOW() WHERE id = ?', [filtersJson, roomId]);

    await generateRoomStack(roomId, filters || {});

    const io = getIo();
    io.to(`room:${roomId}`).emit(SocketEvents.FILTERS_UPDATED, { filters });

    const [rooms] = await pool.query<RoomRow[]>(
      'SELECT id, code, created_by, created_at, status, name, filters, last_activity_at FROM rooms WHERE id = ?',
      [roomId],
    );

    res.json({ room: rooms[0] });
  } catch (err) {
    logger.error({ err, userId, roomId }, 'Update room filters error');
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

router.delete('/:id/leave', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  const userId = (req as AuthRequest).user.userId;
  const roomId = parseInt(req.params['id'], 10);

  if (isNaN(roomId)) {
    res.status(400).json({ error: 'Ungueltige Room-ID' });
    return;
  }

  try {
    const [membership] = await pool.query<MemberRow[]>(
      'SELECT user_id, is_active FROM room_members WHERE room_id = ? AND user_id = ?',
      [roomId, userId],
    );
    if (membership.length === 0) {
      res.status(404).json({ error: 'Kein Mitglied dieses Rooms' });
      return;
    }

    await pool.query('UPDATE room_members SET is_active = ? WHERE room_id = ? AND user_id = ?', [
      false,
      roomId,
      userId,
    ]);

    const [activeMembers] = await pool.query<CountRow[]>(
      'SELECT COUNT(*) AS count FROM room_members WHERE room_id = ? AND is_active = ?',
      [roomId, true],
    );

    const lastMember = activeMembers[0].count === 0;

    if (lastMember) {
      const [memberCountRows] = await pool.query<CountRow[]>(
        'SELECT COUNT(*) AS count FROM room_members WHERE room_id = ?',
        [roomId],
      );
      const totalMembersEver = memberCountRows[0].count;
      const wasNeverUsed = totalMembersEver === 1; // Nur Creator war je dabei, niemand ist beigetreten

      if (wasNeverUsed) {
        // Niemand war je beigetreten → Raum löschen, nicht archivieren
        await pool.query('DELETE FROM rooms WHERE id = ?', [roomId]);
      } else {
        // Raum war genutzt (Partner war dabei) → archivieren
        await pool.query('UPDATE rooms SET status = ?, last_activity_at = NOW() WHERE id = ?', ['dissolved', roomId]);
      }

      const io = getIo();
      io.to(`room:${roomId}`).emit(SocketEvents.ROOM_DISSOLVED, { roomId });
    } else {
      await pool.query('UPDATE rooms SET status = ?, last_activity_at = NOW() WHERE id = ?', ['waiting', roomId]);

      const io = getIo();
      io.to(`room:${roomId}`).emit(SocketEvents.PARTNER_LEFT, { userId });
    }

    res.json({ lastMember });
  } catch (err) {
    logger.error({ err, userId, roomId }, 'Leave room error');
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

// DELETE /api/rooms/:id/archive — Raum aus eigener Archivliste löschen
// Hard-Delete aus DB nur wenn beide User gelöscht haben
router.delete('/:id/archive', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  const userId = (req as AuthRequest).user.userId;
  const roomId = parseInt(req.params['id'], 10);

  if (isNaN(roomId)) {
    res.status(400).json({ error: 'Ungueltige Room-ID' });
    return;
  }

  try {
    const [rooms] = await pool.query<RoomRow[]>(
      'SELECT id, status FROM rooms WHERE id = ?',
      [roomId],
    );

    if (rooms.length === 0) {
      res.status(404).json({ error: 'Room nicht gefunden' });
      return;
    }

    if (rooms[0].status !== 'dissolved') {
      res.status(400).json({ error: 'Room ist nicht archiviert' });
      return;
    }

    const [membership] = await pool.query<RowDataPacket[]>(
      'SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ? AND deleted_from_archive_at IS NULL',
      [roomId, userId],
    );
    if (membership.length === 0) {
      res.status(403).json({ error: 'Kein Mitglied oder bereits geloescht' });
      return;
    }

    await pool.query(
      'UPDATE room_members SET deleted_from_archive_at = NOW() WHERE room_id = ? AND user_id = ?',
      [roomId, userId],
    );

    const [remaining] = await pool.query<CountRow[]>(
      'SELECT COUNT(*) AS count FROM room_members WHERE room_id = ? AND deleted_from_archive_at IS NULL',
      [roomId],
    );

    if (remaining[0].count === 0) {
      await pool.query('DELETE FROM rooms WHERE id = ?', [roomId]);
      logger.info({ roomId }, 'Room hard-deleted: both users deleted from archive');
    }

    res.json({ deleted: true });
  } catch (err) {
    logger.error({ err, userId, roomId }, 'Delete from archive error');
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

export default router;
