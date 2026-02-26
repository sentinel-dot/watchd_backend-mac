import dotenv from 'dotenv';
dotenv.config();

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export const config = {
  port: parseInt(process.env['PORT'] ?? '3000', 10),
  jwtSecret: requireEnv('JWT_SECRET'),
  tmdbApiKey: requireEnv('TMDB_API_KEY'),
  db: {
    host: requireEnv('DB_HOST'),
    port: parseInt(process.env['DB_PORT'] ?? '3306', 10),
    user: requireEnv('DB_USER'),
    password: requireEnv('DB_PASSWORD'),
    name: requireEnv('DB_NAME'),
  },
};
