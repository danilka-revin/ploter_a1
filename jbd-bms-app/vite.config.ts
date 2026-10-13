import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Интерфейс собирается в dist/; сервер scripts/server.mjs отдаёт его и API на одном порту,
// поэтому в браузере нет обращений к localhost — только относительные адреса.
export default defineConfig({
  plugins: [react()],
  base: './',
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false },
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:8585',
      '/update': 'http://127.0.0.1:8585',
      '/healthz': 'http://127.0.0.1:8585',
    },
  },
});
