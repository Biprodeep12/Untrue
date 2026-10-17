/// <reference types="vitest/config" />
import { defineConfig } from 'vite';

export default defineConfig({
  // Relative paths, so the build works from any folder on any static host.
  base: './',
  worker: { format: 'es' },
  // World-streaming tests generate thousands of chunks: give them room on slow or busy machines.
  test: { testTimeout: 30000 },
  build: {
    target: 'es2022',
    // Pixi in its own file, cached across game updates.
    rollupOptions: {
      output: {
        manualChunks: (id: string) => (id.includes('node_modules') && id.includes('pixi') ? 'pixi' : undefined),
      },
    },
    chunkSizeWarningLimit: 800,
  },
});
