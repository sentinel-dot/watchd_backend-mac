import type { Server as HttpServer } from 'http';
import type { Socket } from 'socket.io';
import { Server as SocketServer } from 'socket.io';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { logger } from '../logger';
import { pool } from '../db/connection';
import type { AuthPayload } from '../middleware/auth';
import { SocketEvents } from './events';
import type { RowDataPacket } from 'mysql2';

let io: SocketServer;

interface ConnectPayload {
  token?: string;
  roomId?: number;
}

interface MemberCheckRow extends RowDataPacket {
  user_id: number;
}

export function initSocket(httpServer: HttpServer, corsOrigins: string | string[]): SocketServer {
  io = new SocketServer(httpServer, {
    cors: {
      origin: corsOrigins,
      methods: ['GET', 'POST'],
    },
  });

  io.on('connection', (socket: Socket) => {
    socket.on(SocketEvents.JOIN, async (payload: ConnectPayload) => {
      const { token, roomId } = payload ?? {};

      if (!token || !roomId) {
        socket.emit(SocketEvents.ERROR, { message: 'token and roomId are required' });
        socket.disconnect();
        return;
      }

      try {
        const user = jwt.verify(token, config.jwtSecret) as AuthPayload;

        // Verify the user is actually a member of this room
        const [membership] = await pool.query<MemberCheckRow[]>(
          'SELECT user_id FROM room_members WHERE room_id = ? AND user_id = ?',
          [roomId, user.userId],
        );
        if (membership.length === 0) {
          logger.warn({ userId: user.userId, roomId }, 'Socket join denied: not a room member');
          socket.emit(SocketEvents.ERROR, { message: 'Not a member of this room' });
          socket.disconnect();
          return;
        }

        const roomChannel = `room:${roomId}`;
        void socket.join(roomChannel);
        void socket.join(`user:${user.userId}`);
        socket.emit(SocketEvents.JOINED, { roomId });
        logger.info({ userId: user.userId, roomId }, 'User joined room via socket');
      } catch (err) {
        logger.warn({ err }, 'Socket auth failed');
        socket.emit(SocketEvents.ERROR, { message: 'Invalid or expired token' });
        socket.disconnect();
      }
    });

    socket.on(SocketEvents.DISCONNECT, () => {
      logger.debug('Socket disconnected');
    });
  });

  return io;
}

export function getIo(): SocketServer {
  if (!io) throw new Error('Socket.io not initialized');
  return io;
}

/**
 * Force-closes all active Socket.io connections belonging to a user.
 * Called after account deletion so orphaned sockets don't outlive the DB record.
 */
export function disconnectUserSockets(userId: number): void {
  if (!io) return;
  io.in(`user:${userId}`).disconnectSockets(true);
  logger.info({ userId }, 'Disconnected all sockets for deleted user');
}
