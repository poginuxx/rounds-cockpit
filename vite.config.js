import { defineConfig } from 'vite';

export default defineConfig({
  // App is served from the domain root. If you deploy under a sub-path
  // (e.g. https://host/rounds/), set base: '/rounds/'.
  base: '/',
  server: { port: 5173, host: true },
  build: { outDir: 'dist', sourcemap: true },
  test: { environment: 'node' },
});
