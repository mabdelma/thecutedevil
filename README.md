# The Cute Devil

Brand website and shop. Charming outside. Mysterious inside.

## Run it

```
npm install
npm run dev      # local preview
npm run build    # outputs the static site to dist/
```

## Deploy (Hostinger, Node.js web app from GitHub)

- Framework: Vite (auto-detected)
- Build command: `npm run build`
- Output directory: `dist`
- Node.js: 20 or 22

Every push to `main` triggers a new build.

## Where things are

- Pages: `*.html` in the project root
- Styles: `src/css/` (colours and themes in `tokens.css`)
- Scripts: `src/js/` (products in `products.js`, checkout and the payment slot in `checkout.js`, tagline in `shell.js`)
- Product illustrations: `src/js/art.js`
- Static files: `public/`

Prices are samples. Legal pages are drafts with placeholders in [SQUARE BRACKETS].
