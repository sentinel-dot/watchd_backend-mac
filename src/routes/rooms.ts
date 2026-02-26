import { Router, Request, Response } from 'express';
import { pool } from '../db/connection';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { RowDataPacket, ResultSetHeader } from 'mysql2';

const router = Router();

interface RoomRow extends RowDataPacket {
  id: number;
  code: string;
  created_by: number;
  created_at: Date;
}

interface MemberRow extends RowDataPacket {
  user_id: number;
  name: string;
  email: string;
  joined_at: Date;
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

  try {
    let code: string;
    let attempts = 0;
    do {
      code = generateRoomCode();
      attempts++;
      if (attempts > 10) {
        res.status(500).json({ error: 'Could not generate unique room code' });
        return;
      }
      const [existing] = await pool.query<RoomRow[]>(
        'SELECT id FROM rooms WHERE code = ?',
        [code],
      );
      if (existing.length === 0) break;
    } while (true);

    const [result] = await pool.query<ResultSetHeader>(
      'INSERT INTO rooms (code, created_by) VALUES (?, ?)',
      [code, userId],
    );
    const roomId = result.insertId;

    await pool.query(
      'INSERT INTO room_members (room_id, user_id) VALUES (?, ?)',
      [roomId, userId],
    );

    const [rooms] = await pool.query<RoomRow[]>(
      'SELECT id, code, created_by, created_at FROM rooms WHERE id = ?',
      [roomId],
    );

    res.status(201).json({ room: rooms[0] });
  } catch (err) {
    console.error('Create room error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/rooms/join — join a room by code
router.post('/join', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  const userId = (req as AuthRequest).user.userId;
  const { code } = req.body as { code?: string };

  if (!code) {
    res.status(400).json({ error: 'code is required' });
    return;
  }

  try {
    const [rooms] = await pool.query<RoomRow[]>(
      'SELECT id, code, created_by, created_at FROM rooms WHERE code = ?',
      [code.toUpperCase()],
    );

    if (rooms.length === 0) {
      res.status(404).json({ error: 'Room not found' });
      return;
    }

    const room = rooms[0];

    // Check if already a member
    const [membership] = await pool.query<RowDataPacket[]>(
      'SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ?',
      [room.id, userId],
    );
    if (membership.length > 0) {
      res.json({ room });
      return;
    }

    // Enforce max 2 members
    const [countRows] = await pool.query<CountRow[]>(
      'SELECT COUNT(*) AS count FROM room_members WHERE room_id = ?',
      [room.id],
    );
    if (countRows[0].count >= 2) {
      res.status(409).json({ error: 'Room is full' });
      return;
    }

    await pool.query(
      'INSERT INTO room_members (room_id, user_id) VALUES (?, ?)',
      [room.id, userId],
    );

    res.json({ room });
  } catch (err) {
    console.error('Join room error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/rooms/:id — room info + members
router.get('/:id', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  const userId = (req as AuthRequest).user.userId;
  const roomId = parseInt(req.params['id'], 10);

  if (isNaN(roomId)) {
    res.status(400).json({ error: 'Invalid room id' });
    return;
  }

  try {
    const [rooms] = await pool.query<RoomRow[]>(
      'SELECT id, code, created_by, created_at FROM rooms WHERE id = ?',
      [roomId],
    );

    if (rooms.length === 0) {
      res.status(404).json({ error: 'Room not found' });
      return;
    }

    // Verify requester is a member
    const [membership] = await pool.query<RowDataPacket[]>(
      'SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ?',
      [roomId, userId],
    );
    if (membership.length === 0) {
      res.status(403).json({ error: 'Not a member of this room' });
      return;
    }

    const [members] = await pool.query<MemberRow[]>(
      `SELECT u.id AS user_id, u.name, u.email, rm.joined_at
       FROM room_members rm
       JOIN users u ON u.id = rm.user_id
       WHERE rm.room_id = ?`,
      [roomId],
    );

    res.json({ room: rooms[0], members });
  } catch (err) {
    console.error('Get room error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
