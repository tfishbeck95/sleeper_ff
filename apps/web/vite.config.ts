import { defineConfig } from 'vite';

export default defineConfig({
  // The workspace packages ship built JavaScript to Node and TypeScript source to everything in this
  // repository. Vite is in the second group: it compiles the source itself, so a stale `dist` can never
  // be what the browser bundle was built from.
  resolve: { conditions: ['@sleeper/source'] },
  server: {
    // Same-origin requests work even when Vite selects a different available port.
    proxy: { '/api': 'http://localhost:4000' },
  },
  build: {
    // Hashed asset names are what makes the immutable CDN cache policy in docs/deployment.md safe.
    sourcemap: true,
    rollupOptions: { output: { assetFileNames: 'assets/[name]-[hash][extname]', chunkFileNames: 'assets/[name]-[hash].js', entryFileNames: 'assets/[name]-[hash].js' } },
  },
});
