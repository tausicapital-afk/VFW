import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    // IPv4 explicitly. Vite's default host ('localhost') resolves to ::1 on
    // Windows and binds IPv6-only, but Chrome resolves localhost to 127.0.0.1 —
    // so the dev server is up, curl can reach it over [::1], and the browser
    // still gets ERR_CONNECTION_REFUSED. Binding 127.0.0.1 makes the documented
    // http://localhost:5173 work everywhere without a --host flag.
    host: '127.0.0.1',
    port: 5173,
    // Proxy /api in dev so the browser sees one origin. That keeps the session
    // cookie same-site locally and means no CORS in the inner loop.
    proxy: {
      // The socket.io endpoint must proxy the WebSocket upgrade (ws: true), and
      // has to be listed before '/api' so it wins the match for /api/socket.io.
      '/api/socket.io': {
        target: 'ws://localhost:3001',
        ws: true,
        changeOrigin: true,
      },
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
});
