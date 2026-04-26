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
  PARTNERSHIP_ENDED: 'partnership_ended',
  PARTNERSHIP_REQUEST: 'partnership_request',
  PARTNERSHIP_ACCEPTED: 'partnership_accepted',
  FILTERS_UPDATED: 'filters_updated',
} as const;

export type SocketEventName = (typeof SocketEvents)[keyof typeof SocketEvents];
