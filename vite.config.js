import { defineConfig } from 'vite';

// The app: index.html at the root loads src/main.js (ES modules). `npm run dev` serves it with hot reload on port 8000,
// `npm run build` writes a static site to dist/ (relative paths, so it can be opened from any folder of a web server).
export default defineConfig({
  base: './',
  server: { port: 8000, open: false },
  build: { outDir: 'dist', target: 'es2022', sourcemap: true },
});
