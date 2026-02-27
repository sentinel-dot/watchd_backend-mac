import { pool } from '../db/connection';
import { logger } from '../logger';
import { getMovieById } from './tmdb';
import { getStreamingOffers, StreamingOffer } from './justwatch';
import { RowDataPacket, ResultSetHeader } from 'mysql2';

export interface MatchResult {
  isMatch: boolean;
  matchId?: number;
  movieId?: number;
  movieTitle?: string;
  posterPath?: string | null;
  streamingOptions?: StreamingOffer[];
}

interface SwipeRow extends RowDataPacket {
  user_id: number;
}

interface MemberRow extends RowDataPacket {
  user_id: number;
}

interface MatchExistsRow extends RowDataPacket {
  id: number;
}

export async function checkAndCreateMatch(
  userId: number,
  movieId: number,
  roomId: number,
): Promise<MatchResult> {
  const [members] = await pool.query<MemberRow[]>(
    'SELECT user_id FROM room_members WHERE room_id = ?',
    [roomId],
  );

  const memberCount = members.length;
  logger.info({ roomId, memberCount, memberIds: members.map(m => m.user_id) }, 'Checking match - room members');

  const [swipes] = await pool.query<SwipeRow[]>(
    `SELECT user_id FROM swipes
     WHERE movie_id = ? AND room_id = ? AND direction = 'right'`,
    [movieId, roomId],
  );

  const rightSwipeCount = swipes.length;
  const swipedUserIds = swipes.map(s => s.user_id);
  logger.info({ 
    roomId, 
    movieId, 
    memberCount, 
    rightSwipeCount, 
    swipedUserIds,
    needsMatch: rightSwipeCount >= memberCount 
  }, 'Checking match - swipe status');

  if (memberCount < 2 || swipes.length < memberCount) {
    return { isMatch: false };
  }

  const [existing] = await pool.query<MatchExistsRow[]>(
    'SELECT id FROM matches WHERE room_id = ? AND movie_id = ?',
    [roomId, movieId],
  );

  if (existing.length > 0) {
    logger.info({ roomId, movieId, existingMatchId: existing[0].id }, 'Match already exists');
    return { isMatch: false };
  }

  const [result] = await pool.query<ResultSetHeader>(
    'INSERT INTO matches (room_id, movie_id) VALUES (?, ?)',
    [roomId, movieId],
  );

  const matchId = result.insertId;

  let movieTitle = '';
  let posterPath: string | null = null;
  let streamingOptions: StreamingOffer[] = [];

  try {
    const movie = await getMovieById(movieId);
    movieTitle = movie.title;
    posterPath = movie.poster_path;

    const releaseYear = movie.release_date
      ? parseInt(movie.release_date.slice(0, 4), 10)
      : new Date().getFullYear();

    streamingOptions = await getStreamingOffers(movieId, movie.title, releaseYear);
  } catch (err) {
    logger.warn({ err, movieId }, 'Failed to fetch movie details for match');
  }

  logger.info({ matchId, roomId, movieId, movieTitle }, 'Match created');

  return {
    isMatch: true,
    matchId,
    movieId,
    movieTitle,
    posterPath,
    streamingOptions,
  };
}
