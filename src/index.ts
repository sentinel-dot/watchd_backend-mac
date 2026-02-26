import 'dotenv/config';
import http from 'http';
import express from 'express';
import cors from 'cors';
import { config } from './config';
import { initSocket } from './socket';

import authRouter from './routes/auth';
import roomsRouter from './routes/rooms';
import moviesRouter from './routes/movies';
import swipesRouter from './routes/swipes';
import matchesRouter from './routes/matches';

const app = express();

app.use(cors());
app.use(express.json());

app.use('/api/auth', authRouter);
app.use('/api/rooms', roomsRouter);
app.use('/api/movies', moviesRouter);
app.use('/api/swipes', swipesRouter);
app.use('/api/matches', matchesRouter);

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

const httpServer = http.createServer(app);
initSocket(httpServer);

httpServer.listen(config.port, () => {
  console.log(`Watchd server running on port ${config.port}`);
});

export { app };
