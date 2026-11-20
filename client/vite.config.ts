import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const target = process.env.API_URL ?? 'http://localhost:3000';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': target,
      '/auth': target,
      '/scim': target,
      // AI agents: OAuth for MCP clients, and the MCP server.
      '/oauth': target,
      '/mcp': target,
      '/.well-known': target,
      '/socket.io': { target, ws: true },
    },
  },
});
