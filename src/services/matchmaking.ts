import { pool } from '../db/connection';
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
  // Get all current members of the room
  const [members] = await pool.query<MemberRow[]>(
    'SELECT user_id FROM room_members WHERE room_id = ?',
    [roomId],
  );

  const memberCount = members.length;

  // Count how many members have swiped right on this movie in this room.
  // This naturally handles solo rooms (1 member = 1 right swipe needed) and
  // late joiners (User B joins after User A already liked → still triggers a match).
  const [swipes] = await pool.query<SwipeRow[]>(
    `SELECT user_id FROM swipes
     WHERE movie_id = ? AND room_id = ? AND direction = 'right'`,
    [movieId, roomId],
  );

  if (memberCount < 2 || swipes.length < memberCount) {
    return { isMatch: false };
  }

  // Prevent duplicate matches
  const [existing] = await pool.query<MatchExistsRow[]>(
    'SELECT id FROM matches WHERE room_id = ? AND movie_id = ?',
    [roomId, movieId],
  );

  if (existing.length > 0) {
    return { isMatch: false };
  }

  // Insert the match
  const [result] = await pool.query<ResultSetHeader>(
    'INSERT INTO matches (room_id, movie_id) VALUES (?, ?)',
    [roomId, movieId],
  );

  const matchId = result.insertId;

  // Fetch movie details and streaming info for the notification
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
  } catch {
    // Non-fatal: match is created, notification may lack details
  }

  return {
    isMatch: true,
    matchId,
    movieId,
    movieTitle,
    posterPath,
    streamingOptions,
  };
}
