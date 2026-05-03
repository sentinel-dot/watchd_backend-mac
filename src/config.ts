import dotenv from 'dotenv';
dotenv.config();

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export const config = {
  port: parseInt(process.env['PORT'] ?? '3000', 10),
  nodeEnv: process.env['NODE_ENV'] ?? 'development',
  jwtSecret: requireEnv('JWT_SECRET'),
  jwtRefreshSecret: requireEnv('JWT_REFRESH_SECRET'),
  tmdbApiKey: requireEnv('TMDB_API_KEY'),
  /** Read token for TMDB v4 API – used as Bearer token instead of query-param api_key. */
  tmdbReadAccessToken: process.env['TMDB_READ_ACCESS_TOKEN'] ?? '',
  corsOrigins: process.env['CORS_ORIGINS'] ?? '*',
  db: {
    host: requireEnv('DB_HOST'),
    port: parseInt(process.env['DB_PORT'] ?? '3306', 10),
    user: requireEnv('DB_USER'),
    password: requireEnv('DB_PASSWORD'),
    name: requireEnv('DB_NAME'),
  },
  smtp: {
    host: process.env['SMTP_HOST'] ?? '',
    port: parseInt(process.env['SMTP_PORT'] ?? '587', 10),
    secure: process.env['SMTP_SECURE'] === 'true',
    user: process.env['SMTP_USER'] ?? '',
    password: process.env['SMTP_PASSWORD'] ?? '',
    from: process.env['SMTP_FROM'] ?? 'noreply@watchd.app',
  },
  appUrl: process.env['APP_URL'] ?? 'https://watchd.app',
  bcryptRounds: parseInt(process.env['BCRYPT_ROUNDS'] ?? '12', 10),
  apns: {
    keyId: process.env['APNS_KEY_ID'] ?? '',
    teamId: process.env['APNS_TEAM_ID'] ?? '',
    // Base64-encoded contents of the .p8 file (avoids newline issues in env vars)
    key: process.env['APNS_PRIVATE_KEY'] ?? '',
    // false = sandbox (debug builds on device), true = production (App Store / TestFlight)
    production: process.env['APNS_PRODUCTION'] === 'true',
  },
  // Apple Sign-In config is read lazily via getter so that tests can override
  // process.env values after module import without restarting the app.
  get apple() {
    return {
      servicesId: process.env['APPLE_SERVICES_ID'] ?? '',
      teamId: process.env['APPLE_TEAM_ID'] ?? '',
      keyId: process.env['APPLE_KEY_ID'] ?? '',
      privateKey: process.env['APPLE_PRIVATE_KEY'] ?? '',
    };
  },
};
