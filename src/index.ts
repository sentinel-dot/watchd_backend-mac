import 'dotenv/config';
import http from 'http';
import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { config } from './config';
import { initSocket } from './socket';
import { logger } from './logger';
import { pool } from './db/connection';

import authRouter from './routes/auth';
import usersRouter from './routes/users';
import roomsRouter from './routes/rooms';
import moviesRouter from './routes/movies';
import swipesRouter from './routes/swipes';
import matchesRouter from './routes/matches';

const app = express();

app.use(cors());
app.use(express.json());

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
  res.status(404).json({ error: 'Not found' });
});

// Express error middleware — catches errors passed via next(err) or thrown in async handlers
app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
  const message = err instanceof Error ? err.message : String(err);
  logger.error({ err, method: req.method, url: req.url }, `Unhandled route error: ${message}`);
  if (!res.headersSent) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

const httpServer = http.createServer(app);
initSocket(httpServer);

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

httpServer.listen(config.port, () => {
  logger.info(`Watchd server running on port ${config.port}`);
});

export { app };
