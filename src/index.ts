import 'dotenv/config';
import { createApp } from './app';
import { config } from './config';
import { initSocket } from './socket';
import { logger } from './logger';
import { pool } from './db/connection';
import { applyDevSchemaIfEnabled } from './db/apply-schema';
import { scheduleTokenCleanup } from './services/token-cleanup';

const { httpServer, parsedOrigins } = createApp();
initSocket(httpServer, parsedOrigins);

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
