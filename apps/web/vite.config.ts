import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    // Same-origin requests work even when Vite selects a different available port.
    proxy: { '/api': 'http://localhost:4000' },
  },
});
