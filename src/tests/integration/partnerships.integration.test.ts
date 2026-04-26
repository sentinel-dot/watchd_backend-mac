import { describe, it, expect, vi } from 'vitest';
import type { RowDataPacket } from 'mysql2';
import { agent } from '../setup';
import { pool } from '../../db/connection';
import {
  createUser,
  createPartnership,
  createPendingRequest,
  seedStackMovie,
  seedSwipe,
  seedMatch,
} from '../helpers';
import { sendPartnershipRequestPush, sendPartnershipAcceptedPush } from '../../services/apns';
import { generatePartnershipStack } from '../../services/partnership-stack';
// @ts-expect-error - test-only export from setup mock
import { __io } from '../../socket';

async function setDeviceToken(userId: number, token: string): Promise<void> {
  await pool.query('UPDATE users SET device_token = ? WHERE id = ?', [token, userId]);
}

describe('POST /api/partnerships/request', () => {
  it('creates a pending partnership, requester-only member row, and triggers push', async () => {
    const requester = await createUser(agent, { email: 'req@example.com' });
    const target = await createUser(agent, { email: 'target@example.com' });
    await setDeviceToken(target.userId, 'a'.repeat(64));

    const res = await agent
      .post('/api/partnerships/request')
      .set('Authorization', `Bearer ${requester.accessToken}`)
      .send({ shareCode: target.shareCode });

    expect(res.status).toBe(201);
    expect(res.body.partnership).toMatchObject({
      status: 'pending',
      requesterId: requester.userId,
      addresseeId: target.userId,
      partner: { id: target.userId, name: target.name },
    });
    const partnershipId = res.body.partnership.id;

    const [partnerships] = await pool.query<
      (RowDataPacket & { status: string; addressee_id: number })[]
    >('SELECT status, addressee_id FROM partnerships WHERE id = ?', [partnershipId]);
    expect(partnerships[0]).toMatchObject({ status: 'pending', addressee_id: target.userId });

    const [members] = await pool.query<(RowDataPacket & { user_id: number })[]>(
      'SELECT user_id FROM partnership_members WHERE partnership_id = ?',
      [partnershipId],
    );
    expect(members.map((m) => m.user_id)).toEqual([requester.userId]);

    expect(__io.to).toHaveBeenCalledWith(`user:${target.userId}`);
    expect(__io.to(`user:${target.userId}`).emit).toHaveBeenCalledWith(
      'partnership_request',
      expect.objectContaining({ partnershipId }),
    );

    await vi.waitFor(() => {
      expect(vi.mocked(sendPartnershipRequestPush)).toHaveBeenCalledOnce();
    });
  });

  it('returns 400 when using own share-code', async () => {
    const user = await createUser(agent);
    const res = await agent
      .post('/api/partnerships/request')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({ shareCode: user.shareCode });
    expect(res.status).toBe(400);
  });

  it('returns 404 when share-code is unknown', async () => {
    const user = await createUser(agent);
    const res = await agent
      .post('/api/partnerships/request')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({ shareCode: 'ZZZZZZZZ' });
    expect(res.status).toBe(404);
  });

  it('returns 400 when share-code is malformed', async () => {
    const user = await createUser(agent);
    const res = await agent
      .post('/api/partnerships/request')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({ shareCode: 'short' });
    expect(res.status).toBe(400);
  });

  it('returns 409 when an active partnership already exists', async () => {
    const a = await createUser(agent);
    const b = await createUser(agent);
    await createPartnership(a.userId, b.userId, 'active');

    const res = await agent
      .post('/api/partnerships/request')
      .set('Authorization', `Bearer ${a.accessToken}`)
      .send({ shareCode: b.shareCode });
    expect(res.status).toBe(409);
  });

  it('returns 409 when a pending partnership already exists in either direction', async () => {
    const a = await createUser(agent);
    const b = await createUser(agent);
    await createPendingRequest(a.userId, b.userId);

    // A → B (already requested)
    const sameDir = await agent
      .post('/api/partnerships/request')
      .set('Authorization', `Bearer ${a.accessToken}`)
      .send({ shareCode: b.shareCode });
    expect(sameDir.status).toBe(409);

    // B → A (reverse direction also blocked)
    const reverseDir = await agent
      .post('/api/partnerships/request')
      .set('Authorization', `Bearer ${b.accessToken}`)
      .send({ shareCode: a.shareCode });
    expect(reverseDir.status).toBe(409);
  });
});

