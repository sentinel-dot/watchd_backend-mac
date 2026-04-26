import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { createServer, type Server as HttpServer } from 'http';
import type { AddressInfo } from 'net';
import type { Server as SocketIOServer } from 'socket.io';
import { io as ioc, type Socket as ClientSocket } from 'socket.io-client';
import type * as SocketModule from '../../socket';
import { agent } from '../setup';
import { createUser, createPartnership } from '../helpers';

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
}, 30000);

afterAll(async () => {
  await new Promise<void>((resolve) => ioServer.close(() => resolve()));
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

interface JoinOutcome {
  event: 'joined' | 'error';
  payload: { partnershipId?: number | null; message?: string };
}

function connectAndJoin(payload: { token?: string; partnershipId?: number }): Promise<JoinOutcome> {
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
    client.on('joined', (p: { partnershipId: number | null }) =>
      finish({ event: 'joined', payload: p }),
    );
    client.on('error', (p: { message: string }) => finish({ event: 'error', payload: p }));
    client.on('connect_error', (err) => {
      clearTimeout(timer);
      client.disconnect();
      reject(err);
    });
  });
}

describe('Socket.io JOIN handshake', () => {
  it('admits a partnership member with a valid JWT and emits joined', async () => {
    const a = await createUser(agent, { email: 'socket-ok-a@example.com' });
    const b = await createUser(agent, { email: 'socket-ok-b@example.com' });
    const partnership = await createPartnership(a.userId, b.userId, 'active');

    const outcome = await connectAndJoin({
      token: a.accessToken,
      partnershipId: partnership.id,
    });

    expect(outcome.event).toBe('joined');
    expect(outcome.payload).toEqual({ partnershipId: partnership.id });
  });

  it('admits a valid JWT without partnershipId (user-channel only)', async () => {
    const user = await createUser(agent, { email: 'socket-userchan@example.com' });

    const outcome = await connectAndJoin({ token: user.accessToken });

    expect(outcome.event).toBe('joined');
    expect(outcome.payload).toEqual({ partnershipId: null });
  });

  it('rejects a valid JWT whose user is not a member of the requested partnership', async () => {
    const alice = await createUser(agent, { email: 'socket-alice@example.com' });
    const bob = await createUser(agent, { email: 'socket-bob@example.com' });
    const carol = await createUser(agent, { email: 'socket-carol@example.com' });
    const partnership = await createPartnership(alice.userId, bob.userId, 'active');

    const outcome = await connectAndJoin({
      token: carol.accessToken,
      partnershipId: partnership.id,
    });

    expect(outcome.event).toBe('error');
    expect(outcome.payload.message).toBe('Not a member of this partnership');
  });

  it('rejects an invalid JWT', async () => {
    const a = await createUser(agent, { email: 'socket-badjwt-a@example.com' });
    const b = await createUser(agent, { email: 'socket-badjwt-b@example.com' });
    const partnership = await createPartnership(a.userId, b.userId, 'active');

    const outcome = await connectAndJoin({
      token: 'not-a-real-jwt',
      partnershipId: partnership.id,
    });

    expect(outcome.event).toBe('error');
    expect(outcome.payload.message).toBe('Invalid or expired token');
  });

  it('rejects a payload missing the token', async () => {
    const a = await createUser(agent, { email: 'socket-notoken-a@example.com' });
    const b = await createUser(agent, { email: 'socket-notoken-b@example.com' });
    const partnership = await createPartnership(a.userId, b.userId, 'active');

    const outcome = await connectAndJoin({ partnershipId: partnership.id });

    expect(outcome.event).toBe('error');
    expect(outcome.payload.message).toBe('token is required');
  });
});
