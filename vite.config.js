import { defineConfig } from 'vite';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

// 'checkout' and 'order' are the commerce pages (owner: web). They join the build as soon as the
// HTML files exist, so this file does not need another edit. See web/COMMERCE_ARCH.md section j.
const pages = ['index', 'shop', 'product', 'story', 'contact', 'faq', 'shipping-returns', 'terms', 'privacy', 'cookies', 'legal', '404', 'checkout', 'order']
  .filter((p) => existsSync(resolve(import.meta.dirname, `${p}.html`)));

// In development the API runs as its own process (`npm run dev:api`); Vite forwards /api to it.
const proxy = { '/api': { target: `http://127.0.0.1:${process.env.API_PORT || 3000}`, changeOrigin: false } };

export default defineConfig({
  base: './',
  server: { proxy },
  preview: { proxy },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: Object.fromEntries(pages.map((p) => [p, resolve(import.meta.dirname, `${p}.html`)])),
    },
  },
});