describe('POST /api/partnerships/:id/accept', () => {
  it('flips the partnership to active, adds the addressee as member, generates the stack, emits and pushes', async () => {
    const requester = await createUser(agent);
    const addressee = await createUser(agent);
    await setDeviceToken(requester.userId, 'b'.repeat(64));
    const partnership = await createPendingRequest(requester.userId, addressee.userId);

    const res = await agent
      .post(`/api/partnerships/${partnership.id}/accept`)
      .set('Authorization', `Bearer ${addressee.accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.partnership).toMatchObject({
      id: partnership.id,
      status: 'active',
      requesterId: requester.userId,
      addresseeId: addressee.userId,
    });

    const [rows] = await pool.query<
      (RowDataPacket & { status: string; accepted_at: Date | null })[]
    >('SELECT status, accepted_at FROM partnerships WHERE id = ?', [partnership.id]);
    expect(rows[0].status).toBe('active');
    expect(rows[0].accepted_at).not.toBeNull();

    const [members] = await pool.query<(RowDataPacket & { user_id: number })[]>(
      'SELECT user_id FROM partnership_members WHERE partnership_id = ? ORDER BY user_id ASC',
      [partnership.id],
    );
    expect(members.map((m) => m.user_id).sort()).toEqual(
      [requester.userId, addressee.userId].sort(),
    );

    expect(vi.mocked(generatePartnershipStack)).toHaveBeenCalledWith(partnership.id, {});

    expect(__io.to).toHaveBeenCalledWith(`user:${requester.userId}`);
    expect(__io.to(`user:${requester.userId}`).emit).toHaveBeenCalledWith(
      'partnership_accepted',
      expect.objectContaining({ partnershipId: partnership.id }),
    );

    await vi.waitFor(() => {
      expect(vi.mocked(sendPartnershipAcceptedPush)).toHaveBeenCalledOnce();
    });
  });

  it('returns 403 when the requester tries to accept their own request', async () => {
    const requester = await createUser(agent);
    const addressee = await createUser(agent);
    const partnership = await createPendingRequest(requester.userId, addressee.userId);

    const res = await agent
      .post(`/api/partnerships/${partnership.id}/accept`)
      .set('Authorization', `Bearer ${requester.accessToken}`);
    expect(res.status).toBe(403);
  });

  it('returns 400 when the partnership is already active', async () => {
    const a = await createUser(agent);
    const b = await createUser(agent);
    const partnership = await createPartnership(a.userId, b.userId, 'active');

    const res = await agent
      .post(`/api/partnerships/${partnership.id}/accept`)
      .set('Authorization', `Bearer ${b.accessToken}`);
    expect(res.status).toBe(400);
  });
});

describe('POST /api/partnerships/:id/decline', () => {
  it('hard-deletes the pending partnership', async () => {
    const requester = await createUser(agent);
    const addressee = await createUser(agent);
    const partnership = await createPendingRequest(requester.userId, addressee.userId);

    const res = await agent
      .post(`/api/partnerships/${partnership.id}/decline`)
      .set('Authorization', `Bearer ${addressee.accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);

    const [rows] = await pool.query<RowDataPacket[]>('SELECT id FROM partnerships WHERE id = ?', [
      partnership.id,
    ]);
    expect(rows.length).toBe(0);
  });

  it('returns 403 when the requester (not the addressee) tries to decline', async () => {
    const requester = await createUser(agent);
    const addressee = await createUser(agent);
    const partnership = await createPendingRequest(requester.userId, addressee.userId);

    const res = await agent
      .post(`/api/partnerships/${partnership.id}/decline`)
      .set('Authorization', `Bearer ${requester.accessToken}`);
    expect(res.status).toBe(403);
  });
});

describe('DELETE /api/partnerships/:id/cancel-request', () => {
  it('hard-deletes the pending partnership when the requester cancels', async () => {
    const requester = await createUser(agent);
    const addressee = await createUser(agent);
    const partnership = await createPendingRequest(requester.userId, addressee.userId);

    const res = await agent
      .delete(`/api/partnerships/${partnership.id}/cancel-request`)
      .set('Authorization', `Bearer ${requester.accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);

    const [rows] = await pool.query<RowDataPacket[]>('SELECT id FROM partnerships WHERE id = ?', [
      partnership.id,
    ]);
    expect(rows.length).toBe(0);
  });

  it('returns 403 when the addressee tries to cancel-request', async () => {
    const requester = await createUser(agent);
    const addressee = await createUser(agent);
    const partnership = await createPendingRequest(requester.userId, addressee.userId);

    const res = await agent
      .delete(`/api/partnerships/${partnership.id}/cancel-request`)
      .set('Authorization', `Bearer ${addressee.accessToken}`);
    expect(res.status).toBe(403);
  });
});

describe('GET /api/partnerships', () => {
  it('splits the result into incoming, outgoing and active', async () => {
    const me = await createUser(agent);
    const incomingRequester = await createUser(agent);
    const outgoingAddressee = await createUser(agent);
    const activePartner = await createUser(agent);

    await createPendingRequest(incomingRequester.userId, me.userId); // incoming for me
    await createPendingRequest(me.userId, outgoingAddressee.userId); // outgoing from me
    await createPartnership(me.userId, activePartner.userId, 'active');

    const res = await agent
      .get('/api/partnerships')
      .set('Authorization', `Bearer ${me.accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.incoming).toHaveLength(1);
    expect(res.body.incoming[0].partner.id).toBe(incomingRequester.userId);
    expect(res.body.outgoing).toHaveLength(1);
    expect(res.body.outgoing[0].partner.id).toBe(outgoingAddressee.userId);
    expect(res.body.active).toHaveLength(1);
    expect(res.body.active[0].partner.id).toBe(activePartner.userId);
  });
});

describe('GET /api/partnerships/:id', () => {
  it('returns the partnership detail for a member', async () => {
    const a = await createUser(agent);
    const b = await createUser(agent);
    const partnership = await createPartnership(a.userId, b.userId, 'active');

    const res = await agent
      .get(`/api/partnerships/${partnership.id}`)
      .set('Authorization', `Bearer ${a.accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.partnership.partner.id).toBe(b.userId);
  });

  it('returns 403 for a stranger', async () => {
    const a = await createUser(agent);
    const b = await createUser(agent);
    const stranger = await createUser(agent);
    const partnership = await createPartnership(a.userId, b.userId, 'active');

    const res = await agent
      .get(`/api/partnerships/${partnership.id}`)
      .set('Authorization', `Bearer ${stranger.accessToken}`);
    expect(res.status).toBe(403);
  });
});

describe('PATCH /api/partnerships/:id/filters', () => {
  it('updates filters, regenerates the stack and emits filters_updated', async () => {
    const a = await createUser(agent);
    const b = await createUser(agent);
    const partnership = await createPartnership(a.userId, b.userId, 'active');

    const filters = { genres: [28, 12], yearFrom: 2010 };
    const res = await agent
      .patch(`/api/partnerships/${partnership.id}/filters`)
      .set('Authorization', `Bearer ${a.accessToken}`)
      .send({ filters });

    expect(res.status).toBe(200);
    expect(res.body.filters).toEqual(filters);

    expect(vi.mocked(generatePartnershipStack)).toHaveBeenCalledWith(partnership.id, filters);
    expect(__io.to).toHaveBeenCalledWith(`partnership:${partnership.id}`);
    expect(__io.to(`partnership:${partnership.id}`).emit).toHaveBeenCalledWith(
      'filters_updated',
      expect.objectContaining({ filters }),
    );
  });

  it('returns 403 for a non-member', async () => {
    const a = await createUser(agent);
    const b = await createUser(agent);
    const stranger = await createUser(agent);
    const partnership = await createPartnership(a.userId, b.userId, 'active');

    const res = await agent
      .patch(`/api/partnerships/${partnership.id}/filters`)
      .set('Authorization', `Bearer ${stranger.accessToken}`)
      .send({ filters: { genres: [28] } });
    expect(res.status).toBe(403);
  });

  it('returns 400 for malformed filters', async () => {
    const a = await createUser(agent);
    const b = await createUser(agent);
    const partnership = await createPartnership(a.userId, b.userId, 'active');

    const res = await agent
      .patch(`/api/partnerships/${partnership.id}/filters`)
      .set('Authorization', `Bearer ${a.accessToken}`)
      .send({ filters: { yearFrom: 1500 } });
    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/partnerships/:id', () => {
  it('cascades to members/swipes/matches/stack and emits partnership_ended', async () => {
    const a = await createUser(agent);
    const b = await createUser(agent);
    const partnership = await createPartnership(a.userId, b.userId, 'active');
    await seedStackMovie(partnership.id, 9001, 0);
    await seedSwipe(a.userId, 9001, partnership.id, 'right');
    await seedMatch(partnership.id, 9001);

    const res = await agent
      .delete(`/api/partnerships/${partnership.id}`)
      .set('Authorization', `Bearer ${a.accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);

    const [partnerships] = await pool.query<RowDataPacket[]>(
      'SELECT id FROM partnerships WHERE id = ?',
      [partnership.id],
    );
    expect(partnerships.length).toBe(0);

    const [members] = await pool.query<RowDataPacket[]>(
      'SELECT id FROM partnership_members WHERE partnership_id = ?',
      [partnership.id],
    );
    expect(members.length).toBe(0);

    const [stack] = await pool.query<RowDataPacket[]>(
      'SELECT id FROM partnership_stack WHERE partnership_id = ?',
      [partnership.id],
    );
    expect(stack.length).toBe(0);

    const [swipes] = await pool.query<RowDataPacket[]>(
      'SELECT id FROM swipes WHERE partnership_id = ?',
      [partnership.id],
    );
    expect(swipes.length).toBe(0);

    const [matches] = await pool.query<RowDataPacket[]>(
      'SELECT id FROM matches WHERE partnership_id = ?',
      [partnership.id],
    );
    expect(matches.length).toBe(0);

    expect(__io.to).toHaveBeenCalledWith(`partnership:${partnership.id}`);
    expect(__io.to(`partnership:${partnership.id}`).emit).toHaveBeenCalledWith(
      'partnership_ended',
      expect.objectContaining({ partnershipId: partnership.id }),
    );
    expect(__io.in).toHaveBeenCalledWith(`partnership:${partnership.id}`);
    expect(__io.__disconnectSockets).toHaveBeenCalledWith(true);
  });

  it('returns 403 for a stranger', async () => {
    const a = await createUser(agent);
    const b = await createUser(agent);
    const stranger = await createUser(agent);
    const partnership = await createPartnership(a.userId, b.userId, 'active');

    const res = await agent
      .delete(`/api/partnerships/${partnership.id}`)
      .set('Authorization', `Bearer ${stranger.accessToken}`);
    expect(res.status).toBe(403);
  });
});
