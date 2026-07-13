import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
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
