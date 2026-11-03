import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

/** Preloads the tour's headline face; its hashed file name is only known once the bundle is written. */
function preloadTourFont(): Plugin {
  let base = '/';
  return {
    name: 'lattice-preload-tour-font',
    apply: 'build',
    configResolved(config) {
      base = config.base;
    },
    transformIndexHtml: {
      order: 'post',
      handler(_html, context) {
        if (!context.bundle || !context.filename.endsWith('index.html')) return [];
        return Object.keys(context.bundle)
          .filter((file) => /archivo-variable-[\w-]+\.woff2$/.test(file))
          .map((file) => ({
            tag: 'link',
            attrs: { rel: 'preload', as: 'font', type: 'font/woff2', href: base + file, crossorigin: '' },
            injectTo: 'head' as const,
          }));
      },
    },
  };
}

export default defineConfig({
  plugins: [react(), preloadTourFont()],
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
