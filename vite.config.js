import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// Laptop page (index.html) + phone controller (phone.html). /v1 is proxied to the local SpacetimeDB
// so a single tunnel URL serves pages, WebSockets and the database to phones and other laptops.
export default defineConfig({
  server: {
    port: 5180,
    strictPort: true,
    host: true,
    // Live reload is off by default: through a tunnel its socket can drop and Vite then reloads the
    // page, which would kick players out mid-rally. `npm run dev:hmr` turns it back on for development.
    hmr: process.env.BB_HMR === '1',
    allowedHosts: true,
    proxy: {
      '/v1': { target: 'http://127.0.0.1:3000', ws: true, changeOrigin: true },
    },
  },
  build: {
    rollupOptions: {
      input: { main: resolve(import.meta.dirname, 'index.html'), phone: resolve(import.meta.dirname, 'phone.html') },
    },
  },
});
