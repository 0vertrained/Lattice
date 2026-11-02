import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: false,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
  preview: {
    port: 4173,
    strictPort: true,
  },
  build: {
    sourcemap: false,
    manifest: true,
    rollupOptions: { input: { index: 'index.html', operator: 'operator.html' } },
    target: 'es2022',
    chunkSizeWarningLimit: 950,
  },
});
