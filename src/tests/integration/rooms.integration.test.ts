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

    const [rows] = await pool.query<RowDataPacket[]>('SELECT id FROM rooms WHERE id = ?', [
      room.id,
    ]);
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
    expect(__io.to(`room:${room.id}`).emit).toHaveBeenCalledWith(
      'partner_left',
      expect.any(Object),
    );
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
    await agent
      .delete(`/api/rooms/${room.id}/leave`)
      .set('Authorization', `Bearer ${alice.accessToken}`);
    await agent
      .delete(`/api/rooms/${room.id}/leave`)
      .set('Authorization', `Bearer ${bob.accessToken}`);

    // Alice deletes from archive first — row should still exist
    const first = await agent
      .delete(`/api/rooms/${room.id}/archive`)
      .set('Authorization', `Bearer ${alice.accessToken}`);
    expect(first.status).toBe(200);
    const [stillExists] = await pool.query<RowDataPacket[]>('SELECT id FROM rooms WHERE id = ?', [
      room.id,
    ]);
    expect(stillExists).toHaveLength(1);

    // Bob deletes from archive → hard-deleted
    const second = await agent
      .delete(`/api/rooms/${room.id}/archive`)
      .set('Authorization', `Bearer ${bob.accessToken}`);
    expect(second.status).toBe(200);
    const [gone] = await pool.query<RowDataPacket[]>('SELECT id FROM rooms WHERE id = ?', [
      room.id,
    ]);
    expect(gone).toHaveLength(0);
  });
});

describe('POST /api/rooms/join — rejoin', () => {
  it('reactivates an inactive member and emits partner_joined', async () => {
    const alice = await createUser(agent, { email: 'a-rejoin@example.com' });
    const bob = await createUser(agent, { email: 'b-rejoin@example.com' });
    const room = await createRoom(agent, alice.accessToken);
    await joinRoom(agent, bob.accessToken, room.code);
    await agent
      .delete(`/api/rooms/${room.id}/leave`)
      .set('Authorization', `Bearer ${bob.accessToken}`);

    const [before] = await pool.query<(RowDataPacket & { is_active: number })[]>(
      'SELECT is_active FROM room_members WHERE room_id = ? AND user_id = ?',
      [room.id, bob.userId],
    );
    expect(before[0].is_active).toBe(0);

    const res = await agent
      .post('/api/rooms/join')
      .set('Authorization', `Bearer ${bob.accessToken}`)
      .send({ code: room.code });

    expect(res.status).toBe(200);
    expect(res.body.room.status).toBe('active');

    const [after] = await pool.query<(RowDataPacket & { is_active: number })[]>(
      'SELECT is_active FROM room_members WHERE room_id = ? AND user_id = ?',
      [room.id, bob.userId],
    );
    expect(after[0].is_active).toBe(1);

    expect(__io.to).toHaveBeenCalledWith(`room:${room.id}`);
    expect(__io.to(`room:${room.id}`).emit).toHaveBeenCalledWith(
      'partner_joined',
      expect.objectContaining({ userId: bob.userId }),
    );
  });
});

