import { defineConfig } from 'vite';

// base './' keeps every path relative, so the same build works at the site root
// and inside a preview folder. In dev, /api and /ws are forwarded to the API.
export default defineConfig({
  base: './',
  build: { target: 'es2020', assetsInlineLimit: 0 },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8787',
      '/ws': { target: 'ws://localhost:8787', ws: true },
      '/shop': 'http://localhost:8787',
      '/thanks': 'http://localhost:8787',
      '/admin': 'http://localhost:8787',
    },
  },
});
