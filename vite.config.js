import { defineConfig } from 'vite';
import path from 'path';

export default defineConfig({
  // Serve from project root so core/ and network/ are accessible
  root: path.resolve(__dirname, '.'),
  // Files at the root level (index.html, sw.js, manifest.json, ai-worker.js) are served as static assets
  build: {
    outDir: 'dist',
    rollupOptions: {
      input: path.resolve(__dirname, 'web/index.html'),
    },
  },
  server: {
    port: 3000,
    open: '/web/index.html',
    fs: {
      // Allow serving files from the project root and up
      allow: ['.'],
    },
  },
  optimizeDeps: {
    include: ['bip39', 'buffer'],
    esbuildOptions: {
      target: 'esnext',
      define: {
        global: 'globalThis',
      },
    },
  },
  resolve: {},
  define: {
    global: 'globalThis',
  },
});
