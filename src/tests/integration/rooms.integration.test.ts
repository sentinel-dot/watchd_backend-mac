import { describe, it, expect } from 'vitest';
import { agent } from '../setup';
import { pool } from '../../db/connection';
import { createUser, createRoom, joinRoom } from '../helpers';
// @ts-expect-error - test-only export from setup mock
import { __io } from '../../socket';
import type { RowDataPacket } from 'mysql2';

describe('POST /api/rooms', () => {
  it('creates a room with the creator as an active member and status waiting', async () => {
    const user = await createUser(agent);
    const res = await agent
      .post('/api/rooms')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({ name: 'My Room' });
    expect(res.status).toBe(201);
    expect(res.body.room.status).toBe('waiting');
    expect(res.body.room.name).toBe('My Room');
    expect(res.body.room.code).toMatch(/^[A-Z0-9]{6}$/);

    const [members] = await pool.query<RowDataPacket[]>(
      'SELECT user_id, is_active FROM room_members WHERE room_id = ?',
      [res.body.room.id],
    );
    expect(members).toHaveLength(1);
    expect(members[0].user_id).toBe(user.userId);
    expect(members[0].is_active).toBe(1);
  });
});

describe('POST /api/rooms/join', () => {
  it('activates the room when a second member joins', async () => {
    const alice = await createUser(agent, { email: 'a-join@example.com' });
    const bob = await createUser(agent, { email: 'b-join@example.com' });
    const room = await createRoom(agent, alice.accessToken);

    const res = await agent
      .post('/api/rooms/join')
      .set('Authorization', `Bearer ${bob.accessToken}`)
      .send({ code: room.code });
    expect(res.status).toBe(200);
    expect(res.body.room.status).toBe('active');
  });

  it('returns 409 when the room is full', async () => {
    const a = await createUser(agent, { email: 'a-full@example.com' });
    const b = await createUser(agent, { email: 'b-full@example.com' });
    const c = await createUser(agent, { email: 'c-full@example.com' });
    const room = await createRoom(agent, a.accessToken);
    await joinRoom(agent, b.accessToken, room.code);

    const res = await agent
      .post('/api/rooms/join')
      .set('Authorization', `Bearer ${c.accessToken}`)
      .send({ code: room.code });
    expect(res.status).toBe(409);
  });

  it('returns 410 when the room is dissolved', async () => {
    const a = await createUser(agent, { email: 'a-dis@example.com' });
    const b = await createUser(agent, { email: 'b-dis@example.com' });
    const room = await createRoom(agent, a.accessToken);
    await pool.query('UPDATE rooms SET status = ? WHERE id = ?', ['dissolved', room.id]);

    const res = await agent
      .post('/api/rooms/join')
      .set('Authorization', `Bearer ${b.accessToken}`)
      .send({ code: room.code });
    expect(res.status).toBe(410);
  });

  it('returns 404 for an unknown code', async () => {
    const user = await createUser(agent);
    const res = await agent
      .post('/api/rooms/join')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({ code: 'ZZZZZZ' });
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/rooms/:id/leave', () => {
  it('hard-deletes a never-used room when the creator leaves alone', async () => {
    const user = await createUser(agent);
    const room = await createRoom(agent, user.accessToken);

    const res = await agent
      .delete(`/api/rooms/${room.id}/leave`)
      .set('Authorization', `Bearer ${user.accessToken}`);
    expect(res.status).toBe(200);

    const [rows] = await pool.query<RowDataPacket[]>('SELECT id FROM rooms WHERE id = ?', [room.id]);
    expect(rows).toHaveLength(0);
  });

  it('sets status=waiting and notifies partner when one of two members leaves', async () => {
    const alice = await createUser(agent, { email: 'a-leave@example.com' });
    const bob = await createUser(agent, { email: 'b-leave@example.com' });
    const room = await createRoom(agent, alice.accessToken);
    await joinRoom(agent, bob.accessToken, room.code);

    const res = await agent
      .delete(`/api/rooms/${room.id}/leave`)
      .set('Authorization', `Bearer ${bob.accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.lastMember).toBe(false);

    const [rows] = await pool.query<(RowDataPacket & { status: string })[]>(
      'SELECT status FROM rooms WHERE id = ?',
      [room.id],
    );
    expect(rows[0].status).toBe('waiting');

    expect(__io.to).toHaveBeenCalledWith(`room:${room.id}`);
    expect(__io.to(`room:${room.id}`).emit).toHaveBeenCalledWith('partner_left', expect.any(Object));
  });

  it('dissolves the room when the last of two members leaves after use', async () => {
    const alice = await createUser(agent, { email: 'a-dissolve@example.com' });
    const bob = await createUser(agent, { email: 'b-dissolve@example.com' });
    const room = await createRoom(agent, alice.accessToken);
    await joinRoom(agent, bob.accessToken, room.code);

    await agent
      .delete(`/api/rooms/${room.id}/leave`)
      .set('Authorization', `Bearer ${alice.accessToken}`);
    await agent
      .delete(`/api/rooms/${room.id}/leave`)
      .set('Authorization', `Bearer ${bob.accessToken}`);

    const [rows] = await pool.query<(RowDataPacket & { status: string })[]>(
      'SELECT status FROM rooms WHERE id = ?',
      [room.id],
    );
    expect(rows[0].status).toBe('dissolved');
  });
});

describe('DELETE /api/rooms/:id/archive', () => {
  it('hard-deletes only when both members have deleted from archive', async () => {
    const alice = await createUser(agent, { email: 'a-arch@example.com' });
    const bob = await createUser(agent, { email: 'b-arch@example.com' });
    const room = await createRoom(agent, alice.accessToken);
    await joinRoom(agent, bob.accessToken, room.code);
    // Use the room so it dissolves (both leave)
    await agent.delete(`/api/rooms/${room.id}/leave`).set('Authorization', `Bearer ${alice.accessToken}`);
    await agent.delete(`/api/rooms/${room.id}/leave`).set('Authorization', `Bearer ${bob.accessToken}`);

    // Alice deletes from archive first — row should still exist
    const first = await agent
      .delete(`/api/rooms/${room.id}/archive`)
      .set('Authorization', `Bearer ${alice.accessToken}`);
    expect(first.status).toBe(200);
    const [stillExists] = await pool.query<RowDataPacket[]>('SELECT id FROM rooms WHERE id = ?', [room.id]);
    expect(stillExists).toHaveLength(1);

    // Bob deletes from archive → hard-deleted
    const second = await agent
      .delete(`/api/rooms/${room.id}/archive`)
      .set('Authorization', `Bearer ${bob.accessToken}`);
    expect(second.status).toBe(200);
    const [gone] = await pool.query<RowDataPacket[]>('SELECT id FROM rooms WHERE id = ?', [room.id]);
    expect(gone).toHaveLength(0);
  });
});

describe('PATCH /api/rooms/:id/filters', () => {
  it('updates filters and emits filters_updated socket event', async () => {
    const user = await createUser(agent);
    const room = await createRoom(agent, user.accessToken);
    const res = await agent
      .patch(`/api/rooms/${room.id}/filters`)
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({ filters: { genres: [28], minRating: 7 } });
    expect(res.status).toBe(200);

    expect(__io.to).toHaveBeenCalledWith(`room:${room.id}`);
    expect(__io.to(`room:${room.id}`).emit).toHaveBeenCalledWith(
      'filters_updated',
      expect.objectContaining({ filters: expect.objectContaining({ genres: [28] }) }),
    );
  });
});
