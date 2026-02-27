export const SocketEvents = {
  // Client -> Server
  JOIN: 'join',
  DISCONNECT: 'disconnect',
  
  // Server -> Client
  JOINED: 'joined',
  ERROR: 'error',
  MATCH: 'match',
  PARTNER_JOINED: 'partner_joined',
  PARTNER_LEFT: 'partner_left',
  ROOM_DISSOLVED: 'room_dissolved',
  FILTERS_UPDATED: 'filters_updated',
} as const;

export type SocketEventName = typeof SocketEvents[keyof typeof SocketEvents];
