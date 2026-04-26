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
  partnershipId?: number;
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
      const { token, partnershipId } = payload ?? {};

      if (!token) {
        socket.emit(SocketEvents.ERROR, { message: 'token is required' });
        socket.disconnect();
        return;
      }

      try {
        const user = jwt.verify(token, config.jwtSecret) as AuthPayload;

        // The user channel always gets joined — it carries partnership_request /
        // partnership_accepted events which are user-scoped, not partnership-scoped.
        void socket.join(`user:${user.userId}`);

        if (partnershipId) {
          const [membership] = await pool.query<MemberCheckRow[]>(
            'SELECT user_id FROM partnership_members WHERE partnership_id = ? AND user_id = ?',
            [partnershipId, user.userId],
          );
          if (membership.length === 0) {
            logger.warn(
              { userId: user.userId, partnershipId },
              'Socket join denied: not a partnership member',
            );
            socket.emit(SocketEvents.ERROR, { message: 'Not a member of this partnership' });
            socket.disconnect();
            return;
          }

          void socket.join(`partnership:${partnershipId}`);
          socket.emit(SocketEvents.JOINED, { partnershipId });
          logger.info({ userId: user.userId, partnershipId }, 'User joined partnership via socket');
        } else {
          socket.emit(SocketEvents.JOINED, { partnershipId: null });
          logger.info({ userId: user.userId }, 'User joined user-channel only');
        }
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