describe('GET /api/rooms', () => {
  it('lists only rooms the user is a member of', async () => {
    const alice = await createUser(agent, { email: 'a-list@example.com' });
    const bob = await createUser(agent, { email: 'b-list@example.com' });
    const aliceRoom = await createRoom(agent, alice.accessToken, { name: 'Alice Room' });
    await createRoom(agent, bob.accessToken, { name: 'Bob Room' });

    const res = await agent.get('/api/rooms').set('Authorization', `Bearer ${alice.accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.rooms).toHaveLength(1);
    expect(res.body.rooms[0].id).toBe(aliceRoom.id);
  });

  it('excludes rooms the user has left while partner stays', async () => {
    const alice = await createUser(agent, { email: 'a-left@example.com' });
    const bob = await createUser(agent, { email: 'b-left@example.com' });
    const room = await createRoom(agent, alice.accessToken, { name: 'Shared' });
    await joinRoom(agent, bob.accessToken, room.code);

    await agent
      .delete(`/api/rooms/${room.id}/leave`)
      .set('Authorization', `Bearer ${alice.accessToken}`);

    const aliceList = await agent
      .get('/api/rooms')
      .set('Authorization', `Bearer ${alice.accessToken}`);
    expect(aliceList.body.rooms).toHaveLength(0);

    const bobList = await agent.get('/api/rooms').set('Authorization', `Bearer ${bob.accessToken}`);
    expect(bobList.body.rooms).toHaveLength(1);
    expect(bobList.body.rooms[0].id).toBe(room.id);
  });

  it('surfaces dissolved rooms for a user who left first, once the partner also leaves', async () => {
    const alice = await createUser(agent, { email: 'a-archsurface@example.com' });
    const bob = await createUser(agent, { email: 'b-archsurface@example.com' });
    const room = await createRoom(agent, alice.accessToken, { name: 'Archive Me' });
    await joinRoom(agent, bob.accessToken, room.code);

    await agent
      .delete(`/api/rooms/${room.id}/leave`)
      .set('Authorization', `Bearer ${alice.accessToken}`);

    const aliceDuring = await agent
      .get('/api/rooms')
      .set('Authorization', `Bearer ${alice.accessToken}`);
    expect(aliceDuring.body.rooms).toHaveLength(0);

    await agent
      .delete(`/api/rooms/${room.id}/leave`)
      .set('Authorization', `Bearer ${bob.accessToken}`);

    const aliceAfter = await agent
      .get('/api/rooms')
      .set('Authorization', `Bearer ${alice.accessToken}`);
    expect(aliceAfter.body.rooms).toHaveLength(1);
    expect(aliceAfter.body.rooms[0].id).toBe(room.id);
    expect(aliceAfter.body.rooms[0].status).toBe('dissolved');
  });

  it('returns 401 without auth', async () => {
    const res = await agent.get('/api/rooms');
    expect(res.status).toBe(401);
  });
});

describe('GET /api/rooms/:id', () => {
  it('returns room details with members for a member', async () => {
    const alice = await createUser(agent, { email: 'a-get@example.com' });
    const bob = await createUser(agent, { email: 'b-get@example.com' });
    const room = await createRoom(agent, alice.accessToken);
    await joinRoom(agent, bob.accessToken, room.code);

    const res = await agent
      .get(`/api/rooms/${room.id}`)
      .set('Authorization', `Bearer ${alice.accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.room.id).toBe(room.id);
    expect(res.body.members).toHaveLength(2);
    const ids = res.body.members.map((m: { user_id: number }) => m.user_id).sort();
    expect(ids).toEqual([alice.userId, bob.userId].sort());
  });

  it('returns 403 when the user is not a member', async () => {
    const alice = await createUser(agent, { email: 'a-forbid@example.com' });
    const outsider = await createUser(agent, { email: 'o-forbid@example.com' });
    const room = await createRoom(agent, alice.accessToken);

    const res = await agent
      .get(`/api/rooms/${room.id}`)
      .set('Authorization', `Bearer ${outsider.accessToken}`);

    expect(res.status).toBe(403);
  });

  it('returns 404 for an unknown room id', async () => {
    const user = await createUser(agent, { email: 'nf-get@example.com' });
    const res = await agent
      .get('/api/rooms/999999')
      .set('Authorization', `Bearer ${user.accessToken}`);
    expect(res.status).toBe(404);
  });
});

describe('PATCH /api/rooms/:id', () => {
  it('renames the room for a member', async () => {
    const user = await createUser(agent, { email: 'a-rename@example.com' });
    const room = await createRoom(agent, user.accessToken, { name: 'Old' });

    const res = await agent
      .patch(`/api/rooms/${room.id}`)
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({ name: 'Renamed' });

    expect(res.status).toBe(200);
    expect(res.body.room.name).toBe('Renamed');
  });

  it('returns 403 when a non-member tries to rename', async () => {
    const alice = await createUser(agent, { email: 'a-ren-forbid@example.com' });
    const outsider = await createUser(agent, { email: 'o-ren-forbid@example.com' });
    const room = await createRoom(agent, alice.accessToken);

    const res = await agent
      .patch(`/api/rooms/${room.id}`)
      .set('Authorization', `Bearer ${outsider.accessToken}`)
      .send({ name: 'Hijack' });

    expect(res.status).toBe(403);
  });

  it('returns 400 for empty name', async () => {
    const user = await createUser(agent, { email: 'a-ren-empty@example.com' });
    const room = await createRoom(agent, user.accessToken);

    const res = await agent
      .patch(`/api/rooms/${room.id}`)
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({ name: '' });

    expect(res.status).toBe(400);
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
