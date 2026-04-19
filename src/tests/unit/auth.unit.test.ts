import { describe, it, expect } from 'vitest';
import { decodeRefreshToken } from '../../routes/auth';

describe('decodeRefreshToken', () => {
  it('decodes a valid base64url-encoded payload', () => {
    const payload = { uid: 42, tok: 'abcd', fam: 'fam-uuid' };
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
    expect(decodeRefreshToken(encoded)).toEqual(payload);
  });

  it('returns null for malformed base64', () => {
    expect(decodeRefreshToken('!!!not-base64!!!')).toBeNull();
  });

  it('returns null for valid base64 but non-JSON content', () => {
    const encoded = Buffer.from('not json at all').toString('base64url');
    expect(decodeRefreshToken(encoded)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(decodeRefreshToken('')).toBeNull();
  });
});
