import { defineConfig } from 'vite';
import { resolve } from 'node:path';

const pages = ['index', 'shop', 'product', 'story', 'contact', 'faq', 'shipping-returns', 'terms', 'privacy', 'cookies', 'legal', '404'];

export default defineConfig({
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: Object.fromEntries(pages.map((p) => [p, resolve(import.meta.dirname, `${p}.html`)])),
    },
  },
});
