import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { createServer, type Server as HttpServer } from 'http';
import type { AddressInfo } from 'net';
import type { Server as SocketIOServer } from 'socket.io';
import { io as ioc, type Socket as ClientSocket } from 'socket.io-client';
import type * as SocketModule from '../../socket';
import { agent } from '../setup';
import { createUser, createRoom } from '../helpers';

// The global mock in setup.ts replaces '../socket' for the app under test.
// Here we pull the real `initSocket` via `vi.importActual` and attach it to
// a dedicated httpServer — the shared server from setup.ts stays untouched.
let realInitSocket!: typeof SocketModule.initSocket;
let httpServer!: HttpServer;
let ioServer!: SocketIOServer;
let port!: number;

beforeAll(async () => {
  const actual = await vi.importActual<typeof SocketModule>('../../socket');
  realInitSocket = actual.initSocket;

  httpServer = createServer();
  ioServer = realInitSocket(httpServer, '*');
  await new Promise<void>((resolve) => httpServer.listen(0, () => resolve()));
  port = (httpServer.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => ioServer.close(() => resolve()));
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

interface JoinOutcome {
  event: 'joined' | 'error';
  payload: { roomId?: number; message?: string };
}

function connectAndJoin(payload: { token?: string; roomId?: number }): Promise<JoinOutcome> {
  return new Promise((resolve, reject) => {
    const client: ClientSocket = ioc(`http://127.0.0.1:${port}`, {
      transports: ['websocket'],
      reconnection: false,
      forceNew: true,
    });
    const timer = setTimeout(() => {
      client.disconnect();
      reject(new Error('Timed out waiting for joined/error'));
    }, 2000);

    const finish = (outcome: JoinOutcome) => {
      clearTimeout(timer);
      client.disconnect();
      resolve(outcome);
    };

    client.on('connect', () => client.emit('join', payload));
    client.on('joined', (p: { roomId: number }) => finish({ event: 'joined', payload: p }));
    client.on('error', (p: { message: string }) => finish({ event: 'error', payload: p }));
    client.on('connect_error', (err) => {
      clearTimeout(timer);
      client.disconnect();
      reject(err);
    });
  });
}

describe('Socket.io JOIN handshake', () => {
  it('admits a member with a valid JWT and emits joined', async () => {
    const user = await createUser(agent, { email: 'socket-ok@example.com' });
    const room = await createRoom(agent, user.accessToken);

    const outcome = await connectAndJoin({ token: user.accessToken, roomId: room.id });

    expect(outcome.event).toBe('joined');
    expect(outcome.payload).toEqual({ roomId: room.id });
  });

  it('rejects a valid JWT whose user is not a member of the requested room', async () => {
    const alice = await createUser(agent, { email: 'socket-alice@example.com' });
    const bob = await createUser(agent, { email: 'socket-bob@example.com' });
    const aliceRoom = await createRoom(agent, alice.accessToken);

    const outcome = await connectAndJoin({ token: bob.accessToken, roomId: aliceRoom.id });

    expect(outcome.event).toBe('error');
    expect(outcome.payload.message).toBe('Not a member of this room');
  });

  it('rejects an invalid JWT', async () => {
    const user = await createUser(agent, { email: 'socket-badjwt@example.com' });
    const room = await createRoom(agent, user.accessToken);

    const outcome = await connectAndJoin({ token: 'not-a-real-jwt', roomId: room.id });

    expect(outcome.event).toBe('error');
    expect(outcome.payload.message).toBe('Invalid or expired token');
  });

  it('rejects a payload missing the token', async () => {
    const user = await createUser(agent, { email: 'socket-notoken@example.com' });
    const room = await createRoom(agent, user.accessToken);

    const outcome = await connectAndJoin({ roomId: room.id });

    expect(outcome.event).toBe('error');
    expect(outcome.payload.message).toBe('token and roomId are required');
  });

  it('rejects a payload missing the roomId', async () => {
    const user = await createUser(agent, { email: 'socket-noroom@example.com' });

    const outcome = await connectAndJoin({ token: user.accessToken });

    expect(outcome.event).toBe('error');
    expect(outcome.payload.message).toBe('token and roomId are required');
  });
});
