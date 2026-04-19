import { describe, it, expect, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import type { Request, Response, NextFunction } from 'express';
import { authMiddleware } from '../../middleware/auth';
import { config } from '../../config';

function buildRes(): Response {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) { this.statusCode = code; return this; },
    json(b: unknown) { this.body = b; return this; },
  };
  return res as unknown as Response;
}

describe('authMiddleware', () => {
  it('returns 401 when Authorization header is missing', () => {
    const req = { headers: {} } as Request;
    const res = buildRes();
    const next = vi.fn() as NextFunction;

    authMiddleware(req, res, next);

    expect((res as unknown as { statusCode: number }).statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 when header is not Bearer format', () => {
    const req = { headers: { authorization: 'Basic foo' } } as unknown as Request;
    const res = buildRes();
    const next = vi.fn() as NextFunction;

    authMiddleware(req, res, next);

    expect((res as unknown as { statusCode: number }).statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 for an invalid JWT', () => {
    const req = { headers: { authorization: 'Bearer not-a-real-jwt' } } as unknown as Request;
    const res = buildRes();
    const next = vi.fn() as NextFunction;

    authMiddleware(req, res, next);

    expect((res as unknown as { statusCode: number }).statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 for an expired JWT', () => {
    const expiredToken = jwt.sign(
      { userId: 1, email: 'a@b.c', isGuest: false },
      config.jwtSecret,
      { expiresIn: '-1s' },
    );
    const req = { headers: { authorization: `Bearer ${expiredToken}` } } as unknown as Request;
    const res = buildRes();
    const next = vi.fn() as NextFunction;

    authMiddleware(req, res, next);

    expect((res as unknown as { statusCode: number }).statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('calls next() and attaches user for a valid JWT', () => {
    const token = jwt.sign(
      { userId: 42, email: 'x@y.z', isGuest: false },
      config.jwtSecret,
      { expiresIn: '15m' },
    );
    const req = { headers: { authorization: `Bearer ${token}` } } as unknown as Request;
    const res = buildRes();
    const next = vi.fn() as NextFunction;

    authMiddleware(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect((req as unknown as { user: { userId: number } }).user.userId).toBe(42);
  });
});
