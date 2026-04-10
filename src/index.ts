import 'dotenv/config';
import path from 'path';
import http from 'http';
import express, { Request, Response, NextFunction } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { config } from './config';
import { initSocket } from './socket';
import { logger } from './logger';
import { pool } from './db/connection';
import { applyDevSchemaIfEnabled } from './db/apply-schema';
import { scheduleTokenCleanup } from './services/token-cleanup';

import authRouter from './routes/auth';
import usersRouter from './routes/users';
import roomsRouter from './routes/rooms';
import moviesRouter from './routes/movies';
import swipesRouter from './routes/swipes';
import matchesRouter from './routes/matches';

const app = express();

// Security headers (OWASP best practices)
app.use(helmet({
  contentSecurityPolicy: false, // API only, no HTML served
  crossOriginEmbedderPolicy: false,
}));

// CORS – restrict origins in production, allow all in development
const corsOrigins = config.corsOrigins;
const parsedOrigins = corsOrigins === '*' ? '*' : corsOrigins.split(',').map((s: string) => s.trim());
app.use(cors({
  origin: parsedOrigins,
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(express.json({ limit: '1mb' }));

// Statische Dateien (Streaming-Icons etc.) unter /icons/*
const publicDir = path.join(process.cwd(), 'public');
app.use('/icons', express.static(path.join(publicDir, 'icons')));

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Zu viele Versuche, bitte warte 15 Minuten.' },
  standardHeaders: true,
  legacyHeaders: false,
});

app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);
app.use('/api/auth/forgot-password', authLimiter);

app.use('/api/auth', authRouter);
app.use('/api/users', usersRouter);
app.use('/api/rooms', roomsRouter);
app.use('/api/movies', moviesRouter);
app.use('/api/swipes', swipesRouter);
app.use('/api/matches', matchesRouter);

app.get('/health', async (_req, res) => {
  const healthData: {
    status: 'ok' | 'degraded';
    db: 'ok' | 'error';
    tmdb: 'ok' | 'error';
    uptime: number;
  } = {
    status: 'ok',
    db: 'ok',
    tmdb: 'ok',
    uptime: process.uptime(),
  };

  try {
    await pool.query('SELECT 1');
  } catch (err) {
    logger.error({ err }, 'Database health check failed');
    healthData.db = 'error';
    healthData.status = 'degraded';
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    
    const response = await fetch(
      `https://api.themoviedb.org/3/configuration?api_key=${config.tmdbApiKey}`,
      { signal: controller.signal }
    );
    
    clearTimeout(timeout);
    
    if (!response.ok) {
      throw new Error(`TMDB returned ${response.status}`);
    }
  } catch (err) {
    logger.error({ err }, 'TMDB health check failed');
    healthData.tmdb = 'error';
    healthData.status = 'degraded';
  }

  res.json(healthData);
});

// Catch-all for unknown routes
app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: 'Nicht gefunden' });
});

// Express error middleware — catches errors passed via next(err) or thrown in async handlers
app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
  const message = err instanceof Error ? err.message : String(err);
  logger.error({ err, method: req.method, url: req.url }, `Unhandled route error: ${message}`);
  if (!res.headersSent) {
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

const httpServer = http.createServer(app);
initSocket(httpServer, parsedOrigins);

// Global safety nets for anything that slips past try/catch
process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'Unhandled Promise rejection');
});

process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception — shutting down');
  process.exit(1);
});

const shutdown = async () => {
  logger.info('Shutting down gracefully...');
  httpServer.close(() => {
    logger.info('HTTP server closed');
  });
  try {
    await pool.end();
    logger.info('Database pool closed');
  } catch (err) {
    logger.error({ err }, 'Error closing database pool');
  }
  process.exit(0);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

async function start(): Promise<void> {
  await applyDevSchemaIfEnabled();
  scheduleTokenCleanup();
  httpServer.listen(config.port, () => {
    logger.info(`Watchd server running on port ${config.port}`);
  });
}

void start().catch((err: unknown) => {
  logger.fatal({ err }, 'Server start failed');
  process.exit(1);
});

export { app };
