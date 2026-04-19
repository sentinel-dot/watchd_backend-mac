import path from 'path';
import http from 'http';
import express, { Request, Response, NextFunction } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { config } from './config';
import { logger } from './logger';
import { pool } from './db/connection';

import authRouter from './routes/auth';
import usersRouter from './routes/users';
import roomsRouter from './routes/rooms';
import moviesRouter from './routes/movies';
import swipesRouter from './routes/swipes';
import matchesRouter from './routes/matches';

export interface CreateAppOptions {
  skipRateLimiter?: boolean;
}

export interface CreateAppResult {
  app: express.Express;
  httpServer: http.Server;
  parsedOrigins: string | string[];
}

export function createApp(options?: CreateAppOptions): CreateAppResult {
  const app = express();

  // Railway (and most PaaS) terminate TLS and forward via reverse proxy.
  // Trust the first hop so express-rate-limit can read X-Forwarded-For correctly.
  app.set('trust proxy', 1);

  app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  }));

  const corsOrigins = config.corsOrigins;
  const parsedOrigins: string | string[] = corsOrigins === '*'
    ? '*'
    : corsOrigins.split(',').map((s: string) => s.trim());
  app.use(cors({
    origin: parsedOrigins,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  }));
  app.use(express.json({ limit: '1mb' }));

  const publicDir = path.join(process.cwd(), 'public');
  app.use('/icons', express.static(path.join(publicDir, 'icons')));

  if (!options?.skipRateLimiter) {
    const authLimiter = rateLimit({
      windowMs: 15 * 60 * 1000,
      max: 10,
      message: { error: 'Zu viele Versuche, bitte warte 15 Minuten.' },
      standardHeaders: true,
      legacyHeaders: false,
    });

    // 120 swipes/min (2/s average) — generous for real usage, blocks scripting.
    // Keyed by IP; the authenticated userId is not yet available at middleware level.
    const swipeLimiter = rateLimit({
      windowMs: 60_000,
      max: 120,
      message: { error: 'Zu viele Swipes. Bitte kurz warten.' },
      standardHeaders: true,
      legacyHeaders: false,
    });

    app.use('/api/auth/login', authLimiter);
    app.use('/api/auth/register', authLimiter);
    app.use('/api/auth/forgot-password', authLimiter);
    app.use('/api/swipes', swipeLimiter);
  }

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

  // Apple App Site Association — must be served before the catch-all, no auth, no redirect.
  // Apple crawls this during app install to establish the applinks entitlement.
  app.get('/.well-known/apple-app-site-association', (_req, res) => {
    res.json({
      applinks: {
        details: [
          {
            appIDs: [`${config.apns.teamId}.com.watchd.app`],
            components: [{ '/': '/reset-password*' }],
          },
        ],
      },
    });
  });

  // Fallback page for Universal Links when the app is not installed.
  // iOS intercepts /reset-password before this is ever reached if the app is present.
  app.get('/reset-password', (req: Request, res: Response) => {
    const token = typeof req.query['token'] === 'string' ? req.query['token'] : '';
    const deepLink = token ? `watchd://reset-password?token=${encodeURIComponent(token)}` : '';

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Watchd – Passwort zurücksetzen</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{background:#141414;color:#fff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
    .card{background:#1e1e1e;border-radius:12px;padding:40px 32px;max-width:480px;width:100%;text-align:center}
    h1{color:#E50914;font-size:28px;font-weight:700;letter-spacing:2px;margin-bottom:32px}
    h2{font-size:20px;font-weight:600;margin-bottom:16px}
    p{color:#aaa;font-size:15px;line-height:1.6;margin-bottom:16px}
    .btn{display:inline-block;background:#E50914;color:#fff;font-size:16px;font-weight:600;text-decoration:none;padding:14px 32px;border-radius:6px;margin:8px 0}
    .btn-secondary{background:transparent;border:1px solid #555;color:#ccc;font-size:14px;padding:10px 24px}
    .hint{font-size:13px;color:#666;margin-top:24px;line-height:1.5}
    .divider{border:none;border-top:1px solid #333;margin:24px 0}
  </style>
</head>
<body>
  <div class="card">
    <h1>WATCHD</h1>
    <h2>Passwort zurücksetzen</h2>
    <p>Um dein Passwort zurückzusetzen, öffne diesen Link in der Watchd-App.</p>
    ${deepLink ? `
    <hr class="divider">
    <p>Hast du die App bereits installiert?</p>
    <a href="${deepLink}" class="btn">In App öffnen</a>
    <hr class="divider">
    ` : ''}
    <p>Du hast die App noch nicht installiert?<br>Bitte installiere Watchd zuerst und fordere danach einen neuen Reset-Link an — der Link ist nur <strong style="color:#fff">1 Stunde</strong> gültig.</p>
    <p class="hint">Falls du diese E-Mail nicht angefordert hast, kannst du sie ignorieren.</p>
  </div>
</body>
</html>`);
  });

  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'Nicht gefunden' });
  });

  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, method: req.method, url: req.url }, `Unhandled route error: ${message}`);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Interner Serverfehler' });
    }
  });

  const httpServer = http.createServer(app);

  return { app, httpServer, parsedOrigins };
}
