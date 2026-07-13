import { io, type Socket } from 'socket.io-client';

/**
 * One shared socket for the whole app. It rides the same origin as the REST API
 * (the nginx proxy forwards /api/socket.io to the backend), so the httpOnly
 * session cookie is sent automatically on the handshake — there is no token to
 * attach here either. The gateway verifies that cookie and disconnects anyone
 * without a valid session.
 */
const API_BASE = import.meta.env.VITE_API_BASE ?? '';

let socket: Socket | null = null;

export function getSocket(): Socket {
  if (!socket) {
    socket = io(API_BASE || undefined, {
      path: '/api/socket.io',
      withCredentials: true,
      autoConnect: false,
      transports: ['websocket', 'polling'],
    });
  }
  return socket;
}

export function connectSocket(): Socket {
  const s = getSocket();
  if (!s.connected) s.connect();
  return s;
}

export function disconnectSocket() {
  if (socket) {
    socket.removeAllListeners();
    socket.disconnect();
    socket = null;
  }
}
