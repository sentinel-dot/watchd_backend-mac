import { Server as HttpServer } from 'http';
import { Server as SocketServer, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { AuthPayload } from '../middleware/auth';

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
    socket.on('join', (payload: ConnectPayload) => {
      const { token, roomId } = payload ?? {};

      if (!token || !roomId) {
        socket.emit('error', { message: 'token and roomId are required' });
        socket.disconnect();
        return;
      }

      try {
        jwt.verify(token, config.jwtSecret) as AuthPayload;
        const roomChannel = `room:${roomId}`;
        socket.join(roomChannel);
        socket.emit('joined', { roomId });
      } catch {
        socket.emit('error', { message: 'Invalid or expired token' });
        socket.disconnect();
      }
    });

    socket.on('disconnect', () => {
      // Socket.io automatically removes socket from all rooms on disconnect
    });
  });

  return io;
}

export function getIo(): SocketServer {
  if (!io) throw new Error('Socket.io not initialized');
  return io;
}
