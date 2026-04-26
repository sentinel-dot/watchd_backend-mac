import { beforeAll, beforeEach, vi } from 'vitest';
import type { AddressInfo } from 'net';

// Mock factories MUST be idempotent. With `isolate: false`, vitest hoists
// vi.mock() into each test file's module context and re-invokes the factory
// per file. A naive factory returns fresh vi.fn()s every time, which detaches
// the app (built once at top-level) from the mock instances the test files
// import — causing "spy 0 calls" flakes whose outcome depends on which file
// runs first.
//
// We stash shared mock state on globalThis so the factory always returns the
// same references. vitest's beforeEach→clearAllMocks still resets call history
// between tests, so cross-test isolation is preserved.
// vi.hoisted runs BEFORE vi.mock factories, so this helper is safe to call
// from inside them. A plain `const` would hit the TDZ because vi.mock is
// hoisted above all other top-level statements.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MockModule = Record<string, any>;
type MockRegistry = {
  partnershipStack?: MockModule;
  socket?: MockModule;
  apns?: MockModule;
  mail?: MockModule;
  tmdb?: MockModule;
  justwatch?: MockModule;
};
const { getRegistry } = vi.hoisted(() => ({
  getRegistry: (): MockRegistry => {
    const g = globalThis as unknown as { __watchdMocks?: MockRegistry };
    return (g.__watchdMocks ??= {});
  },
}));

vi.mock('../services/partnership-stack', () => {
  const r = getRegistry();
  return (r.partnershipStack ??= {
    generatePartnershipStack: vi.fn().mockResolvedValue(undefined),
    appendPartnershipStack: vi.fn().mockResolvedValue(undefined),
    buildTmdbUrl: vi.fn(),
  });
});

vi.mock('../socket', () => {
  const r = getRegistry();
  if (!r.socket) {
    const emit = vi.fn();
    const to = vi.fn(() => ({ emit }));
    const disconnectSockets = vi.fn();
    const inFn = vi.fn(() => ({ disconnectSockets }));
    const io = { to, emit, in: inFn, __disconnectSockets: disconnectSockets };
    r.socket = {
      initSocket: vi.fn(() => io),
      getIo: vi.fn(() => io),
      disconnectUserSockets: vi.fn(),
      __io: io,
    };
  }
  return r.socket;
});

vi.mock('../services/apns', () => {
  const r = getRegistry();
  return (r.apns ??= {
    sendMatchPush: vi.fn().mockResolvedValue(undefined),
    sendPartnershipRequestPush: vi.fn().mockResolvedValue(undefined),
    sendPartnershipAcceptedPush: vi.fn().mockResolvedValue(undefined),
    sendPushToDevice: vi.fn().mockResolvedValue(undefined),
  });
});

vi.mock('../services/mail', () => {
  const r = getRegistry();
  return (r.mail ??= {
    sendPasswordResetEmail: vi.fn().mockResolvedValue(undefined),
  });
});

vi.mock('../services/tmdb', () => {
  const r = getRegistry();
  return (r.tmdb ??= {
    getMovieById: vi.fn(async (id: number) => ({
      id,
      title: `Mock Movie ${id}`,
      overview: 'Mock overview',
      poster_path: '/mock-poster.jpg',
      backdrop_path: '/mock-backdrop.jpg',
      release_date: '2024-01-01',
      vote_average: 7.5,
      genre_ids: [28],
      genres: [{ id: 28, name: 'Action' }],
    })),
    getPopularMovies: vi.fn(async () => []),
  });
});

vi.mock('../services/justwatch', () => {
  const r = getRegistry();
  return (r.justwatch ??= {
    getStreamingOffers: vi.fn(async () => []),
  });
});

// Eager imports AFTER mock registration
import { createApp } from '../app';
import { pool } from '../db/connection';
import supertest from 'supertest';

// With vitest's `pool: 'threads'` + `fileParallelism: false` + `isolate: false`,
// this module is evaluated exactly once per worker and shared across all test
// files. App + httpServer + db pool live for the whole run.
const { httpServer } = createApp({ skipRateLimiter: true });

// `agent` is reassigned on first beforeAll; TS transpiles `import { agent }` to
// a live binding, so importers see the initialized value inside `it(...)`.
export let agent: ReturnType<typeof supertest> = null as unknown as ReturnType<typeof supertest>;

beforeAll(async () => {
  if (httpServer.listening) return;
  await new Promise<void>((resolve) => httpServer.listen(0, () => resolve()));
  const port = (httpServer.address() as AddressInfo).port;
  agent = supertest(`http://127.0.0.1:${port}`);
});

const TABLES = [
  'password_reset_tokens',
  'refresh_tokens',
  'favorites',
  'partnership_stack',
  'matches',
  'swipes',
  'partnership_members',
  'partnerships',
  'users',
];

export async function truncateAll(): Promise<void> {
  const conn = await pool.getConnection();
  try {
    await conn.query('SET FOREIGN_KEY_CHECKS = 0');
    for (const table of TABLES) {
      await conn.query(`TRUNCATE TABLE \`${table}\``);
    }
    await conn.query('SET FOREIGN_KEY_CHECKS = 1');
  } finally {
    conn.release();
  }
}

beforeEach(async () => {
  await truncateAll();
  vi.clearAllMocks();
});

// No afterAll: the worker owns httpServer + pool for the entire run. Closing
// them after any single file would break every subsequent file, since
// `isolate: false` shares module state across files.
