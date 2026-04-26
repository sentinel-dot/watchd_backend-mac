import { randomBytes } from 'node:crypto';
import { pool } from '../db/connection';
import type { RowDataPacket } from 'mysql2';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LENGTH = 8;
const MAX_RETRIES = 5;

const PROFANITY_BLOCKLIST = [
  'FUCK',
  'SHIT',
  'CUNT',
  'COCK',
  'DICK',
  'PISS',
  'TWAT',
  'SLUT',
  'WHORE',
  'SEX',
  'ASS',
  'NAZI',
  'KILL',
  'RAPE',
  'FAG',
  'JEW',
  'NIGR',
  'NEGR',
  'NUTTE',
  'HURE',
  'FOTZE',
  'SCHWUL',
];

export function generateShareCode(): string {
  const bytes = randomBytes(CODE_LENGTH);
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += ALPHABET[bytes[i] & 0x1f];
  }
  return code;
}

export function containsProfanity(code: string): boolean {
  const upper = code.toUpperCase();
  return PROFANITY_BLOCKLIST.some((word) => upper.includes(word));
}

interface CountRow extends RowDataPacket {
  c: number;
}

export async function generateUniqueShareCode(): Promise<string> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const code = generateShareCode();
    if (containsProfanity(code)) continue;

    const [rows] = await pool.query<CountRow[]>(
      'SELECT COUNT(*) AS c FROM users WHERE share_code = ?',
      [code],
    );
    if (rows[0].c === 0) return code;
  }
  throw new Error('share-code collision ceiling');
}
