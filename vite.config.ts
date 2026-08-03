import { defineConfig } from 'vite';

export default defineConfig({
  root: 'src/client',
  build: {
    outDir: '../../dist/public',
    emptyOutDir: true,
    target: 'es2022',
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
      '/health': 'http://localhost:3000',
      '/ws': { target: 'ws://localhost:3000', ws: true },
    },
  },
});
