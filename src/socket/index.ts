import { Server as HttpServer } from 'http';
import { Server as SocketServer, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { logger } from '../logger';
import { AuthPayload } from '../middleware/auth';
import { SocketEvents } from './events';

let io: SocketServer;

interface ConnectPayload {
  token?: string;
  roomId?: number;
}

export function initSocket(httpServer: HttpServer): SocketServer {
  io = new SocketServer(httpServer, {
    cors: {
      origin: '*',
      methods: ['GET', 'POST'],
    },
  });

  io.on('connection', (socket: Socket) => {
    socket.on(SocketEvents.JOIN, (payload: ConnectPayload) => {
      const { token, roomId } = payload ?? {};

      if (!token || !roomId) {
        socket.emit(SocketEvents.ERROR, { message: 'token and roomId are required' });
        socket.disconnect();
        return;
      }

      try {
        const user = jwt.verify(token, config.jwtSecret) as AuthPayload;
        const roomChannel = `room:${roomId}`;
        socket.join(roomChannel);
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
